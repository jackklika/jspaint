// GIF usage counters (GifStats Durable Object): POST /api/gifs/used tallies a GifCities GIF per site and overall;
// GET /api/gifs/top lists the most used. Somebody has to be behind a click (a session, a site's password, the master
// key): a stranger's counts for nothing. Needs the editor Worker: SITE_BUILDER_EDITOR_URL=http://localhost:8787 and
// SITE_BUILDER_SECRET (the master key).
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !secret) {
	console.log("gif-stats: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const gif = `${"A".repeat(20)}${Date.now().toString(36).toUpperCase()}`;
const site = `stats-${Date.now().toString(36)}`;
const post = (/** @type {object} */ body, auth = { Authorization: `Bearer ${secret}` }) => fetch(`${editor}/api/gifs/used`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) });

assert.equal((await post({ gif, site }, {})).status, 401, "a stranger's click counts for nothing");
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
