// The tabs above the canvas: the site's pages, a click switches, and every page keeps its edits in its own draft
// session — leaving a page asks nothing and publishes nothing; coming back finds the edits; only Publish
// publishes. Too many pages: a "…" opens My Pages. Needs both Workers running locally, like publish.test.mjs.
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const sites = process.env.SITE_BUILDER_SITES_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("page-tabs: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `tabs-${Date.now().toString(36)}`;
const settings = { site, secret, editor_url: editor, page: "index.html", remember_secret: true };
const seed = (/** @type {any} */ arg) => { localStorage.setItem("jspaint site publish settings", JSON.stringify(arg)); };
const headers = { Authorization: `Bearer ${secret}` };
const publish = (/** @type {import("playwright").Page} */ page, /** @type {string} */ path) => page.evaluate(async (path) => {
	await (await import("/src/my-site.js")).save_page_to_site(path);
}, path).then(() => page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 }))
	.then(() => page.evaluate(() => { [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel")?.click(); }));
const tabs = (/** @type {import("playwright").Page} */ page) => page.evaluate(() => [...document.querySelectorAll(".page-tab")].filter((t) => t.style.display !== "none").map((t) => `${t.textContent}${t.classList.contains("current") ? "*" : ""}`));
const pixel = (/** @type {import("playwright").Page} */ page) => page.evaluate(() => main_ctx.getImageData(100, 100, 1, 1).data.join(","));

// Two pages on the site, made in Paint
{
	const { page, close } = await open_paint({ init: seed, init_arg: settings });
	await page.waitForTimeout(1500);
	await page.evaluate(() => { document.querySelector(".page-loading-panel")?.remove(); document.body.classList.remove("page-loading"); });
	await publish(page, "index.html");
	await publish(page, "about.html");
	await close();
}

// A fresh visit opens the front page; the bar shows both pages, index pressed
const { page, close } = await open_paint({ init: seed, init_arg: settings });
await page.waitForFunction(() => file_name === "index.html", null, { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll(".page-tab").length === 2, null, { timeout: 15000 });
assert.deepEqual(await tabs(page), ["index.html*", "about.html"]);
assert.equal(await page.$eval(".page-path-site", (el) => el.textContent), `~${site}/`);
assert.equal(await page.evaluate(() => !!document.querySelector(".page-path-label:not([style*='display: none'])") && document.querySelector(".page-path-label").offsetParent !== null), false, "tabs, not the single label");

// Draw on index; switch to about: no question asked, nothing published
const c = await canvas_box(page);
await select_tool(page, "Brush");
await page.mouse.click(c.x + 100, c.y + 100);
await page.waitForFunction(() => main_ctx.getImageData(100, 100, 1, 1).data.join(",") !== "255,255,255,255", null, { timeout: 5000 });
const painted = await pixel(page);
const index_session = await page.evaluate(() => location.hash);
await page.click('.page-tab[data-page="about.html"]');
await page.waitForFunction(() => file_name === "about.html", null, { timeout: 20000 });
assert.equal(await page.evaluate(() => [...document.querySelectorAll(".window")].some((w) => /Save changes/.test(w.textContent))), false, "no save prompt");
await page.waitForFunction(() => document.querySelector(".page-tab.current")?.textContent === "about.html", null, { timeout: 10000 });
assert.deepEqual(await tabs(page), ["index.html", "about.html*"]);
assert.equal(await pixel(page), "255,255,255,255", "about is untouched");
assert.notEqual(await page.evaluate(() => location.hash), index_session, "about has its own session");
const version = async () => /collages\/index\.png\?v=([0-9a-f]+)/.exec(await (await fetch(`${sites}/~${site}/index.html`, { cache: "no-store" })).text())?.[1];
const published_index = await version();

// Back to index: the draft, stroke and all — and the site still has the published version
await page.click('.page-tab[data-page="index.html"]');
await page.waitForFunction(() => file_name === "index.html", null, { timeout: 20000 });
await page.waitForFunction((painted) => main_ctx.getImageData(100, 100, 1, 1).data.join(",") === painted, painted, { timeout: 30000 });
assert.equal(await page.evaluate(() => location.hash), index_session, "the same draft session");
assert.deepEqual(await page.evaluate(() => system_file_handle), { site_page: "index.html", site }, "still that page of the site: Ctrl+S publishes it");
assert.equal(await version(), published_index, "nothing was published by switching");

// Publishing is explicit: Ctrl+S puts the draft on the site
await page.keyboard.press("Control+s");
await page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
assert.match(await page.$eval(".site-publish-log", (el) => el.innerText), /Done!/);
assert.notEqual(await version(), published_index, "now it's published");
await page.evaluate(() => { [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel")?.click(); });

// A tab whose remembered draft isn't that page (a session shared by two pages, another site's, a session that's gone):
// the page comes from the site instead, in a session of its own — never "untitled — not on a site"
await page.evaluate(() => {
	const drafts = JSON.parse(localStorage.getItem("jspaint site drafts") || "{}");
	const key = Object.keys(drafts).find((k) => k.endsWith("/about.html"));
	drafts[key] = { session: "deadbeefdeadbe", at: Date.now() };
	localStorage.setItem("jspaint site drafts", JSON.stringify(drafts));
});
await page.click('.page-tab[data-page="about.html"]');
await page.waitForFunction(() => file_name === "about.html" && system_file_handle && system_file_handle.site_page === "about.html", null, { timeout: 20000 });
assert.equal(await page.evaluate(() => !!document.querySelector(".page-path-label") && document.querySelector(".page-path-label").offsetParent !== null), false, "still tabs, not the single label");
await page.waitForFunction(() => document.querySelector(".page-tab.current")?.textContent === "about.html", null, { timeout: 10000 });
assert.notEqual(await page.evaluate(() => location.hash), "#local:deadbeefdeadbe", "the broken draft was left behind");
await page.click('.page-tab[data-page="index.html"]');
await page.waitForFunction(() => file_name === "index.html", null, { timeout: 20000 });

// The + tab: a new page, named in the same New Page dialog as My Site › Pages; it opens fresh and becomes the
// current tab (on the site once saved)
await page.click(".page-tabs-new");
const new_page_input = ".dialog-window:has(.window-title:text-is('New Page')) input[type=text]";
await page.waitForSelector(new_page_input, { timeout: 5000 });
assert.equal(await page.inputValue(new_page_input), "about.html", "the site has a front page: the suggestion is another name");
await page.fill(new_page_input, "contact");
await page.keyboard.press("Enter");
await page.waitForFunction(() => file_name === "contact.html" && system_file_handle && system_file_handle.fresh === true, null, { timeout: 15000 });
await page.waitForFunction(() => document.querySelector(".page-tab.current")?.textContent === "contact.html", null, { timeout: 10000 });
assert.deepEqual(await tabs(page), ["contact.html*", "index.html", "about.html"], "the fresh page leads the tabs until it's listed");
assert.equal(await page.evaluate(() => [...document.querySelectorAll(".window")].some((w) => /Save changes/.test(w.textContent))), false, "no save prompt on the way");
await page.keyboard.press("Control+s");
await page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
await page.evaluate(() => { [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel")?.click(); });
await page.waitForFunction(() => [...document.querySelectorAll(".page-tab")].map((t) => t.textContent).join() === "index.html,about.html,contact.html", null, { timeout: 15000 });

// Too many pages for the bar: "…" shows, and opens My Pages
for (let i = 1; i <= 14; i++) {
	await fetch(`${editor}/api/sites/${site}/files/posts/entry-number-${i}.html`, { method: "PUT", headers: { ...headers, "Content-Type": "text/html" }, body: `<html><head><title>${i}</title></head><body>${i}</body></html>` });
}
await page.evaluate(async () => { const m = await import("/src/my-site.js"); await m.switch_page("about.html"); }); // (a switch lists the pages again)
await page.waitForFunction(() => document.querySelectorAll(".page-tab").length === 17, null, { timeout: 15000 });
await page.waitForSelector(".page-tabs-more:visible", { timeout: 10000 });
assert.equal((await tabs(page))[0], "about.html*", "the current page is always in view");
await page.click(".page-tabs-more");
await page.waitForSelector(".my-site-window", { timeout: 10000 });
assert.equal(await page.getAttribute(".my-site-window .my-site-tab.selected", "data-tab"), "pages");

// Clean up
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }); }
await close();
console.log("page-tabs: ok");
