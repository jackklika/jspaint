// Sign in with Google (worker/editor/auth.js), against a fake Google this test runs on :8790 (the editor's .dev.vars
// point GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_USERINFO_URL at it): the state cookie, the callback, the session
// cookie, whoami with an account, taking a new site, claiming one that has a password, cookie requests from another
// site being refused, and signing out. Needs the editor Worker:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SECRET=<master, from worker/editor/.dev.vars>
import { createServer } from "node:http";
import { assert, click_menu_item, open_paint } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const master = process.env.SITE_BUILDER_SECRET;
if (!editor || !master) {
	console.log("google-auth: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const stamp = Date.now().toString(36);

// The fake Google: any code buys a token; the token names whoever the test says
let person = { sub: `sub-${stamp}`, email: `jack-${stamp}@example.com`, email_verified: true, name: "Jack Test" };
const fake = createServer((request, response) => {
	const url = new URL(request.url || "/", "http://localhost:8790");
	if (url.pathname === "/token" && request.method === "POST") {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const params = new URLSearchParams(body);
			const ok = params.get("client_id") === "test-client" && params.get("client_secret") === "test-secret" && params.get("grant_type") === "authorization_code" && params.get("code") === "good-code";
			response.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
			response.end(JSON.stringify(ok ? { access_token: `token-${stamp}`, token_type: "Bearer" } : { error: "invalid_grant" }));
		});
		return;
	}
	if (url.pathname === "/auth") {
		// Google's sign-in page, in a hurry: straight back to the app with a code
		const back = new URL(url.searchParams.get("redirect_uri") || "");
		back.searchParams.set("code", "good-code");
		back.searchParams.set("state", url.searchParams.get("state") || "");
		response.writeHead(302, { Location: back.href });
		response.end();
		return;
	}
	if (url.pathname === "/userinfo") {
		const ok = request.headers.authorization === `Bearer token-${stamp}`;
		response.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
		response.end(JSON.stringify(ok ? person : { error: "bad token" }));
		return;
	}
	response.writeHead(404);
	response.end();
});
await new Promise((resolve) => { fake.listen(8790, resolve); });

/** @param {Response} response @param {string} name */
const cookie_from = (response, name) => {
	for (const line of response.headers.getSetCookie()) {
		const [pair, ...attrs] = line.split(";");
		const [key, ...rest] = pair.split("=");
		if (key === name) { return { value: decodeURIComponent(rest.join("=")), attrs: attrs.map((a) => a.trim()) }; }
	}
	return null;
};
/** @param {string} path @param {RequestInit} init @param {Record<string, string>} [cookies] */
const call = (path, init = {}, cookies = {}) => fetch(`${editor}${path}`, {
	...init,
	redirect: "manual",
	headers: { ...(init.headers || {}), ...(Object.keys(cookies).length ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") } : {}), "Sec-Fetch-Site": "same-origin" },
});

try {
	// The editor says which ways in it has
	assert.deepEqual(await (await call("/auth/methods")).json(), { google: true, password: true });

	// Start: off to Google with our client id, the callback address, and a state kept in a cookie
	let response = await call(`/auth/google?next=${encodeURIComponent("/?signed_in=1")}`);
	assert.equal(response.status, 302);
	const to = new URL(response.headers.get("Location") || "");
	assert.equal(`${to.origin}${to.pathname}`, "http://localhost:8790/auth");
	assert.equal(to.searchParams.get("client_id"), "test-client");
	assert.equal(to.searchParams.get("redirect_uri"), `${editor}/auth/google/callback`);
	assert.equal(to.searchParams.get("scope"), "openid email profile");
	const state = to.searchParams.get("state") || "";
	assert.match(state, /^[0-9a-f]{32}$/);
	const state_cookie = cookie_from(response, "coolpaint_auth_state");
	assert.ok(state_cookie && state_cookie.value === `${state}|/?signed_in=1`, JSON.stringify(state_cookie));
	assert.ok(state_cookie.attrs.includes("HttpOnly") && state_cookie.attrs.includes("SameSite=Lax"));

	// Back from Google: the state must match; a good code becomes a session cookie and a hop to `next`
	response = await call(`/auth/google/callback?code=good-code&state=wrong`, {}, { coolpaint_auth_state: state_cookie.value });
	assert.equal(response.status, 400, "a state that isn't ours");
	response = await call(`/auth/google/callback?code=bad-code&state=${state}`, {}, { coolpaint_auth_state: state_cookie.value });
	assert.equal(response.status, 502, "a code Google refuses");
	response = await call(`/auth/google/callback?code=good-code&state=${state}`, {}, { coolpaint_auth_state: state_cookie.value });
	assert.equal(response.status, 302, await response.text());
	assert.equal(response.headers.get("Location"), "/?signed_in=1");
	const session = cookie_from(response, "coolpaint_session");
	assert.ok(session && /^[0-9a-f]{64}$/.test(session.value), "a session cookie");
	assert.ok(session.attrs.includes("HttpOnly") && session.attrs.includes("SameSite=Lax") && session.attrs.some((a) => /^Max-Age=7776000$/.test(a)), JSON.stringify(session.attrs));
	assert.equal(cookie_from(response, "coolpaint_auth_state")?.attrs.some((a) => a === "Max-Age=0"), true, "the state cookie is cleared");
	const cookies = { coolpaint_session: session.value };

	// whoami with the cookie: an account, no sites yet, and no role on any site
	let me = await (await call("/api/whoami", {}, cookies)).json();
	assert.equal(me.role, "user");
	assert.deepEqual(me.user, { id: me.user.id, email: person.email, name: "Jack Test" });
	assert.deepEqual(me.sites, []);
	assert.match(me.user.id, /^[0-9a-f]{24}$/);
	const user_id = me.user.id;
	const my_email = person.email; // (the fake's `person` changes later, for the other-account cases)
	const site = `g-${stamp}`;
	assert.equal((await call(`/api/whoami?site=${site}`, {}, cookies)).status, 200);
	assert.equal((await (await call(`/api/whoami?site=${site}`, {}, cookies)).json()).role, "user", "not this site's owner (yet)");

	// Taking a site: a free name is yours; then the cookie edits it like the site's password would
	response = await call("/auth/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Bad Name!" }) }, cookies);
	assert.equal(response.status, 400);
	response = await call("/auth/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "root" }) }, cookies);
	assert.equal(response.status, 403, "root belongs to the master");
	response = await call("/auth/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: site }) });
	assert.equal(response.status, 401, "no session, no site");
	response = await call("/auth/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: site }) }, cookies);
	assert.deepEqual(await response.json(), { ok: true, site, yours: true });
	me = await (await call(`/api/whoami?site=${site}`, {}, cookies)).json();
	assert.equal(me.role, "site");
	assert.deepEqual(me.sites, [site]);
	const page = "<html><head><title>g</title></head><body>hello</body></html>";
	response = await call(`/api/sites/${site}/files/index.html`, { method: "PUT", headers: { "Content-Type": "text/html" }, body: page }, cookies);
	assert.equal(response.status, 200, await response.text());
	assert.equal((await call(`/api/sites/${site}/files`, {}, cookies)).status, 200, "listing");
	// …but not someone else's site, and not from another website (a cross-site request with the cookie)
	assert.equal((await call(`/api/sites/${site}-not-mine/files/index.html`, { method: "PUT", headers: { "Content-Type": "text/html" }, body: page }, cookies)).status, 401);
	response = await fetch(`${editor}/api/sites/${site}/files/index.html`, { method: "PUT", headers: { "Content-Type": "text/html", Cookie: `coolpaint_session=${session.value}`, "Sec-Fetch-Site": "cross-site" }, body: page });
	assert.equal(response.status, 401, "a cross-site request can't act with the cookie");
	// The owner may give the site a password (the master could already)
	response = await call(`/api/sites/${site}/password`, { method: "POST" }, cookies);
	const own_password = await response.json();
	assert.equal(response.status, 200, JSON.stringify(own_password));
	assert.match(own_password.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);

	// Claiming a site that has a password (made by the master, as they all were before accounts): the password proves it
	const older = `g-${stamp}-old`;
	const minted = await (await fetch(`${editor}/api/sites/${older}/password`, { method: "POST", headers: { Authorization: `Bearer ${master}` } })).json();
	response = await call("/auth/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: older }) }, cookies);
	assert.equal(response.status, 409, "it has a password: not free");
	assert.equal((await response.json()).claimable, true);
	response = await call(`/auth/sites/${older}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "nope-nope-nope-nope" }) }, cookies);
	assert.equal(response.status, 401);
	response = await call(`/auth/sites/${older}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: minted.password }) }, cookies);
	assert.deepEqual(await response.json(), { ok: true, site: older, yours: true });
	me = await (await call(`/api/whoami?site=${older}`, {}, cookies)).json();
	assert.equal(me.role, "site");
	assert.deepEqual(me.sites, [site, older]);

	// The same Google account again: the same user; another Google account with the same verified email: also the same user
	const again = async () => {
		const start = await call("/auth/google");
		const s = new URL(start.headers.get("Location") || "").searchParams.get("state");
		const back = await call(`/auth/google/callback?code=good-code&state=${s}`, {}, { coolpaint_auth_state: cookie_from(start, "coolpaint_auth_state")?.value || "" });
		return { coolpaint_session: cookie_from(back, "coolpaint_session")?.value || "" };
	};
	assert.equal((await (await call("/api/whoami", {}, await again())).json()).user.id, user_id);
	person = { ...person, sub: `sub-${stamp}-other-device` };
	assert.equal((await (await call("/api/whoami", {}, await again())).json()).user.id, user_id, "joined by email");
	person = { ...person, sub: `sub-${stamp}-stranger`, email: `stranger-${stamp}@example.com` };
	assert.notEqual((await (await call("/api/whoami", {}, await again())).json()).user.id, user_id, "a different person");
	person = { ...person, email_verified: false };
	const start = await call("/auth/google");
	const unverified = await call(`/auth/google/callback?code=good-code&state=${new URL(start.headers.get("Location") || "").searchParams.get("state")}`, {}, { coolpaint_auth_state: cookie_from(start, "coolpaint_auth_state")?.value || "" });
	assert.equal(unverified.status, 403, "an unverified email doesn't get in");

	// The master hands a site to an account by email (support, by hand); root too
	const handed = `g-${stamp}-handed`;
	response = await fetch(`${editor}/auth/sites/${handed}/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: my_email }) });
	assert.equal(response.status, 401, "the master key only");
	response = await fetch(`${editor}/auth/sites/${handed}/assign`, { method: "POST", headers: { Authorization: `Bearer ${master}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: `nobody-${stamp}@example.com` }) });
	assert.equal(response.status, 404, "an account that never signed in");
	response = await fetch(`${editor}/auth/sites/${handed}/assign`, { method: "POST", headers: { Authorization: `Bearer ${master}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: my_email.toUpperCase() }) });
	assert.deepEqual(await response.json(), { ok: true, site: handed, user: { email: my_email, name: "Jack Test" } });
	assert.equal((await (await call(`/api/whoami?site=${handed}`, {}, cookies)).json()).role, "site", "…and now the account edits it");
	const sites_to_clean = [site, older, handed];

	// Signing out ends the session
	response = await call("/auth/sign-out", { method: "POST" }, cookies);
	assert.equal(response.status, 200);
	assert.equal(cookie_from(response, "coolpaint_session")?.attrs.includes("Max-Age=0"), true);
	assert.equal((await call("/api/whoami", {}, cookies)).status, 401, "the old cookie is dead");

	// In the browser, from Paint at the editor: the Sign In dialog's Google button, the round trip, no site yet → pick a
	// name → My Site opens for it, signed in as the account
	person = { sub: `sub-${stamp}-browser`, email: `browser-${stamp}@example.com`, email_verified: true, name: "Browser Jack" };
	const { page: paint, close } = await open_paint({ url: `${editor}/` });
	await click_menu_item(paint, "Sign In to My Site...");
	await paint.waitForSelector(".my-site-sign-in .google-sign-in", { timeout: 10000 });
	assert.match(await paint.getAttribute(".my-site-sign-in .google-sign-in", "href") || "", /\/auth\/google\?next=/);
	await paint.click(".my-site-sign-in .google-sign-in");
	await paint.waitForSelector(".my-site-sign-in-account", { timeout: 20000 }); // back, with an account and no site
	assert.match(await paint.$eval(".my-site-sign-in-account .my-site-account", (el) => el.textContent), new RegExp(`browser-${stamp}@example.com`));
	const browser_site = `g-${stamp}-ui`;
	await paint.fill('.my-site-sign-in-account input[name="new-site-name"]', browser_site);
	await paint.click(".my-site-sign-in-account button[type=submit]");
	await paint.waitForSelector(".my-site-window .my-site-facts", { timeout: 20000 });
	assert.match(await paint.$eval(".my-site-window .my-site-facts", (el) => el.textContent), new RegExp(`Signed in:browser-${stamp}@example.com \\(Google\\)`));
	assert.deepEqual(await paint.evaluate(() => { const s = JSON.parse(localStorage.getItem("jspaint site publish settings")); return [s.site, s.secret, s.account.sites]; }), [browser_site, "", [browser_site]]);
	await close();
	sites_to_clean.push(browser_site);

	// Clean up (the master)
	for (const name of sites_to_clean) {
		const listing = await (await fetch(`${editor}/api/sites/${name}/files`, { headers: { Authorization: `Bearer ${master}` } })).json();
		for (const file of listing.files) { await fetch(`${editor}/api/sites/${name}/files/${file.path}`, { method: "DELETE", headers: { Authorization: `Bearer ${master}` } }); }
		await fetch(`${editor}/api/sites/${name}/password`, { method: "DELETE", headers: { Authorization: `Bearer ${master}` } });
	}
	console.log("google-auth: ok");
} finally {
	fake.close();
}
