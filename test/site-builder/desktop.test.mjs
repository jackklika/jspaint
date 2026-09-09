// The desktop: sign in, edit a page with blocks (heading, marquee, counter), save, and read it back from the
// sites Worker; then a collage round-trip through the Paint window. Needs both Workers running locally, like publish.test.mjs:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=dev-secret-123
import { assert, make_gif } from "./helpers.mjs";
import { chromium } from "playwright";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const sites = process.env.SITE_BUILDER_SITES_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("desktop: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `desk-${Date.now().toString(36)}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") { errors.push(`console: ${m.text().slice(0, 300)}`); } });
page.on("response", (r) => { if (r.status() >= 400) { errors.push(`${r.status()} ${r.request().method()} ${r.url()}`); } });
await page.goto(`${editor}/desktop/`, { waitUntil: "domcontentloaded", timeout: 60000 });

// Sign in
await page.waitForSelector("#si-site", { timeout: 15000 });
await page.fill("#si-site", site);
await page.fill("#si-secret", secret);
await page.fill("#si-editor", editor);
await page.click("#si-ok");
await page.waitForSelector(".page-canvas", { timeout: 15000 });
await page.waitForFunction(() => document.querySelector("#site-indicator")?.textContent?.startsWith("~"), null, { timeout: 10000 });
assert.equal(await page.$eval("#site-indicator", (el) => el.textContent), `~${site}`);

// A fresh index.html has one heading; add a marquee, a paragraph, and a counter
await page.waitForFunction(() => document.querySelectorAll(".page-canvas > .block").length === 1, null, { timeout: 15000 });
await page.click('[data-add="marquee"]');
await page.click('[data-add="paragraph"]');
await page.waitForFunction(() => document.querySelectorAll(".x-elements button").length >= 2, null, { timeout: 15000 });
await page.click('.x-elements button:has-text("Visitor counter")');
assert.equal(await page.evaluate(() => document.querySelectorAll(".page-canvas > .block").length), 4);

// Type into the paragraph and make a word bold with the toolbar
const paragraph = page.locator('.page-canvas > .block-paragraph [contenteditable="true"]');
await paragraph.click();
await page.keyboard.press("Control+a");
await page.keyboard.type("hello from the desktop");
await page.keyboard.press("Shift+Home");
await page.click('[data-format="bold"]');
await page.click(".page-editor-body .save");
await page.waitForFunction(() => /Saved\./.test(document.querySelector(".page-editor-body .status-line")?.textContent || ""), null, { timeout: 30000 });

// Read it back from the sites Worker
const url = `${sites}/~${site}/`;
const response = await fetch(url);
assert.equal(response.status, 200);
const html = await response.text();
assert.match(html, /<h1><font face="Comic Sans MS" color="#ff1493">index<\/font><\/h1>/);
assert.match(html, /<marquee[^>]*>~\*~ welcome to my page ~\*~<\/marquee>/);
assert.match(html, /<p><b>hello from the desktop<\/b><\/p>|<p>[^<]*<b>[^<]*<\/b>[^<]*<\/p>/);
assert.match(html, /<x-counter>You are visitor number/); // rendered by the sites Worker
assert.match(html, /contenteditable/.test(html) ? /^$/ : /./, "no contenteditable leaks into the saved page");
assert.doesNotMatch(html, /contenteditable/);

// Collage round-trip: open Paint, paste a GIF sticker inside the frame, send it to the page editor
await page.click('[data-add="collage"]');
const frame_el = await page.waitForSelector("iframe.app-frame", { timeout: 15000 });
const frame = await frame_el.contentFrame();
await frame.waitForSelector(".main-canvas", { timeout: 60000 });
await frame.waitForTimeout(1500); // the desktop's open-collage message lands after Paint is ready
const gif = await make_gif(frame, { width: 40, height: 30 });
await frame.evaluate((bytes) => {
	const dt = new DataTransfer();
	dt.items.add(new File([new Uint8Array(bytes)], "a.gif", { type: "image/gif" }));
	window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, gif);
await frame.waitForSelector(".sticker", { timeout: 10000 });
await frame.evaluate(() => document.querySelector('[role=menuitem][aria-label="Send to Page Editor"]').click());
await page.waitForFunction(() => document.querySelectorAll(".page-canvas > .block-collage").length === 1, null, { timeout: 60000 });
// The Paint window overlaps the editor now; click Save programmatically rather than through the frame.
await page.evaluate(() => document.querySelector(".page-editor-body .save").click());
await page.waitForFunction(() => /Saved\./.test(document.querySelector(".page-editor-body .status-line")?.textContent || ""), null, { timeout: 30000 });
const html2 = await (await fetch(url)).text();
assert.match(html2, /<div class="collage"[^>]*>/);
assert.match(html2, /<img class="sticker" src="gifs\/[0-9a-f]{40}\.gif"/);
assert.match(html2, /class="bitmap" src="gifs\/[0-9a-f]{40}\.png"/);
const sticker_path = /src="(gifs\/[0-9a-f]{40}\.gif)"/.exec(html2)[1];
assert.equal((await fetch(`${sites}/~${site}/${sticker_path}`)).status, 200);

// Clean up
const headers = { Authorization: `Bearer ${secret}` };
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) {
	await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers });
}
await browser.close();
assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], "page errors");
console.log("desktop: ok");
