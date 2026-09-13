// Page elements (blocks): place a heading with its toolbox tool, type into it, arrange it with the Pointer tool,
// paint through it with a paint tool, add a counter and a marquee, round-trip through the web page format,
// and flatten. Also checks the toolbox: a divider, custom icons, one-shot tools.
import { assert, canvas_box, capture_saves, click_menu_item, commit_by_clicking_bare_canvas, open_paint, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint();
const blocks = () => page.evaluate(() => (current_history_node.blocks || []).map((b) => `${b.id}:${b.tag}@${b.x},${b.y} ${b.width}x${b.height}`));
const selected_tool = () => page.evaluate(() => selected_tool.id);

// The toolbox: paint tools, a divider, then the page tools with their own icons
// First run is party-ready: the big round brush in dark blue
assert.deepEqual(await page.evaluate(() => [selected_tool.id, brush_shape, brush_size, selected_colors.foreground]), ["TOOL_BRUSH", "circle", 7, "#000080"]);

// The globe at the bottom of the toolbox is My Site: not signed in, it asks you to sign in
assert.equal(await page.evaluate(() => document.querySelector(".tools-component").lastElementChild.className), "site-globe-button");
assert.equal(await page.evaluate(() => { const b = document.querySelector(".site-globe-button").getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}`; }), "50x50");
assert.equal(await page.$eval(".site-globe-name", (el) => el.textContent), "sign in", "the globe says what it's for when nobody's signed in");
assert.match(await page.$eval(".page-path-label", (el) => el.textContent), /not on a site$/, "a plain picture: the label says so");
await page.click(".site-globe-button");
await page.waitForSelector(".my-site-sign-in", { timeout: 5000 });
await page.evaluate(() => [...document.querySelectorAll(".my-site-sign-in button")].find((b) => b.textContent === "Cancel").click());
await page.waitForFunction(() => !document.querySelector(".my-site-sign-in"), null, { timeout: 5000 });

const tool_titles = await page.evaluate(() => [...document.querySelectorAll(".tools > *")].map((el) => el.classList.contains("tool-divider") ? "---" : el.getAttribute("title")));
// The top of the toolbox is vanilla MS Paint: the 16 classic tools, in order; everything of ours is below the groove
assert.deepEqual(tool_titles.slice(0, 16), ["Free-Form Select", "Select", "Eraser/Color Eraser", "Fill With Color", "Pick Color", "Magnifier", "Pencil", "Brush", "Airbrush", "Text", "Line", "Curve", "Rectangle", "Polygon", "Ellipse", "Rounded Rectangle"]);
assert.deepEqual(tool_titles.slice(16, 23), ["---", "Pointer", "Text Box", "Web Text", "Section", "Divider", "Link"]);
assert.ok(tool_titles.includes("Folder View") && tool_titles.includes("Contents"), "the blog index and contents elements have tools");
assert.equal((tool_titles.length - 17) % 2, 0, "an even number of page tools: no empty cell");
assert.ok(tool_titles.includes("GIF Picker") && tool_titles.includes("Guestbook") && tool_titles.includes("HTML"), tool_titles.join(","));
assert.ok(!tool_titles.includes("Heading") && !tool_titles.includes("Marquee"), "no separate Heading/Marquee tools");
assert.equal(await page.evaluate(() => document.querySelectorAll(".tool-icon.custom-tool-icon").length), 16);
assert.equal(await page.evaluate(() => main_canvas.width), 800, "new documents are page width");

// Text Box tool: drag a box → a <p> block, selected, in edit mode, Pointer tool active
await select_tool(page, "Text Box");
const c = await canvas_box(page);
await page.mouse.move(c.x + 40, c.y + 30);
await page.mouse.down();
await page.mouse.move(c.x + 440, c.y + 90, { steps: 5 });
await page.mouse.up();
await page.waitForSelector(".block-layer", { timeout: 5000 });
assert.deepEqual(await blocks(), ["b1:p@40,30 401x61"]);
assert.equal(await page.evaluate(() => current_history_node.name), "Add Text Box");
assert.equal(await selected_tool(), "TOOL_POINTER");
assert.equal(await page.evaluate(() => document.querySelector(".block-layer.editing .block-el[contenteditable=true]") !== null), true, "editing in place");
assert.equal(await page.evaluate(() => document.body.classList.contains("pointer-tool")), true);

// Type over the placeholder (it's selected) — the text lands in the model as a coalesced "Edit Text" step
await page.keyboard.type("Hello page");
await page.waitForTimeout(100);
assert.equal(await page.evaluate(() => current_history_node.name), "Edit Text");
assert.match(await page.evaluate(() => current_history_node.blocks[0].html), /Hello page/);
// Bold from the Font toolbar applies to the selected words (Home doesn't move the caret on macOS, so arrow-select)
for (let i = 0; i < 4; i++) { await page.keyboard.press("Shift+ArrowLeft"); }
await page.evaluate(() => document.querySelector('.font-box .toggle[aria-label="Bold"]').click());
await page.waitForTimeout(100);
assert.equal(await page.evaluate(() => current_history_node.blocks[0].html), "Hello <b>page</b>");
// Escape ends editing; the block stays selected
await page.keyboard.press("Escape");
assert.equal(await page.evaluate(() => document.querySelectorAll(".block-layer.editing").length), 0);
assert.equal(await page.evaluate(() => document.querySelectorAll(".block-layer.selected").length), 1);

// Pointer tool: drag the block; nudge with the keyboard (soft steps)
const layer = await (await page.$(".block-layer .block-content")).boundingBox();
await page.mouse.move(layer.x + 100, layer.y + 20);
await page.mouse.down();
await page.mouse.move(layer.x + 200, layer.y + 120, { steps: 5 });
await page.mouse.up();
assert.deepEqual(await blocks(), ["b1:p@140,130 401x61"]);
assert.equal(await page.evaluate(() => current_history_node.name), "Move Element");
await page.keyboard.press("Shift+ArrowLeft");
assert.deepEqual(await blocks(), ["b1:p@130,130 401x61"]);

// A paint tool paints through the (deselected) block; the block is click-through
await select_tool(page, "Brush");
await page.mouse.click(c.x + 700, c.y + 500); // deselect by clicking elsewhere
assert.equal(await page.evaluate(() => document.querySelectorAll(".block-layer.selected").length), 0);
const before = await page.evaluate(() => main_ctx.getImageData(300, 160, 1, 1).data.join(","));
await page.mouse.move(c.x + 280, c.y + 160);
await page.mouse.down();
await page.mouse.move(c.x + 320, c.y + 160, { steps: 4 });
await page.mouse.up();
assert.notEqual(await page.evaluate(() => main_ctx.getImageData(300, 160, 1, 1).data.join(",")), before, "painted under the block");
assert.deepEqual(await blocks(), ["b1:p@130,130 401x61"], "the block is untouched");

// A click (no drag) places an element at its default size; x-elements keep their fallback content
await select_tool(page, "Visitor Counter");
await page.mouse.click(c.x + 60, c.y + 400);
await page.waitForFunction(() => (current_history_node.blocks || []).length === 2, null, { timeout: 5000 });
assert.deepEqual((await blocks())[1], "b2:x-counter@60,400 300x28");
assert.match(await page.evaluate(() => document.querySelector('.block-layer[data-tag="x-counter"] .block-el').innerHTML), /visitor number/);
// Marquee is a text style: place a Text Box, then the Font toolbar's Marquee toggle turns it into scrolling text
await select_tool(page, "Text Box");
await page.mouse.click(c.x + 60, c.y + 450);
await page.waitForFunction(() => (current_history_node.blocks || []).length === 3, null, { timeout: 5000 });
assert.equal(await page.evaluate(() => document.querySelector(".font-box .marquee-toggle").disabled), false, "the toggle is live while editing");
await page.evaluate(() => document.querySelector(".font-box .marquee-toggle").click());
await page.waitForTimeout(150);
assert.equal(await page.evaluate(() => document.querySelector(".font-box .marquee-toggle").getAttribute("aria-pressed")), "true");
assert.equal(await page.evaluate(() => document.querySelectorAll(".block-layer.editing").length), 1, "still editing after the switch");
await page.keyboard.press("Escape");
assert.equal(await page.evaluate(() => document.querySelector('.block-layer[data-tag="marquee"] .block-el').getAttribute("scrollamount")), "4");
assert.equal(await page.evaluate(() => current_history_node.name), "Marquee On");

// Undo/redo: the marquee switch, then the box itself
await page.keyboard.press("Control+z");
assert.deepEqual(await page.evaluate(() => current_history_node.blocks.map((b) => b.tag)), ["p", "x-counter", "p"]);
await page.keyboard.press("Control+z");
assert.equal((await blocks()).length, 2);
await page.keyboard.press("Control+y");
await page.keyboard.press("Control+y");
assert.equal((await blocks()).length, 3);
assert.deepEqual(await page.evaluate(() => current_history_node.blocks.map((b) => b.tag)), ["p", "x-counter", "marquee"]);

// Marquee from the classic Text tool: type, press the toggle (a real click), finish → a <marquee> element in that font
await select_tool(page, "Text");
assert.equal(await page.evaluate(() => document.querySelector(".font-box .marquee-toggle").disabled), true, "no text box yet: nothing to make scroll");
await page.mouse.move(c.x + 60, c.y + 520);
await page.mouse.down();
await page.mouse.move(c.x + 300, c.y + 560, { steps: 4 });
await page.mouse.up();
await page.waitForSelector(".textbox", { timeout: 5000 });
await page.keyboard.type("scroll me");
await page.waitForFunction(() => document.querySelector(".font-box .marquee-toggle")?.disabled === false, null, { timeout: 5000 });
const mt = await (await page.$(".font-box .marquee-toggle")).boundingBox();
await page.mouse.click(mt.x + mt.width / 2, mt.y + mt.height / 2);
assert.equal(await page.evaluate(() => document.querySelector(".font-box .marquee-toggle").getAttribute("aria-pressed")), "true");
assert.equal(await page.evaluate(() => document.querySelector(".textbox textarea").value), "scroll me", "typing continues after the toggle");
await commit_by_clicking_bare_canvas(page, { x: 60, y: 520, width: 240, height: 40 });
await page.waitForFunction(() => (current_history_node.blocks || []).length === 4, null, { timeout: 5000 });
assert.equal(await page.evaluate(() => current_history_node.blocks[3].tag), "marquee");
assert.match(await page.evaluate(() => current_history_node.blocks[3].html), /^<font face="[^"]+" size="\d" color="#000080">scroll me<\/font>$/);
assert.equal(await page.evaluate(() => current_history_node.name), "Add Marquee");
await page.keyboard.press("Control+z");
assert.equal((await blocks()).length, 3);

// Layers window lists the elements
await click_menu_item(page, "Layers");
await page.waitForSelector(".layers-window", { timeout: 5000 });
const rows = await page.evaluate(() => [...document.querySelectorAll(".layer-row-block .layer-name")].map((el) => el.textContent));
assert.deepEqual(rows, ["Marquee: Write something here.", "Visitor Counter: You are visitor number 0", "Text Box: Hello page"]); // (names are clipped to 24 characters)
await page.evaluate(() => [...document.querySelectorAll(".layers-window button")].find((b) => b.textContent === "Close").click());

// Save as Web Page: elements are positioned children of the collage; reopen → same model
await capture_saves(page);
await click_menu_item(page, "Save as Web Page (HTML)...");
await page.waitForFunction(() => window.__saved.length === 1, null, { timeout: 10000 });
const html = await page.evaluate(() => window.__saved[0].text);
assert.match(html, /<p class="block" style="left:130px;top:130px;width:401px;height:61px">Hello <b>page<\/b><\/p>/);
assert.match(html, /<x-counter class="block" style="left:60px;top:400px;width:300px;height:28px">You are visitor number <b>000123<\/b><\/x-counter>/);
assert.match(html, /<marquee data-was="p" behavior="scroll" scrollamount="4" class="block"/);
assert.doesNotMatch(html, /contenteditable/);
const before_reopen = await blocks();
await page.evaluate(() => { saved = true; });
await click_menu_item(page, "New");
await page.waitForFunction(() => document.querySelectorAll(".block-layer").length === 0, null, { timeout: 5000 });
await page.evaluate((html) => { window.open_from_file(new File([html], "page.html", { type: "text/html" })); }, html);
await page.waitForFunction(() => document.querySelectorAll(".block-layer").length === 3, null, { timeout: 10000 });
await page.waitForTimeout(300);
assert.deepEqual(await blocks(), before_reopen);
assert.equal(await page.evaluate(() => file_format), "text/html");

// Flatten draws the text box into the bitmap (select it with the Pointer tool first)
await select_tool(page, "Pointer");
const h1 = await (await page.$('.block-layer[data-tag="p"] .block-content')).boundingBox();
await page.mouse.click(h1.x + 50, h1.y + 30);
assert.equal(await page.evaluate(() => document.querySelector('.block-layer[data-tag="p"]').classList.contains("selected")), true);
await click_menu_item(page, "Flatten Element");
await page.waitForFunction(() => document.querySelectorAll(".block-layer").length === 2, null, { timeout: 5000 });
const ink = await page.evaluate(() => main_ctx.getImageData(130, 130, 401, 61).data.filter((v, i) => i % 4 === 0 && v !== 255).length);
assert.ok(ink > 100, `text ink drawn: ${ink}`);

// Multi-line text: Enter makes <br> lines, never <div>s (which a browser would push out of a <p> on the live page)
await select_tool(page, "Text Box");
await page.mouse.click(c.x + 60, c.y + 60);
await page.waitForSelector(".block-layer.editing", { timeout: 5000 });
await page.keyboard.type("one");
await page.keyboard.press("Enter");
await page.keyboard.type("two");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("four");
await page.keyboard.press("Escape");
const lines_html = await page.evaluate(() => current_history_node.blocks[current_history_node.blocks.length - 1].html);
assert.equal(lines_html, "one<br>two<br><br>four", lines_html);
// …and a page saved the old way (divs inside the block) reads back as lines
const repaired = await page.evaluate(async () => (await import("/src/collage-format.js")).repair_block_lines('<p class="block" style="left:1px">first<div><br></div><div>second</div></p><h1 class="block">fine</h1><marquee class="block">a<div>b</div></marquee>'));
assert.equal(repaired, '<p class="block" style="left:1px">first<br><br>second</p><h1 class="block">fine</h1><marquee class="block">a<div>b</div></marquee>');

await close();
console.log("blocks: ok");
