// Page Properties: the two color fields have a swatch that opens Paint's Edit Colors dialog; a pick lands in the field
// as #rrggbb and the swatch shows it; typing a color recolors the swatch; OK applies it to the page.
import { assert, click_menu_item, open_paint } from "./helpers.mjs";

const { page, close } = await open_paint();
await page.waitForTimeout(500);
await click_menu_item(page, "Page Properties...");
await page.waitForSelector(".page-properties-window", { timeout: 10000 });
const swatches = await page.$$eval(".page-properties-window .page-properties-swatch", (els) => els.map((el) => el.getAttribute("aria-label")));
assert.deepEqual(swatches, ["Pick a color for Background color", "Pick a color for Text color"]);
// Empty background: the swatch shows white with a slash; the text swatch is black
assert.equal(await page.$eval(".page-properties-window .page-properties-swatch", (el) => el.classList.contains("empty")), true);
assert.equal(await page.$eval(".page-properties-window .page-properties-swatch:nth-of-type(1)", (el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");

// The background swatch opens Edit Colors — the same dialog as Colors › Edit Colors…; a basic swatch, OK → hex in the field
await page.click(".page-properties-window .page-properties-swatch");
await page.waitForSelector(".edit-colors-window", { timeout: 10000 });
// (a real click: the dialog's swatches listen to the pointer, not to synthetic click events)
const swatch_handles = await page.$$(".edit-colors-window .swatch");
const colors = await Promise.all(swatch_handles.map((h) => h.getAttribute("data-color")));
let index = colors.findIndex((color) => /^rgb\(255, 0, 0\)$|^#ff0000$/i.test(color || ""));
if (index === -1) { index = colors.findIndex((color, i) => i > 0 && color && !/^rgb\(255, 255, 255\)$|^#fff(fff)?$/i.test(color)); }
const picked = colors[index];
await swatch_handles[index].click();
await page.waitForTimeout(150);
await page.evaluate(() => { [...document.querySelectorAll(".edit-colors-window button")].find((b) => b.textContent === "OK").click(); });
await page.waitForSelector(".edit-colors-window", { state: "detached", timeout: 5000 });
const hex = await page.$eval(".page-properties-window input", (el) => el.value);
assert.match(hex, /^#[0-9a-f]{6}$/, `a hex color (picked ${picked}): ${hex}`);
const expected = await page.evaluate((color) => {
	const c = document.createElement("canvas").getContext("2d");
	c.fillStyle = color;
	return c.fillStyle;
}, picked);
assert.equal(hex, expected, "the field holds the picked swatch's color");
assert.equal(await page.$eval(".page-properties-window .page-properties-swatch", (el) => el.classList.contains("empty")), false);
const as_rgb = (/** @type {string} */ h) => page.evaluate((h) => {
	const d = document.createElement("div");
	d.style.background = h;
	document.body.append(d);
	const v = getComputedStyle(d).backgroundColor;
	d.remove();
	return v;
}, h);
assert.equal(await page.$eval(".page-properties-window .page-properties-swatch", (el) => getComputedStyle(el).backgroundColor), await as_rgb(hex), "the swatch shows the pick");

// Typing recolors the text swatch; OK applies both to the page
await page.fill(".page-properties-window .page-properties-row:nth-of-type(2) input", "#0000ff");
assert.equal(await page.$eval(".page-properties-window .page-properties-row:nth-of-type(2) .page-properties-swatch", (el) => getComputedStyle(el).backgroundColor), "rgb(0, 0, 255)");
await page.evaluate(() => { [...document.querySelectorAll(".page-properties-window button")].find((b) => b.textContent === "OK").click(); });
await page.waitForSelector(".page-properties-window", { state: "detached", timeout: 5000 });
const props = await page.evaluate(async () => (await import("/src/page-properties.js")).get_page_properties());
assert.equal(props.bgcolor, hex);
assert.equal(props.text_color, "#0000ff");

await close();
console.log("page-properties: ok");
