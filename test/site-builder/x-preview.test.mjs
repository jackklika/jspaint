// <x-*> elements on the canvas show what the site shows for them: the visitor counter's real count (a look that
// doesn't count as a visit), the folder view's actual pages, the contents list's sections, the last-updated date —
// no dotted outline or badge (the tag shows only while selected). Double-clicking a folder view opens its settings,
// where the folder is a pick from the site's folders (or a new one). Needs both Workers running locally.
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const sites = process.env.SITE_BUILDER_SITES_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("x-preview: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `xp-${Date.now().toString(36)}`;
const headers = { Authorization: `Bearer ${secret}` };
const put = (path, html) => fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": "text/html" }, body: html });
const settings = { site, secret, editor_url: editor, page: "index.html", remember_secret: true };
const seed = (arg) => { localStorage.setItem("jspaint site publish settings", JSON.stringify(arg)); };
const publish = (page) => page.keyboard.press("Control+s")
	.then(() => page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 }))
	.then(() => page.evaluate(() => { [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel")?.click(); }));
const shown = (page, tag) => page.evaluate((tag) => document.querySelector(`.block-layer[data-tag="${tag}"] .block-el`)?.innerHTML || "", tag);
const digits = (html) => [...html.matchAll(/<span[^>]*>(\d)<\/span>/g)].map((m) => m[1]).join("");

await put("posts/hello.html", "<html><head><title>Hello there</title></head><body>hi</body></html>");
await put("posts/second.html", "<html><head><title>Second post</title></head><body>2</body></html>");

const { page, close } = await open_paint({ init: seed, init_arg: settings });
await page.waitForTimeout(1500);
await page.evaluate(() => { document.querySelector(".page-loading-panel")?.remove(); document.body.classList.remove("page-loading"); });
await page.evaluate(async () => { await (await import("/src/my-site.js")).save_page_to_site("index.html"); });
await page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
await page.evaluate(() => { [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel")?.click(); });
await page.waitForFunction(() => system_file_handle && system_file_handle.site_page === "index.html", null, { timeout: 10000 });
const c = await canvas_box(page);

// A visitor counter shows the page's real count — nobody has visited: 000000 — not the placeholder
await select_tool(page, "Visitor Counter");
await page.mouse.click(c.x + 100, c.y + 400);
await page.waitForFunction(() => /<span/.test(document.querySelector('.block-layer[data-tag="x-counter"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });
assert.equal(digits(await shown(page, "x-counter")), "000000");
assert.match(await shown(page, "x-counter"), /^You are visitor number /);
assert.equal(await page.evaluate(() => current_history_node.blocks.find((b) => b.tag === "x-counter").html), "You are visitor number <b>000123</b>", "the model keeps the fallback");
// …and looks like the page: no dotted outline, no tag badge until it's selected
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.block-layer[data-tag="x-counter"] .block-el')).outlineStyle), "none");
await page.mouse.click(c.x + 600, c.y + 550); // deselect
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.block-layer[data-tag="x-counter"]'), "::after").content), "none", "no badge when not selected");
await select_tool(page, "Pointer");
await page.mouse.click(c.x + 150, c.y + 410);
assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.block-layer[data-tag="x-counter"]'), "::after").content), /x-counter/, "the badge shows while selected");
await page.mouse.click(c.x + 600, c.y + 550);

// Looking didn't count: the first real visit is number 1. Two visits, then the editor shows 2 after a save.
await publish(page);
const served = async () => digits(await (await fetch(`${sites}/~${site}/index.html`, { cache: "no-store" })).text());
assert.equal(await served(), "000001", "previews never counted as visits");
assert.equal(await served(), "000002");
await publish(page); // (a save asks the site again)
await page.waitForFunction(() => /<span[^>]*>2<\/span>/.test(document.querySelector('.block-layer[data-tag="x-counter"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });
assert.equal(digits(await shown(page, "x-counter")), "000002");

// A folder view lists the folder's pages, by title
await select_tool(page, "Folder View");
await page.mouse.click(c.x + 100, c.y + 100);
await page.waitForFunction(() => /folder-item/.test(document.querySelector('.block-layer[data-tag="x-folder"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });
let folder_html = await shown(page, "x-folder");
assert.match(folder_html, /Hello there/);
assert.match(folder_html, /Second post/);
assert.equal((folder_html.match(/folder-item/g) || []).length, 2);

// Double-click it: its settings, with the folder as a pick from the site's folders; a new folder by name
await select_tool(page, "Pointer");
await page.mouse.click(c.x + 600, c.y + 550);
await page.mouse.dblclick(c.x + 150, c.y + 130);
await page.waitForSelector(".block-properties-window select.block-properties-folder", { timeout: 10000 });
await page.waitForFunction(() => [...document.querySelectorAll(".block-properties-folder option")].some((o) => o.value === "posts"), null, { timeout: 10000 });
assert.equal(await page.$eval(".block-properties-folder", (el) => el.value), "posts");
assert.deepEqual(await page.$$eval(".block-properties-folder option", (els) => els.map((o) => o.value)), ["posts", "__new"]);
await page.selectOption(".block-properties-folder", "__new");
await page.waitForSelector(".block-properties-folder-name:visible", { timeout: 5000 });
await page.fill(".block-properties-folder-name", "notes");
await page.evaluate(() => { [...document.querySelectorAll(".block-properties-window button")].find((b) => b.textContent === "OK").click(); });
await page.waitForFunction(() => current_history_node.blocks.find((b) => b.tag === "x-folder")?.attrs.path === "notes", null, { timeout: 5000 });
await page.waitForFunction(() => /Nothing in notes/.test(document.querySelector('.block-layer[data-tag="x-folder"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });
await put("notes/a.html", "<html><head><title>A note</title></head><body>a</body></html>");
await publish(page);
await page.waitForFunction(() => /A note/.test(document.querySelector('.block-layer[data-tag="x-folder"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });

// Contents lists the page's sections (they get their anchors when the page is saved); Last Updated shows a date
await select_tool(page, "Contents");
await page.mouse.click(c.x + 500, c.y + 100);
await select_tool(page, "Section");
await page.mouse.click(c.x + 100, c.y + 250);
await page.keyboard.press("Escape");
await select_tool(page, "Last Updated");
await page.mouse.click(c.x + 500, c.y + 400);
await page.waitForFunction(() => /<i>\d{4}-\d{2}-\d{2}<\/i>/.test(document.querySelector('.block-layer[data-tag="x-updated"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });
await publish(page);
await page.waitForFunction(() => /toc-item/.test(document.querySelector('.block-layer[data-tag="x-toc"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });

// The published page holds the fallbacks, rendered by the site when served
const html = await (await fetch(`${sites}/~${site}/index.html`, { cache: "no-store" })).text();
assert.match(html, /<x-folder path="notes"[^>]*>.*A note.*<\/x-folder>/s);
assert.match(html, /<x-toc[^>]*>.*toc-item.*<\/x-toc>/s);

// Clean up
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }); }
await close();
console.log("x-preview: ok");
