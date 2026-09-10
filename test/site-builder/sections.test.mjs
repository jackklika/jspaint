// Sections: writing that stacks in the page's column, grows with its text, reorders with ↑/↓ and by dragging, and
// is published as <div class="column"> of <div class="block section"> (normal flow on the live page) — then reads
// back in the same order. No Workers needed.
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint();
const c = await canvas_box(page);
const sections = () => page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => `${b.id}@${b.x},${b.y} ${b.width}x${b.height}`));
const texts = () => page.evaluate(() => [...document.querySelectorAll(".block-layer.flow")].sort((a, b) => a.offsetTop - b.offsetTop).map((el) => el.querySelector(".block-el").textContent.split(" ")[0]));

// Two sections, placed with the tool: they stack in the default column (40px in, page width minus 80)
await select_tool(page, "Section");
await page.mouse.click(c.x + 300, c.y + 300); // where you click doesn't matter for a section
await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
await page.keyboard.type("First section");
await page.keyboard.press("Escape");
await select_tool(page, "Section");
await page.mouse.click(c.x + 780, c.y + 300); // bare canvas beside the column (the selected section would take a click on it)
await page.waitForFunction(() => document.querySelectorAll(".block-layer.flow").length === 2, null, { timeout: 5000 });
await page.keyboard.type("Second section");
await page.keyboard.press("Escape");
let s = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => ({ id: b.id, x: b.x, y: b.y, width: b.width, height: b.height })));
assert.equal(s.length, 2);
assert.deepEqual([s[0].x, s[0].width, s[0].y], [40, 720, 40], JSON.stringify(s));
assert.equal(s[1].x, 40);
assert.equal(s[1].y, s[0].y + s[0].height + 16, "the second sits under the first");
assert.ok(s[0].height >= 24 && s[1].height >= 24);
assert.equal(await page.evaluate(() => [...document.querySelectorAll(".block-layer.flow.selected .handle")].filter((handle) => getComputedStyle(handle).opacity !== "0").length), 0, "no resize handles showing: the column sizes it");

// Selected: ↑ moves it up the column (an undoable step)
assert.deepEqual(await texts(), ["First", "Second"]);
await page.keyboard.press("ArrowUp");
assert.deepEqual(await texts(), ["Second", "First"]);
assert.equal(await page.evaluate(() => current_history_node.name), "Move Section Up");
await page.keyboard.press("Control+z");
assert.deepEqual(await texts(), ["First", "Second"]);

// Dragging the first section below the second reorders them
const first = await (await page.$(".block-layer.flow .block-content")).boundingBox();
await page.mouse.move(first.x + 20, first.y + 10);
await page.mouse.down();
await page.mouse.move(first.x + 20, first.y + 300, { steps: 8 });
await page.mouse.up();
assert.deepEqual(await texts(), ["Second", "First"]);
assert.equal(await page.evaluate(() => current_history_node.name), "Move Element");

// More text makes it taller and pushes the next one down
const before = await sections();
await page.evaluate(() => { const el = [...document.querySelectorAll(".block-layer.flow")].sort((a, b) => a.offsetTop - b.offsetTop)[0]; el.querySelector(".block-content").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
await page.evaluate(() => { const el = [...document.querySelectorAll(".block-layer.flow")].sort((a, b) => a.offsetTop - b.offsetTop)[0]; el.querySelector(".block-content").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); }); // double-click: edit
await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
await page.keyboard.press("End");
for (let i = 0; i < 6; i++) { await page.keyboard.press("Enter"); await page.keyboard.type("line"); }
await page.keyboard.press("Escape");
const after = await sections();
assert.notEqual(after[0], before[0], "the first section grew");
const [top_after, bottom_after] = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => [b.y, b.height]));
assert.equal(bottom_after[0], top_after[0] + top_after[1] + 16, "the second moved down with it");

// Published: a column of sections in order, no positions of their own; reads back the same
const html = await page.evaluate(async () => (await import("/src/collage-format.js")).serialize_collage_html());
assert.match(html, /<div class="collage has-column"/);
// (A new section starts as a heading line; typing over the placeholder keeps the <h2>.)
assert.match(html, /<div class="column" style="left:40px;top:40px;width:720px">\s*<div data-kind="section" class="block section"><h2>Second section<\/h2>(<br>line){6}<\/div>\s*<div data-kind="section" class="block section"><h2>First section<\/h2><\/div>\s*<\/div>/);
const parsed = await page.evaluate(async (html) => {
	const parsed = (await import("/src/collage-format.js")).parse_collage_html(html);
	return { blocks: parsed.blocks.map((b) => [b.kind, !!b.flow, b.html.replace(/<[^>]+>/g, "").slice(0, 14)]), column: [parsed.page_properties.column_left, parsed.page_properties.column_top, parsed.page_properties.column_width] };
}, html);
assert.deepEqual(parsed.blocks, [["section", true, "Second section"], ["section", true, "First section"]]);
assert.deepEqual(parsed.column, [40, 40, 720]);

await close();
console.log("sections: ok");
