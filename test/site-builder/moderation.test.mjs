// Moderation (MALICIOUS_ACTOR_PLAN.md phase 2 and the admin's page, 2.5), driven with the master key: outbound links
// carry rel="nofollow ugc noopener" and every page ends with a "report this page" link; the admin's overview lists
// every page by site; a hidden page is a 404 and a disabled site a 451, on the sites host and through the editor's
// public reads, at once; a visitor's report reaches the admin (three a day); share links can be revoked; a room
// gives a second connection claiming a live id a fresh one; a site can be deleted outright. Needs both Workers:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=…
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const sites = (process.env.SITE_BUILDER_SITES_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("moderation: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const master = { Authorization: `Bearer ${secret}` };
const site = `mod-${Date.now().toString(36)}`;
const visitor = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
/** @param {string} path @param {string} body */
const put = async (path, body) => {
	const response = await fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "PUT", headers: { ...master, "Content-Type": "text/html" }, body });
	assert.equal(response.status, 200, `${path}: ${await response.text()}`);
};
/** @param {string} path @param {RequestInit} [init] */
const get = (path, init = {}) => fetch(`${sites}/~${site}/${path}`, { redirect: "manual", ...init, headers: { "CF-Connecting-IP": visitor, ...(init.headers || {}) } });
/** @param {object} body */
const moderate = async (body) => {
	const response = await fetch(`${editor}/api/admin/sites/${site}/moderate`, { method: "POST", headers: { ...master, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text).moderation;
};
const overview = async () => (await fetch(`${editor}/api/admin/overview?fresh=1`, { headers: master })).json();
const page = (/** @type {string} */ body) => `<html><head><title>${site}</title></head><body>${body}</body></html>`;
/** A WebSocket client that can await a message type. @param {string} url */
function connect(url) {
	const ws = new WebSocket(url);
	const queue = [];
	const waiters = [];
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		const index = waiters.findIndex((w) => w.type === message.type);
		if (index !== -1) { waiters.splice(index, 1)[0].resolve(message); } else { queue.push(message); }
	});
	return {
		ws,
		opened: new Promise((resolve) => { ws.addEventListener("open", () => resolve(true)); ws.addEventListener("error", () => resolve(false)); ws.addEventListener("close", () => resolve(false)); }),
		send: (message) => ws.send(JSON.stringify(message)),
		next(type, timeout = 10000) {
			const index = queue.findIndex((m) => m.type === type);
			if (index !== -1) { return Promise.resolve(queue.splice(index, 1)[0]); }
			return new Promise((resolve, reject) => {
				const waiter = { type, resolve };
				waiters.push(waiter);
				setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`timed out waiting for "${type}"`)); }, timeout);
			});
		},
	};
}

try {
	await put("index.html", page(`<h1>home</h1><p><a href="https://example.com/x">out</a> <a href="blog/p.html">in</a> <a href="//cdn.example.org/y" target="_top">scheme-relative</a></p>`));
	await put("blog/p.html", page("<h1>post</h1>"));

	// Served pages: outbound links carry the rel, links within the site don't; every page ends with a report link
	let response = await get("");
	let html = await response.text();
	assert.equal(response.status, 200);
	assert.match(html, /<a href="https:\/\/example\.com\/x" rel="nofollow ugc noopener">out<\/a>/);
	assert.match(html, /<a href="blog\/p\.html">in<\/a>/, "a link within the site is left alone");
	assert.match(html, /<a href="\/\/cdn\.example\.org\/y" rel="nofollow ugc noopener">scheme-relative<\/a>/, "…and target=_top is dropped");
	assert.match(html, new RegExp(`<a href="/~${site}/x/report\\?page=index\\.html"[^>]*>report this page</a>\\s*</p>\\s*</body>`), "the report link sits before </body>");
	// The admin's marker is never a file of the site: not writable, not served, not listed
	assert.equal((await fetch(`${editor}/api/sites/${site}/files/.moderation.json`, { method: "PUT", headers: { ...master, "Content-Type": "application/json" }, body: "{}" })).status, 400);
	assert.equal((await get(".moderation.json")).status, 404);

	// The admin's overview: the site with its pages, no owner (the master key made it); the page itself needs the admin
	assert.equal((await fetch(`${editor}/api/admin/overview`)).status, 401);
	assert.equal((await fetch(`${editor}/admin`)).status, 401, "a stranger is asked to sign in");
	response = await fetch(`${editor}/admin`, { headers: master });
	assert.equal(response.status, 200);
	assert.match(await response.text(), /coolpaint\.world — admin/);
	let data = await overview();
	let mine = data.sites.find((s) => s.name === site);
	assert.ok(mine, "the site is listed");
	assert.deepEqual(mine.pages.map((p) => [p.path, p.hidden]), [["blog/p.html", false], ["index.html", false]]);
	assert.equal(mine.owner, null);
	assert.equal(mine.disabled, false);
	assert.ok(data.totals.sites >= 1 && data.totals.pages >= 2);

	// Hiding a page: a 404 on the sites host and through the editor's public read, at once; the owner still reads it
	let moderation = await moderate({ hide: ["blog/p.html"] });
	assert.deepEqual(moderation.hidden, ["blog/p.html"]);
	assert.equal((await get("blog/p")).status, 404);
	assert.equal((await get("")).status, 200, "the other page is fine");
	assert.equal((await fetch(`${editor}/api/sites/${site}/files/blog/p.html`)).status, 404, "not through the editor's public read either");
	assert.equal((await fetch(`${editor}/api/sites/${site}/files/blog/p.html`, { headers: master })).status, 200, "…except for the owner or the master");
	mine = (await overview()).sites.find((s) => s.name === site);
	assert.deepEqual(mine.pages.map((p) => [p.path, p.hidden]), [["blog/p.html", true], ["index.html", false]]);
	moderation = await moderate({ unhide: ["blog/p.html"] });
	assert.equal(moderation.hidden, undefined);
	assert.equal((await get("blog/p")).status, 200);

	// Taking a site down: every page is a 451, the guestbook form too, and strangers can't read its files; the master still
	// publishes; back up, the next view is fresh
	moderation = await moderate({ disabled: true, reason: "a test takedown" });
	assert.equal(moderation.disabled, true);
	response = await get("");
	assert.equal(response.status, 451);
	assert.match(await response.text(), /This site is unavailable/);
	assert.equal((await get("blog/p")).status, 451);
	assert.equal((await fetch(`${sites}/~${site}/x/guestbook`, { method: "POST", redirect: "manual", headers: { "CF-Connecting-IP": visitor, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "a", message: "hi", back: `/~${site}/` }) })).status, 451);
	assert.equal((await fetch(`${editor}/api/sites/${site}/files/index.html`)).status, 404, "strangers can't read a disabled site's files");
	await put("index.html", page("<h1>home v2</h1>")); // (the master may)
	mine = (await overview()).sites.find((s) => s.name === site);
	assert.equal(mine.disabled, true);
	assert.equal(mine.reason, "a test takedown");
	moderation = await moderate({ disabled: false, reason: null });
	assert.deepEqual([moderation.disabled, moderation.reason], [undefined, undefined]);
	response = await get("");
	assert.equal(response.status, 200);
	assert.match(await response.text(), /home v2/);

	// A visitor reports a page: the form, then the report in the admin's overview; three a day per visitor; the honeypot
	response = await get("x/report?page=index.html");
	assert.equal(response.status, 200);
	html = await response.text();
	assert.match(html, /<textarea name="reason"/);
	assert.match(html, new RegExp(`action="/~${site}/x/report"`));
	const report = (/** @type {Record<string, string>} */ fields) => fetch(`${sites}/~${site}/x/report`, { method: "POST", redirect: "manual", headers: { "CF-Connecting-IP": visitor, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
	response = await report({ page: "index.html", reason: `spam from ${site}` });
	const thanks = await response.text();
	assert.equal(response.status, 200, thanks);
	assert.match(thanks, /Your report was sent/);
	assert.equal((await report({ page: "index.html", reason: "x" })).status, 400, "say a little");
	assert.equal((await report({ page: "index.html", reason: "a bot's report", website: "http://spam" })).status, 200, "the honeypot pretends");
	data = await overview();
	const reports = data.reports.filter((r) => r.site === site);
	assert.deepEqual(reports.map((r) => [r.page, r.reason, r.resolved]), [["index.html", `spam from ${site}`, false]], "one report, not the bot's");
	assert.equal((await report({ page: "blog/p.html", reason: "second report" })).status, 200);
	assert.equal((await report({ page: "blog/p.html", reason: "third report" })).status, 200);
	response = await report({ page: "blog/p.html", reason: "fourth report" });
	assert.equal(response.status, 429, "three a day per visitor");
	assert.match(await response.text(), /reported enough for today/);
	response = await fetch(`${editor}/api/admin/reports/${reports[0].id}/resolve`, { method: "POST", headers: { ...master, "Content-Type": "application/json" }, body: JSON.stringify({ resolved: true }) });
	assert.equal(response.status, 200);
	assert.equal((await overview()).reports.find((r) => r.id === reports[0].id).resolved, true);

	// Share links can be revoked: the guest's key stops working, a new one works
	const ws_base = editor.replace(/^http/, "ws");
	const invite = async () => (await (await fetch(`${editor}/api/sites/${site}/rooms/index.html/invite`, { method: "POST", headers: { ...master, "Content-Type": "application/json" }, body: JSON.stringify({ days: 1 }) })).json()).key;
	const key = await invite();
	let guest = connect(`${ws_base}/api/sites/${site}/rooms/index.html?invite=${encodeURIComponent(key)}`);
	assert.equal(await guest.opened, true, "the key opens the room");
	guest.ws.close(1000, "done");
	response = await fetch(`${editor}/api/sites/${site}/rooms/index.html/invite/revoke`, { method: "POST", headers: master });
	assert.deepEqual(await response.json(), { site, page: "index.html", revoked: true });
	guest = connect(`${ws_base}/api/sites/${site}/rooms/index.html?invite=${encodeURIComponent(key)}`);
	assert.equal(await guest.opened, false, "the old key is dead");
	const fresh_key = await invite();
	assert.notEqual(fresh_key, key);
	guest = connect(`${ws_base}/api/sites/${site}/rooms/index.html?invite=${encodeURIComponent(fresh_key)}`);
	assert.equal(await guest.opened, true, "a new key works");
	guest.ws.close(1000, "done");

	// A second connection claiming a live id gets a fresh one (no spoofing a member's cursor or locks)
	const room = `${ws_base}/api/sites/${site}/rooms/index.html?token=${encodeURIComponent(secret)}`;
	const a = connect(room);
	assert.equal(await a.opened, true);
	a.send({ type: "hello", client_id: "dup-id", name: "A" });
	assert.equal((await a.next("snapshot")).you.client_id, "dup-id");
	const b = connect(room);
	assert.equal(await b.opened, true);
	b.send({ type: "hello", client_id: "dup-id", name: "B" });
	const you = (await b.next("snapshot")).you;
	assert.notEqual(you.client_id, "dup-id", "B got a fresh id");
	assert.equal((await a.next("join")).client.client_id, you.client_id, "A sees B under the fresh id");
	a.ws.close(1000, "done");
	b.ws.close(1000, "done");

	// Deleting the site: gone from the bucket, the overview, and the sites host
	response = await fetch(`${editor}/api/admin/sites/${site}`, { method: "DELETE", headers: master });
	const deleted = await response.json();
	assert.equal(response.status, 200, JSON.stringify(deleted));
	assert.ok(deleted.deleted >= 2, `objects deleted: ${deleted.deleted}`);
	assert.equal((await overview()).sites.some((s) => s.name === site), false);
	assert.equal((await get("")).status, 404);
	assert.deepEqual((await (await fetch(`${editor}/api/sites/${site}/usage?recount`, { headers: master })).json()).files, 0);
} finally {
	await fetch(`${editor}/api/admin/sites/${site}`, { method: "DELETE", headers: master }).catch(() => {});
}
console.log("moderation: ok");
