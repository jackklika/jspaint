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
//   POST /auth/sites/:name/assign {email}    the master key hands a site (root included) to the account with that email
//   GET  /auth/sites/:name/owner             support (master key): who owns a site, and every account with that email
//   GET  /auth/favorites                     the signed-in account's favorite GIFs (the picker's ♥), newest first
//   POST /auth/favorites {add, remove}       hearts and un-hearts (add: [{id, width, height, at}], remove: [id]) → the list;
//                                            an id is `source:id-in-that-source` (`gifcities:ABC…`; a bare GifCities id still counts)
//
// A user = { id, email, name }; identities = (provider, subject) → user, joined by verified email so a Google
// sign-in and a later email sign-in land on the same person; owners = site → user. Sessions are random tokens
// stored as SHA-256 hashes (a leaked table isn't a set of sessions), 90 days, HttpOnly, SameSite=Lax.
//
// Beside the session cookie rides a signed *claims* cookie (coolpaint_id, an hour): who you are, the session it
// belongs to, and the sites you own, HMAC-signed by the Worker. Any request that carries a valid one is known
// without asking the Accounts Durable Object — one global object that every API call and room join used to hit
// twice. When it's missing or an hour old, the session cookie is looked up as before and a fresh claims cookie
// rides back on the response. Signing out deletes the session row and clears both; a claims cookie can outlive
// that by at most its hour. Routes that need the account's email or name ask for a fresh lookup.
import { reserved_site_name, valid_site_name } from "../shared/names.js";
import { client_ip, limited, report_limited, too_many } from "../shared/limits.js";
import { write_moderation } from "./moderation.js";
import { error_page_html } from "../shared/server-page.js";

const SESSION_COOKIE = "coolpaint_session";
const CLAIMS_COOKIE = "coolpaint_id";
const CLAIMS_TTL_S = 60 * 60;
const MAX_SITES = 5; // per account (the master key can hand out more)
const SITE_CREATION_HOURLY = 50; // platform-wide: more new sites than this in an hour is a farm, and new ones wait (the master key still may)

/**
 * The admin accounts: ADMIN_EMAILS in wrangler.jsonc (comma-separated). An admin's session acts as the master key
 * (every site, the admin page at /admin, MALICIOUS_ACTOR_PLAN.md phase 2.5).
 * @param {any} env @param {string} email
 */
function is_admin(env, email) {
	if (!email) { return false; }
	return String(env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}
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

/** Constant-time string comparison (no early exit on the first differing character). @param {string} a @param {string} b */
function same_string(a, b) {
	const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) { diff |= (x[i] || 0) ^ (y[i] || 0); }
	return diff === 0;
}

/** @param {Uint8Array} bytes */
function b64url(bytes) {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** @param {string} text */
function b64url_decode(text) {
	return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
}

/** @param {string} secret @param {string} message @returns {Promise<string>} HMAC-SHA256, base64url */
async function hmac_b64url(secret, message) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

/**
 * The key the claims cookie is signed with: SESSION_SIGNING_KEY when set (so it can rotate on its own, which signs
 * everyone out of the fast path for an hour and nothing else), else one derived from the master key.
 * @param {any} env
 */
function signing_secret(env) {
	return env.SESSION_SIGNING_KEY || (env.SITE_EDIT_SECRET ? `${env.SITE_EDIT_SECRET}|claims` : "");
}

/**
 * @typedef {{ u: string, h: string, s: string[], e: number, a?: number }} Claims - user id, session hash, sites owned, expiry (ms), admin (1)
 */

/** `v1.<claims>.<signature>` @param {any} env @param {Claims} claims */
async function sign_claims(env, claims) {
	const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
	return `v1.${payload}.${await hmac_b64url(signing_secret(env), `v1.${payload}`)}`;
}

/** The claims a cookie carries, if its signature is ours and it hasn't expired. @param {any} env @param {string} cookie @returns {Promise<Claims | null>} */
async function verify_claims(env, cookie) {
	const match = /^v1\.([A-Za-z0-9_-]{1,2000})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
	const secret = signing_secret(env);
	if (!match || !secret) { return null; }
	if (!same_string(await hmac_b64url(secret, `v1.${match[1]}`), match[2])) { return null; }
	try {
		const claims = JSON.parse(b64url_decode(match[1]));
		if (typeof claims.u !== "string" || typeof claims.h !== "string" || !Array.isArray(claims.s) || typeof claims.e !== "number") { return null; }
		return claims.e > Date.now() ? claims : null;
	} catch (_error) {
		return null;
	}
}

/** A fresh claims cookie for a user (asks Accounts which sites are theirs). @param {URL} url @param {any} env @param {string} user_id @param {string} hash */
async function claims_cookie(url, env, user_id, hash) {
	const accounts = accounts_of(env);
	const [sites, user] = await Promise.all([accounts.sites_of(user_id), accounts.get_user(user_id)]);
	/** @type {Claims} */
	const claims = { u: user_id, h: hash, s: sites.slice(0, 50), e: Date.now() + CLAIMS_TTL_S * 1000 };
	if (user && is_admin(env, user.email)) { claims.a = 1; }
	return set_cookie(url, env, CLAIMS_COOKIE, await sign_claims(env, claims), CLAIMS_TTL_S);
}

/** Requests whose response should carry a fresh claims cookie (a session was looked up, or a site changed hands). @type {WeakMap<Request, Promise<string>>} */
const pending_claims = new WeakMap();

/** Have the response to this request set a fresh claims cookie. @param {Request} request @param {any} env @param {string} user_id @param {string} hash */
function refresh_claims(request, env, user_id, hash) {
	pending_claims.set(request, claims_cookie(new URL(request.url), env, user_id, hash).catch(() => ""));
}

/**
 * The exported fetch wraps every response in this: a pending claims cookie rides along (never on a WebSocket
 * handshake, whose response can't be touched).
 * @param {Request} request @param {Response} response
 */
async function with_refreshed_claims(request, response) {
	const pending = pending_claims.get(request);
	if (!pending || response.status === 101) { return response; }
	const cookie = await pending;
	if (!cookie) { return response; }
	const out = new Response(response.body, response);
	out.headers.append("Set-Cookie", cookie);
	return out;
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
 * Server-side product events (signup, site_claimed): captured straight to PostHog's ingestion API with
 * the editor Worker's POSTHOG_API_KEY secret (the public client key — same project as the app's
 * analytics). From there, Hog Functions route them onward — a Discord destination for signups today.
 * Fire-and-forget: waitUntil keeps it alive past the response; no key set (local dev) = a no-op.
 * @param {any} env
 * @param {ExecutionContext | null} ctx
 * @param {string} event
 * @param {string} distinct_id the account's user id, so events tie to one person
 * @param {Record<string, string>} properties
 */
function capture_event(env, ctx, event, distinct_id, properties) {
	const api_key = env.POSTHOG_API_KEY;
	if (!api_key) { return; }
	const capture = fetch("https://us.i.posthog.com/e/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key, batch: [{ event, properties: { distinct_id, ...properties }, timestamp: new Date().toISOString() }] }),
	}).catch(() => { /* analytics must never break a signup */ });
	if (ctx) { ctx.waitUntil(capture); }
}

/**
 * The signed-in user behind the request's cookies, if any (and if the request looks like our own page's — a
 * cross-site request can't act with the cookie; see cookie_request_allowed). A valid claims cookie answers on its
 * own (`sites` filled in, `email`/`name` empty, `claimed: true`); otherwise the session cookie is looked up in
 * Accounts and the response gets a fresh claims cookie. `fresh: true` skips the claims (routes that need the
 * email or name, or must see a sign-out at once).
 * @param {Request} request @param {any} env @param {{ fresh?: boolean }} [options]
 * @returns {Promise<{ id: string, email: string, name: string, hash: string, sites: string[] | null, claimed: boolean, admin: boolean } | null>}
 */
async function session_of(request, env, { fresh = false } = {}) {
	if (!cookie_request_allowed(request, env)) { return null; }
	if (!fresh) {
		const claims = await verify_claims(env, cookie_of(request, CLAIMS_COOKIE));
		if (claims) { return { id: claims.u, email: "", name: "", hash: claims.h, sites: claims.s, claimed: true, admin: claims.a === 1 }; }
	}
	const token = cookie_of(request, SESSION_COOKIE);
	if (!token || !/^[0-9a-f]{64}$/.test(token)) { return null; }
	const hash = await sha256_hex(token);
	const session = await accounts_of(env).get_session(hash);
	if (!session) { return null; }
	refresh_claims(request, env, session.user.id, hash); // the next hour of requests won't need this lookup
	const { locked, ...user } = session.user;
	void locked; // (a locked account has no session: get_session already said so)
	return { ...user, hash, sites: null, claimed: false, admin: is_admin(env, user.email) };
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
 * A fresh session for a user: the cookies to set (the session, and the claims beside it).
 * @param {URL} url @param {any} env @param {string} user_id
 * @returns {Promise<string[]>}
 */
async function issue_session(url, env, user_id) {
	const token = random_token(32);
	const hash = await sha256_hex(token);
	await accounts_of(env).create_session(hash, user_id, Date.now() + SESSION_TTL_MS);
	return [set_cookie(url, env, SESSION_COOKIE, token, SESSION_TTL_MS / 1000), await claims_cookie(url, env, user_id, hash)];
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
async function handle_auth(request, url, env, { role_of, password_hash, site_hash }, ctx = null) {
	const path = url.pathname;
	if (request.method === "OPTIONS") { return new Response(null, { status: 204, headers: CORS }); }
	if (path === "/auth/methods") {
		// (plus where the sites live: Paint learns it here before anyone signs in — a stranger's starter page previews
		// its counter from the domain's own site, and a copy previews from the copied site)
		return json({ google: !!PROVIDERS.google.client(env).id, password: true, site_limit: MAX_SITES, sites_url: env.SITES_URL || null });
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
		const { user, created } = await accounts_of(env).sign_in_identity({ provider: name, subject: identity.subject, email: identity.email, name: identity.name });
		if (user.locked) {
			// The admin locked this account: no session, one plain sentence
			return new Response(error_page_html(403, `<p>This account is locked.</p>\n<p><a href="/">Back to Paint</a></p>`), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": clear_state } });
		}
		if (created) {
			capture_event(env, ctx, "signup", user.id, { email: user.email || "", name: user.name || "", provider: name });
		}
		const headers = new Headers({ Location: safe_next(next), "Cache-Control": "no-store" });
		for (const cookie of await issue_session(url, env, user.id)) { headers.append("Set-Cookie", cookie); }
		headers.append("Set-Cookie", clear_state);
		return new Response(null, { status: 302, headers });
	}
	if (path === "/auth/sign-out") {
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const session = await session_of(request, env, { fresh: true });
		if (session) { await accounts_of(env).delete_session(session.hash); }
		pending_claims.delete(request); // (the lookup above would have sent a fresh claims cookie along)
		const response = json({ ok: true });
		response.headers.append("Set-Cookie", set_cookie(url, env, SESSION_COOKIE, "", 0));
		response.headers.append("Set-Cookie", set_cookie(url, env, CLAIMS_COOKIE, "", 0));
		return response;
	}
	const available_match = /^\/auth\/sites\/([^/]+)\/available$/.exec(path);
	if (available_match) {
		// Is this name free? — asked as someone types a site name (my-site.js new_site_form). Public (site names are
		// public addresses), per-address limited, and only ever a word: free, yours, taken, reserved, claimable, invalid.
		if (request.method !== "GET") { return json({ error: "Method not allowed" }, 405); }
		if (await limited(env.LIMIT_IP_10S, `available:${client_ip(request)}`)) { return too_many(10, CORS); }
		const site = available_match[1].toLowerCase();
		const answer = async () => {
			if (!valid_site_name(site)) { return "invalid"; }
			if (site === "root") { return "reserved"; }
			const session = await session_of(request, env);
			const accounts = accounts_of(env);
			const owner = await accounts.owner_of(site);
			if (owner && session && owner === session.id) { return "yours"; }
			if (owner) { return "taken"; }
			if (reserved_site_name(site) && !session?.admin) { return "reserved"; }
			if (await site_hash(env, site, { fresh: true })) { return "claimable"; }
			const listing = await env.SITES.list({ prefix: `sites/${site}/`, limit: 1 });
			return listing.objects.length ? "taken" : "free";
		};
		const reason = await answer();
		return json({ name: site, available: reason === "free", reason });
	}
	if (path === "/auth/sites") {
		// A signed-in user takes a site that nobody has
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const session = await session_of(request, env, { fresh: true });
		if (!session) { return json({ error: "Sign in first" }, 401); }
		const body = await request.json().catch(() => ({}));
		const site = String(body.name || "").trim().toLowerCase();
		if (!valid_site_name(site)) { return json({ error: "Site names are 1–32 lowercase letters, digits, or hyphens" }, 400); }
		if (site === "root") { return json({ error: "The domain's own site belongs to the master key" }, 403); }
		const accounts = accounts_of(env);
		const owner = await accounts.owner_of(site);
		if (owner === session.id) { return json({ ok: true, site, yours: true }); }
		if (owner) { return json({ error: "That name is taken" }, 409); }
		if (reserved_site_name(site) && !session.admin) { return json({ error: "That name is reserved. Pick another." }, 400); }
		if ((await accounts.sites_of(session.id)).length >= MAX_SITES) { return json({ error: `An account can have up to ${MAX_SITES} sites`, limit: MAX_SITES }, 409); }
		if ((await accounts.claims_since(Date.now() - 60 * 60 * 1000)) >= SITE_CREATION_HOURLY && (await role_of(request, env)) !== "master") {
			report_limited(env, ctx, { kind: "site-creation-surge", worker: "jspaint-editor" }, { always: true });
			return json({ error: "New sites are paused for a little while. Please try again in an hour.", code: "surge" }, 429);
		}
		if (await site_hash(env, site, { fresh: true })) { return json({ error: "That site has a password: claim it with the password", claimable: true }, 409); }
		const listing = await env.SITES.list({ prefix: `sites/${site}/`, limit: 1 });
		if (listing.objects.length) { return json({ error: "That name is taken" }, 409); }
		await accounts.claim_site(site, session.id);
		refresh_claims(request, env, session.id, session.hash); // (the claims cookie names the new site at once)
		await write_moderation(env, ctx, site, { created: Date.now() }, session.email || "system"); // (its first day is noindex)
		capture_event(env, ctx, "site_claimed", session.id, { site, email: session.email || "" });
		return json({ ok: true, site, yours: true });
	}
	const claim_match = /^\/auth\/sites\/([^/]+)\/claim$/.exec(path);
	if (claim_match) {
		// A site that has a password becomes the signed-in user's by proving the password (once)
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const session = await session_of(request, env, { fresh: true });
		if (!session) { return json({ error: "Sign in first" }, 401); }
		const site = claim_match[1];
		if (!valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
		if (site === "root") { return json({ error: "The domain's own site belongs to the master key" }, 403); }
		const accounts = accounts_of(env);
		const owner = await accounts.owner_of(site);
		if (owner && owner !== session.id) { return json({ error: "That site is someone else's" }, 409); }
		if (owner !== session.id && (await accounts.sites_of(session.id)).length >= MAX_SITES) { return json({ error: `An account can have up to ${MAX_SITES} sites`, limit: MAX_SITES }, 409); }
		const body = await request.json().catch(() => ({}));
		const password = String(body.password || "");
		const stored = await site_hash(env, site, { fresh: true });
		const given = password ? await password_hash(env.SITE_EDIT_SECRET, site, password) : "";
		const is_master = (await role_of(request, env, site)) === "master";
		if (!is_master && (!stored || !given || given !== stored)) { return json({ error: "The password was rejected" }, 401); }
		await accounts.claim_site(site, session.id);
		refresh_claims(request, env, session.id, session.hash);
		capture_event(env, ctx, "site_claimed", session.id, { site, email: session.email || "" });
		return json({ ok: true, site, yours: true });
	}
	if (path === "/auth/favorites") {
		// The account's favorite GIFs: GifCities ids the picker hearted, so they're the same on every device
		const session = await session_of(request, env);
		if (!session) { return json({ error: "Sign in first" }, 401); }
		const accounts = accounts_of(env);
		if (request.method === "GET") { return json({ favorites: await accounts.favorites_of(session.id) }); }
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const body = await request.json().catch(() => ({}));
		// `source:id` — any store the picker may grow (a bare GifCities id, from before stores were named, is one)
		const key_of = (/** @type {unknown} */ id) => {
			if (typeof id !== "string") { return ""; }
			const key = /^[A-Z0-9]{20,40}$/.test(id) ? `gifcities:${id}` : id;
			return /^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(key) ? key : "";
		};
		const size = (/** @type {unknown} */ n) => Math.max(0, Math.min(4000, Math.round(Number(n) || 0)));
		/** @type {{ id: string, width: number, height: number, at: number }[]} */
		const add = [];
		for (const item of Array.isArray(body.add) ? body.add.slice(0, 300) : []) {
			const key = item ? key_of(item.id) : "";
			if (!key) { return json({ error: "add: GIFs as source:id, with width and height" }, 400); }
			add.push({ id: key, width: size(item.width), height: size(item.height), at: Math.min(Date.now(), Math.max(0, Math.round(Number(item.at) || 0))) || Date.now() });
		}
		/** @type {string[]} */
		const remove = [];
		for (const id of Array.isArray(body.remove) ? body.remove.slice(0, 300) : []) {
			const key = key_of(id);
			if (!key) { return json({ error: "remove: GIFs as source:id" }, 400); }
			remove.push(key);
		}
		await accounts.update_favorites(session.id, add, remove);
		return json({ favorites: await accounts.favorites_of(session.id) });
	}
	const owner_match = /^\/auth\/sites\/([^/]+)\/owner$/.exec(path);
	if (owner_match) {
		// Support, by hand: whose is this site, and are there several accounts with that email (a sign-in gone wrong)
		if (request.method !== "GET") { return json({ error: "Method not allowed" }, 405); }
		const site = owner_match[1];
		if (!valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
		if ((await role_of(request, env, site)) !== "master") { return json({ error: "Unauthorized: send Authorization: Bearer <master key>" }, 401); }
		const accounts = accounts_of(env);
		const owner_id = await accounts.owner_of(site);
		const owner = owner_id ? await accounts.get_user(owner_id) : null;
		const same_email = owner && owner.email ? await accounts.users_by_email(owner.email) : [];
		return json({ site, owner: owner ? { ...owner, sites: await accounts.sites_of(owner.id) } : null, accounts_with_that_email: await Promise.all(same_email.map(async (user) => ({ ...user, sites: await accounts.sites_of(user.id) }))) });
	}
	const assign_match = /^\/auth\/sites\/([^/]+)\/assign$/.exec(path);
	if (assign_match) {
		// Support, by hand: the master key makes a site (root included) an account's
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const site = assign_match[1];
		if (!valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
		if ((await role_of(request, env, site)) !== "master") { return json({ error: "Unauthorized: send Authorization: Bearer <master key>" }, 401); }
		const body = await request.json().catch(() => ({}));
		const email = String(body.email || "").trim().toLowerCase();
		if (!email) { return json({ error: "email: the account's address (they must have signed in once)" }, 400); }
		const accounts = accounts_of(env);
		const user = await accounts.user_by_email(email);
		if (!user) { return json({ error: "No account with that email has signed in yet" }, 404); }
		await accounts.claim_site(site, user.id);
		return json({ ok: true, site, user: { email: user.email, name: user.name } });
	}
	return json({ error: "Not found" }, 404);
}

export { CLAIMS_COOKIE, SESSION_COOKIE, accounts_of, capture_event, cookie_request_allowed, editor_origin, handle_auth, is_admin, session_of, with_refreshed_claims };
