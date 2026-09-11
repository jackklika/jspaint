// Sections: writing that stacks in the page's column, grows with its text, reorders with ↑/↓ and by dragging, and
// is published as <div class="column"> of <div class="block section"> (normal flow on the live page) — then reads
// back in the same order. No Workers needed.
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint();
const c = await canvas_box(page);
const sections = () => page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => `${b.id}@${b.x},${b.y} ${b.width}x${b.height}`));
const texts = () => page.evaluate(() => [...document.querySelectorAll(".block-layer.flow")].sort((a, b) => a.offsetTop - b.offsetTop).map((el) => el.querySelector(".block-el").textContent.split(" ")[0]));
/** Double-clicks the section whose text starts so (a real double-click: a synthetic pointerdown with no pointerup would leave its drag listener behind). @param {RegExp} starts */
const edit_section = async (starts) => {
	await page.waitForTimeout(500); // (not within 400 ms of the last press)
	const box = await page.evaluate((source) => { const layer = [...document.querySelectorAll(".block-layer.flow")].find((el) => new RegExp(source).test(el.querySelector(".block-el").textContent)); const r = layer.querySelector(".block-content").getBoundingClientRect(); return { x: r.x, y: r.y }; }, starts.source);
	await page.mouse.dblclick(box.x + 20, box.y + 10);
	await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
	await page.keyboard.press("End");
};

// Two sections, placed with the tool: the first starts the column where you click; the next stacks under it
await select_tool(page, "Section");
await page.mouse.click(c.x + 300, c.y + 300);
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
assert.deepEqual([s[0].x, s[0].width, s[0].y], [300, 480, 300], JSON.stringify(s)); // width: to the page's edge, less a margin
assert.equal(s[1].x, 300);
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

// Dragging the second section above the first reorders them (the first section is the column: dragging it moves all)
const second = await (await page.$$(".block-layer.flow .block-content"))[1].boundingBox();
await page.mouse.move(second.x + 20, second.y + 10);
await page.mouse.down();
await page.mouse.move(second.x + 20, second.y - 120, { steps: 8 });
await page.mouse.up();
assert.deepEqual(await texts(), ["Second", "First"]);
assert.equal(await page.evaluate(() => current_history_node.name), "Move Element");

// Dragging the first section moves the whole column (the second follows)
{
	await page.waitForTimeout(500); // (a press within 400 ms of the last one would read as a double-click: edit)
	const top = await (await page.$(".block-layer.flow .block-content")).boundingBox();
	await page.mouse.move(top.x + 20, top.y + 10);
	await page.mouse.down();
	await page.mouse.move(top.x + 20 - 200, top.y + 10 - 200, { steps: 6 });
	await page.mouse.up();
	const moved = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => [b.x, b.y]));
	assert.ok(Math.abs(moved[0][0] - 100) <= 1 && Math.abs(moved[0][1] - 100) <= 1, JSON.stringify(moved)); // (pointer rounding)
	assert.equal(moved[1][0], moved[0][0], "the second section came along");
	await page.waitForTimeout(500);
	await page.mouse.move(top.x + 20 - 200, top.y + 10 - 200);
	await page.mouse.down();
	await page.mouse.move(top.x + 20, top.y + 10, { steps: 6 });
	await page.mouse.up();
	const back = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => b.x));
	assert.ok(Math.abs(back[0] - 300) <= 1 && back[1] === back[0], `and back: ${JSON.stringify(back)}`);
}

// Undo takes the column back (the geometry rides on the history node), and a reload of the same #local: session
// lays the sections out where they were (it's saved with the layers)
{
	const column = () => page.evaluate(async () => { const p = (await import("/src/page-properties.js")).get_page_properties(); return [p.column_left, p.column_top]; });
	await page.waitForTimeout(500);
	const top = await (await page.$(".block-layer.flow .block-content")).boundingBox(); // (the top section drags the column)
	await page.mouse.move(top.x + 20, top.y + 10);
	await page.mouse.down();
	await page.mouse.move(top.x + 20 - 200, top.y + 10 - 200, { steps: 6 });
	await page.mouse.up();
	const near = (/** @type {number[]} */ pair, /** @type {number} */ value) => pair.every((n) => Math.abs(n - value) <= 1);
	assert.ok(near(await column(), 100), `moved: ${await column()}`);
	await page.keyboard.press("Control+z");
	assert.ok(near(await column(), 300), `undone: ${await column()}`);
	await page.keyboard.press("Control+y");
	assert.ok(near(await column(), 100), `redone: ${await column()}`);
	await page.waitForFunction(() => /#local:/.test(location.hash), null, { timeout: 5000 });
	await page.waitForTimeout(1200); // the sidecar autosave is debounced
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.querySelectorAll(".block-layer.flow").length === 2 && (current_history_node.blocks || []).filter((b) => b.flow).length === 2, null, { timeout: 20000 });
	assert.ok(near(await column(), 100), `after a reload: ${await column()}`);
	const xs = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => b.x));
	assert.ok(Math.abs(xs[0] - 100) <= 1 && xs[1] === xs[0], `sections stayed in the column: ${JSON.stringify(xs)}`);
	await select_tool(page, "Pointer"); // (a reload starts with a paint tool; elements take the pointer only under the Pointer tool)
}

// More text makes it taller and pushes the next one down
const before = await sections();
await edit_section(/^Second/);
for (let i = 0; i < 6; i++) { await page.keyboard.press("Enter"); await page.keyboard.type("line"); }
await page.keyboard.press("Escape");
const after = await sections();
assert.notEqual(after[0], before[0], "the first section grew");
const [top_after, bottom_after] = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => [b.y, b.height]));
assert.equal(bottom_after[0], top_after[0] + top_after[1] + 16, "the second moved down with it");

// Anchors: each section got a #name from what was typed first; a link to it is the page's address plus #name
assert.deepEqual(await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => b.attrs.id)), ["second-section", "first-section"]);
assert.equal(await page.evaluate(async () => { const m = await import("/src/blocks.js"); return m.section_link(m.get_selected_block()); }), "#second-section", "not on a site yet: just the anchor");

// Writing tools: Style makes a heading, the list button a list, Ctrl+K a link — all inside the section
await edit_section(/^First/);
assert.equal(await page.evaluate(() => document.querySelector(".font-box .block-tools").offsetParent !== null), true, "the writing tools show while editing a section");
const caret_to_end = () => page.evaluate(() => {
	const range = document.createRange();
	range.selectNodeContents(document.querySelector(".block-layer.flow.editing .block-el"));
	range.collapse(false);
	const selection = document.getSelection();
	selection.removeAllRanges();
	selection.addRange(range);
});
await caret_to_end();
await page.keyboard.press("Enter");
await page.keyboard.type("A heading");
await page.selectOption(".font-box select.block-style", "h2");
await caret_to_end();
await page.keyboard.press("Enter");
await page.keyboard.type("item one");
await page.evaluate(() => { const b = /** @type {HTMLElement} */ (document.querySelector('.font-box button[aria-label="Bulleted List"]')); b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); b.click(); });
await caret_to_end();
await page.keyboard.press("Enter");
await page.keyboard.type("item two");
for (let i = 0; i < 8; i++) { await page.keyboard.press("Shift+ArrowLeft"); } // select "item two" (Shift+Home would take the whole section here)
await page.keyboard.press("Control+k");
await page.waitForSelector(".link-window", { timeout: 5000 });
await page.fill('.link-window input[name="link-url"]', "https://example.com/");
await page.click(".link-window button[type=submit]");
await page.waitForFunction(() => !document.querySelector(".link-window"), null, { timeout: 5000 });
await page.keyboard.press("Escape");
const rich = await page.evaluate(() => (current_history_node.blocks || []).find((b) => b.flow && /First section/.test(b.html)).html);
assert.match(rich, /<h2>A heading<\/h2>/, rich);
assert.match(rich, /<ul><li>item one<\/li><li><a href="https:\/\/example.com\/">item two<\/a><\/li><\/ul>/, rich);

// Published: a column of sections in order, no positions of their own; reads back the same
const html = await page.evaluate(async () => (await import("/src/collage-format.js")).serialize_collage_html());
assert.match(html, /<div class="collage has-column"/);
// (A new section starts as a heading line; typing over the placeholder keeps the <h2>, and Enter makes paragraphs.)
assert.match(html, /<div class="column" style="left:(?:99|100|101)px;top:(?:99|100|101)px;width:680px">\s*<div data-kind="section" id="second-section" class="block section"><h2>Second section<\/h2>(<p>line<\/p>){6}<\/div>\s*<div data-kind="section" id="first-section" class="block section"><h2>First section<\/h2><h2>A heading<\/h2><ul>/);
const parsed = await page.evaluate(async (html) => {
	const parsed = (await import("/src/collage-format.js")).parse_collage_html(html);
	return { blocks: parsed.blocks.map((b) => [b.kind, !!b.flow, b.html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).slice(0, 2).join(" ")]), column: [parsed.page_properties.column_left, parsed.page_properties.column_top, parsed.page_properties.column_width] };
}, html);
assert.deepEqual(parsed.blocks, [["section", true, "Second section"], ["section", true, "First section"]]);
assert.ok(Math.abs(parsed.column[0] - 100) <= 1 && Math.abs(parsed.column[1] - 100) <= 1 && parsed.column[2] === 680, JSON.stringify(parsed.column)); // (pointer rounding; the width is automatic: to the page's edge less a margin)

await close();
console.log("sections: ok");
