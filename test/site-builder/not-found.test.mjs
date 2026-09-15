// What a site serves for addresses that aren't files: /about is about.html (clean addresses), a folder's bare address
// goes to its slash, and a site's own 404.html — a page made in Paint like any other — is its not-found page (status
// 404, x-elements rendered, the site's stylesheet); without one, the default 404. Needs both Workers running locally.
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const sites = (process.env.SITE_BUILDER_SITES_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("not-found: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `nf-${Date.now().toString(36)}`;
const headers = { Authorization: `Bearer ${secret}` };
const put = (path, body, type = "text/html") => fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": type }, body });
const get = (path) => fetch(`${sites}/~${site}/${path}`, { redirect: "manual", cache: "no-store" });

await put("about.html", "<html><head><title>About</title></head><body><h1>about me</h1></body></html>");
await put("blog/index.html", "<html><head><title>Blog</title></head><body>posts</body></html>");
await put("blog/first.html", "<html><head><title>First</title></head><body>first post</body></html>");

// Clean addresses
let response = await get("about");
assert.equal(response.status, 200);
assert.match(await response.text(), /about me/);
assert.equal((await get("about.html")).status, 200, "the .html address still works");
response = await get("blog/first");
assert.equal(response.status, 200);
assert.match(await response.text(), /first post/);
response = await get("blog");
assert.equal(response.status, 301, "a folder's bare address goes to its slash (relative addresses inside then resolve right)");
assert.equal(response.headers.get("Location"), `/~${site}/blog/`);
assert.match(await (await get("blog/")).text(), /posts/);

// No page: the default 404
response = await get("nope");
assert.equal(response.status, 404);
assert.match(await response.text(), /under construction/);
assert.equal((await get("nope.html")).status, 404);
assert.equal((await get("gifs/nothing.gif")).status, 404, "a missing file with an extension is just missing");

// The site's own 404 page: status 404, its content, its x-elements rendered, its stylesheet
await put("404.html", '<html><head><title>Lost</title></head><body><h1>you are lost</h1><x-updated label="since ">fallback</x-updated></body></html>');
await put("site.css", "h1 { color: #ff69b4 }", "text/css");
response = await get("nope");
assert.equal(response.status, 404, "a custom 404 page is still a 404");
const body = await response.text();
assert.match(body, /you are lost/);
assert.match(body, /since <i>\d{4}-\d{2}-\d{2}<\/i>/, "x-elements render on it like any page");
assert.match(body, /site\.css/, "the site's stylesheet applies");
assert.equal((await get("deeper/still/missing")).status, 404);
assert.match(await (await get("deeper/still/missing")).text(), /you are lost/);
assert.equal((await get("404.html")).status, 200, "the page itself is just a page");
assert.equal((await get("404")).status, 200, "…at its clean address too");

// Clean up
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }); }
console.log("not-found: ok");
