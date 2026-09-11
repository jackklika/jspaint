// Versions: writing over a page keeps the old copy (and its picture); the editor can list and restore them; the
// sites Worker never serves versions/. Needs: SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET.
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const sites = (process.env.SITE_BUILDER_SITES_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("versions: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `ver-${Date.now().toString(36)}`;
const headers = { Authorization: `Bearer ${secret}` };
/** @param {string} path @param {BodyInit} body @param {string} type */
const put = async (path, body, type) => {
	const response = await fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": type }, body });
	assert.equal(response.status, 200, `put ${path}`);
};
// Two tiny PNGs that differ (a 1×1 white and a 1×1 black), hashed the way Paint hashes bitmaps (SHA-1, 12 hex)
const png = (/** @type {string} */ base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const white = png("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=");
const black = png("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
const hash12 = async (/** @type {Uint8Array} */ bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
const page_html = (/** @type {string} */ text, /** @type {string} */ v) => `<html><head><title>${text}</title></head><body><div class="collage"><img class="bitmap" src="collages/index.png?v=${v}"><p>${text}</p></div></body></html>`;

// Save 1 (white picture), then save 2 (black picture) over it
await put("collages/index.png", white, "image/png");
await put("index.html", page_html("first", await hash12(white)), "text/html");
await new Promise((resolve) => setTimeout(resolve, 1100));
await put("collages/index.png", black, "image/png");
await put("index.html", page_html("second", await hash12(black)), "text/html");
assert.match(await (await fetch(`${sites}/~${site}/`)).text(), /second/);

// The first save is a version now; versions/ is private on the sites host; guests can't touch versions
const listing = await (await fetch(`${editor}/api/sites/${site}/versions?page=index.html`, { headers })).json();
assert.equal(listing.versions.length, 1, JSON.stringify(listing));
assert.match(listing.versions[0].version, /^\d{4}-\d{2}-\d{2}T/);
assert.equal((await fetch(`${sites}/~${site}/versions/${listing.versions[0].version}/index.html`)).status, 404);
assert.equal((await fetch(`${editor}/api/sites/${site}/versions?page=index.html`)).status, 401);

// Restore: the page and its picture come back; the "second" save becomes a version itself
const restored = await (await fetch(`${editor}/api/sites/${site}/versions/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ page: "index.html", version: listing.versions[0].version }) })).json();
assert.deepEqual([restored.ok, restored.bitmap_restored], [true, true], JSON.stringify(restored));
assert.match(await (await fetch(`${sites}/~${site}/`)).text(), /first/);
assert.deepEqual(new Uint8Array(await (await fetch(`${sites}/~${site}/collages/index.png`)).arrayBuffer()), white, "the white picture is back");
const after = await (await fetch(`${editor}/api/sites/${site}/versions?page=index.html`, { headers })).json();
assert.equal(after.versions.length, 2, "the second save was kept as a version");
assert.equal((await fetch(`${editor}/api/sites/${site}/versions/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ page: "index.html", version: "1999-01-01T00-00-00-000Z" }) })).status, 404);

// Clean up (versions included: the listing shows them)
const all = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of all.files) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }); }
console.log("versions: ok");
