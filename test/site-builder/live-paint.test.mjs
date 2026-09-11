// Two copies of Paint editing the same page of a site through its live room: an element placed in one appears
// in the other; a stroke painted in one shows up in the other's pixels; moving an element and undoing propagate;
// a heading being edited in one is locked in the other; a third copy joining late gets everything.
// Needs both Workers running locally, like my-site.test.mjs:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=dev-secret-123
import { assert, canvas_box, click_menu_item, select_tool } from "./helpers.mjs";
import { chromium } from "playwright";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const secret = process.env.SITE_BUILDER_SECRET;
const paint_url = process.env.JSPAINT_URL || `${editor}/`;
if (!editor || !secret) {
	console.log("live-paint: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `live-${Date.now().toString(36)}`;
const browser = await chromium.launch();
const errors = [];

/** A signed-in Paint in its own browser context (own localStorage), pointed at the local editor. */
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
const blocks = (page) => page.evaluate(() => (current_history_node.blocks || []).map((b) => `${b.id}:${b.tag}@${b.x},${b.y}`));
const pixel = (page, x, y) => page.evaluate(([x, y]) => main_ctx.getImageData(x, y, 1, 1).data.join(","), [x, y]);
const wait_live = (page, others) => page.waitForFunction((others) => { const s = window.live_sync_state(); return s.connected && s.others.length === others; }, others, { timeout: 30000 });

// Alice creates the page (My Site › New Page…) — she is the authority; the room gets seeded
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
assert.deepEqual((await live(alice)).room, { site, page: "about.html" });
// Save it so Bob can open it from My Site
await alice.keyboard.press("Control+s");
await alice.waitForFunction(() => /Done!/.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
await alice.evaluate(() => [...document.querySelectorAll(".site-publish-window button")].find((b) => b.textContent === "Cancel").click());

// Bob opens the same page from My Site and joins the room
const bob = await open_signed_in("Bob");
await click_menu_item(bob, "My Site...");
await bob.waitForSelector(".my-site-window", { timeout: 15000 });
await bob.click(".my-site-window .my-site-tab[data-tab=pages]"); // the Pages tab: a tile per page
await bob.waitForSelector(".my-site-window .my-site-tile[data-path='about.html']", { timeout: 15000 });
await bob.dblclick(".my-site-window .my-site-tile[data-path='about.html']");
await bob.waitForSelector(".block-layer", { timeout: 15000 });
await wait_live(bob, 1);
await wait_live(alice, 1);
assert.deepEqual((await live(alice)).others, ["Bob"]);
assert.deepEqual((await live(bob)).others, ["Alice"]);
assert.deepEqual(await blocks(bob), await blocks(alice), "Bob has Alice's heading");

// Alice adds a text box (click-to-place) → Bob sees it
await select_tool(alice, "Text Box");
const ac = await canvas_box(alice);
await alice.mouse.click(ac.x + 100, ac.y + 300);
await alice.waitForFunction(() => (current_history_node.blocks || []).length === 2, null, { timeout: 5000 });
await alice.keyboard.press("Escape");
await bob.waitForFunction(() => (current_history_node.blocks || []).length === 2, null, { timeout: 15000 });
assert.deepEqual(await blocks(bob), await blocks(alice));
assert.equal(await bob.evaluate(() => document.querySelector('.block-layer[data-tag="p"] .block-el').textContent), "Write something here.");

// Bob paints a stroke → Alice's pixels change (and Alice's history nodes carry it)
await select_tool(bob, "Brush");
const bc = await canvas_box(bob);
await bob.mouse.click(bc.x + 600, bc.y + 500); // deselect
await bob.mouse.move(bc.x + 500, bc.y + 450);
await bob.mouse.down();
await bob.mouse.move(bc.x + 560, bc.y + 450, { steps: 4 });
await bob.mouse.up();
assert.notEqual(await pixel(bob, 530, 450), "255,255,255,255");
await alice.waitForFunction(() => main_ctx.getImageData(530, 450, 1, 1).data.join(",") !== "255,255,255,255", null, { timeout: 15000 });
assert.equal(await pixel(alice, 530, 450), await pixel(bob, 530, 450));
assert.equal(await alice.evaluate(() => { const d = root_history_node.image_data; return [...d.data.slice((450 * d.width + 530) * 4, (450 * d.width + 530) * 4 + 4)].join(","); }), await pixel(bob, 530, 450), "remote strokes are rebased into Alice's undo tree");

// A stroke in progress: while Bob holds the brush down, Alice sees his stroke on a preview overlay (drawn by her
// copy of his Brush tool), his cursor shows as painting, and her picture is untouched until he lets go
const overlay_ink = (page) => page.evaluate(() => {
	const canvas = document.querySelector(".remote-stroke-layer canvas");
	if (!canvas) { return -1; }
	const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
	let count = 0;
	for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { count++; } }
	return count;
});
await bob.mouse.move(bc.x + 100, bc.y + 520);
await bob.mouse.down();
await bob.mouse.move(bc.x + 300, bc.y + 520, { steps: 8 });
const overlay_has_ink = () => {
	const c = document.querySelector(".remote-stroke-layer canvas");
	if (!c) { return false; }
	const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
	for (let i = 3; i < d.length; i += 4) {
		if (d[i] > 0) { return true; }
	}
	return false;
};
await alice.waitForFunction(overlay_has_ink, null, { timeout: 15000 });
assert.ok((await overlay_ink(alice)) > 200, "Alice previews Bob's stroke in progress");
assert.equal(await pixel(alice, 200, 520), "255,255,255,255", "…but her picture is still untouched");
assert.equal(await alice.evaluate(() => document.querySelector(".live-cursor")?.classList.contains("painting")), true, "Bob's cursor shows as painting");
await bob.mouse.up();
await alice.waitForFunction(() => main_ctx.getImageData(200, 520, 1, 1).data.join(",") !== "255,255,255,255", null, { timeout: 15000 });
const overlay_is_clear = () => {
	const c = document.querySelector(".remote-stroke-layer canvas");
	const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
	for (let i = 3; i < d.length; i += 4) {
		if (d[i] > 0) { return false; }
	}
	return true;
};
await alice.waitForFunction(overlay_is_clear, null, { timeout: 15000 });
assert.equal(await pixel(alice, 200, 520), await pixel(bob, 200, 520), "the finished stroke replaced the preview");
assert.equal(await bob.evaluate(() => current_history_node.name), "Brush", "Bob's own history is the ordinary Brush step");

// Bob moves the text box with the Pointer tool → Alice sees the new position; Bob undoes → Alice sees it back
await select_tool(bob, "Pointer");
const marquee = await (await bob.$('.block-layer[data-tag="p"] .block-content')).boundingBox();
await bob.mouse.move(marquee.x + 40, marquee.y + 10);
await bob.mouse.down();
await bob.mouse.move(marquee.x + 140, marquee.y + 60, { steps: 5 });
await bob.mouse.up();
const moved = await blocks(bob);
await alice.waitForFunction((moved) => JSON.stringify((current_history_node.blocks || []).map((b) => `${b.id}:${b.tag}@${b.x},${b.y}`)) === JSON.stringify(moved), moved, { timeout: 15000 });
await bob.keyboard.press("Control+z");
const undone = await blocks(bob);
assert.notDeepEqual(undone, moved);
await alice.waitForFunction((undone) => JSON.stringify((current_history_node.blocks || []).map((b) => `${b.id}:${b.tag}@${b.x},${b.y}`)) === JSON.stringify(undone), undone, { timeout: 15000 });

// Alice edits the heading's text: Bob sees the lock, then the new text once she's done
await select_tool(alice, "Pointer");
const heading = await (await alice.$('.block-layer[data-tag="h1"] .block-content')).boundingBox();
await alice.mouse.click(heading.x + 30, heading.y + 20);
await alice.keyboard.press("Enter");
await alice.waitForSelector(".block-layer.editing", { timeout: 5000 });
await bob.waitForSelector('.block-layer[data-tag="h1"].remote-editing', { timeout: 15000 });
assert.equal(await bob.evaluate(() => document.querySelector('.block-layer[data-tag="h1"]').getAttribute("data-remote-editor")), "Alice");
await alice.keyboard.type(" edited live");
await alice.keyboard.press("Escape");
await bob.waitForFunction(() => /edited live/.test(document.querySelector('.block-layer[data-tag="h1"] .block-el').textContent), null, { timeout: 15000 });
await bob.waitForFunction(() => !document.querySelector('.block-layer[data-tag="h1"].remote-editing'), null, { timeout: 15000 });

// Remote cursor shows up with the name, and the icon of the tool Alice is holding
await alice.mouse.move(ac.x + 200, ac.y + 200);
await bob.waitForFunction(() => [...document.querySelectorAll(".live-cursor-name")].some((el) => /Alice/.test(el.textContent)), null, { timeout: 15000 });
await bob.waitForFunction(() => !!document.querySelector(".live-cursor-tool img"), null, { timeout: 15000 });
assert.equal(await bob.$eval(".live-cursor-tool", (el) => el.getAttribute("data-tool")), await alice.evaluate(() => selected_tool.id));

// Alice shares the page: File › Share Page… shows a link and a QR code
await click_menu_item(alice, "Share Page...");
await alice.waitForSelector(".share-window input[readonly]", { timeout: 10000 });
await alice.waitForFunction(() => /\?join=/.test(document.querySelector(".share-window input[readonly]")?.value || ""), null, { timeout: 15000 });
const share_link = await alice.$eval(".share-window input[readonly]", (el) => el.value);
assert.match(share_link, new RegExp(`\\?join=${site}/about\\.html/\\d+\\.[A-Za-z0-9_-]{16}$`), share_link);
assert.equal(await alice.evaluate(() => document.querySelector(".share-window .share-qr canvas") !== null), true, "a QR code is drawn");
// Sharing uploads a preview card of the page as it is now…
await alice.waitForFunction(() => /Link preview updated/.test(document.querySelector(".share-window .share-status")?.textContent || ""), null, { timeout: 20000 });
const preview_head = await fetch(`${editor}/api/sites/${site}/files/previews/about.png`, { method: "HEAD" });
assert.equal(preview_head.status, 200, "previews/about.png is on the site");
assert.equal(preview_head.headers.get("Content-Type"), "image/png");
await alice.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Close" && b.closest(".share-window")).click());
// …and the link itself answers with link-preview tags pointing at it (what messaging apps show)
const landing = await (await fetch(`${editor}/${share_link.replace(/^https?:\/\/[^/]+\//, "")}`)).text();
assert.equal((landing.match(/property="og:title"/g) || []).length, 1, "one og:title (the defaults are replaced)");
assert.match(landing, new RegExp(`<meta property="og:title" content="about · ~${site}">`));
// (wrangler dev reports the configured custom domain as the request host, so the origin isn't checked here)
assert.match(landing, new RegExp(`<meta property="og:image" content="https?://[^/]+/api/sites/${site}/files/previews/about\\.png\\?v=\\w+">`));
assert.match(landing, /<meta name="twitter:card" content="summary_large_image">/);
assert.match(landing, /<meta property="og:url" content="[^"]*\?join=/);
assert.match(landing, /<script type="module" src="src\/app\.js">/, "still the whole app");
const plain = await (await fetch(`${editor}/`)).text();
assert.match(plain, /<meta property="og:title" content="coolpaint\.world">/, "the bare editor keeps the default card");

// Cid opens the link with no sign-in at all: a guest, straight into the room with the merged document
const cid_context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const cid = await cid_context.newPage();
cid.on("pageerror", (e) => errors.push(`Cid pageerror: ${e.message}`));
cid.on("console", (m) => { if (m.type() === "error") { errors.push(`Cid console: ${m.text().slice(0, 200)}`); } });
// (No site, no secret — only where the editor is, since this test's Paint isn't served by the editor Worker.)
await cid.addInitScript(([editor]) => {
	localStorage.setItem("jspaint live name", "Cid");
	localStorage.setItem("jspaint site publish settings", JSON.stringify({ editor_url: editor }));
}, [editor]);
await cid.goto(share_link.replace(/^https?:\/\/[^/]+\//, paint_url), { waitUntil: "domcontentloaded", timeout: 60000 });
await cid.waitForSelector(".main-canvas", { timeout: 60000 });
await wait_live(cid, 2);
assert.deepEqual((await live(cid)).room, { site, page: "about.html" });
assert.equal(await cid.evaluate(() => system_file_handle.guest.site), site);
await cid.waitForFunction((expected) => JSON.stringify((current_history_node.blocks || []).map((b) => `${b.id}:${b.tag}@${b.x},${b.y}`)) === JSON.stringify(expected), await blocks(alice), { timeout: 20000 });
await cid.waitForFunction(() => main_ctx.getImageData(530, 450, 1, 1).data.join(",") !== "255,255,255,255", null, { timeout: 20000 });
assert.match(await cid.evaluate(() => document.querySelector('.block-layer[data-tag="h1"] .block-el').textContent), /edited live/);
assert.match(await cid.getAttribute(".site-globe-button", "title"), /guest/, "the globe knows Cid is a guest (Share lives in its My Site view)");

// The guest saves with Ctrl+S: the share key publishes that page (and nothing else)
await cid.keyboard.press("Control+s");
await cid.waitForFunction(() => /Done!|Couldn't|rejected|expired/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
assert.match(await cid.$eval(".site-publish-log", (el) => el.innerText), /Done!/);
const published = await (await fetch(`${process.env.SITE_BUILDER_SITES_URL}/~${site}/about.html`)).text();
assert.match(published, /edited live/, "the guest's save is live on the site");
assert.match(published, /<p class="block"/, "with everyone's elements");

// Clean up
const headers = { Authorization: `Bearer ${secret}` };
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) {
	await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers });
}
await browser.close();
assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], "page errors");
console.log("live-paint: ok");
