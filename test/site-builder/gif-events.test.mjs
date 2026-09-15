// GIF picker analytics events (src/app-analytics.js + gif-picker.js), with a stubbed window.posthog:
// opening the picker fires gif_picker_opened; the automatic starter search does NOT fire gif_search;
// typing and pressing Enter fires it with the query. No network or Workers needed.
import { assert, open_paint } from "./helpers.mjs";

const { page, close } = await open_paint({
	init: () => {
		window.__events = [];
		window.posthog = { capture: (name, props) => { window.__events.push([name, props]); } };
	},
});

const click_gif_tool = () => page.evaluate(() => {
	[...document.querySelectorAll(".tool")].find((el) => el.getAttribute("title") === "GIF Picker").click();
});

await click_gif_tool();
await page.waitForSelector(".gif-picker-window", { timeout: 5000 });
// Wait for the starter search to settle (whatever proxy it hits — success or failure — the guard must clear).
await page.waitForFunction(() => {
	const status = document.querySelector(".gif-picker-status");
	return status && !status.textContent.includes("Searching...");
}, null, { timeout: 30000 });
await page.waitForTimeout(100);
assert.deepEqual(await page.evaluate(() => window.__events), [["gif_picker_opened", { site: null }]], "open fires gif_picker_opened, starter search is not a gif_search");

await page.fill(".gif-picker-window input[type=search]", "sparkle");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
assert.deepEqual(await page.evaluate(() => window.__events), [
	["gif_picker_opened", { site: null }],
	["gif_search", { query: "sparkle", append: false, site: null }],
], "Enter fires gif_search with the query");

// Closing and reopening the picker counts as another open.
await click_gif_tool(); // toggle closed
await page.waitForSelector(".gif-picker-window", { state: "detached", timeout: 5000 });
await click_gif_tool(); // open again
await page.waitForSelector(".gif-picker-window", { timeout: 5000 });
await page.waitForFunction(() => {
	const status = document.querySelector(".gif-picker-status");
	return status && !status.textContent.includes("Searching...");
}, null, { timeout: 30000 });
await page.waitForTimeout(100);
const events = await page.evaluate(() => window.__events);
assert.equal(events.filter(([name]) => name === "gif_picker_opened").length, 2, "reopen fires gif_picker_opened again");
assert.equal(events.filter(([name]) => name === "gif_search").length, 1, "the second starter search isn't a gif_search either");

await close();
console.log("gif-events: ok");
