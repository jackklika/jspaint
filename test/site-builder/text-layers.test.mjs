import { assert, canvas_box, capture_saves, click_menu_item, open_paint, type_text_box } from "./helpers.mjs";

const { page, close } = await open_paint();
const layers = () => page.evaluate(() => (current_history_node.text_layers || []).map((t) => `${t.id}:"${t.text}"@${t.x},${t.y} ${t.font.family} href=${t.href}`));

await type_text_box(page, "Hello web", { x: 50, y: 50, tool: "Web Text" });
await page.waitForSelector(".text-layer", { timeout: 5000 });
assert.deepEqual(await layers(), ['t1:"Hello web"@50,50 "Arial" href=']);
assert.equal(await page.evaluate(() => current_history_node.name), "Finish Text");

// Select by clicking its middle; nudge; undo
const tl = await (await page.$(".text-layer-content")).boundingBox();
const middle = [tl.x + tl.width / 2, tl.y + tl.height / 2];
await page.mouse.click(...middle);
await page.keyboard.press("Shift+ArrowDown");
assert.match((await layers())[0], /@50,60 /);
await page.keyboard.press("Control+z");
assert.match((await layers())[0], /@50,50 /);

// Double-click reopens it in the textbox; committing keeps the id
await page.mouse.click(...middle);
await page.waitForTimeout(80);
await page.mouse.click(...middle);
await page.waitForSelector(".textbox", { timeout: 5000 });
assert.equal(await page.evaluate(() => textbox.$editor.val()), "Hello web");
await page.keyboard.press("End");
await page.keyboard.type(" page");
const c = await canvas_box(page);
await page.mouse.click(c.x + c.width - 20, c.y + c.height - 20);
await page.waitForSelector(".text-layer", { timeout: 5000 });
assert.deepEqual(await layers(), ['t1:"Hello web page"@50,50 "Arial" href=']);

// Link dialog
await page.mouse.click(...middle);
await click_menu_item(page, "Add Link to Element...");
await page.waitForSelector(".dialog-window input[type=text]", { timeout: 5000 });
await page.fill(".dialog-window input[type=text]", "https://example.com/");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
assert.match((await layers())[0], /href=https:\/\/example\.com\/$/);
assert.equal(await page.evaluate(() => document.querySelector(".text-layer").classList.contains("has-link")), true);

// Save as web page → reopen → identical
await capture_saves(page);
await click_menu_item(page, "Save as Web Page (HTML)...");
await page.waitForFunction(() => window.__saved.length === 1, null, { timeout: 10000 });
const html = await page.evaluate(() => window.__saved[0].text);
assert.match(html, /<a class="text" href="https:\/\/example\.com\/"[^>]*>Hello web page<\/a>/);
const before = await layers();
await page.evaluate(() => { saved = true; });
await click_menu_item(page, "New");
await page.waitForFunction(() => document.querySelectorAll(".text-layer").length === 0, null, { timeout: 5000 });
await page.evaluate((html) => { window.open_from_file(new File([html], "text.html", { type: "text/html" })); }, html);
await page.waitForSelector(".text-layer", { timeout: 10000 });
await page.waitForTimeout(400);
assert.deepEqual(await layers(), before);
assert.equal(await page.evaluate(() => file_format), "text/html");

// Flatten draws the text into the bitmap
await click_menu_item(page, "Flatten Text Layers");
await page.waitForTimeout(400);
assert.equal(await page.evaluate(() => document.querySelectorAll(".text-layer").length), 0);
const ink = await page.evaluate(() => main_ctx.getImageData(50, 50, 250, 70).data.filter((v, i) => i % 4 === 0 && v !== 255).length);
assert.ok(ink > 100, `text ink drawn: ${ink}`);

await close();
console.log("text-layers: ok");
