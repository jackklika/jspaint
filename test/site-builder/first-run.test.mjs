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
	const next_of = (href) => decodeURIComponent(new URL(href).searchParams.get("next") || "");
	assert.match(await page.$eval(".welcome-window", (el) => el.textContent), /press\s*Publish/, "the Welcome points at Publish, not at signing in");
	assert.equal(await page.evaluate(() => !!document.querySelector(".welcome-window .google-sign-in")), false, "signing in belongs to the moment of publishing");
	assert.equal(await page.$eval(".site-globe-name", (el) => el.textContent), "sign in");
	assert.equal(await page.$eval(".page-path-label", (el) => el.textContent), "index.html — not published yet");
	assert.equal(await page.evaluate(() => document.querySelector(".page-loading-panel")), null, "the veil is gone");
	// The Publish button, always in view at the far end of the page bar, in its first-time look
	assert.equal(await page.$eval(".page-publish", (el) => el.textContent), "Publish");
	assert.equal(await page.$eval(".page-publish", (el) => el.classList.contains("page-publish-first")), true);
	assert.match(await page.$eval(".page-publish", (el) => el.getAttribute("title") || ""), /pick a name/);
	// Start drawing closes it; the Publish button asks to sign in (the page is still there behind the dialog), and the
	// funnel saw the click; Ctrl+S does the same
	await page.evaluate(() => { window.__events = []; window.posthog = { capture: (name, props) => { window.__events.push([name, props]); } }; });
	await page.evaluate(() => { [...document.querySelectorAll(".welcome-window button")].find((b) => b.textContent === "Start drawing").click(); });
	await page.waitForSelector(".welcome-window", { state: "detached", timeout: 5000 });
	await page.click(".page-publish");
	await page.waitForSelector(".my-site-sign-in .google-sign-in", { timeout: 10000 });
	assert.match(next_of(await page.$eval(".my-site-sign-in .google-sign-in", (el) => el.getAttribute("href"))), /^\/\?signed_in=1&resume=save&page=index\.html#local:[a-z0-9]+$/, "Google comes back to this drawing and the publish");
	assert.deepEqual(await page.evaluate(() => window.__events.map((e) => [e[0], e[1].source])), [["publish_clicked", "button"]], "the funnel saw the click");
	await page.evaluate(() => { [...document.querySelectorAll(".my-site-sign-in button")].find((b) => b.textContent === "Cancel")?.click(); });
	await page.waitForSelector(".my-site-sign-in", { state: "detached", timeout: 5000 });
	await select_tool(page, "Brush");
	const c = await canvas_box(page);
	await page.mouse.click(c.x + 500, c.y + 500);
	await page.keyboard.press("Control+s");
	await page.waitForSelector(".my-site-sign-in", { timeout: 10000 });
	assert.match(next_of(await page.$eval(".my-site-sign-in .google-sign-in", (el) => el.getAttribute("href"))), /^\/\?signed_in=1&resume=save&page=index\.html#local:[a-z0-9]+$/);
	assert.deepEqual(await handle(page), { site_page: "index.html", fresh: true });
	assert.deepEqual(await page.evaluate(() => window.__events.filter((e) => e[0] === "publish_clicked").map((e) => e[1].source)), ["button", "ctrl_s"]);
	// "Show this next time" unchecked: it stays away
	await page.evaluate(() => { [...document.querySelectorAll(".my-site-sign-in button")].find((b) => b.textContent === "Cancel")?.click(); });
	// The nudge, once: after enough drawing on an unpublished page (the wait shortened for the test), a balloon under
	// Publish; its button publishes (the funnel says so); it never shows again in this browser
	await page.waitForSelector(".my-site-sign-in", { state: "detached", timeout: 5000 });
	await page.evaluate(() => { localStorage.setItem("jspaint publish nudge delay ms", "0"); window.__events = []; });
	await select_tool(page, "Pencil");
	for (let i = 0; i < 7; i++) {
		await page.mouse.move(c.x + 40 + i * 20, c.y + 300);
		await page.mouse.down();
		await page.mouse.move(c.x + 50 + i * 20, c.y + 320, { steps: 2 });
		await page.mouse.up();
	}
	await page.waitForSelector(".publish-nudge", { timeout: 10000 });
	assert.match(await page.$eval(".publish-nudge", (el) => el.textContent), /Like it\? Publish it/);
	assert.equal(await page.evaluate(() => localStorage.getItem("jspaint publish nudge shown")), "1");
	await page.click(".publish-nudge-go");
	await page.waitForSelector(".my-site-sign-in", { timeout: 10000 });
	assert.equal(await page.evaluate(() => !!document.querySelector(".publish-nudge")), false, "the balloon went with the click");
	const seen = await page.evaluate(() => window.__events.map((e) => e[0]));
	assert.ok(seen.includes("nudge_shown") && seen.includes("nudge_clicked") && seen.includes("publish_clicked"), seen.join(","));
	assert.equal(await page.evaluate(() => window.__events.find((e) => e[0] === "publish_clicked")[1].source), "nudge");
	await page.evaluate(() => { [...document.querySelectorAll(".my-site-sign-in button")].find((b) => b.textContent === "Cancel")?.click(); });
	await page.waitForSelector(".my-site-sign-in", { state: "detached", timeout: 5000 });
	await page.evaluate(() => { localStorage.setItem("jspaint welcome seen", "1"); });
	await page.goto(`${editor}/`, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => system_file_handle && system_file_handle.fresh === true, null, { timeout: 20000 });
	await page.waitForTimeout(1500);
	assert.equal(await page.evaluate(() => !!document.querySelector(".welcome-window")), false, "not shown again");
	await page.evaluate(() => { localStorage.setItem("jspaint publish nudge delay ms", "0"); });
	await select_tool(page, "Pencil");
	const rb = await canvas_box(page);
	for (let i = 0; i < 7; i++) {
		await page.mouse.move(rb.x + 40 + i * 20, rb.y + 340);
		await page.mouse.down();
		await page.mouse.move(rb.x + 50 + i * 20, rb.y + 360, { steps: 2 });
		await page.mouse.up();
	}
	await page.waitForTimeout(400);
	assert.equal(await page.evaluate(() => !!document.querySelector(".publish-nudge")), false, "the nudge is once per browser");
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
	for (const path of ["index.html", "collages/index.png", "thumbs/index.png", "previews/index.png"]) {
		const body = await (await fetch(`${editor}/api/sites/${site}/files/${path}`)).blob();
		assert.equal((await fetch(`${editor}/api/sites/root/files/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": body.type }, body })).status, 200);
	}

	const { page, close } = await open_paint({ url: `${editor}/new`, init: seed, init_arg: settings });
	await page.waitForFunction(() => system_file_handle && system_file_handle.fresh === true && location.search === "", null, { timeout: 20000 });
	assert.deepEqual(await handle(page), { site_page: "index.html", fresh: true, site }, "a fresh page of the signed-in site");
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
	// A copy stays a copy across a reload (its session remembers): it doesn't turn into your own index.html
	await copy.waitForFunction(() => /#local:/.test(location.hash), null, { timeout: 5000 });
	await copy.evaluate(() => { $(window).triggerHandler("session-update"); });
	await copy.waitForTimeout(600);
	await copy.reload({ waitUntil: "domcontentloaded" });
	await copy.waitForFunction(() => system_file_handle && system_file_handle.site_page === "index.html", null, { timeout: 20000 });
	assert.deepEqual(await copy.evaluate(() => system_file_handle), { site_page: "index.html", copy_of: "root" }, "still a copy of root's after a reload");
	assert.match(await copy.$eval(".page-path-label", (el) => el.textContent), /a copy of ~root's/);
	await close_copy();

	// The root site's welcome.html, when it has one, is the starter page for newcomers (the owner draws it at /welcome)
	{
		const body = await (await fetch(`${editor}/api/sites/${site}/files/index.html`)).blob();
		assert.equal((await fetch(`${editor}/api/sites/root/files/welcome.html`, { method: "PUT", headers: { ...headers, "Content-Type": body.type }, body })).status, 200);
		const { page: newcomer, close: close_newcomer } = await open_paint({ url: `${editor}/` });
		await newcomer.waitForFunction(() => system_file_handle && system_file_handle.fresh === true && (current_history_node.blocks || []).length > 0, null, { timeout: 20000 });
		assert.deepEqual(await handle(newcomer), { site_page: "index.html", fresh: true }, "a fresh page of their own");
		assert.deepEqual(await blocks(newcomer), ["x-counter"], "…with the welcome page's content, not the built-in start");
		await newcomer.waitForSelector(".welcome-window", { timeout: 10000 });
		await close_newcomer();
	}
	for (const path of ["index.html", "collages/index.png", "thumbs/index.png", "previews/index.png", "welcome.html"]) { await fetch(`${editor}/api/sites/root/files/${path}`, { method: "DELETE", headers }); }
}

// Clean up
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }); }
console.log("first-run: ok");
