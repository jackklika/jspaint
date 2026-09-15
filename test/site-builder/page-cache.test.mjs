// Served pages are cached under the site's generation (sites/index.js): the first view of a page renders it, the next
// is a cache hit with no R2 read; the visitor counter still ticks on every view (its slot is filled per view); a
// publish, a delete, and a guestbook signing each bump the generation, so the very next view is fresh; HEAD and a
// 404 page don't count; the visitor's own headers stay no-cache. Needs both Workers running locally:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=…
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const sites = (process.env.SITE_BUILDER_SITES_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("page-cache: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const headers = { Authorization: `Bearer ${secret}` };
const site = `cache-${Date.now().toString(36)}`;
const visitor = `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // (a fresh visitor for the guestbook's cooldown)
/** @param {string} path @param {string} body */
async function put(path, body) {
	const response = await fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": "text/html" }, body });
	assert.equal(response.status, 200, `${path}: ${await response.text()}`);
}
/** @param {string} path @param {RequestInit} [init] */
const get = (path, init = {}) => fetch(`${sites}/~${site}/${path}`, { redirect: "manual", ...init, headers: { "CF-Connecting-IP": visitor, ...(init.headers || {}) } });
/** The counter's digits in a served page. @param {string} html */
const counter_of = (html) => {
	const slot = /<span data-x-counter="(\d+)">([\s\S]*?)<\/span><\/span>/.exec(html);
	return slot ? [...`${slot[2]}</span>`.matchAll(/>([0-9?])<\/span>/g)].map((m) => m[1]).join("") : null; // (the last digit's </span> is the pair's first)
};
const page = (/** @type {string} */ body) => `<html><head><title>${site}</title></head><body>${body}</body></html>`;

try {
	await put("index.html", page(`<h1>home v1</h1><p>You are visitor <x-counter digits="4">?</x-counter></p><x-folder path="blog">…</x-folder><x-guestbook>…</x-guestbook>`));
	await put("blog/first.html", page("<h1>first post</h1>"));

	// First view: rendered (a miss); the counter counts it; the folder lists the post; visitors get no-cache headers
	let response = await get("");
	let html = await response.text();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("X-Cache"), "miss");
	assert.equal(response.headers.get("Cache-Control"), "no-cache, no-transform", "the visitor's browser still revalidates");
	assert.match(html, /home v1/);
	assert.match(html, /first\.html/, "the folder lists the post");
	assert.equal(counter_of(html), "0001");
	// Second view: from the cache, and the counter still ticks
	response = await get("");
	html = await response.text();
	assert.equal(response.headers.get("X-Cache"), "hit");
	assert.equal(counter_of(html), "0002");
	// Every address of the page shares the cached copy
	response = await get("index.html");
	assert.equal(response.headers.get("X-Cache"), "hit");
	assert.equal(counter_of(await response.text()), "0003");
	// HEAD: headers only, and not a visit
	response = await get("", { method: "HEAD" });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "");
	assert.equal(counter_of(await (await get("")).text()), "0004", "HEAD didn't count");

	// A publish anywhere in the site bumps its generation: the next view is fresh (the folder shows the new post)
	await put("blog/second.html", page("<h1>second post</h1>"));
	response = await get("");
	html = await response.text();
	assert.equal(response.headers.get("X-Cache"), "miss", "a new page remade the home page");
	assert.match(html, /second\.html/);
	assert.equal(counter_of(html), "0005", "the count survived");
	assert.equal((await get("")).headers.get("X-Cache"), "hit");

	// Signing the guestbook bumps it too: the entry shows on the very next view
	response = await fetch(`${sites}/~${site}/x/guestbook`, { method: "POST", redirect: "manual", headers: { "CF-Connecting-IP": visitor, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "Cid", message: `hello from ${site}`, back: `/~${site}/` }) });
	assert.equal(response.status, 303, await response.text());
	response = await get("");
	html = await response.text();
	assert.equal(response.headers.get("X-Cache"), "miss");
	assert.match(html, new RegExp(`hello from ${site}`));

	// Publishing the page itself: new content at once
	await put("index.html", page(`<h1>home v2</h1><x-counter digits="4">?</x-counter>`));
	response = await get("");
	html = await response.text();
	assert.equal(response.headers.get("X-Cache"), "miss");
	assert.match(html, /home v2/);
	assert.equal(counter_of(html), "0008", "the counter kept counting across versions");

	// The site's own 404 page is cached like any page, and a 404 isn't a visit: its counter shows the same number twice
	await put("404.html", page(`<h1>lost</h1><x-counter digits="3">?</x-counter>`));
	response = await get("nowhere");
	html = await response.text();
	assert.equal(response.status, 404);
	assert.equal(response.headers.get("X-Cache"), "miss");
	assert.match(html, /lost/);
	const lost_count = counter_of(html);
	response = await get("elsewhere");
	assert.equal(response.status, 404);
	assert.equal(response.headers.get("X-Cache"), "hit", "one cached copy serves every missing address");
	assert.equal(counter_of(await response.text()), lost_count, "a 404 doesn't count");

	// Deleting the page: the next view is the 404 page, not the cached page
	response = await fetch(`${editor}/api/sites/${site}/files/index.html`, { method: "DELETE", headers });
	assert.equal(response.status, 200);
	response = await get("");
	assert.equal(response.status, 404, "the deleted page is gone at once");
} finally {
	for (const path of ["index.html", "blog/first.html", "blog/second.html", "404.html"]) {
		await fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "DELETE", headers }).catch(() => {});
	}
	const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json().catch(() => ({ files: [] }));
	for (const file of listing.files || []) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }).catch(() => {}); }
}
console.log("page-cache: ok");
