// My Site inside Paint: sign in, make a new page, add an element, Ctrl+S saves it to the site, the sites Worker
// serves it (with the counter rendered), and the My Site folder lists it and opens it back into Paint.
// Needs both Workers running locally, like publish.test.mjs:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=dev-secret-123
import { assert, canvas_box, click_menu_item, open_paint, select_tool } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const sites = process.env.SITE_BUILDER_SITES_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("my-site: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `site-${Date.now().toString(36)}`;
// The site gets its own password (minted with the master key); Paint signs in with that, not the master.
const minted = await (await fetch(`${editor}/api/sites/${site}/password`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } })).json();
assert.match(minted.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
const { page, close } = await open_paint();

// Sign in
await click_menu_item(page, "Sign In to My Site...");
await page.waitForSelector(".my-site-sign-in", { timeout: 5000 });
await page.fill('.my-site-sign-in input[name="site-name"]', site);
await page.fill('.my-site-sign-in input[name="password"]', minted.password);
await page.fill('.my-site-sign-in input[name="editor-url"]', editor);
await page.click(".my-site-sign-in button[type=submit]");
await page.waitForFunction(() => !document.querySelector(".my-site-sign-in"), null, { timeout: 15000 });

// Signed in, the toolbox globe shows the site view: address, and Browse Files… opens the folder
assert.match(await page.getAttribute(".site-globe-button", "title"), new RegExp(`~${site}`));
await page.click(".site-globe-button");
await page.waitForSelector(".site-view-window", { timeout: 5000 });
assert.match(await page.$eval(".site-view-window", (el) => el.textContent), new RegExp(`~${site}`));
assert.equal(await page.$eval(".site-view-window a[target=_blank]", (el) => el.getAttribute("href")), `${sites}/~${site}/`);
await page.evaluate(() => [...document.querySelectorAll(".site-view-window button")].find((b) => b.textContent === "Browse Files…").click());
await page.waitForSelector(".my-site-window", { timeout: 10000 });
await page.waitForFunction(() => !document.querySelector(".site-view-window"), null, { timeout: 5000 });

// My Site → New Page… → about.html
await click_menu_item(page, "My Site...");
await page.waitForSelector(".my-site-window", { timeout: 10000 });
await page.evaluate(() => [...document.querySelectorAll(".my-site-toolbar button")].find((b) => b.textContent === "New Page…").click());
await page.waitForSelector(".dialog-window input[placeholder='about.html']", { timeout: 5000 });
await page.keyboard.press("Enter");
await page.waitForSelector(".block-layer", { timeout: 10000 });
assert.equal(await page.evaluate(() => file_name), "about.html");
assert.match(await page.evaluate(() => document.querySelector(".block-layer .block-el").textContent), /about/);
await page.keyboard.press("Escape");

// Add a counter, then Ctrl+S saves to the site (the publish dialog runs by itself)
await select_tool(page, "Visitor Counter");
const c = await canvas_box(page);
await page.mouse.click(c.x + 60, c.y + 300);
await page.waitForFunction(() => (current_history_node.blocks || []).length === 2, null, { timeout: 5000 });
await page.keyboard.press("Control+s");
await page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
const log = await page.$eval(".site-publish-log", (el) => el.innerText);
assert.match(log, /Done!/, log);
assert.equal(await page.evaluate(() => saved), true);
await page.evaluate(() => [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel").click());

// The sites Worker serves it, with the counter rendered
const url = `${sites}/~${site}/about.html`;
const response = await fetch(url);
assert.equal(response.status, 200);
const html = await response.text();
assert.match(html, /<h1 class="block"[^>]*><font face="Comic Sans MS" color="#ff1493">about<\/font><\/h1>/);
assert.match(html, /<x-counter class="block"[^>]*>You are visitor number/);
assert.doesNotMatch(html, /000123/, "the fallback was replaced by the rendered counter");

// My Site lists it; opening it brings the elements back
await page.evaluate(() => { saved = true; });
await click_menu_item(page, "New");
await page.waitForFunction(() => document.querySelectorAll(".block-layer").length === 0, null, { timeout: 5000 });
await click_menu_item(page, "My Site...");
await page.waitForSelector(".my-site-window .my-site-row", { timeout: 15000 });
const names = await page.evaluate(() => [...document.querySelectorAll(".my-site-name")].map((el) => el.textContent));
assert.ok(names.includes("about.html") && names.includes("collages/about.png"), names.join(","));
await page.evaluate(() => [...document.querySelectorAll(".my-site-row")].find((row) => row.querySelector(".my-site-name").textContent === "about.html").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
await page.waitForFunction(() => document.querySelectorAll(".block-layer").length === 2, null, { timeout: 15000 });
assert.equal(await page.evaluate(() => file_name), "about.html");
assert.deepEqual(await page.evaluate(() => system_file_handle), { site_page: "about.html" });

// edit.<domain>/~site/about.html → Paint with ?site=&page=: a fresh browser gets Sign In prefilled, then the page
{
	const { page: fresh, close: close_fresh } = await open_paint({ query: `?site=${site}&page=about.html` });
	await fresh.waitForSelector(".my-site-sign-in", { timeout: 10000 });
	assert.equal(await fresh.inputValue('.my-site-sign-in input[name="site-name"]'), site, "prefilled");
	assert.equal(await fresh.evaluate(() => location.search), "", "the query is consumed");
	await fresh.fill('.my-site-sign-in input[name="password"]', minted.password);
	await fresh.fill('.my-site-sign-in input[name="editor-url"]', editor);
	await fresh.click(".my-site-sign-in button[type=submit]");
	await fresh.waitForFunction(() => file_name === "about.html", null, { timeout: 20000 });
	assert.deepEqual(await fresh.evaluate(() => system_file_handle), { site_page: "about.html" });
	await close_fresh();
}
// Already signed in as that site: ?site= opens the folder, no dialog
{
	const seed = (/** @type {any} */ arg) => { localStorage.setItem("jspaint site publish settings", JSON.stringify(arg)); };
	const { page: known, close: close_known } = await open_paint({ query: `?site=${site}`, init: seed, init_arg: { site, secret: minted.password, editor_url: editor, page: "index.html", remember_secret: true } });
	await known.waitForSelector(".my-site-window", { timeout: 15000 });
	assert.equal(await known.evaluate(() => !!document.querySelector(".my-site-sign-in")), false);
	await close_known();
	// Signed in as one site, sent to another: the dialog, prefilled with the other one
	const { page: elsewhere, close: close_elsewhere } = await open_paint({ query: `?site=other-${site}`, init: seed, init_arg: { site, secret: minted.password, editor_url: editor, page: "index.html", remember_secret: true } });
	await elsewhere.waitForSelector(".my-site-sign-in", { timeout: 10000 });
	assert.equal(await elsewhere.inputValue('.my-site-sign-in input[name="site-name"]'), `other-${site}`);
	await close_elsewhere();
}
// The root site is the domain itself: its address has no /~root/
{
	const { page: root, close: close_root } = await open_paint({ query: "?site=root" });
	await root.waitForSelector(".my-site-sign-in", { timeout: 10000 });
	assert.match(await root.$eval(".my-site-sign-in p", (el) => el.textContent), /front page of the domain/);
	await root.fill('.my-site-sign-in input[name="password"]', secret); // the master key opens root too
	await root.fill('.my-site-sign-in input[name="editor-url"]', editor);
	await root.click(".my-site-sign-in button[type=submit]");
	await root.waitForSelector(".my-site-window", { timeout: 15000 });
	await root.evaluate(() => [...document.querySelectorAll(".my-site-window button")].find((b) => b.textContent === "Close")?.click());
	await root.click(".site-globe-button");
	await root.waitForSelector(".site-view-window", { timeout: 5000 });
	assert.equal(await root.$eval(".site-view-window a[target=_blank]", (el) => el.getAttribute("href")), `${sites}/`);
	await close_root();
}

// Clean up the test site
const headers = { Authorization: `Bearer ${secret}` };
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) {
	await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers });
}
await close();
console.log("my-site: ok");
