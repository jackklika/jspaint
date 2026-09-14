// The first run: someone who isn't signed in at edit.<domain>/ gets a starter page of their own (a fresh page, not
// a copy of the domain's homepage) and the Welcome window; /new gives anyone that page; Save on a fresh page or a
// copy asks before replacing a page you already have; a copy shows what its own site shows (the real counter).
// Needs both Workers running locally (Paint is loaded from the editor Worker: only the hosted editor does this).
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const sites = process.env.SITE_BUILDER_SITES_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("first-run: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `first-${Date.now().toString(36)}`;
const headers = { Authorization: `Bearer ${secret}` };
const settings = { site, secret, editor_url: editor, page: "index.html", remember_secret: true };
const seed = (arg) => { localStorage.setItem("jspaint site publish settings", JSON.stringify(arg)); };
const handle = (page) => page.evaluate(() => system_file_handle);
const blocks = (page) => page.evaluate(() => (current_history_node.blocks || []).map((b) => b.tag));
const windows = (page) => page.evaluate(() => [...document.querySelectorAll(".window-title")].map((t) => t.textContent));

// A stranger at /: the starter page — fresh, theirs — and the Welcome window; the globe says sign in
{
	const { page, close } = await open_paint({ url: `${editor}/` });
	await page.waitForFunction(() => system_file_handle && system_file_handle.site_page === "index.html" && system_file_handle.fresh === true, null, { timeout: 20000 });
	assert.deepEqual(await handle(page), { site_page: "index.html", fresh: true }, "a fresh page, not a copy of ~root's");
	await page.waitForFunction(() => (current_history_node.blocks || []).length === 3, null, { timeout: 10000 });
	assert.deepEqual(await blocks(page), ["h1", "div", "x-counter"], "a heading, a section, a counter to change");
	await page.waitForSelector(".welcome-window", { timeout: 10000 });
	assert.match(await page.$eval(".welcome-window", (el) => el.textContent), /This is Paint, and this page is yours/);
	assert.match(await page.$eval(".welcome-window", (el) => el.textContent), /~name\//);
	assert.match(await page.$eval(".welcome-window a", (el) => el.getAttribute("href")), /\/~root\/$/, "a way to the site's own homepage");
	await page.waitForSelector(".welcome-window .google-sign-in:visible", { timeout: 10000 }); // (this editor has Google set up)
	const next_of = (href) => decodeURIComponent(new URL(href).searchParams.get("next") || "");
	assert.match(next_of(await page.$eval(".welcome-window .google-sign-in", (el) => el.getAttribute("href"))), /^\/\?signed_in=1&resume=save&page=index\.html#local:[a-z0-9]+$/, "Google comes back to this drawing and the save");
	assert.equal(await page.$eval(".site-globe-name", (el) => el.textContent), "sign in");
	assert.equal(await page.$eval(".page-path-label", (el) => el.textContent), "index.html — not saved to a site yet");
	assert.equal(await page.evaluate(() => document.querySelector(".page-loading-panel")), null, "the veil is gone");
	// Start drawing closes it; Ctrl+S asks to sign in (the page is still there behind the dialog)
	await page.evaluate(() => { [...document.querySelectorAll(".welcome-window button")].find((b) => b.textContent === "Start drawing").click(); });
	await page.waitForSelector(".welcome-window", { state: "detached", timeout: 5000 });
	await select_tool(page, "Brush");
	const c = await canvas_box(page);
	await page.mouse.click(c.x + 500, c.y + 500);
	await page.keyboard.press("Control+s");
	await page.waitForSelector(".my-site-sign-in", { timeout: 10000 });
	assert.match(next_of(await page.$eval(".my-site-sign-in .google-sign-in", (el) => el.getAttribute("href"))), /^\/\?signed_in=1&resume=save&page=index\.html#local:[a-z0-9]+$/);
	assert.deepEqual(await handle(page), { site_page: "index.html", fresh: true });
	// "Show this next time" unchecked: it stays away
	await page.evaluate(() => { [...document.querySelectorAll(".my-site-sign-in button")].find((b) => b.textContent === "Cancel")?.click(); });
	await page.evaluate(() => { localStorage.setItem("jspaint welcome seen", "1"); });
	await page.goto(`${editor}/`, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => system_file_handle && system_file_handle.fresh === true, null, { timeout: 20000 });
	await page.waitForTimeout(1500);
	assert.equal(await page.evaluate(() => !!document.querySelector(".welcome-window")), false, "not shown again");
	await close();
}

// Signed in as a site that has a front page: /new is a fresh page too (no Welcome), and Save asks before replacing
{
	// The site gets a front page with a counter, made in Paint
	const { page: maker, close: close_maker } = await open_paint({ init: seed, init_arg: settings });
	await maker.waitForTimeout(1500);
	await maker.evaluate(() => { document.querySelector(".page-loading-panel")?.remove(); document.body.classList.remove("page-loading"); });
	await select_tool(maker, "Visitor Counter");
	const mc = await canvas_box(maker);
	await maker.mouse.click(mc.x + 60, mc.y + 200);
	await maker.evaluate(async () => { await (await import("/src/my-site.js")).save_page_to_site("index.html"); });
	await maker.waitForFunction(() => /Done!/.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
	await close_maker();
	// (the site's page also stands in for the root site's front page, copied over with the master key)
	for (const path of ["index.html", "collages/index.png"]) {
		const body = await (await fetch(`${editor}/api/sites/${site}/files/${path}`)).blob();
		assert.equal((await fetch(`${editor}/api/sites/root/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": body.type }, body })).status, 200);
	}

	const { page, close } = await open_paint({ url: `${editor}/new`, init: seed, init_arg: settings });
	await page.waitForFunction(() => system_file_handle && system_file_handle.fresh === true && location.search === "", null, { timeout: 20000 });
	assert.deepEqual(await handle(page), { site_page: "index.html", fresh: true });
	assert.equal(await page.evaluate(() => !!document.querySelector(".welcome-window")), false, "signed in: no Welcome");
	assert.equal(await page.$eval(".site-globe-name", (el) => el.textContent), `~${site}`);
	await page.keyboard.press("Control+s");
	await page.waitForFunction(() => [...document.querySelectorAll(".window")].some((w) => /already on your site/.test(w.textContent)), null, { timeout: 30000 });
	await page.evaluate(() => { const box = [...document.querySelectorAll(".window")].find((w) => /already on your site/.test(w.textContent)); [...box.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click(); });
	await page.waitForFunction(() => /Not saved/.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 10000 });
	assert.equal((await (await fetch(`${sites}/~${site}/index.html`, { cache: "no-store" })).text()).includes("My cool site"), false, "the front page was left alone");
	await page.evaluate(() => { [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel")?.click(); });
	await close();

	// A copy of the domain's homepage (/~root/): it shows root's real counter, and Save asks before replacing index.html
	const { page: copy, close: close_copy } = await open_paint({ url: `${editor}/~root/`, init: seed, init_arg: settings });
	await copy.waitForFunction(() => system_file_handle && system_file_handle.copy_of === "root", null, { timeout: 20000 });
	await copy.waitForFunction(() => /<span/.test(document.querySelector('.block-layer[data-tag="x-counter"] .block-el')?.innerHTML || ""), null, { timeout: 15000 });
	assert.doesNotMatch(await copy.$eval('.block-layer[data-tag="x-counter"] .block-el', (el) => el.innerHTML), /000123/, "the copy shows what coolpaint.world shows, not the placeholder");
	await copy.keyboard.press("Control+s");
	await copy.waitForFunction(() => [...document.querySelectorAll(".window")].some((w) => /already on your site/.test(w.textContent)), null, { timeout: 30000 });
	await copy.evaluate(() => { const box = [...document.querySelectorAll(".window")].find((w) => /already on your site/.test(w.textContent)); [...box.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click(); });
	await copy.waitForFunction(() => /Not saved/.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 10000 });
	await copy.evaluate(() => { [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel")?.click(); });
	assert.deepEqual(await windows(copy).then((list) => list.filter((t) => /Save|Sign In/.test(t))), []);
	await close_copy();

	for (const path of ["index.html", "collages/index.png"]) { await fetch(`${editor}/api/sites/root/files/${path}`, { method: "DELETE", headers }); }
}

// Clean up
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }); }
console.log("first-run: ok");
