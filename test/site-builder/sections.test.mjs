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

// Anchors: each section got a #name from what was typed first; a link to it is the page's address plus #name
assert.deepEqual(await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => b.attrs.id)), ["second-section", "first-section"]);
assert.equal(await page.evaluate(async () => { const m = await import("/src/blocks.js"); return m.section_link(m.get_selected_block()); }), "#second-section", "not on a site yet: just the anchor");

// Writing tools: Style makes a heading, the list button a list, Ctrl+K a link — all inside the section
await page.evaluate(() => { const el = [...document.querySelectorAll(".block-layer.flow")].sort((a, b) => a.offsetTop - b.offsetTop)[1]; for (let i = 0; i < 2; i++) { el.querySelector(".block-content").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); } });
await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
assert.equal(await page.evaluate(() => document.querySelector(".font-box .block-tools").offsetParent !== null), true, "the writing tools show while editing a section");
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("A heading");
await page.selectOption(".font-box select.block-style", "h2");
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("item one");
await page.evaluate(() => { const b = /** @type {HTMLElement} */ (document.querySelector('.font-box button[aria-label="Bulleted List"]')); b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); b.click(); });
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("item two");
for (let i = 0; i < 8; i++) { await page.keyboard.press("Shift+ArrowLeft"); } // select "item two" (Shift+Home would take the whole section here)
await page.keyboard.press("Control+k");
await page.waitForSelector(".link-window", { timeout: 5000 });
await page.fill('.link-window input[name="link-url"]', "https://example.com/");
await page.click(".link-window button[type=submit]");
await page.waitForFunction(() => !document.querySelector(".link-window"), null, { timeout: 5000 });
await page.keyboard.press("Escape");
const rich = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => b.html)[1]);
assert.match(rich, /<h2>A heading<\/h2>/, rich);
assert.match(rich, /<ul><li>item one<\/li><li><a href="https:\/\/example.com\/">item two<\/a><\/li><\/ul>/, rich);

// Published: a column of sections in order, no positions of their own; reads back the same
const html = await page.evaluate(async () => (await import("/src/collage-format.js")).serialize_collage_html());
assert.match(html, /<div class="collage has-column"/);
// (A new section starts as a heading line; typing over the placeholder keeps the <h2>, and Enter makes paragraphs.)
assert.match(html, /<div class="column" style="left:40px;top:40px;width:720px">\s*<div data-kind="section" id="second-section" class="block section"><h2>Second section<\/h2>(<p>line<\/p>){6}<\/div>\s*<div data-kind="section" id="first-section" class="block section"><h2>First section<\/h2><h2>A heading<\/h2><ul>/);
const parsed = await page.evaluate(async (html) => {
	const parsed = (await import("/src/collage-format.js")).parse_collage_html(html);
	return { blocks: parsed.blocks.map((b) => [b.kind, !!b.flow, b.html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).slice(0, 2).join(" ")]), column: [parsed.page_properties.column_left, parsed.page_properties.column_top, parsed.page_properties.column_width] };
}, html);
assert.deepEqual(parsed.blocks, [["section", true, "Second section"], ["section", true, "First section"]]);
assert.deepEqual(parsed.column, [40, 40, 720]);

await close();
console.log("sections: ok");
