// GIF usage counters (GifStats Durable Object): POST /api/gifs/used tallies a GifCities GIF per site and overall;
// GET /api/gifs/top lists the most used. Needs the editor Worker: SITE_BUILDER_EDITOR_URL=http://localhost:8787
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
if (!editor) {
	console.log("gif-stats: skipped (set SITE_BUILDER_EDITOR_URL)");
	process.exit(0);
}
const gif = `${"A".repeat(20)}${Date.now().toString(36).toUpperCase()}`;
const site = `stats-${Date.now().toString(36)}`;
const post = (/** @type {object} */ body) => fetch(`${editor}/api/gifs/used`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

assert.equal((await post({ gif, site })).status, 200);
assert.equal((await post({ gif, site })).status, 200);
assert.equal((await post({ gif })).status, 200, "nobody in particular still counts overall");
assert.equal((await post({ gif: "nope" })).status, 400, "only GifCities ids");
assert.equal((await post({ gif, site: "Not A Site!" })).status, 400);

const mine = await (await fetch(`${editor}/api/gifs/top?site=${site}`)).json();
assert.deepEqual(mine.top.map((entry) => [entry.gif, entry.count]), [[gif, 2]], JSON.stringify(mine));
const everyone = await (await fetch(`${editor}/api/gifs/top?limit=1000`)).json();
assert.equal(everyone.site, "");
assert.equal(everyone.top.find((entry) => entry.gif === gif)?.count, 3, "two from the site plus one anonymous");
console.log("gif-stats: ok");
