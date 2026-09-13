// @ts-check
// Accounts and sessions for the editor: who you are (a Google account today; email codes, SMS, and passkeys are
// meant to slot in beside it), which sites are yours, and a session cookie that the API accepts next to the master
// key and site passwords (index.js role_of). Nothing here touches the pages sandbox: the cookie lives on the editor
// origin only.
//
//   GET  /auth/methods                    which ways to sign in are configured (Paint shows the buttons it can)
//   GET  /auth/google[?next=/path]        start: a state cookie, then off to Google
//   GET  /auth/google/callback            back from Google: code → tokens → profile → user → session cookie → next
//   POST /auth/sign-out                   ends the session (the cookie is cleared)
//   POST /auth/sites {name}               a signed-in user takes a site nobody has (no owner, no password, no files)
//   POST /auth/sites/:name/claim {password}  …or one that has a password, by proving it (once; then it's theirs)
//
// A user = { id, email, name }; identities = (provider, subject) → user, joined by verified email so a Google
// sign-in and a later email sign-in land on the same person; owners = site → user. Sessions are random tokens
// stored as SHA-256 hashes (a leaked table isn't a set of sessions), 90 days, HttpOnly, SameSite=Lax.
import { valid_site_name } from "../shared/names.js";

const SESSION_COOKIE = "coolpaint_session";
const STATE_COOKIE = "coolpaint_auth_state";
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const STATE_TTL_S = 10 * 60;

/** Sign-in providers: the OAuth dance is the same; only the addresses, the scope, and the profile shape differ. */
const PROVIDERS = {
	google: {
		auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
		token_url: "https://oauth2.googleapis.com/token",
		userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo",
		scope: "openid email profile",
		extra: { prompt: "select_account" },
		/** @param {any} env */
		client(env) { return { id: env.GOOGLE_CLIENT_ID || "", secret: env.GOOGLE_CLIENT_SECRET || "" }; },
		/** @param {any} env */
		urls(env) { return { auth: env.GOOGLE_AUTH_URL || this.auth_url, token: env.GOOGLE_TOKEN_URL || this.token_url, userinfo: env.GOOGLE_USERINFO_URL || this.userinfo_url }; }, // (overridable for tests)
		/** @param {any} profile @returns {{ subject: string, email: string, verified: boolean, name: string }} */
		identity(profile) { return { subject: String(profile.sub || ""), email: String(profile.email || "").toLowerCase(), verified: profile.email_verified === true, name: String(profile.name || "") }; },
	},
};

/** @param {number} bytes */
function random_token(bytes = 32) {
	const view = crypto.getRandomValues(new Uint8Array(bytes));
	return [...view].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {string} text */
async function sha256_hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {Request} request @param {string} name */
function cookie_of(request, name) {
	const header = request.headers.get("Cookie") || "";
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) { return decodeURIComponent(rest.join("=")); }
	}
	return "";
}

/**
 * The editor's own origin, as the browser sees it: EDITOR_URL in production; AUTH_ORIGIN (.dev.vars) for a localhost
 * editor, since `wrangler dev` reports the configured custom domain as the request host.
 * @param {URL} url @param {any} env
 */
function editor_origin(url, env) {
	return String(env.AUTH_ORIGIN || env.EDITOR_URL || url.origin).replace(/\/+$/, "");
}

/**
 * @param {URL} url @param {any} env - a localhost editor (http) gets a cookie too
 * @param {string} name @param {string} value @param {number} max_age - seconds; 0 clears
 */
function set_cookie(url, env, name, value, max_age) {
	const secure = editor_origin(url, env).startsWith("https:") ? "; Secure" : "";
	return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${max_age}; HttpOnly; SameSite=Lax${secure}`;
}

/** @param {any} env */
const accounts_of = (env) => /** @type {any} */ (env.ACCOUNTS.getByName("global"));

/**
 * The signed-in user behind the request's session cookie, if any (and if the request looks like our own page's —
 * a cross-site request can't act with the cookie; see cookie_request_allowed).
 * @param {Request} request @param {any} env
 * @returns {Promise<{ id: string, email: string, name: string, hash: string } | null>}
 */
async function session_of(request, env) {
	const token = cookie_of(request, SESSION_COOKIE);
	if (!token || !/^[0-9a-f]{64}$/.test(token) || !cookie_request_allowed(request, env)) { return null; }
	const hash = await sha256_hex(token);
	const session = await accounts_of(env).get_session(hash);
	return session ? { ...session.user, hash } : null;
}

/**
 * Cookie-authenticated requests must come from the editor itself: browsers say so (Sec-Fetch-Site: same-origin, or
 * none for a typed address); a cross-site page's request is refused. A request without those headers (not a browser)
 * is allowed — CSRF is a browser problem, and a non-browser holding the cookie already has it. A localhost editor
 * also takes Paint from another localhost port (tests, `npm run dev:*`), which browsers call cross-site.
 * @param {Request} request @param {any} env
 */
function cookie_request_allowed(request, env) {
	const url = new URL(request.url);
	const own = editor_origin(url, env);
	const dev = /^http:\/\/localhost(:\d+)?$/.test(own);
	const origin = request.headers.get("Origin") || "";
	const local_pair = dev && /^http:\/\/localhost(:\d+)?$/.test(origin);
	const fetch_site = request.headers.get("Sec-Fetch-Site");
	if (fetch_site && fetch_site !== "same-origin" && fetch_site !== "none" && !local_pair) { return false; }
	// (wrangler dev rewrites a same-origin Origin to the configured custom domain, as it does the request host: both count as ours)
	if (origin && origin !== own && origin !== url.origin && !local_pair) { return false; }
	return true;
}

/**
 * A fresh session for a user: the cookie to set.
 * @param {URL} url @param {any} env @param {string} user_id
 */
async function issue_session(url, env, user_id) {
	const token = random_token(32);
	await accounts_of(env).create_session(await sha256_hex(token), user_id, Date.now() + SESSION_TTL_MS);
	return set_cookie(url, env, SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
}

/** Only a path on the editor itself (with its query), never another site. @param {string} next */
function safe_next(next) {
	return /^\/(?!\/)[^\s]*$/.test(next) ? next : "/";
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; // (index.js narrows this to the exact origin, with credentials, for a localhost pair)

/** @param {any} data @param {number} [status] @param {Record<string, string>} [headers] */
function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/**
 * The /auth/* routes.
 * @param {Request} request @param {URL} url @param {any} env
 * @param {(request: Request, env: any, site?: string) => Promise<string | null>} role_of - index.js's (the master key, a site's password)
 * @param {(secret: string, site: string, password: string) => Promise<string>} password_hash - index.js's
 * @param {Map<string, any>} site_hashes - index.js's cache, to look a stored hash up
 * @param {(env: any, site: string, options?: { fresh?: boolean }) => Promise<string | null>} site_hash
 */
async function handle_auth(request, url, env, { role_of, password_hash, site_hash }) {
	const path = url.pathname;
	if (request.method === "OPTIONS") { return new Response(null, { status: 204, headers: CORS }); }
	if (path === "/auth/methods") {
		return json({ google: !!PROVIDERS.google.client(env).id, password: true });
	}
	const provider_match = /^\/auth\/([a-z]+)(\/callback)?$/.exec(path);
	if (provider_match && PROVIDERS[provider_match[1]]) {
		const provider = PROVIDERS[provider_match[1]];
		const name = provider_match[1];
		const client = provider.client(env);
		if (!client.id || !client.secret) { return json({ error: `Signing in with ${name} isn't set up on this editor.` }, 503); }
		const urls = provider.urls(env);
		const redirect_uri = `${editor_origin(url, env)}/auth/${name}/callback`;
		if (!provider_match[2]) {
			// Start: remember a random state (and where to go afterwards), then send them to the provider
			if (request.method !== "GET") { return json({ error: "Method not allowed" }, 405); }
			const state = random_token(16);
			const next = safe_next(url.searchParams.get("next") || "/");
			const params = new URLSearchParams({ client_id: client.id, redirect_uri, response_type: "code", scope: provider.scope, state, ...provider.extra });
			return new Response(null, {
				status: 302,
				headers: { Location: `${urls.auth}?${params}`, "Set-Cookie": set_cookie(url, env, STATE_COOKIE, `${state}|${next}`, STATE_TTL_S), "Cache-Control": "no-store" },
			});
		}
		// Callback: the state must be ours; the code buys tokens; the profile names the person
		const [state, next = "/"] = cookie_of(request, STATE_COOKIE).split("|");
		const clear_state = set_cookie(url, env, STATE_COOKIE, "", 0);
		if (!state || url.searchParams.get("state") !== state) { return json({ error: "The sign-in didn't start here (no matching state). Try again." }, 400, { "Set-Cookie": clear_state }); }
		if (url.searchParams.get("error")) { return json({ error: `${name} said: ${url.searchParams.get("error")}` }, 400, { "Set-Cookie": clear_state }); }
		const code = url.searchParams.get("code") || "";
		if (!code) { return json({ error: "No code came back" }, 400, { "Set-Cookie": clear_state }); }
		const token_response = await fetch(urls.token, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, code, grant_type: "authorization_code", redirect_uri }),
		});
		const tokens = await token_response.json().catch(() => ({}));
		if (!token_response.ok || !tokens.access_token) { return json({ error: `${name} refused the code (${tokens.error || token_response.status})` }, 502, { "Set-Cookie": clear_state }); }
		const profile_response = await fetch(urls.userinfo, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
		const profile = await profile_response.json().catch(() => ({}));
		const identity = provider.identity(profile);
		if (!profile_response.ok || !identity.subject) { return json({ error: `${name} didn't say who you are` }, 502, { "Set-Cookie": clear_state }); }
		if (!identity.verified || !identity.email) { return json({ error: `Your ${name} account has no verified email address` }, 403, { "Set-Cookie": clear_state }); }
		const { user } = await accounts_of(env).sign_in_identity({ provider: name, subject: identity.subject, email: identity.email, name: identity.name });
		const session_cookie = await issue_session(url, env, user.id);
		const headers = new Headers({ Location: safe_next(next), "Cache-Control": "no-store" });
		headers.append("Set-Cookie", session_cookie);
		headers.append("Set-Cookie", clear_state);
		return new Response(null, { status: 302, headers });
	}
	if (path === "/auth/sign-out") {
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const session = await session_of(request, env);
		if (session) { await accounts_of(env).delete_session(session.hash); }
		return json({ ok: true }, 200, { "Set-Cookie": set_cookie(url, env, SESSION_COOKIE, "", 0) });
	}
	if (path === "/auth/sites") {
		// A signed-in user takes a site that nobody has
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const session = await session_of(request, env);
		if (!session) { return json({ error: "Sign in first" }, 401); }
		const body = await request.json().catch(() => ({}));
		const site = String(body.name || "").trim().toLowerCase();
		if (!valid_site_name(site)) { return json({ error: "Site names are 1–32 lowercase letters, digits, or hyphens" }, 400); }
		if (site === "root") { return json({ error: "The domain's own site belongs to the master key" }, 403); }
		const accounts = accounts_of(env);
		const owner = await accounts.owner_of(site);
		if (owner === session.id) { return json({ ok: true, site, yours: true }); }
		if (owner) { return json({ error: "That name is taken" }, 409); }
		if (await site_hash(env, site, { fresh: true })) { return json({ error: "That site has a password: claim it with the password", claimable: true }, 409); }
		const listing = await env.SITES.list({ prefix: `sites/${site}/`, limit: 1 });
		if (listing.objects.length) { return json({ error: "That name is taken" }, 409); }
		await accounts.claim_site(site, session.id);
		return json({ ok: true, site, yours: true });
	}
	const claim_match = /^\/auth\/sites\/([^/]+)\/claim$/.exec(path);
	if (claim_match) {
		// A site that has a password becomes the signed-in user's by proving the password (once)
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const session = await session_of(request, env);
		if (!session) { return json({ error: "Sign in first" }, 401); }
		const site = claim_match[1];
		if (!valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
		if (site === "root") { return json({ error: "The domain's own site belongs to the master key" }, 403); }
		const accounts = accounts_of(env);
		const owner = await accounts.owner_of(site);
		if (owner && owner !== session.id) { return json({ error: "That site is someone else's" }, 409); }
		const body = await request.json().catch(() => ({}));
		const password = String(body.password || "");
		const stored = await site_hash(env, site, { fresh: true });
		const given = password ? await password_hash(env.SITE_EDIT_SECRET, site, password) : "";
		const is_master = (await role_of(request, env, site)) === "master";
		if (!is_master && (!stored || !given || given !== stored)) { return json({ error: "The password was rejected" }, 401); }
		await accounts.claim_site(site, session.id);
		return json({ ok: true, site, yours: true });
	}
	return json({ error: "Not found" }, 404);
}

export { SESSION_COOKIE, accounts_of, cookie_request_allowed, editor_origin, handle_auth, session_of };
