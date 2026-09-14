// Page addresses on the editor host open that page in Paint: /~name[/page] and, for the root site, /page — the Worker
// answers with a redirect to /?site=&page=. Paint's own files are untouched.
// Needs the editor Worker: SITE_BUILDER_EDITOR_URL=http://localhost:8787
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
if (!editor) {
	console.log("edit-entry: skipped (set SITE_BUILDER_EDITOR_URL)");
	process.exit(0);
}
/** @param {string} path */
async function entry(path) {
	const response = await fetch(`${editor}${path}`, { redirect: "manual" });
	return `${response.status} ${response.headers.get("Location") || ""}`.trim();
}
assert.equal(await entry("/~jack"), "302 /?site=jack");
assert.equal(await entry("/~jack/"), "302 /?site=jack");
assert.equal(await entry("/~jack/about.html"), "302 /?site=jack&page=about.html");
assert.equal(await entry("/~jack/blog/"), "302 /?site=jack&page=blog%2Findex.html"); // cspell:disable-line
assert.equal(await entry("/~jack/gifs/x.gif"), "302 /?site=jack", "not a page: just the site");
assert.equal(await entry("/~root"), "302 /?site=root");
assert.equal(await entry("/~jack/about"), "302 /?site=jack&page=about.html", ".html is optional");
assert.equal(await entry("/~Jack!"), "404");
// The root site's pages mirror coolpaint.world/…
assert.equal(await entry("/about"), "302 /?site=root&page=about.html");
assert.equal(await entry("/about.html"), "302 /?site=root&page=about.html");
assert.equal(await entry("/blog/post"), "302 /?site=root&page=blog%2Fpost.html"); // cspell:disable-line
assert.equal(await entry("/blog/"), "302 /?site=root&page=blog%2Findex.html"); // cspell:disable-line
// Paint's own files still come from the app
for (const asset of ["/", "/favicon.ico", "/src/app.js", "/images/icons/512x512.png", "/manifest.webmanifest"]) {
	assert.equal(await entry(asset), "200", asset);
}
assert.equal(await entry("/index.html"), "307 /", "the assets' own canonical redirect, untouched");
assert.equal(await entry("/privacy.html"), "302 /?site=root&page=privacy.html", "jspaint's own about/privacy pages give way to the site's");
assert.equal(await entry("/new"), "302 /?new=1", "a new site's first page, not a root page called new");
assert.equal(await entry("/new/"), "302 /?new=1");
assert.equal(await entry("/nope.png"), "404", "not a page, not a file");
console.log("edit-entry: ok");
