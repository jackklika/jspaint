// Per-site passwords: the master key mints a random password for a site (POST /api/sites/:name/password); it signs
// in (whoami), lists/writes/deletes that site's files, mints invites and opens its rooms — and nothing on another
// site; the master still does everything. Needs the editor Worker:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SECRET=<master, from worker/editor/.dev.vars>
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const master = process.env.SITE_BUILDER_SECRET;
if (!editor || !master) {
	console.log("site-password: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const stamp = Date.now().toString(36);
const site = `pw-${stamp}`;
const other = `pw-${stamp}-other`;
const page = "<html><head><title>pw</title></head><body>hello</body></html>";
/** @param {string} path @param {RequestInit} [init] @param {string} [token] */
const call = (path, init = {}, token = master) => fetch(`${editor}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
const status = async (/** @type {Promise<Response>} */ p) => (await p).status;

// Minting needs the master
assert.equal(await status(call(`/api/sites/${site}/password`, { method: "POST" }, "")), 401);
assert.equal(await status(call(`/api/sites/${site}/password`, { method: "POST" }, "wrong")), 401);
const minted = await (await call(`/api/sites/${site}/password`, { method: "POST" })).json();
assert.equal(minted.site, site);
assert.equal(minted.rotated, false);
assert.match(minted.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/, minted.password);
const password = minted.password;

// whoami: the password is good for its site only; the master for everything
let who = await (await call(`/api/whoami?site=${site}`, {}, password)).json();
assert.deepEqual([who.ok, who.role, who.site], [true, "site", site]);
assert.equal(await status(call("/api/whoami", {}, password)), 401, "a site password needs ?site=");
assert.equal(await status(call(`/api/whoami?site=${other}`, {}, password)), 401);
who = await (await call("/api/whoami")).json();
assert.deepEqual([who.role, who.site], ["master", null]);
who = await (await call(`/api/whoami?site=${site}`)).json();
assert.equal(who.role, "master");
// typed sloppily: uppercase, no dashes
assert.equal(await status(call(`/api/whoami?site=${site}`, {}, password.toUpperCase())), 200);
assert.equal(await status(call(`/api/whoami?site=${site}`, {}, password.replace(/-/g, ""))), 200);
assert.equal(await status(call(`/api/whoami?site=${site}`, {}, `${password}x`)), 401);

// Files: own site yes, another site no
assert.equal(await status(call(`/api/sites/${site}/files/index.html`, { method: "PUT", body: page, headers: { "Content-Type": "text/html" } }, password)), 200);
assert.equal(await status(call(`/api/sites/${other}/files/index.html`, { method: "PUT", body: page, headers: { "Content-Type": "text/html" } }, password)), 401);
assert.equal(await status(call(`/api/sites/${other}/files`, {}, password)), 401, "no listing another site");
assert.equal(await status(call(`/api/sites/${site}/files`, {}, password)), 200);
assert.equal(await status(call(`/api/sites/${site}/files/index.html`, {}, "")), 200, "reads stay public");

// Invites and rooms
const invite = await (await call(`/api/sites/${site}/rooms/index.html/invite`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }, password)).json();
assert.match(invite.key, /^\d+\.[A-Za-z0-9_-]{16}$/);
assert.equal(await status(call(`/api/sites/${other}/rooms/index.html/invite`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }, password)), 401);
const ws_base = editor.replace(/^http/, "ws");
/** @param {string} url @returns {Promise<boolean>} whether the room accepted the socket */
const opens = (url) => new Promise((resolve) => {
	const ws = new WebSocket(url);
	const done = (/** @type {boolean} */ ok) => { resolve(ok); try { ws.close(); } catch (_error) { /* ignore */ } };
	ws.addEventListener("open", () => done(true));
	ws.addEventListener("error", () => done(false));
	ws.addEventListener("close", () => done(false));
	setTimeout(() => done(false), 8000);
});
assert.equal(await opens(`${ws_base}/api/sites/${site}/rooms/index.html?token=${encodeURIComponent(password)}`), true, "the password opens the site's room");
assert.equal(await opens(`${ws_base}/api/sites/${other}/rooms/index.html?token=${encodeURIComponent(password)}`), false, "but not another site's");
assert.equal(await opens(`${ws_base}/api/sites/${site}/rooms/index.html?token=nope`), false);
assert.equal(await opens(`${ws_base}/api/sites/${site}/rooms/index.html?invite=${invite.key}`), true, "the invite it minted works");
assert.equal(await opens(`${ws_base}/api/sites/${site}/rooms/index.html?token=${encodeURIComponent(master)}`), true);

// A site password can't mint passwords
assert.equal(await status(call(`/api/sites/${site}/password`, { method: "POST" }, password)), 403);
assert.equal(await status(call(`/api/sites/${other}/password`, { method: "POST" }, password)), 401);

// Rotate: the old one dies, the new one works at once
const rotated = await (await call(`/api/sites/${site}/password`, { method: "POST" })).json();
assert.equal(rotated.rotated, true);
assert.notEqual(rotated.password, password);
assert.equal(await status(call(`/api/whoami?site=${site}`, {}, password)), 401);
assert.equal(await status(call(`/api/whoami?site=${site}`, {}, rotated.password)), 200);

// Revoke: the master still works
const removed = await (await call(`/api/sites/${site}/password`, { method: "DELETE" })).json();
assert.deepEqual([removed.ok, removed.removed], [true, true]);
assert.equal(await status(call(`/api/whoami?site=${site}`, {}, rotated.password)), 401);
assert.equal(await status(call(`/api/sites/${site}/files/index.html`, { method: "DELETE" })), 200);
assert.equal((await (await call(`/api/sites/${site}/password`, { method: "DELETE" })).json()).removed, false);
console.log("site-password: ok");
