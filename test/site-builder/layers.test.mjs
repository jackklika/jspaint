import { assert, click_menu_item, make_gif, open_paint, paste_file, type_text_box } from "./helpers.mjs";

const { page, close } = await open_paint();
await paste_file(page, await make_gif(page, { width: 40, height: 30 }), "a.gif");
await page.waitForSelector(".sticker", { timeout: 5000 });
await paste_file(page, await make_gif(page, { width: 20, height: 20 }), "b.gif");
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 2, null, { timeout: 5000 });
await type_text_box(page, "Layer text", { x: 300, y: 200, width: 200, height: 60, tool: "Web Text" });
await page.waitForSelector(".text-layer", { timeout: 5000 });

await click_menu_item(page, "Layers");
await page.waitForSelector(".layers-window", { timeout: 5000 });
const rows = () => page.evaluate(() => [...document.querySelectorAll(".layer-row")].map((r) => `${r.classList.contains("selected") ? "*" : ""}${r.querySelector(".layer-name").textContent}`));
assert.deepEqual(await rows(), ["*Layer text", "Sticker 2 (20×20)", "Sticker 1 (40×30)", "Picture (pixels)"]); // the new text layer stays selected

// Lower the top sticker: model and DOM order follow
await page.evaluate(() => document.querySelector(".layer-row-sticker").querySelector('button[title="Lower"]').click());
await page.waitForTimeout(200);
assert.deepEqual(await page.evaluate(() => current_history_node.stickers.map((s) => s.id)), ["s2", "s1"]);
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".sticker img")].map((i) => i.naturalWidth)), [20, 40]);
assert.equal(await page.evaluate(() => current_history_node.name), "Lower Sticker");

// Clicking a row selects on the canvas
await page.evaluate(() => [...document.querySelectorAll(".layer-row-sticker")][1].click());
assert.equal(await page.evaluate(() => document.querySelector(".sticker.selected img").naturalWidth), 20);

// Flatten the text layer from its row, undo
await page.evaluate(() => document.querySelector(".layer-row-text").querySelector('button[title="Flatten into the picture"]').click());
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => document.querySelectorAll(".layer-row-text").length), 0);
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
assert.equal(await page.evaluate(() => document.querySelectorAll(".layer-row-text").length), 1);

// Delete a sticker from its row
await page.evaluate(() => document.querySelector(".layer-row-sticker").querySelector('button[title="Delete"]').click());
await page.waitForTimeout(200);
assert.equal(await page.evaluate(() => document.querySelectorAll(".sticker").length), 1);

await close();
console.log("layers: ok");
