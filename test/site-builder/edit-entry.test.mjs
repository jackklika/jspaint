// edit.<domain>/~name[/page] is an entry point into Paint: the editor Worker answers with a redirect to /?site=&page=.
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
assert.equal(await entry("/~Jack!"), "404");
console.log("edit-entry: ok");
