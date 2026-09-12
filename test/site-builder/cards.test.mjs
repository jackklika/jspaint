// Cards inside a section: "/" on an empty line opens the Insert menu; a callout, a toggle, a button, and one of the
// site's elements go into the flow of the text; a card moves with ↑/↓ and by dragging (the text shifts), is removed
// with ✕, and publishes as plain markup (no editing attributes, toggles closed). No Workers needed for most of it;
// with them, the published page renders a counter inside the section.
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint();
const c = await canvas_box(page);
const html = () => page.evaluate(() => (current_history_node.blocks || []).find((b) => b.flow).html);
/** A fresh empty line after a card, with the caret on it (what Enter after the card's text gives you). @param {string} kind */
const new_line_after = (kind) => page.evaluate((kind) => {
	const card = document.querySelector(`.block-layer.flow [data-card="${kind}"]`);
	const p = document.createElement("p");
	p.innerHTML = "<br>";
	card.after(p);
	const range = document.createRange();
	range.setStart(p, 0);
	range.collapse(true);
	const selection = document.getSelection();
	selection.removeAllRanges();
	selection.addRange(range);
}, kind);
const cards = () => page.evaluate(() => [...document.querySelectorAll(".block-layer.flow .block-el [data-card]")].map((el) => el.dataset.card));

// A section; Enter makes an empty line; "/" there opens the menu; typing filters it; Enter picks
await select_tool(page, "Section");
await page.mouse.click(c.x + 40, c.y + 80);
await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
await page.keyboard.type("A post with cards");
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.press("/");
await page.waitForSelector(".card-menu", { timeout: 5000 });
assert.ok((await page.evaluate(() => [...document.querySelectorAll(".card-menu-item")].map((el) => el.dataset.cardKind))).includes("x-counter"), "the site's elements are offered too");
await page.keyboard.type("call");
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".card-menu-item")].map((el) => el.dataset.cardKind)), ["callout"]);
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.querySelector(".card-menu") && document.querySelector('.block-layer.flow [data-card="callout"]'), null, { timeout: 5000 });
assert.equal(await page.evaluate(() => !!document.querySelector(".block-layer.flow.editing")), true, "still editing");
// The caret is in the callout's text (its placeholder selected): typing replaces it
await page.keyboard.type("Mind the gap.");
assert.match(await html(), /<div class="card callout" data-card="callout" style="background:[^"]*"><span class="callout-emoji card-text">💡<\/span><div class="callout-text card-text"><p>Mind the gap\.<\/p><\/div><\/div>/, await html());
assert.doesNotMatch(await html(), /contenteditable/, "editing attributes stay out of the model");

// Enter after the card's text: a paragraph below; a toggle there via the Font toolbar's Insert
await page.keyboard.press("Escape"); // (deselects nothing; the caret stays)
assert.equal(await page.evaluate(() => !!document.querySelector(".block-layer.flow.editing")), true);
await new_line_after("callout");
await page.evaluate(() => { const b = /** @type {HTMLElement} */ (document.querySelector('.font-box button[aria-label="Insert"]')); b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); b.click(); });
await page.waitForSelector(".card-menu", { timeout: 5000 });
await page.click('.card-menu-item[data-card-kind="toggle"]');
await page.waitForSelector('.block-layer.flow [data-card="toggle"]', { timeout: 5000 });
await page.keyboard.type("Spoilers ahead, mind you");
assert.deepEqual(await cards(), ["callout", "toggle"]);
assert.match(await html(), /<details class="card toggle" data-card="toggle"><summary class="card-text">Spoilers ahead, mind you<\/summary>/, "the toggle is closed in the model (open while editing); spaces typed into its title survive");
assert.equal(await page.evaluate(() => document.querySelector('.block-layer.flow [data-card="toggle"]').hasAttribute("open")), true, "…but open in the editor, so its text can be reached");

// Select the toggle as a whole (click its chrome, not its text) → the grip shows; ↑ moves it above the callout; ✕ removes it
await page.evaluate(() => document.querySelector('.block-layer.flow [data-card="toggle"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
await page.waitForSelector(".card-grip:visible", { timeout: 5000 });
await page.keyboard.press("ArrowUp");
assert.deepEqual(await cards(), ["toggle", "callout"], "↑ moved the toggle above the callout");
await page.keyboard.press("ArrowDown");
assert.deepEqual(await cards(), ["callout", "toggle"]);
assert.equal(await page.evaluate(() => current_history_node.name), "Edit Text", "one coalesced step");
await page.click(".card-grip button[aria-label='Remove the card']");
assert.deepEqual(await cards(), ["callout"]);

// A button card: its label is typed; its link comes from the link dialog (the grip's 🔗)
await new_line_after("callout");
await page.keyboard.press("/");
await page.waitForSelector(".card-menu", { timeout: 5000 });
await page.keyboard.type("butt");
await page.keyboard.press("Enter");
await page.waitForSelector('.block-layer.flow [data-card="button"]', { timeout: 5000 });
await page.keyboard.type("Read more");
await page.evaluate(() => document.querySelector('.block-layer.flow [data-card="button"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
await page.waitForSelector(".card-grip button[aria-label='Where the button goes']:visible", { timeout: 5000 });
await page.click(".card-grip button[aria-label='Where the button goes']");
await page.waitForSelector(".link-window", { timeout: 5000 });
await page.fill('.link-window input[name="link-url"]', "https://example.com/more");
await page.click(".link-window button[type=submit]");
await page.waitForFunction(() => !document.querySelector(".link-window"), null, { timeout: 5000 });
assert.match(await html(), /<p class="card button-card" data-card="button" align="center"><a class="button card-text" href="https:\/\/example\.com\/more">Read more<\/a><\/p>/, await html());

// One of the site's elements, inside the text
await new_line_after("button");
await page.keyboard.press("/");
await page.waitForSelector(".card-menu", { timeout: 5000 });
await page.keyboard.type("counter");
await page.keyboard.press("Enter");
await page.waitForSelector('.block-layer.flow x-counter[data-card="x-element"]', { timeout: 5000 });
assert.match(await html(), /<x-counter class="card" data-card="x-element"[^>]*>[\s\S]*<\/x-counter>/, await html());
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector(".block-layer.flow.editing"), null, { timeout: 5000 });

// A second section; dragging a card by its grip into it moves it there (the text shifts)
await select_tool(page, "Section");
await page.mouse.click(c.x + 780, c.y + 80);
await page.waitForFunction(() => document.querySelectorAll(".block-layer.flow").length === 2, null, { timeout: 5000 });
await page.keyboard.type("Second section");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
const first = await (await page.$$(".block-layer.flow .block-content"))[0].boundingBox();
await page.mouse.dblclick(first.x + 20, first.y + 8); // into the first section's heading, to edit it
await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
await page.evaluate(() => document.querySelector('.block-layer.flow [data-card="callout"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
await page.waitForSelector(".card-grip:visible", { timeout: 5000 });
const handle = await (await page.$(".card-grip-handle")).boundingBox();
const second = await (await page.$$(".block-layer.flow .block-el"))[1].boundingBox();
await page.mouse.move(handle.x + 6, handle.y + 6);
await page.mouse.down();
await page.mouse.move(second.x + 40, second.y + second.height - 4, { steps: 8 });
await page.waitForSelector(".card-drop-line:visible", { timeout: 5000 });
await page.mouse.up();
const both = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow).map((b) => (b.html.match(/data-card="([^"]+)"/g) || []).join(",")));
assert.deepEqual(both, ['data-card="button",data-card="x-element"', 'data-card="callout"'], `the callout moved to the second section: ${JSON.stringify(both)}`);

// Published: the cards are plain markup; the column carries its geometry for wide/full cards; the page's CSS styles them
const published = await page.evaluate(async () => (await import("/src/collage-format.js")).serialize_collage_html());
assert.match(published, /<div class="column" style="[^"]*--column-left:\d+px;--page-width:800px">/);
assert.match(published, /<p class="card button-card" data-card="button" align="center"><a class="button card-text" href="https:\/\/example\.com\/more">Read more<\/a><\/p>/);
assert.match(published, /<x-counter class="card" data-card="x-element"/);
assert.match(published, /<div class="card callout" data-card="callout"/);
assert.doesNotMatch(published, /contenteditable/);
assert.match(published, /\.column > \.section a\.button \{ display: inline-block;/, "card styles travel with the page");

await close();
console.log("cards: ok");
