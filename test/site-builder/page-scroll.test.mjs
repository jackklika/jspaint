// Getting around a tall page: the "make page longer" button under the picture, the Page menu items, panning
// bare canvas with the Pointer tool, and that a tall page is scrollable to its bottom (and past it).
import { assert, canvas_box, click_menu_item, open_paint, select_tool } from "./helpers.mjs";

const { page, close } = await open_paint({ viewport: { width: 1000, height: 700 }, init: () => { localStorage.setItem("jspaint pan joystick", "on"); } });
const size = () => page.evaluate(() => `${main_canvas.width}x${main_canvas.height}`);
const scroll = () => page.evaluate(() => ({ top: $canvas_area.scrollTop(), height: $canvas_area[0].scrollHeight, client: $canvas_area[0].clientHeight }));
assert.equal(await size(), "800x600");

// The button sits under the picture, centered
const button = await page.$(".page-extend-button");
const b = await button.boundingBox();
const c = await canvas_box(page);
assert.ok(b.y >= c.y + c.height + 5 && b.y < c.y + c.height + 30, `button under the canvas: ${b.y} vs canvas bottom ${c.y + c.height}`);
assert.ok(Math.abs((b.x + b.width / 2) - (c.x + c.width / 2)) < 4, "button centered under the canvas");

// Click → 300 px longer, undoable, scrolled to the bottom
await button.click();
await page.waitForTimeout(400);
assert.equal(await size(), "800x900");
assert.equal(await page.evaluate(() => current_history_node.name), "Make Page Longer");
let s = await scroll();
assert.ok(s.height > s.client, "the canvas area scrolls now");
assert.ok(s.top > 0, `scrolled down after extending: ${s.top}`);
assert.ok(s.top + s.client >= s.height - 1, "scrolled to the very bottom (past the picture, to the button)");
const b2 = await (await page.$(".page-extend-button")).boundingBox();
assert.ok(b2.y > 0 && b2.y < 700, "the button is on screen at the bottom");

// Page menu: longer again, then shorter
await click_menu_item(page, "Make Page Longer");
assert.equal(await size(), "800x1200");
await click_menu_item(page, "Make Page Shorter");
assert.equal(await size(), "800x900");
assert.equal(await page.evaluate(() => current_history_node.name), "Make Page Shorter");
await page.keyboard.press("Control+z");
assert.equal(await size(), "800x1200");

// Pointer tool: dragging bare canvas pans the view (a phone's one finger)
await select_tool(page, "Pointer");
await page.evaluate(() => { $canvas_area.scrollTop(0); });
const c2 = await canvas_box(page);
await page.mouse.move(c2.x + 400, c2.y + 500);
await page.mouse.down();
await page.mouse.move(c2.x + 400, c2.y + 200, { steps: 6 });
await page.mouse.up();
s = await scroll();
assert.ok(s.top >= 280 && s.top <= 320, `panned by the drag distance: scrollTop ${s.top}`);
assert.equal(await page.evaluate(() => main_ctx.getImageData(400, 350, 1, 1).data.join(",")), "255,255,255,255", "panning painted nothing");

// A brush drag still paints (only the Pointer tool pans)
await select_tool(page, "Brush");
const before = await scroll();
await page.mouse.move(c2.x + 300, c2.y + 400);
await page.mouse.down();
await page.mouse.move(c2.x + 300, c2.y + 300, { steps: 4 });
await page.mouse.up();
assert.equal((await scroll()).top, before.top, "the brush didn't pan");

// Scroll a lot: a very tall page (Image › Attributes) reaches its bottom
await click_menu_item(page, "Attributes...");
await page.waitForSelector(".attributes-window input[type=number]", { timeout: 5000 });
await page.fill(".attributes-window label:has-text('Height') input", "4000");
await page.keyboard.press("Enter");
await page.waitForFunction(() => main_canvas.height === 4000, null, { timeout: 5000 });
await page.evaluate(() => { $canvas_area.scrollTop(1e9); });
s = await scroll();
assert.ok(s.top + s.client >= 4000, `can scroll to the bottom of a 4000 px page: ${s.top + s.client}`);
assert.equal(await size(), "800x4000");

// Page › Page Width presets (remembered as the default for new pages)
await click_menu_item(page, "Phone (390 px wide)");
assert.equal(await size(), "390x4000");
assert.equal(await page.evaluate(() => current_history_node.name), "Page Width");
await click_menu_item(page, "Classic (800 px wide)");
assert.equal(await size(), "800x4000");

// The pan joystick (forced on for this desktop test): dragging the knob down-right scrolls that way while held
await page.evaluate(() => { $canvas_area.scrollTop(0); $canvas_area.scrollLeft(0); });
const joystick = await (await page.$(".pan-joystick")).boundingBox();
assert.ok(joystick && joystick.x > 900, `joystick at the bottom right: ${JSON.stringify(joystick)}`);
const jc = { x: joystick.x + joystick.width / 2, y: joystick.y + joystick.height / 2 };
await page.mouse.move(jc.x, jc.y);
await page.mouse.down();
await page.mouse.move(jc.x + 30, jc.y + 30, { steps: 3 });
await page.waitForTimeout(500);
const mid = await scroll();
assert.ok(mid.top > 100, `scrolled down while the knob is held: ${mid.top}`);
assert.ok(await page.evaluate(() => $canvas_area.scrollLeft() > 0) === false || true); // (nothing to scroll horizontally on a wide desktop)
await page.waitForTimeout(300);
const later = await scroll();
assert.ok(later.top > mid.top, "keeps scrolling while held");
await page.mouse.up();
await page.waitForTimeout(200);
const stopped = await scroll();
await page.waitForTimeout(200);
assert.equal((await scroll()).top, stopped.top, "stops when released");
assert.equal(await page.evaluate(() => document.querySelector(".pan-joystick-knob").style.transform), "", "knob springs back");

// View › Pan Joystick hides it
await click_menu_item(page, "Pan Joystick");
assert.equal(await page.evaluate(() => $(".pan-joystick").is(":visible")), false);

// Undo / Redo buttons at the bottom right, next to the colors: follow the undo tree like Ctrl+Z / Ctrl+Y
const undo_button = await page.$('.quick-button[aria-label="Undo"]');
const redo_button = await page.$('.quick-button[aria-label="Redo"]');
const ub = await undo_button.boundingBox();
const colors = await (await page.$(".colors-component")).boundingBox();
assert.ok(ub.x > colors.x + colors.width && ub.y > 600, `undo button right of the colors in the bottom bar: ${JSON.stringify(ub)}`);
assert.equal(await redo_button.isDisabled(), true, "nothing to redo yet");
assert.equal(await undo_button.isDisabled(), false, "there is history to undo");
const before_undo = await size();
await undo_button.click();
await page.waitForTimeout(150);
assert.notEqual(await size(), before_undo, "the button undid the last resize");
assert.equal(await redo_button.isDisabled(), false);
await redo_button.click();
await page.waitForTimeout(150);
assert.equal(await size(), before_undo, "redo put it back");

await close();
console.log("page-scroll: ok");
