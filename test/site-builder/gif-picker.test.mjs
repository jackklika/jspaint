// Needs the GifCities proxy (agent-server) and network: set SITE_BUILDER_PROXY_URL=http://localhost:4097 to run.
import { assert, open_paint } from "./helpers.mjs";

const proxy = process.env.SITE_BUILDER_PROXY_URL;
if (!proxy) {
	console.log("gif-picker: skipped (set SITE_BUILDER_PROXY_URL to the agent-server to run it)");
	process.exit(0);
}
const { page, close } = await open_paint({ init: (proxy) => { localStorage.setItem("jspaint agent-drive server url", proxy); }, init_arg: proxy.replace(/\/+$/, "") });

await page.evaluate(() => { [...document.querySelectorAll(".tool")].find((el) => el.getAttribute("title") === "GIF Picker").click(); });
await page.waitForSelector(".gif-picker-window", { timeout: 5000 });
await page.fill(".gif-picker-window input[type=search]", "sparkle");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelectorAll(".gif-tile").length > 0, null, { timeout: 30000 });
const tile = await (await page.$(".gif-tile")).boundingBox();
await page.mouse.click(tile.x + tile.width / 2, tile.y + tile.height / 2);
await page.waitForSelector(".sticker", { timeout: 30000 });
assert.equal(await page.evaluate(() => current_history_node.name), "Add Sticker");

const url = await page.evaluate(() => document.querySelectorAll(".gif-tile img")[1].src);
await page.evaluate(([url, type]) => {
	const dt = new DataTransfer();
	dt.setData(type, url);
	const target = document.querySelector(".main-canvas");
	const rect = target.getBoundingClientRect();
	for (const kind of ["dragenter", "dragover", "drop"]) {
		target.dispatchEvent(new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.left + 400, clientY: rect.top + 250 }));
	}
}, [url, "application/x-jspaint-gif-url"]);
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 2, null, { timeout: 30000 });
assert.match((await page.evaluate(() => current_history_node.stickers[1]))?.x?.toString() || "", /^\d+$/);

await close();
console.log("gif-picker: ok");
