import { assert, canvas_box, click_menu_item, drop_file, make_gif, open_paint, paste_file } from "./helpers.mjs";

const { page, close } = await open_paint();
const state = () => page.evaluate(() => ({
	count: document.querySelectorAll(".sticker").length,
	selected: document.querySelectorAll(".sticker.selected").length,
	history: current_history_node.name,
	stickers: (current_history_node.stickers || []).map((s) => `${s.id}@${s.x},${s.y} ${s.width}x${s.height}${s.flip_x ? " fx" : ""}`),
}));

// Paste an animated GIF → sticker (natural size, selected)
await paste_file(page, await make_gif(page, { width: 40, height: 30 }));
await page.waitForSelector(".sticker", { timeout: 5000 });
assert.deepEqual((await state()).stickers, ["s1@0,0 40x30"]);
assert.equal((await state()).history, "Add Sticker");

// Undo removes it, redo brings it back
await page.keyboard.press("Control+z");
assert.equal((await state()).count, 0);
await page.keyboard.press("Control+y");
assert.deepEqual((await state()).stickers, ["s1@0,0 40x30"]);

// Drag it
const box = await (await page.$(".sticker img")).boundingBox();
await page.mouse.move(box.x + 20, box.y + 15);
await page.mouse.down();
await page.mouse.move(box.x + 120, box.y + 65, { steps: 5 });
await page.mouse.up();
assert.deepEqual((await state()).stickers, ["s1@100,50 40x30"]);
assert.equal((await state()).history, "Move Sticker");

// Nudge, flip via menu (moves are "soft" history steps, skipped by undo like Move Selection)
await page.keyboard.press("Shift+ArrowRight");
assert.deepEqual((await state()).stickers, ["s1@110,50 40x30"]);
await click_menu_item(page, "Flip Sticker Horizontal");
assert.deepEqual((await state()).stickers, ["s1@110,50 40x30 fx"]);

// Rotate with Ctrl+. / Ctrl+, (the picture's own rotate keys, redirected to the selected sticker), and via menu
await page.keyboard.press("Control+.");
assert.equal(await page.evaluate(() => current_history_node.stickers[0].rotation), 90);
assert.equal(await page.evaluate(() => current_history_node.name), "Rotate Sticker");
await page.keyboard.press("Control+,");
assert.equal(await page.evaluate(() => current_history_node.stickers[0].rotation), 0);
await click_menu_item(page, "Rotate Sticker Left");
assert.equal(await page.evaluate(() => current_history_node.stickers[0].rotation), 270);
assert.match(await page.evaluate(() => document.querySelector(".sticker img").style.transform), /rotate\(270deg\)/);
await click_menu_item(page, "Rotate Sticker By Angle...");
await page.waitForSelector(".dialog-window input[type=number]", { timeout: 5000 });
await page.fill(".dialog-window input[type=number]", "45");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
assert.equal(await page.evaluate(() => current_history_node.stickers[0].rotation), 45);

// Link via Edit > Add Link to Element…
await click_menu_item(page, "Add Link to Element...");
await page.waitForSelector(".dialog-window input[type=text]", { timeout: 5000 });
await page.fill(".dialog-window input[type=text]", "https://example.com/sticker");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
assert.equal(await page.evaluate(() => current_history_node.stickers[0].href), "https://example.com/sticker");
assert.equal(await page.evaluate(() => document.querySelector(".sticker").classList.contains("has-link")), true);
await page.keyboard.press("Control+z");
assert.equal(await page.evaluate(() => current_history_node.stickers[0].href), "");

// Painting on the canvas away from the sticker still works and deselects it
const c = await canvas_box(page);
const before = await page.evaluate(() => main_ctx.getImageData(400, 300, 1, 1).data.join(","));
await page.mouse.move(c.x + 380, c.y + 300);
await page.mouse.down();
await page.mouse.move(c.x + 420, c.y + 300, { steps: 4 });
await page.mouse.up();
assert.notEqual(await page.evaluate(() => main_ctx.getImageData(400, 300, 1, 1).data.join(",")), before, "painted");
assert.equal((await state()).selected, 0);

// Drop a second GIF at a point; delete it with the keyboard
await drop_file(page, await make_gif(page, { width: 20, height: 20 }), 300, 100);
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 2, null, { timeout: 5000 });
assert.deepEqual((await state()).stickers, ["s1@110,50 40x30 fx", "s2@300,100 20x20"]);
await page.keyboard.press("Delete");
assert.deepEqual((await state()).stickers, ["s1@110,50 40x30 fx"]);

// Flatten draws pixels and removes the sticker; undo restores it
await click_menu_item(page, "Flatten Stickers");
assert.equal((await state()).count, 0);
const flattened = await page.evaluate(() => main_ctx.getImageData(115, 55, 1, 1).data.join(","));
assert.notEqual(flattened, "255,255,255,255", "sticker pixels drawn into the bitmap");
await page.keyboard.press("Control+z");
assert.equal((await state()).count, 1);

// A static GIF (one frame) pastes as a normal selection, not a sticker
await paste_file(page, await make_gif(page, { frames: ["#123456"] }), "static.gif");
await page.waitForTimeout(600);
assert.equal(await page.evaluate(() => !!selection), true, "static GIF became a selection");
assert.equal((await state()).count, 1);

// …but Image > Make Sticker from Selection turns any selection into a sticker layer (PNG source)
await click_menu_item(page, "Make Sticker from Selection");
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 2, null, { timeout: 5000 });
assert.equal(await page.evaluate(() => !!selection), false);
assert.equal(await page.evaluate(() => current_history_node.name), "Make Sticker");

await close();
console.log("stickers: ok");
