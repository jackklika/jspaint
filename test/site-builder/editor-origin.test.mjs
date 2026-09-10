// Served by the editor Worker, a browser with no saved settings (e.g. incognito, opening a share link) talks to the
// origin it loaded from — whatever hostname that is — instead of the hard-coded hosted URL.
import { chromium } from "playwright";
import { assert } from "./helpers.mjs";

const editor = (process.env.SITE_BUILDER_EDITOR_URL || "").replace(/\/+$/, "");
if (!editor) {
	console.log("editor-origin: skipped (set SITE_BUILDER_EDITOR_URL to a running editor Worker)");
	process.exit(0);
}
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${editor}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".main-canvas", { timeout: 60000 });
assert.equal(await page.evaluate(() => document.querySelector('meta[name="jspaint-editor"]')?.getAttribute("content")), "self", "the build marks the editor's copy");
assert.equal(await page.evaluate(async () => (await import("/src/site-publish.js")).get_site_editor_url()), editor, "a fresh browser uses its own origin");
await browser.close();
console.log("editor-origin: ok");
