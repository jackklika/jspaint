// Quotas (MALICIOUS_ACTOR_PLAN.md phase 1): a site holds so many bytes and files, archives included; the master sets
// a site's limits; a write over the line is a plain 413 with code "quota"; usage follows every write and delete and
// the owner can read it (My Site's storage line); a burst of page writes gets a 429 (20 per 10 s per site). Needs the
// editor Worker running locally: SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SECRET=…
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !secret) {
	console.log("quota: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const master = { Authorization: `Bearer ${secret}` };
const site = `quota-${Date.now().toString(36)}`;
const page = (/** @type {string} */ text, pad = 0) => `<html><head><title>${site}</title></head><body><p>${text}</p>${"<!-- x -->".repeat(pad)}</body></html>`;
/** @param {string} path @param {string} body @param {Record<string, string>} [headers] */
const put = (path, body, headers = master) => fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": "text/html" }, body });
const usage = async () => (await fetch(`${editor}/api/sites/${site}/usage`, { headers: master })).json();
/** The recount after a write runs off the response; wait for it. @param {(u: any) => boolean} is_it */
const settled = async (is_it) => {
	for (let i = 0; i < 40; i++) {
		const u = await usage();
		if (is_it(u)) { return u; }
		await new Promise((r) => setTimeout(r, 100));
	}
	return usage();
};

try {
	// Defaults, then the master sets a small quota for this site; nobody else may
	let response = await fetch(`${editor}/api/sites/${site}/usage`);
	assert.equal(response.status, 401, "the owner or the master reads usage");
	let u = await usage();
	assert.deepEqual(u, { site, bytes: 0, files: 0, limit_bytes: 200 * 1024 * 1024, limit_files: 1000 }, JSON.stringify(u));
	response = await fetch(`${editor}/api/sites/${site}/quota`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bytes: 100 }) });
	assert.equal(response.status, 401);
	response = await fetch(`${editor}/api/sites/${site}/quota`, { method: "POST", headers: { ...master, "Content-Type": "application/json" }, body: JSON.stringify({ bytes: 4000, files: 3 }) });
	u = await response.json();
	assert.deepEqual([u.limit_bytes, u.limit_files], [4000, 3], JSON.stringify(u));

	// Writes count; a write past the files limit is refused with a plain sentence and a code
	assert.equal((await put("index.html", page("home"))).status, 200);
	assert.equal((await put("a.html", page("a"))).status, 200);
	assert.equal((await put("b.html", page("b"))).status, 200);
	u = await settled((u) => u.files === 3);
	assert.equal(u.files, 3);
	assert.ok(u.bytes > 0 && u.bytes < 1000, JSON.stringify(u));
	response = await put("c.html", page("c"));
	assert.equal(response.status, 413);
	const refusal = await response.json();
	assert.equal(refusal.code, "quota");
	assert.match(refusal.error, /^This site is full \(0 MB, 3 files\)\. Delete something in My Site to make room\.$/);
	assert.deepEqual([refusal.usage.limit_bytes, refusal.usage.limit_files], [4000, 3]);
	// Writing over a file you have is fine (it replaces, though the archive of the old copy counts too)
	assert.equal((await put("a.html", page("a2"))).status, 200);
	u = await settled((u) => u.files === 4); // (a.html, b.html, index.html, and the archived a.html)
	assert.equal(u.files, 4, JSON.stringify(u));

	// A delete makes room
	assert.equal((await fetch(`${editor}/api/sites/${site}/files/b.html`, { method: "DELETE", headers: master })).status, 200);
	u = await settled((u) => u.files === 3);
	assert.equal(u.files, 3);
	// …but not past the bytes limit (room for files now): one big page is over, a smaller one fits
	response = await fetch(`${editor}/api/sites/${site}/quota`, { method: "POST", headers: { ...master, "Content-Type": "application/json" }, body: JSON.stringify({ bytes: 4000, files: 10 }) });
	assert.equal((await response.json()).limit_files, 10);
	response = await put("big.html", page("big", 500));
	assert.equal(response.status, 413, "over 4000 bytes");
	assert.equal((await response.json()).code, "quota");
	assert.equal((await put("c.html", page("c"))).status, 200, "the small one fits");
	u = await settled((u) => u.files === 4);
	assert.ok(u.bytes < 4000, JSON.stringify(u));
	// ?recount lists the bucket and agrees
	const counted = await (await fetch(`${editor}/api/sites/${site}/usage?recount`, { headers: master })).json();
	assert.deepEqual([counted.bytes, counted.files], [u.bytes, u.files], `${JSON.stringify(counted)} vs ${JSON.stringify(u)}`);
	// Back to the defaults
	response = await fetch(`${editor}/api/sites/${site}/quota`, { method: "POST", headers: { ...master, "Content-Type": "application/json" }, body: JSON.stringify({ bytes: null, files: null }) });
	assert.equal((await response.json()).limit_files, 1000);

	// A burst of page writes: the twenty-first within 10 s is a plain 429 (when the dev server has the bindings)
	const answers = [];
	for (let i = 0; i < 25; i++) { answers.push((await put("index.html", page(`home ${i}`))).status); }
	if (answers.includes(429)) {
		assert.ok(answers.slice(0, 10).every((status) => status === 200), `the first are fine: ${answers.join(",")}`);
		response = await put("index.html", page("once more"));
		assert.equal(response.status, 429);
		assert.equal((await response.json()).code, "rate-limited");
		console.log("quota: the publish brake bites");
	} else {
		console.log("quota: no rate-limit bindings in this dev server");
	}
} finally {
	const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers: master })).json().catch(() => ({ files: [] }));
	for (const file of listing.files || []) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers: master }).catch(() => {}); }
}
console.log("quota: ok");
