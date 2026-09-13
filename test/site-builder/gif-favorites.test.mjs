// The GIF picker's ♥: a heart on each GIF keeps it in the Favorites tab (this browser's, by GifCities id); the tab
// counts them, lists them newest first, and a favorite adds to the page like any result. Search and the GIFs
// themselves are stubbed here, so it runs offline.
import { assert, make_gif, open_paint } from "./helpers.mjs";

const { page, close } = await open_paint();
await page.waitForTimeout(500);
const gif_bytes = await make_gif(page, { width: 24, height: 24 });
const ids = [1, 2, 3].map((n) => `GIFCITIES${String(n).padStart(11, "0")}`); // (the proxy's ids: 20+ capitals and digits)
const stub = async (/** @type {import("playwright").Page} */ p) => {
	await p.route("**/api/gifcities/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: ids.map((id, i) => ({ url: `/api/gifcities/gif/${id}`, width: 24 + i, height: 24 })), next_offset: null }) }));
	await p.route("**/api/gifcities/gif/*", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from(gif_bytes) }));
	await p.route("**/api/gifs/used", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
};
await stub(page);
const open_picker = async (/** @type {import("playwright").Page} */ p) => {
	await p.evaluate(() => { [...document.querySelectorAll(".tool")].find((t) => t.getAttribute("title") === "GIF Picker")?.click(); });
	await p.waitForSelector(".gif-picker-window", { timeout: 10000 });
};
const favorites_tab_text = (/** @type {import("playwright").Page} */ p) => p.$eval(".gif-picker-tab[data-tab=favorites]", (el) => el.textContent);

// Search results: each GIF wears an empty heart; the Favorites tab is empty
await open_picker(page);
await page.waitForFunction(() => document.querySelectorAll(".gif-picker-results .gif-tile").length === 3, null, { timeout: 15000 });
assert.deepEqual(await page.$$eval(".gif-picker-panel[data-tab=search] .gif-heart", (els) => els.map((el) => el.textContent)), ["♡", "♡", "♡"]);
assert.equal(await favorites_tab_text(page), "Favorites ♡");

// ♥ two of them: the hearts fill, the tab counts, nothing was added to the page
await page.click(`.gif-tile[data-gif="${ids[0]}"] .gif-heart`);
await page.click(`.gif-tile[data-gif="${ids[2]}"] .gif-heart`);
assert.deepEqual(await page.$$eval(".gif-picker-panel[data-tab=search] .gif-heart", (els) => els.map((el) => el.textContent)), ["♥", "♡", "♥"]);
assert.equal(await favorites_tab_text(page), "Favorites ♥ 2");
assert.equal(await page.evaluate(() => (current_history_node.stickers || []).length), 0, "hearting doesn't add the GIF");
assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("jspaint favorite gifs"))).map((f) => f.id), [ids[2], ids[0]], "newest first");

// The Favorites tab lists them; one un-hearted there leaves; a favorite clicked goes onto the page
await page.click(".gif-picker-tab[data-tab=favorites]");
await page.waitForFunction(() => document.querySelectorAll(".gif-picker-favorites .gif-tile").length === 2, null, { timeout: 5000 });
assert.deepEqual(await page.$$eval(".gif-picker-favorites .gif-tile", (els) => els.map((el) => el.dataset.gif)), [ids[2], ids[0]]);
assert.equal(await page.$eval(".gif-picker-panel[data-tab=search]", (el) => el.offsetParent === null), true, "the search panel is hidden");
await page.click(`.gif-picker-favorites .gif-tile[data-gif="${ids[2]}"] .gif-heart`);
await page.waitForFunction(() => document.querySelectorAll(".gif-picker-favorites .gif-tile").length === 1, null, { timeout: 5000 });
assert.equal(await favorites_tab_text(page), "Favorites ♥ 1");
await page.click(`.gif-picker-favorites .gif-tile[data-gif="${ids[0]}"]`);
await page.waitForFunction(() => (current_history_node.stickers || []).length === 1, null, { timeout: 10000 });
// Back on Search, the un-hearted one shows an empty heart again
await page.click(".gif-picker-tab[data-tab=search]");
assert.deepEqual(await page.$$eval(".gif-picker-panel[data-tab=search] .gif-heart", (els) => els.map((el) => el.textContent)), ["♥", "♡", "♡"]);

// Favorites survive a reload (localStorage); none → the tab says so
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".main-canvas", { timeout: 60000 });
await page.waitForTimeout(800);
await page.evaluate(() => { document.querySelector(".page-loading-panel")?.remove(); document.body.classList.remove("page-loading"); });
await stub(page);
await open_picker(page);
assert.equal(await favorites_tab_text(page), "Favorites ♥ 1");
await page.click(".gif-picker-tab[data-tab=favorites]");
await page.waitForSelector(".gif-picker-favorites .gif-tile", { timeout: 5000 });
await page.click(".gif-picker-favorites .gif-tile .gif-heart");
await page.waitForSelector(".gif-picker-empty", { timeout: 5000 });
assert.match(await page.$eval(".gif-picker-empty", (el) => el.textContent), /No favorites yet/);
assert.equal(await favorites_tab_text(page), "Favorites ♡");

await close();
console.log("gif-favorites: ok");
