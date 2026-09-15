// Select Elements — Paint's Select, for the page's elements: a box picks every element it touches; the group moves as
// one (drag, arrow keys), deletes as one, each a single undo step; Shift adds; a box over one element is the ordinary
// selection; Escape lets go; leaving the tool lets go. Runs against plain Paint (no Workers).
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint();
await page.waitForTimeout(500);
const c = await canvas_box(page);
const history = () => page.evaluate(() => current_history_node.name);
const positions = () => page.evaluate(() => (current_history_node.blocks || []).map((b) => `${b.x},${b.y}`));
const marked = () => page.evaluate(() => document.querySelectorAll(".block-layer.multi-selected").length);
const group_box = () => page.evaluate(() => { const el = document.querySelector(".element-group"); return el && el.offsetParent !== null ? el.getAttribute("data-count") : null; });
const add_box = async (x, y) => {
	await select_tool(page, "Text Box");
	await page.mouse.click(c.x + x, c.y + y);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
};
const drag = async (from, to) => {
	await page.mouse.move(c.x + from[0], c.y + from[1]);
	await page.mouse.down();
	await page.mouse.move(c.x + to[0], c.y + to[1], { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(200);
};

// Three text boxes (320×80 each): two up top, one lower down (the page is 800×600)
await add_box(100, 100);
await add_box(100, 300);
await add_box(100, 500);
assert.deepEqual(await positions(), ["100,100", "100,300", "100,500"]);

// The tool is in the toolbox next to the Pointer; a box over the top two selects both (not the third)
await select_tool(page, "Select Elements");
await drag([50, 50], [600, 450]);
assert.equal(await marked(), 2, "two elements marked");
assert.equal(await group_box(), "2", "the group box counts them");
assert.equal(await page.evaluate(() => document.querySelectorAll(".block-layer.selected").length), 0, "no single selection alongside the group");

// Dragging one of them moves both, as one history step; the third stays
await drag([200, 130], [300, 180]);
assert.deepEqual(await positions(), ["200,150", "200,350", "100,500"]);
assert.equal(await history(), "Move Elements");
// Arrow keys nudge the group (folding into the same step); Shift moves by 10
await page.keyboard.press("ArrowRight");
await page.keyboard.press("Shift+ArrowDown");
assert.deepEqual(await positions(), ["201,160", "201,360", "100,500"]);
assert.equal(await history(), "Move Elements");
// One Ctrl+Z: the whole move (drag and nudges) — one action
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
assert.deepEqual(await positions(), ["100,100", "100,300", "100,500"], "back where they were, in one step");
assert.equal(await marked(), 2, "still selected after undo");
await page.keyboard.press("Control+y");
await page.waitForTimeout(200);
assert.deepEqual(await positions(), ["201,160", "201,360", "100,500"]);

// Shift + a box adds the third; Shift-click takes one out again
await page.keyboard.down("Shift");
await drag([50, 470], [600, 590]);
await page.keyboard.up("Shift");
assert.equal(await marked(), 3);
await page.keyboard.down("Shift");
await page.mouse.click(c.x + 300, c.y + 520);
await page.keyboard.up("Shift");
await page.waitForTimeout(150);
assert.equal(await marked(), 2, "shift-click removes one from the group");

// Delete removes the group as one step; Ctrl+Z brings both back
await page.keyboard.press("Delete");
await page.waitForTimeout(200);
assert.deepEqual(await positions(), ["100,500"]);
assert.equal(await history(), "Delete Elements");
assert.equal(await group_box(), null, "nothing selected after the delete");
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
assert.deepEqual(await positions(), ["201,160", "201,360", "100,500"]);

// A box over one element: the usual single selection, with handles; Escape lets a group go; a click on nothing too
await drag([50, 470], [600, 590]);
assert.equal(await page.evaluate(() => document.querySelectorAll(".block-layer.selected").length), 1, "one element: the ordinary selection");
assert.equal(await marked(), 0);
await drag([50, 50], [600, 450]);
assert.equal(await marked(), 2);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
assert.equal(await marked(), 0);
await drag([50, 50], [600, 450]);
await page.mouse.click(c.x + 700, c.y + 580);
await page.waitForTimeout(150);
assert.equal(await marked(), 0, "a click on nothing lets go");

// Ctrl+A selects every element; switching tools lets the group go
await page.keyboard.press("Control+a");
await page.waitForTimeout(150);
assert.equal(await marked(), 3);
await select_tool(page, "Pointer");
assert.equal(await marked(), 0, "another tool: no group");
assert.equal(await group_box(), null);

// A box drawn entirely inside one element, touching nothing else, still picks that element
await select_tool(page, "Text Box");
await page.mouse.click(c.x + 450, c.y + 200);
await page.keyboard.press("Escape");
await select_tool(page, "Select Elements");
await drag([500, 220], [560, 260]); // entirely inside the fourth box, touching nothing else
assert.equal(await page.evaluate(() => document.querySelectorAll(".block-layer.selected").length), 1, "the only thing under the box is picked, even though it surrounds the box");

await close();
console.log("element-select: ok");
