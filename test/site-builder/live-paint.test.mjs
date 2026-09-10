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
await alice.waitForSelector(".dialog-window input[placeholder='about.html']", { timeout: 5000 });
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
await bob.waitForSelector(".my-site-window .my-site-row", { timeout: 15000 });
await bob.evaluate(() => [...document.querySelectorAll(".my-site-row")].find((row) => row.querySelector(".my-site-name").textContent === "about.html").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
await bob.waitForSelector(".block-layer", { timeout: 15000 });
await wait_live(bob, 1);
await wait_live(alice, 1);
assert.deepEqual((await live(alice)).others, ["Bob"]);
assert.deepEqual((await live(bob)).others, ["Alice"]);
assert.deepEqual(await blocks(bob), await blocks(alice), "Bob has Alice's heading");

// Alice adds a marquee (click-to-place) → Bob sees it
await select_tool(alice, "Marquee");
const ac = await canvas_box(alice);
await alice.mouse.click(ac.x + 100, ac.y + 300);
await alice.waitForFunction(() => (current_history_node.blocks || []).length === 2, null, { timeout: 5000 });
await alice.keyboard.press("Escape");
await bob.waitForFunction(() => (current_history_node.blocks || []).length === 2, null, { timeout: 15000 });
assert.deepEqual(await blocks(bob), await blocks(alice));
assert.equal(await bob.evaluate(() => document.querySelector('.block-layer[data-tag="marquee"] .block-el').textContent), "~*~ welcome to my page ~*~");

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

// Bob moves the marquee with the Pointer tool → Alice sees the new position; Bob undoes → Alice sees it back
await select_tool(bob, "Pointer");
const marquee = await (await bob.$('.block-layer[data-tag="marquee"] .block-content')).boundingBox();
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

// Remote cursor shows up with the name
await alice.mouse.move(ac.x + 200, ac.y + 200);
await bob.waitForFunction(() => [...document.querySelectorAll(".live-cursor-name")].some((el) => /Alice/.test(el.textContent)), null, { timeout: 15000 });

// A late joiner (Cid) gets the merged document: two blocks, Bob's stroke
const cid = await open_signed_in("Cid");
await click_menu_item(cid, "My Site...");
await cid.waitForSelector(".my-site-window .my-site-row", { timeout: 15000 });
await cid.evaluate(() => [...document.querySelectorAll(".my-site-row")].find((row) => row.querySelector(".my-site-name").textContent === "about.html").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
await wait_live(cid, 2);
await cid.waitForFunction((expected) => JSON.stringify((current_history_node.blocks || []).map((b) => `${b.id}:${b.tag}@${b.x},${b.y}`)) === JSON.stringify(expected), await blocks(alice), { timeout: 20000 });
await cid.waitForFunction(() => main_ctx.getImageData(530, 450, 1, 1).data.join(",") !== "255,255,255,255", null, { timeout: 20000 });
assert.match(await cid.evaluate(() => document.querySelector('.block-layer[data-tag="h1"] .block-el').textContent), /edited live/);

// Clean up
const headers = { Authorization: `Bearer ${secret}` };
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) {
	await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers });
}
await browser.close();
assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], "page errors");
console.log("live-paint: ok");
