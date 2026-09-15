// Ctrl+Z reverts one action at a time across raster steps and element steps: a stroke after an element move undoes
// on its own (moves, resizes and nudges are full history steps, not "soft" ones undo skips); moving two elements is
// two steps; a drag of one element is one; Ctrl+Y walks the same steps forward. Runs against plain Paint (no Workers).
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint();
await page.waitForTimeout(500);
const c = await canvas_box(page);
const history = () => page.evaluate(() => {
	const list = [];
	for (let n = current_history_node; n; n = n.parent) { list.unshift(n.name + (n.soft ? "(soft)" : "")); }
	return list;
});
const at = () => page.evaluate(() => current_history_node.name);
const blocks = () => page.evaluate(() => (current_history_node.blocks || []).map((b) => `${b.x},${b.y}`));
const painted = (y) => page.evaluate((y) => main_ctx.getImageData(600, y, 1, 1).data.join(",") !== "255,255,255,255", y);
const paint = async (y) => {
	await select_tool(page, "Brush");
	await page.mouse.move(c.x + 590, c.y + y);
	await page.mouse.down();
	await page.mouse.move(c.x + 610, c.y + y, { steps: 3 });
	await page.mouse.up();
	await page.waitForFunction((y) => main_ctx.getImageData(600, y, 1, 1).data.join(",") !== "255,255,255,255", y, { timeout: 5000 });
};
const add_box = async (x, y) => {
	await select_tool(page, "Text Box");
	await page.mouse.click(c.x + x, c.y + y);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
};
const drag = async (from, to) => {
	await select_tool(page, "Pointer");
	await page.mouse.move(c.x + from[0], c.y + from[1]);
	await page.mouse.down();
	await page.mouse.move(c.x + to[0], c.y + to[1], { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(150);
};
const key = async (combo) => { await page.keyboard.press(combo); await page.waitForTimeout(150); };

// Add an element, paint, move the element, paint again: four steps, none soft
await add_box(100, 100);
await paint(100);
await drag([150, 115], [250, 215]);
await paint(300);
assert.deepEqual(await history(), ["New", "Add Text Box", "Brush", "Move Element", "Brush"], "a move is an ordinary step");
assert.deepEqual(await blocks(), ["200,200"]);
// One Ctrl+Z: the second stroke goes, the element stays where it was moved
await key("Control+z");
assert.equal(await at(), "Move Element");
assert.equal(await painted(300), false);
assert.equal(await painted(100), true);
assert.deepEqual(await blocks(), ["200,200"], "the move is still there");
// The next: the move
await key("Control+z");
assert.equal(await at(), "Brush");
assert.deepEqual(await blocks(), ["100,100"]);
assert.equal(await painted(100), true);
// Redo walks forward through the move too
await key("Control+y");
assert.equal(await at(), "Move Element");
assert.deepEqual(await blocks(), ["200,200"]);
await key("Control+y");
assert.equal(await at(), "Brush");
assert.equal(await painted(300), true);

// A resize, then a stroke: two steps
await select_tool(page, "Pointer");
await page.mouse.click(c.x + 250, c.y + 215);
await page.waitForSelector(".block-layer.selected .handle", { timeout: 5000 });
const handles = await page.$$(".block-layer.selected .handle:not(.useless-handle)");
const boxes = await Promise.all(handles.map((h) => h.boundingBox()));
const hb = boxes.filter(Boolean).sort((a, b) => (b.x + b.y) - (a.x + a.y))[0]; // the bottom-right one
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + 60, hb.y + 30, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(150);
await paint(500);
assert.deepEqual((await history()).slice(-2), ["Resize Text Box", "Brush"], "one resize step for the whole drag");
const resized = await page.evaluate(() => current_history_node.blocks[0].width);
await key("Control+z");
assert.equal(await painted(500), false);
assert.equal(await page.evaluate(() => current_history_node.blocks[0].width), resized, "the resize stays");
await key("Control+z");
assert.equal(await page.evaluate(() => current_history_node.blocks[0].width), 320, "…then it goes");

// Two elements moved in a row are two steps; a drag of one is one step; arrow nudges of it fold into that step
await add_box(100, 400);
await drag([250, 215], [300, 265]); // the first element again
await drag([150, 415], [200, 465]); // the second
assert.deepEqual((await history()).slice(-3), ["Add Text Box", "Move Element", "Move Element"], "moving A then B is two steps");
await key("Control+z");
assert.deepEqual(await blocks(), ["250,250", "100,400"], "only B went back");
await key("Control+z");
assert.deepEqual(await blocks(), ["200,200", "100,400"], "then A");
await key("Control+y");
await key("Control+y");
await page.mouse.click(c.x + 200, c.y + 465); // select B
await key("ArrowRight");
await key("ArrowRight");
await key("ArrowDown");
assert.deepEqual((await history()).slice(-2), ["Move Element", "Move Element"], "nudges fold into B's move step, not a new one each");
assert.deepEqual(await blocks(), ["250,250", "152,451"]);
await key("Control+z");
assert.deepEqual(await blocks(), ["250,250", "100,400"], "one Ctrl+Z: B's drag and its nudges together");

await close();
console.log("undo-steps: ok");
