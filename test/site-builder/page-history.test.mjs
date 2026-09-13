// The page's history, shared: two copies of Paint editing the same page; Edit › Page History… lists every change
// with who made it; picking an older version previews it; "Go to this version" takes both copies back to it;
// the next change branches from there and the abandoned versions stay (a tree); going to the abandoned tip
// brings it back. Needs both Workers running locally, like live-paint.test.mjs.
import { assert, canvas_box, click_menu_item, select_tool } from "./helpers.mjs";
import { chromium } from "playwright";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const secret = process.env.SITE_BUILDER_SECRET;
const paint_url = process.env.JSPAINT_URL || `${editor}/`;
if (!editor || !secret) {
	console.log("page-history: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `hist-${Date.now().toString(36)}`;
const browser = await chromium.launch();
const errors = [];

async function open_signed_in(label) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
	page.on("console", (m) => { if (m.type() === "error") { errors.push(`${label} console: ${m.text().slice(0, 200)}`); } });
	await page.addInitScript(([editor, site, secret, label]) => {
		localStorage.setItem("jspaint site publish settings", JSON.stringify({ editor_url: editor, site, secret, page: "index.html", remember_secret: true }));
		localStorage.setItem("jspaint live name", label);
	}, [editor, site, secret, label]);
	await page.goto(paint_url, { waitUntil: "domcontentloaded", timeout: 60000 });
	await page.waitForSelector(".main-canvas", { timeout: 60000 });
	await page.waitForTimeout(600);
	return page;
}
const live = (page) => page.evaluate(() => window.live_sync_state());
const pixel = (page, x, y) => page.evaluate(([x, y]) => main_ctx.getImageData(x, y, 1, 1).data.join(","), [x, y]);
const wait_pixel = (page, x, y, painted) => page.waitForFunction(([x, y, painted]) => (main_ctx.getImageData(x, y, 1, 1).data.join(",") !== "255,255,255,255") === painted, [x, y, painted], { timeout: 15000 });
const wait_live = (page, others) => page.waitForFunction((others) => { const s = window.live_sync_state(); return s.connected && s.others.length === others; }, others, { timeout: 30000 });
const entries = (page) => page.evaluate(() => [...document.querySelectorAll(".page-history-entry")].map((el) => ({
	id: Number(el.dataset.id),
	parent: Number(el.dataset.parent),
	who: el.querySelector(".page-history-who").textContent,
	what: el.querySelector(".page-history-what").textContent,
	current: el.classList.contains("current"),
	selected: el.classList.contains("selected"),
	unavailable: el.classList.contains("unavailable"),
})));
const paint = async (page, x, y) => {
	const box = await canvas_box(page);
	await page.mouse.move(box.x + x - 10, box.y + y);
	await page.mouse.down();
	await page.mouse.move(box.x + x + 10, box.y + y, { steps: 3 });
	await page.mouse.up();
	await wait_pixel(page, x, y, true);
};

// Alice makes the page; Bob joins it
const alice = await open_signed_in("Alice");
await click_menu_item(alice, "My Site...");
await alice.waitForSelector(".my-site-window", { timeout: 15000 });
await alice.evaluate(() => [...document.querySelectorAll(".my-site-toolbar button")].find((b) => b.textContent === "New Page…").click());
const new_page_input = ".dialog-window:has(.window-title:text-is('New Page')) input[type=text]";
await alice.waitForSelector(new_page_input, { timeout: 5000 });
await alice.fill(new_page_input, "about.html");
await alice.keyboard.press("Enter");
await alice.waitForSelector(".block-layer", { timeout: 10000 });
await alice.keyboard.press("Escape");
await wait_live(alice, 0);
await alice.keyboard.press("Control+s");
await alice.waitForFunction(() => /Done!/.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
await alice.evaluate(() => [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel").click());
const bob = await open_signed_in("Bob");
await click_menu_item(bob, "My Site...");
await bob.waitForSelector(".my-site-window", { timeout: 15000 });
await bob.click(".my-site-window .my-site-tab[data-tab=pages]");
await bob.waitForSelector(".my-site-window .my-site-tile[data-path='about.html']", { timeout: 15000 });
await bob.dblclick(".my-site-window .my-site-tile[data-path='about.html']");
await bob.waitForSelector(".block-layer", { timeout: 15000 });
await wait_live(bob, 1);
await wait_live(alice, 1);

// Alice paints at (100, 300); Bob paints at (400, 300); both see both
await select_tool(alice, "Brush");
await alice.mouse.click((await canvas_box(alice)).x + 600, (await canvas_box(alice)).y + 550); // (deselect the heading)
await paint(alice, 100, 300);
await wait_pixel(bob, 100, 300, true);
await select_tool(bob, "Brush");
await paint(bob, 400, 300);
await wait_pixel(alice, 400, 300, true);
const alice_version = (await live(alice)).version;

// Edit › Page History… in Alice's copy: the page's versions, by name — hers and Bob's — the newest current
await click_menu_item(alice, "Page History...");
await alice.waitForSelector(".page-history-window", { timeout: 10000 });
await alice.waitForFunction(() => document.querySelectorAll(".page-history-entry").length >= 3, null, { timeout: 15000 });
let list = await entries(alice);
assert.ok(list.some((e) => e.who === "Alice" && e.what === "Brush"), `Alice's stroke is listed: ${JSON.stringify(list)}`);
assert.ok(list.some((e) => e.who === "Bob" && e.what === "Brush"), "Bob's stroke is listed");
assert.equal(list[0].what, "New page", "the first version is the page's creation");
assert.ok(list.some((e) => e.what === "Saved to My Site"), "the publish is listed");
const bobs = list.find((e) => e.who === "Bob" && e.what === "Brush");
const alices = list.findLast((e) => e.who === "Alice" && e.what === "Brush"); // (the deselecting click painted a dot too: an earlier Brush)
assert.ok(bobs.current && bobs.selected, "the newest version is the page now, and selected");
assert.ok(!list.some((e) => e.unavailable), "everything is recent enough to bring back");
assert.equal(await alice.$eval(".page-history-go", (el) => el.offsetParent === null), true, "nothing to go to: this is the page now");

// Pick Alice's version: a preview renders (the bitmap without Bob's stroke), and the button offers to go there
await alice.click(`.page-history-entry[data-id="${alices.id}"]`);
await alice.waitForFunction(() => document.querySelector(".page-history-go").offsetParent !== null, null, { timeout: 5000 });
assert.match(await alice.$eval(".page-history-title", (el) => el.textContent), /Alice — Brush/);
await alice.waitForFunction(() => {
	const c = document.querySelector(".page-history-preview");
	const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
	let white = 0;
	for (let i = 0; i < d.length; i += 4) { if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) { white++; } }
	return white > 1000; // the page (white) has been drawn into the preview (gray until then)
}, null, { timeout: 15000 });

// Go there: both copies lose Bob's stroke and keep Alice's; nothing is deleted — Bob's version is still listed
await alice.click(".page-history-go");
await wait_pixel(alice, 400, 300, false);
await wait_pixel(bob, 400, 300, false);
assert.notEqual(await pixel(alice, 100, 300), "255,255,255,255", "Alice's stroke is still there");
assert.notEqual(await pixel(bob, 100, 300), "255,255,255,255");
await alice.waitForFunction((id) => document.querySelector(`.page-history-entry[data-id="${id}"]`)?.classList.contains("current"), alices.id, { timeout: 15000 });
list = await entries(alice);
assert.ok(list.some((e) => e.id === bobs.id), "Bob's version stays, as a branch");
assert.equal((await live(bob)).version, alices.id, "Bob's copy knows the page is at that version");
assert.ok(alice_version > alices.id);

// The next change branches from the restored version: Bob paints at (200, 500) → a new version whose parent is Alice's
await paint(bob, 200, 500);
await wait_pixel(alice, 200, 500, true);
await alice.waitForFunction((n) => document.querySelectorAll(".page-history-entry").length > n, list.length, { timeout: 15000 });
list = await entries(alice);
const branch = list[list.length - 1];
assert.equal(branch.who, "Bob");
assert.equal(branch.parent, alices.id, "it branches from the version we went to");
assert.ok(branch.current);
assert.ok(branch.id > bobs.id);
// In tree view, Bob's abandoned stroke and his new one are siblings under Alice's version
await alice.selectOption(".page-history-mode", "tree");
const indents = await alice.evaluate(() => Object.fromEntries([...document.querySelectorAll(".page-history-entry")].map((el) => [el.dataset.id, el.style.paddingInlineStart])));
assert.equal(indents[bobs.id], indents[branch.id], "siblings sit at the same depth");
assert.notEqual(indents[alices.id], indents[bobs.id], "…one deeper than their parent");

// Back to the abandoned tip (Bob's first stroke): (400, 300) is painted again, (200, 500) is not — in both copies
await alice.click(`.page-history-entry[data-id="${bobs.id}"]`);
await alice.waitForFunction(() => document.querySelector(".page-history-go").offsetParent !== null, null, { timeout: 5000 });
await alice.click(".page-history-go");
await wait_pixel(alice, 400, 300, true);
await wait_pixel(alice, 200, 500, false);
await wait_pixel(bob, 400, 300, true);
await wait_pixel(bob, 200, 500, false);
assert.equal((await live(alice)).version, bobs.id);

// Bob's own copy shows the same history (the globe's site view has the button too)
await bob.click(".site-globe-button");
await bob.waitForSelector(".site-view-window", { timeout: 10000 });
await bob.evaluate(() => [...document.querySelectorAll(".site-view-window button")].find((b) => b.textContent === "History…").click());
await bob.waitForSelector(".page-history-window", { timeout: 10000 });
await bob.waitForFunction((n) => document.querySelectorAll(".page-history-entry").length === n, list.length, { timeout: 15000 });
assert.deepEqual((await entries(bob)).map((e) => e.id), list.map((e) => e.id));
assert.ok((await entries(bob)).find((e) => e.id === bobs.id).current);

// Not on a page of a site: the window says where the history lives and offers this copy's History instead
const solo = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await solo.goto(paint_url, { waitUntil: "domcontentloaded", timeout: 60000 });
await solo.waitForSelector(".main-canvas", { timeout: 60000 });
await solo.waitForTimeout(800);
await solo.evaluate(() => { document.querySelector(".page-loading-panel")?.remove(); document.body.classList.remove("page-loading"); });
await click_menu_item(solo, "Page History...");
await solo.waitForSelector(".page-history-empty:visible", { timeout: 10000 });
assert.match(await solo.$eval(".page-history-empty", (el) => el.textContent), /live room/);

// Clean up
const headers = { Authorization: `Bearer ${secret}` };
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) { await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers }); }
await browser.close();
assert.deepEqual(errors.filter((e) => !/favicon|ERR_CONNECTION|net::|Failed to load resource/.test(e)), [], "page errors");
console.log("page-history: ok");
