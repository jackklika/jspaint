// The Link tool (toolbox, below the groove): one link dialog for the selected element and for the words of a section
// being edited — an address, one of your pages (thumbnails, when signed in), or a section. No Workers needed here;
// my-site.test.mjs picks a page from the tiles.
/* global $status_text */
import { assert, canvas_box, make_gif, open_paint, paste_file, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint();
const c = await canvas_box(page);
const dialog_open = () => page.evaluate(() => !!document.querySelector(".link-window"));
const status = () => page.evaluate(() => $status_text.text());
const closed = () => page.waitForFunction(() => !document.querySelector(".link-window"), null, { timeout: 5000 });

// Nothing selected: a hint in the status bar, no dialog
await select_tool(page, "Link");
assert.equal(await dialog_open(), false);
assert.match(await status(), /Select a picture/);
assert.equal(await page.evaluate(() => selected_tool.id), "TOOL_BRUSH", "a one-shot tool: the brush stays selected");

// A picture (sticker): the dialog — signed out, no page tiles but a sign-in line — an address, OK: the sticker links there
await paste_file(page, await make_gif(page, { width: 40, height: 30 }));
await page.waitForSelector(".sticker.selected", { timeout: 5000 });
await select_tool(page, "Link");
await page.waitForSelector(".link-window", { timeout: 5000 });
assert.match(await page.$eval(".link-window .link-prompt", (el) => el.textContent), /this picture/);
assert.match(await page.$eval(".link-window .link-pages", (el) => el.textContent), /Sign in to My Site/);
assert.equal(await page.evaluate(() => document.querySelectorAll(".link-window input[type=text]").length), 1, "one text box (the address)");
await page.fill('.link-window input[name="link-url"]', "https://example.com/gif");
await page.click(".link-window button[type=submit]");
await closed();
assert.equal(await page.evaluate(() => current_history_node.stickers[0].href), "https://example.com/gif");
assert.equal(await page.evaluate(() => current_history_node.name), "Set Sticker Link");
// …and Remove Link takes it away
await select_tool(page, "Link");
await page.waitForSelector(".link-window", { timeout: 5000 });
assert.equal(await page.inputValue('.link-window input[name="link-url"]'), "https://example.com/gif");
await page.evaluate(() => [...document.querySelectorAll(".link-window button")].find((b) => b.textContent === "Remove Link").click());
await closed();
assert.equal(await page.evaluate(() => current_history_node.stickers[0].href), "");

// A text box, not being edited, becomes a link as a whole
await select_tool(page, "Text Box");
await page.mouse.click(c.x + 100, c.y + 400);
await page.waitForSelector(".block-layer.editing", { timeout: 5000 });
await page.keyboard.press("Escape");
await page.waitForSelector(".block-layer.selected", { timeout: 5000 });
await select_tool(page, "Link");
await page.waitForSelector(".link-window", { timeout: 5000 });
assert.match(await page.$eval(".link-window .link-prompt", (el) => el.textContent), /this element/);
await page.fill('.link-window input[name="link-url"]', "https://example.com/");
await page.keyboard.press("Enter");
await closed();
assert.match(await page.evaluate(() => (current_history_node.blocks || []).find((b) => b.kind === "paragraph").html), /^<a href="https:\/\/example\.com\/">.*<\/a>$/);

// A counter can't be a link: a hint, no dialog
await select_tool(page, "Visitor Counter");
await page.mouse.click(c.x + 400, c.y + 500);
await page.waitForFunction(() => (current_history_node.blocks || []).some((b) => b.kind === "x-counter"), null, { timeout: 5000 });
await select_tool(page, "Link");
assert.equal(await dialog_open(), false);
assert.match(await status(), /can't be a link/);

// A section being edited: a real click on the tool keeps the words selected (and the section editing), and links them
await select_tool(page, "Section");
await page.mouse.click(c.x + 100, c.y + 100);
await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
await page.keyboard.type("Read the about page");
for (let i = 0; i < 10; i++) { await page.keyboard.press("Shift+ArrowLeft"); } // select "about page"
await page.click('.tool[title="Link"]');
await page.waitForSelector(".link-window", { timeout: 5000 });
assert.equal(await page.evaluate(() => !!document.querySelector(".block-layer.flow.editing")), true, "still editing the section");
assert.match(await page.$eval(".link-window .link-prompt", (el) => el.textContent), /selected words/);
assert.equal(await page.evaluate(() => document.querySelector('.link-window select[name="link-section"]').disabled), true, "no other sections to offer");
await page.fill('.link-window input[name="link-url"]', "about.html");
await page.click(".link-window button[type=submit]");
await closed();
await page.keyboard.press("Escape");
const html = await page.evaluate(() => (current_history_node.blocks || []).find((b) => b.flow).html);
assert.match(html, /Read the <a href="about.html">about page<\/a>/, html);

await close();
console.log("link-tool: ok");
