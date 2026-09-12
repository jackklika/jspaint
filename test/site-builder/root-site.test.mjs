// The root site: coolpaint.world/ serves sites/root/ — pages at /, /about.html; the guestbook posts to /x/guestbook;
// /~root/… redirects to the bare path; ~name sites are untouched. Writes and deletes sites/root/*, so it only runs
// against a local sites Worker. Needs: SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL (localhost), SITE_BUILDER_SECRET.
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const sites = (process.env.SITE_BUILDER_SITES_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("root-site: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(sites).hostname)) {
	console.log("root-site: skipped (it rewrites the root site; local sites Worker only)");
	process.exit(0);
}
const headers = { Authorization: `Bearer ${secret}` };
const marker = `root-${Date.now().toString(36)}`;
/** @param {string} site @param {string} path @param {string} body */
async function put(site, path, body) {
	const response = await fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": "text/html" }, body });
	assert.equal(response.status, 200, `${site}/${path}`);
	return (await response.json()).url;
}
/** @param {string} path @param {RequestInit} [init] */
const get = (path, init = {}) => fetch(`${sites}${path}`, { redirect: "manual", ...init });
/** @param {string} path */
const redirect_of = async (path) => { const r = await get(path); return `${r.status} ${r.headers.get("Location") || ""}`.trim(); };

// Publish: the root site's URLs have no ~, another site's do
assert.equal(await put("root", "index.html", `<html><head><title>${marker}</title></head><body><h1>${marker} home</h1></body></html>`), `${sites}/`);
assert.equal(await put("root", "about.html", `<html><head><title>about</title></head><body><p>${marker} about</p><x-guestbook>Sign</x-guestbook></body></html>`), `${sites}/about.html`);
assert.equal(await put("zz-test", "index.html", `<html><head><title>zz</title></head><body>${marker} zz</body></html>`), `${sites}/~zz-test/`);

// A folder view lists the pages of a folder, newest first, with their titles
await put("root", "posts/first.html", "<html><head><title>First post</title></head><body>one</body></html>");
await new Promise((resolve) => setTimeout(resolve, 1100)); // distinct save times
await put("root", "posts/second.html", "<html><head><title>Second post</title></head><body>two</body></html>");
await put("root", "posts/index.html", '<html><head><title>posts</title></head><body><x-folder path="posts" title="My posts">fallback</x-folder><x-folder path="empty-folder"></x-folder></body></html>');
{
	const listing = await (await get("/posts/")).text();
	assert.match(listing, /<b class="folder-title">My posts<\/b><ul class="folder folder-posts"><li class="folder-item"><a href="\/posts\/second.html">Second post<\/a> <small class="folder-date">\d{4}-\d{2}-\d{2}<\/small><\/li><li class="folder-item"><a href="\/posts\/first.html">First post<\/a>/, "newest first, titles from the pages");
}

// site.json marks a folder as posts: the folder view gets a feed link and <folder>/feed.xml is an RSS feed
{
	const response = await fetch(`${editor}/api/sites/root/files/site.json`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ folders: { posts: { kind: "posts", title: "Root posts" } } }) });
	assert.equal(response.status, 200, "site.json saved");
	assert.equal((await fetch(`${editor}/api/sites/root/files/other.json`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status, 400, "only site.json");
	assert.equal((await fetch(`${editor}/api/sites/root/files/site.json`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: "not json" })).status, 400);
	const listing = await (await get("/posts/")).text();
	assert.match(listing, /<p class="folder-feed"><a href="\/posts\/feed.xml">RSS feed<\/a><\/p>/);
	const feed = await get("/posts/feed.xml");
	assert.equal(feed.status, 200);
	assert.match(feed.headers.get("Content-Type") || "", /application\/rss\+xml/);
	const xml = await feed.text();
	assert.match(xml, /<rss version="2.0"><channel><title>Root posts<\/title>/);
	assert.match(xml, /<item><title>Second post<\/title><link>[^<]*\/posts\/second.html<\/link>[\s\S]*<item><title>First post<\/title>/, "newest first");
	assert.match(xml, /<description>one<\/description>/, "a summary from the page's text");
	assert.equal((await get("/nope/feed.xml")).status, 404, "only posts folders have feeds");
}

// <x-toc> lists a page's sections by their anchors; site.css is linked into every page
await put("root", "toc.html", '<html><head><title>toc</title></head><body><x-toc title="On this page">fallback</x-toc><div class="column"><div class="block section" id="alpha"><h2>Alpha</h2><p>a</p></div><div class="block section" id="beta">Just beta words here</div><div data-kind="section" id="gamma" class="block section"><div class="card" data-card="callout"><p>a nested card first</p></div><h2>Gamma</h2></div></div></body></html>');
{
	const response = await fetch(`${editor}/api/sites/root/files/site.css`, { method: "PUT", headers: { ...headers, "Content-Type": "text/css" }, body: ".toc { color: red; }" });
	assert.equal(response.status, 200, "site.css saved");
	const toc = await (await get("/toc.html")).text();
	assert.match(toc, /<b class="toc-title">On this page<\/b><ul class="toc"><li class="toc-item"><a href="#alpha">Alpha<\/a><\/li><li class="toc-item"><a href="#beta">Just beta words here<\/a><\/li><li class="toc-item"><a href="#gamma">Gamma<\/a><\/li><\/ul>/, "sections in Paint's attribute order, with nested cards, are found too");
	assert.match(toc, /<link rel="stylesheet" href="\/site.css">/, "the site's stylesheet is linked in");
	assert.match(await (await get("/site.css")).text(), /color: red/);
}

// Served at the domain itself, with the sandbox headers
let response = await get("/");
assert.equal(response.status, 200);
assert.match(await response.text(), new RegExp(`${marker} home`));
assert.match(response.headers.get("Content-Security-Policy") || "", /default-src 'none'/);
assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
assert.equal((await get("/", { method: "HEAD" })).status, 200);
response = await get("/about.html");
const about = await response.text();
assert.match(about, /action="\/x\/guestbook"/, "the guestbook posts to the root's /x/");
assert.match(about, /name="back" value="\/about.html"/);
assert.match(await (await get("/~zz-test/")).text(), new RegExp(`${marker} zz`));

// Redirects and 404s
assert.equal(await redirect_of("/~root"), "301 /");
assert.equal(await redirect_of("/~root/"), "301 /");
assert.equal(await redirect_of("/~root/about.html?x=1"), "301 /about.html?x=1");
assert.equal(await redirect_of("/~zz-test"), "301 /~zz-test/");
for (const missing of ["/nope.html", "/~", "/.well-known/x.txt", "/favicon.ico", "/~Bad!/"]) {
	assert.equal((await get(missing)).status, 404, missing);
}

// Signing the root guestbook goes back to the root page; anything else goes home (the honeypot path checks `back` too)
// (Each run signs as a fresh visitor: the guestbook allows a visitor 20 entries a day, and local state persists between runs.)
const visitor_ip = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
const form = (/** @type {Record<string, string>} */ fields) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": visitor_ip }, body: new URLSearchParams(fields).toString() });
response = await get("/x/guestbook", form({ name: "a", message: "hi", back: "/about.html" }));
assert.equal(`${response.status} ${response.headers.get("Location")}`, "303 /about.html#guestbook");
assert.match(await (await get("/about.html")).text(), /<b>a<\/b>/, "the entry shows");
for (const [back, expected] of [["/~zz-test/", "/"], ["//evil.example/", "/"], ["https://evil.example/", "/"], ["/about.html", "/about.html"]]) {
	response = await get("/x/guestbook", form({ website: "x", name: "b", message: "bot", back }));
	assert.equal(`${response.status} ${response.headers.get("Location")}`, `303 ${expected}`, `back=${back}`);
}
response = await get("/~zz-test/x/guestbook", form({ website: "x", name: "b", message: "bot", back: "/~zz-test/about.html" }));
assert.equal(response.headers.get("Location"), "/~zz-test/about.html");

// Old share links on this hostname go to the editor
response = await get("/?join=root/index.html/1.abc");
assert.equal(response.status, 302);
assert.equal(new URL(response.headers.get("Location") || "", sites).search, "?join=root/index.html/1.abc");

// Clean up: the landing page comes back
for (const [site, path] of [["root", "index.html"], ["root", "about.html"], ["root", "posts/first.html"], ["root", "posts/second.html"], ["root", "posts/index.html"], ["root", "site.json"], ["root", "site.css"], ["root", "toc.html"], ["zz-test", "index.html"]]) {
	await fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "DELETE", headers });
}
response = await get("/");
assert.equal(response.status, 200);
assert.match(await response.text(), /Make one/);
assert.equal((await get("/about.html")).status, 404);
console.log("root-site: ok");
