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
await page.fill('.my-site-sign-in input[name="editor-url"]', editor);
await page.waitForSelector(".my-site-sign-in .google-sign-in", { timeout: 5000 }); // that editor has Google sign-in set up: the button is offered
await page.fill('.my-site-sign-in input[name="site-name"]', site);
await page.fill('.my-site-sign-in input[name="password"]', minted.password);
await page.click(".my-site-sign-in button[type=submit]");
await page.waitForFunction(() => !document.querySelector(".my-site-sign-in"), null, { timeout: 15000 });

// Signed in, the toolbox globe shows the site view: address, and My Site… opens the window; the site's name sits under the globe
assert.match(await page.getAttribute(".site-globe-button", "title"), new RegExp(`~${site}`));
assert.equal(await page.$eval(".site-globe-name", (el) => el.textContent), `~${site}`);
await page.click(".site-globe-button");
await page.waitForSelector(".site-view-window", { timeout: 5000 });
assert.match(await page.$eval(".site-view-window", (el) => el.textContent), new RegExp(`~${site}`));
assert.equal(await page.$eval(".site-view-window a[target=_blank]", (el) => el.getAttribute("href")), `${sites}/~${site}/`);
await page.waitForFunction(() => /viewing/.test(document.querySelector(".site-view-presence")?.textContent || ""), null, { timeout: 10000 });
assert.match(await page.$eval(".site-view-presence", (el) => el.textContent), /👁 \d+ viewing \(\d+ today\) · ✏️ \d+ editing/);
await page.evaluate(() => [...document.querySelectorAll(".site-view-window button")].find((b) => b.textContent === "My Site…").click());
await page.waitForSelector(".my-site-window", { timeout: 10000 });
await page.waitForFunction(() => !document.querySelector(".site-view-window"), null, { timeout: 5000 });
assert.equal(await page.getAttribute(".my-site-window .my-site-tab.selected", "data-tab"), "site", "My Site… opens on the Site tab");

// My Site → New Page… → about.html
await click_menu_item(page, "My Site...");
await page.waitForSelector(".my-site-window", { timeout: 10000 });
// Three tabs: Site (the summary), Pages (thumbnails, + at the end), Files (the folder). It opens on Site.
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".my-site-window .my-site-tab")].map((el) => el.textContent)), ["Site", "Pages", "Files"]);
assert.equal(await page.getAttribute(".my-site-window .my-site-tab.selected", "data-tab"), "site");
await page.waitForFunction(() => /\d+ files?/.test(document.querySelector(".my-site-window .my-site-status")?.textContent || ""), null, { timeout: 10000 });
await page.waitForSelector(".my-site-window .my-site-facts", { timeout: 5000 });
assert.match(await page.$eval(".my-site-window .my-site-summary", (el) => el.textContent), new RegExp(`~${site}`));
assert.match(await page.$eval(".my-site-window .my-site-facts", (el) => el.textContent), /Pages:none yet/);
assert.equal(await page.$eval(".my-site-window .my-site-summary-address", (el) => el.getAttribute("href")), `${sites}/~${site}/`);
await page.click(".my-site-window .my-site-tab[data-tab=pages]");
assert.equal(await page.evaluate(() => document.querySelectorAll(".my-site-window .my-site-tile:not(.my-site-new)").length), 0);
await page.click(".my-site-window .my-site-tile.my-site-new"); // + : a new page
const new_page_input = ".dialog-window:has(.window-title:text-is('New Page')) input[type=text]";
await page.waitForSelector(new_page_input, { timeout: 5000 });
assert.equal(await page.inputValue(new_page_input), "index.html", "an empty site's first page is its front page");
await page.fill(new_page_input, "about.html");
await page.keyboard.press("Enter");
await page.waitForSelector(".block-layer", { timeout: 20000 }); // (a fresh page: a session switch and a listing; slow under load)
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
await page.waitForSelector(".my-site-window", { timeout: 10000 });
await page.waitForFunction(() => /\d+ files?/.test(document.querySelector(".my-site-window .my-site-status")?.textContent || ""), null, { timeout: 15000 });
// Pages: a tile per page, its thumbnail the bitmap the site holds for it; the summary counts it
await page.click(".my-site-window .my-site-tab[data-tab=pages]");
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".my-site-window .my-site-tile")].map((el) => el.querySelector(".my-site-tile-name").textContent)), ["about.html", "New Page"]);
assert.match(await page.getAttribute(".my-site-window .my-site-tile[data-path='about.html'] img", "src"), new RegExp(`^${sites}/~${site}/collages/about\\.png\\?v=\\d+$`));
assert.equal(await page.evaluate(() => { const img = document.querySelector(".my-site-window .my-site-tile img"); return img.complete && img.naturalWidth > 0; }), true, "the thumbnail loaded");
await page.click(".my-site-window .my-site-tab[data-tab=site]");
assert.match(await page.$eval(".my-site-window .my-site-facts", (el) => el.textContent), /Pages:1 — no front page \(index\.html\) yet/);
await page.click(".my-site-window .my-site-tab[data-tab=files]");
await page.waitForSelector(".my-site-window .my-site-row", { timeout: 5000 });
const names = await page.evaluate(() => [...document.querySelectorAll(".my-site-name")].map((el) => el.textContent));
assert.ok(names.includes("about.html") && names.includes("collages/about.png"), names.join(","));
await page.evaluate(() => [...document.querySelectorAll(".my-site-row")].find((row) => row.querySelector(".my-site-name").textContent === "about.html").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
await page.waitForFunction(() => document.querySelectorAll(".block-layer").length === 2, null, { timeout: 15000 });
assert.equal(await page.evaluate(() => file_name), "about.html");
assert.deepEqual(await page.evaluate(() => system_file_handle), { site_page: "about.html" });
// The page's address is pinned at the top-left of the canvas area
assert.equal(await page.$eval(".page-path-label", (el) => el.textContent), `~${site}/about.html`);

// The Link tool offers your pages as tiles (signed in): pick one and its address goes in; the heading becomes a link to it
await select_tool(page, "Pointer");
const heading = await (await page.$(".block-layer .block-content")).boundingBox();
await page.mouse.click(heading.x + 10, heading.y + 10);
await page.waitForSelector(".block-layer.selected", { timeout: 5000 });
await select_tool(page, "Link");
await page.waitForSelector(".link-window .my-site-tile[data-path='about.html']", { timeout: 10000 });
await page.click(".link-window .my-site-tile[data-path='about.html']");
assert.equal(await page.inputValue('.link-window input[name="link-url"]'), `/~${site}/about.html`);
assert.equal(await page.evaluate(() => document.querySelector(".link-window .my-site-tile.selected")?.dataset.path), "about.html");
await page.click(".link-window button[type=submit]");
await page.waitForFunction(() => !document.querySelector(".link-window"), null, { timeout: 5000 });
assert.match(await page.evaluate(() => current_history_node.blocks[0].html), new RegExp(`^<a href="/~${site}/about.html">`));
await page.keyboard.press("Control+z");
assert.doesNotMatch(await page.evaluate(() => current_history_node.blocks[0].html), /^<a /);

// edit.<domain>/~site/about.html → Paint with ?site=&page=: anyone gets a copy of the published page to play with —
// no sign-in, no live room; saving it asks who you are, and it lands on the site you sign in to
{
	const { page: fresh, close: close_fresh } = await open_paint({ query: `?site=${site}&page=about.html`, init: (editor) => { localStorage.setItem("jspaint site publish settings", JSON.stringify({ editor_url: editor })); }, init_arg: editor });
	await fresh.waitForFunction(() => file_name === "about.html", null, { timeout: 20000 });
	assert.equal(await fresh.evaluate(() => location.search), "", "the query is consumed");
	assert.equal(await fresh.evaluate(() => !!document.querySelector(".my-site-sign-in")), false, "no sign-in to look");
	assert.deepEqual(await fresh.evaluate(() => system_file_handle), { site_page: "about.html", copy_of: site });
	assert.equal(await fresh.evaluate(() => document.querySelectorAll(".block-layer").length), 2, "the page's elements came along");
	assert.equal(await fresh.evaluate(() => window.live_sync_state().room), null, "a copy doesn't join the page's room");
	await fresh.keyboard.press("Control+s");
	await fresh.waitForSelector(".my-site-sign-in", { timeout: 10000 });
	assert.equal(await fresh.inputValue('.my-site-sign-in input[name="site-name"]'), "", "saving needs an account of your own");
	await fresh.fill('.my-site-sign-in input[name="site-name"]', site); // (the owner, as it happens)
	await fresh.fill('.my-site-sign-in input[name="password"]', minted.password);
	await fresh.click(".my-site-sign-in button[type=submit]");
	await fresh.waitForFunction(() => /Done!|Couldn't|rejected|expired/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
	assert.match(await fresh.$eval(".site-publish-log", (el) => el.innerText), /Done!/);
	await close_fresh();
}
// New Post…: a page in the posts folder with a title section and the date, the folder marked as posts in site.json
{
	await click_menu_item(page, "My Site...");
	await page.waitForSelector(".my-site-window", { timeout: 10000 });
	await page.evaluate(() => [...document.querySelectorAll(".my-site-toolbar button")].find((b) => b.textContent === "New Post…").click());
	await page.waitForSelector(".new-post-window", { timeout: 5000 });
	await page.fill('.new-post-window input[name="post-title"]', "Hello, World!");
	await page.click(".new-post-window button:has-text('OK')");
	await page.waitForFunction(() => file_name === "posts/hello-world.html" || [...document.querySelectorAll(".window")].some((w) => /Save changes to/.test(w.textContent)), null, { timeout: 10000 });
	await page.evaluate(() => { const prompt = [...document.querySelectorAll(".window")].find((w) => /Save changes to/.test(w.textContent)); [...(prompt?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === "No")?.click(); });
	await page.waitForFunction(() => file_name === "posts/hello-world.html", null, { timeout: 10000 });
	await page.waitForFunction(() => (current_history_node.blocks || []).filter((b) => b.flow).length === 2, null, { timeout: 5000 });
	const first = await page.evaluate(() => (current_history_node.blocks || []).filter((b) => b.flow)[0].html);
	assert.match(first, /<h1>Hello, World!<\/h1><p><small>Posted <x-updated label="">today<\/x-updated><\/small><\/p>/, first);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Control+s");
	await page.waitForFunction(() => /Done!|Couldn't|rejected|expired/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
	assert.match(await page.$eval(".site-publish-log", (el) => el.innerText), /Done!/);
	await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.textContent === "Close").forEach((b) => b.click()));
	const settings = await (await fetch(`${editor}/api/sites/${site}/files/site.json`)).json();
	assert.equal(settings.folders.posts.kind, "posts", JSON.stringify(settings));
	const published = await (await fetch(`${sites}/~${site}/posts/hello-world.html`)).text();
	assert.match(published, /<img class="bitmap" src="\.\.\/collages\/posts\/hello-world\.png\?v=[0-9a-f]{12}"/, "a page in a folder reaches up to the site's collages/");
	assert.equal((await fetch(`${sites}/~${site}/collages/posts/hello-world.png`)).status, 200, "and the bitmap is there");
	assert.match(published, /<div class="column"[^>]*>\s*<div data-kind="section" id="hello-world" class="block section"><h1>Hello, World!<\/h1><p><small>Posted <x-updated label(?:="")?><i>\d{4}-\d{2}-\d{2}<\/i><\/x-updated>/, "the date renders on the live page");
	const feed = await (await fetch(`${sites}/~${site}/posts/feed.xml`)).text();
	assert.match(feed, /<item><title>hello-world<\/title>|<item><title>Hello, World!<\/title>/, feed.slice(0, 300));
}

// A plain visit while signed in opens your site's front page — edit.<domain> is where you edit your site.
// (No front page yet: nothing happens. Then make one and visit again.)
{
	const seed = (/** @type {any} */ arg) => { localStorage.setItem("jspaint site publish settings", JSON.stringify(arg)); };
	const settings = { site, secret: minted.password, editor_url: editor, page: "about.html", remember_secret: true };
	const { page: blank, close: close_blank } = await open_paint({ init: seed, init_arg: settings });
	await blank.waitForTimeout(2500);
	assert.equal(await blank.evaluate(() => system_file_handle), null, "no index.html: a blank picture, not the page last saved");
	await close_blank();
	// Make the front page (New Page suggests index.html now that the site has none)
	await click_menu_item(page, "My Site...");
	await page.waitForSelector(".my-site-window", { timeout: 10000 });
	await page.waitForFunction(() => /\d+ files?/.test(document.querySelector(".my-site-window .my-site-status")?.textContent || ""), null, { timeout: 10000 }); // listed: only then does New Page know there's no index.html
	await page.evaluate(() => [...document.querySelectorAll(".my-site-toolbar button")].find((b) => b.textContent === "New Page…").click());
	await page.waitForSelector(new_page_input, { timeout: 5000 });
	assert.equal(await page.inputValue(new_page_input), "index.html");
	await page.keyboard.press("Enter");
	// (The visitor's save above reached this tab through the live room and may have marked the page changed: don't keep it.)
	await page.waitForFunction(() => file_name === "index.html" || [...document.querySelectorAll(".window")].some((w) => /Save changes to/.test(w.textContent)), null, { timeout: 10000 });
	await page.evaluate(() => { const prompt = [...document.querySelectorAll(".window")].find((w) => /Save changes to/.test(w.textContent)); [...(prompt?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === "No")?.click(); });
	await page.waitForFunction(() => file_name === "index.html", null, { timeout: 10000 });
	await page.keyboard.press("Escape");
	await page.keyboard.press("Control+s");
	await page.waitForFunction(() => /Done!|Couldn't|rejected|expired/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
	assert.match(await page.$eval(".site-publish-log", (el) => el.innerText), /Done!/);
	await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.textContent === "Close").forEach((b) => b.click()));
	const { page: back, close: close_back } = await open_paint({ init: seed, init_arg: settings });
	await back.waitForFunction(() => file_name === "index.html", null, { timeout: 20000 });
	assert.deepEqual(await back.evaluate(() => system_file_handle), { site_page: "index.html" });
	await close_back();
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
// Not signed in at all (incognito): a plain visit opens the domain's front page as a copy to play with
{
	// Give the root site a front page: this test's about.html and its bitmap, copied over with the master key
	const copy = async (/** @type {string} */ from, /** @type {string} */ to) => {
		const body = await (await fetch(`${editor}/api/sites/${site}/files/${from}`)).blob();
		const response = await fetch(`${editor}/api/sites/root/files/${to}`, { method: "PUT", headers: { ...headers, "Content-Type": body.type }, body });
		assert.equal(response.status, 200, `copy ${from} → root/${to}`);
	};
	const headers = { Authorization: `Bearer ${secret}` };
	await copy("collages/about.png", "collages/about.png");
	await copy("about.html", "index.html");
	// (Only the hosted editor does this — Paint from a dev server starts blank — so load it from the editor Worker.)
	const { page: visitor, close: close_visitor } = await open_paint({ url: `${editor}/` });
	await visitor.waitForFunction(() => file_name === "index.html", null, { timeout: 20000 });
	assert.deepEqual(await visitor.evaluate(() => system_file_handle), { site_page: "index.html", copy_of: "root" });
	assert.equal(await visitor.evaluate(() => !!document.querySelector(".my-site-sign-in")), false);
	await close_visitor();
	for (const path of ["index.html", "collages/about.png"]) {
		await fetch(`${editor}/api/sites/root/files/${path}`, { method: "DELETE", headers });
	}
}
// The root site is the domain itself: its address has no /~root/
{
	const { page: root, close: close_root } = await open_paint({ query: "?site=root", init: (editor) => { localStorage.setItem("jspaint site publish settings", JSON.stringify({ editor_url: editor })); }, init_arg: editor });
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
