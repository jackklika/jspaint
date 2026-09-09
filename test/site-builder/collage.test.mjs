import { assert, canvas_box, capture_saves, click_menu_item, make_gif, open_paint, paste_file } from "./helpers.mjs";

const { page, close } = await open_paint();
await capture_saves(page);
const c = await canvas_box(page);
await page.mouse.move(c.x + 50, c.y + 300);
await page.mouse.down();
await page.mouse.move(c.x + 500, c.y + 320, { steps: 5 });
await page.mouse.up();
await paste_file(page, await make_gif(page, { width: 40, height: 30, delay: 100 }), "a.gif");
await page.waitForSelector(".sticker", { timeout: 5000 });
await paste_file(page, await make_gif(page, { width: 20, height: 20, frames: ["#000", "#fff"], delay: 150 }), "b.gif");
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 2, null, { timeout: 5000 });
for (let i = 0; i < 3; i++) { await page.keyboard.press("Shift+ArrowRight"); }
await click_menu_item(page, "Flip Sticker Horizontal");
await click_menu_item(page, "Rotate Sticker Right");
await click_menu_item(page, "Add Link to Element...");
await page.waitForSelector(".dialog-window input[type=text]", { timeout: 5000 });
await page.fill(".dialog-window input[type=text]", "https://example.com/");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const snapshot = () => page.evaluate(() => current_history_node.stickers.map((s) => `${s.x},${s.y} ${s.width}x${s.height} fx=${s.flip_x} rot=${s.rotation} href=${s.href}`));
const ink = () => page.evaluate(() => main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data.filter((v, i) => i % 4 === 0 && v !== 255).length);
const before = { stickers: await snapshot(), ink: await ink() };

// Save as Web Page
await click_menu_item(page, "Save as Web Page (HTML)...");
await page.waitForFunction(() => window.__saved.length === 1, null, { timeout: 10000 });
const saved_page = await page.evaluate(() => window.__saved[0]);
assert.equal(saved_page.format, "text/html");
assert.match(saved_page.text, /class="collage"/);
assert.match(saved_page.text, /class="bitmap" src="data:image\/png/);
assert.equal((saved_page.text.match(/class="sticker"/g) || []).length, 2);
assert.match(saved_page.text, /transform:rotate\(90deg\) scale\(-1, 1\)/);
assert.match(saved_page.text, /<a class="sticker" href="https:\/\/example\.com\/"[^>]*><img src="data:image\/gif/);

// Reopen it
await page.evaluate(() => { saved = true; });
await click_menu_item(page, "New");
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 0, null, { timeout: 5000 });
await page.evaluate((html) => { window.open_from_file(new File([html], "my collage.html", { type: "text/html" })); }, saved_page.text);
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 2, null, { timeout: 10000 });
await page.waitForTimeout(300);
assert.deepEqual(await snapshot(), before.stickers);
assert.equal(await ink(), before.ink);
assert.equal(await page.evaluate(() => file_name), "my collage.html");
await page.keyboard.press("Control+s");
await page.waitForFunction(() => window.__saved.length === 2, null, { timeout: 10000 });
assert.equal(await page.evaluate(() => window.__saved[1].format), "text/html");
assert.equal(await page.evaluate(() => window.__saved[1].name), "my collage.html");

// Animated GIF export: multi-frame, looping, correct delays
await click_menu_item(page, "Save as Animated GIF...");
await page.waitForFunction(() => [...document.querySelectorAll(".window-title")].some((el) => el.textContent === "Animated GIF"), null, { timeout: 60000 });
await page.evaluate(() => {
	const win = [...document.querySelectorAll(".window")].find((w) => w.querySelector(".window-title")?.textContent === "Animated GIF");
	[...win.querySelectorAll("button")].find((b) => b.textContent === "Save").click();
});
await page.waitForFunction(() => window.__saved.length === 3, null, { timeout: 10000 });
const info = await page.evaluate(async () => {
	const bytes = new Uint8Array(window.__saved[2].bytes);
	const decoder = new ImageDecoder({ data: bytes, type: "image/gif" });
	await decoder.tracks.ready;
	await decoder.completed;
	return { frames: decoder.tracks.selectedTrack.frameCount, loops: String.fromCharCode(...bytes.slice(0, 1200)).includes("NETSCAPE2.0"), header: String.fromCharCode(...bytes.slice(0, 6)) };
});
assert.equal(info.header, "GIF89a");
assert.ok(info.frames >= 3, `frames: ${info.frames}`);
assert.equal(info.loops, true);

await close();
console.log("collage: ok");
