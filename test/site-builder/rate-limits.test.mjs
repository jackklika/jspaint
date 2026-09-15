// The brakes on the public routes (MALICIOUS_ACTOR_PLAN.md phase 0): GIF usage needs to be somebody; a site's presence
// and viewer stats are answered from a short cache; previews render only for the editor; a flood from one address
// gets a plain 429 (when the dev server has the rate-limit bindings). Needs both Workers running locally:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=…
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const sites = (process.env.SITE_BUILDER_SITES_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("rate-limits: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const master = { Authorization: `Bearer ${secret}` };
const site = `rl-${Date.now().toString(36)}`;
const gif = `GIFCITIES${Date.now().toString().padStart(11, "0")}`.slice(0, 20);
/** A fresh address for each flood, so nothing here brakes the other tests (they share "unknown"). */
const fresh_ip = () => `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

try {
	let response = await fetch(`${editor}/api/sites/${site}/files/index.html`, { method: "PUT", headers: { ...master, "Content-Type": "text/html" }, body: `<html><head><title>${site}</title></head><body><p>rl</p></body></html>` });
	assert.equal(response.status, 200, await response.text());

	// GIF usage: a stranger's click counts for nothing; the master (or a session, or a site's password) counts
	response = await fetch(`${editor}/api/gifs/used`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gif, site }) });
	assert.equal(response.status, 401, "nobody in particular");
	response = await fetch(`${editor}/api/gifs/used`, { method: "POST", headers: { ...master, "Content-Type": "application/json" }, body: JSON.stringify({ gif, site }) });
	assert.equal(response.status, 200, await response.text());
	const top = await (await fetch(`${editor}/api/gifs/top?site=${site}`)).json();
	assert.deepEqual(top.top.map((t) => [t.gif, t.count]), [[gif, 1]], "tallied in memory, exact on read");

	// Presence: one fresh answer per site per 10 s
	response = await fetch(`${editor}/api/sites/${site}/presence`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("X-Cache"), "miss");
	assert.equal((await response.json()).editing, 0);
	response = await fetch(`${editor}/api/sites/${site}/presence`);
	assert.equal(response.headers.get("X-Cache"), "hit");

	// Viewer stats: the same, 5 s, and still no-store for the browser
	response = await fetch(`${sites}/~${site}/x/stats.json`);
	assert.equal(response.headers.get("X-Cache"), "miss");
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	response = await fetch(`${sites}/~${site}/x/stats.json`);
	assert.equal(response.headers.get("X-Cache"), "hit");

	// Previews render for the editor, not for any page on the web (and the allowed origin is echoed, not *)
	const preview = (origin) => fetch(`${sites}/~${site}/x/preview`, { method: "POST", headers: { "Content-Type": "text/plain", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ page: "index.html", tag: "x-counter", attrs: {} }) });
	response = await preview("https://evil.example");
	assert.equal(response.status, 403);
	response = await preview(editor);
	const rendered = await response.text();
	assert.equal(response.status, 200, rendered);
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), editor);
	assert.match(JSON.parse(rendered).html, /visitor number/);
	assert.equal((await preview("")).status, 200, "no Origin (not a browser) is fine");

	// A flood of a cached answer from one address costs nothing and brakes nothing: the cache answers
	const flood_ip = fresh_ip();
	const answers = [];
	for (let i = 0; i < 70; i++) { answers.push((await fetch(`${sites}/~${site}/x/stats.json`, { headers: { "CF-Connecting-IP": flood_ip } })).status); }
	assert.ok(answers.every((status) => status === 200), `cached: ${answers.join(",")}`);
	// A flood of an uncached one gets a plain 429 with Retry-After (the published ping: 30 per 10 s per site)
	const ping = [];
	for (let i = 0; i < 40; i++) { ping.push((await fetch(`${sites}/~${site}/x/published`, { method: "POST", headers: { "CF-Connecting-IP": flood_ip } })).status); }
	if (ping.includes(429)) {
		assert.ok(ping.slice(0, 5).every((status) => status === 204), `the first few are fine: ${ping.join(",")}`);
		response = await fetch(`${sites}/~${site}/x/published`, { method: "POST", headers: { "CF-Connecting-IP": flood_ip } });
		assert.equal(response.status, 429);
		assert.equal(response.headers.get("Retry-After"), "10");
		assert.deepEqual(await response.json(), { error: "Slow down a little and try again.", code: "rate-limited", retry_after: 10 });
		console.log("rate-limits: the bindings brake");
	} else {
		console.log("rate-limits: no rate-limit bindings in this dev server (the routes answered without braking)");
	}
	assert.equal((await fetch(`${sites}/~${site}/x/stats.json`)).status, 200, "another address is untouched");
} finally {
	await fetch(`${editor}/api/sites/${site}/files/index.html`, { method: "DELETE", headers: master }).catch(() => {});
}
console.log("rate-limits: ok");
