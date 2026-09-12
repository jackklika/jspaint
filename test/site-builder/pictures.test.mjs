// Pictures: a photo put on the page goes to the site right away (signed in) — the original, a page-size copy, and a
// thumbnail when it's big; the page shows the copy and links to the full-size original — and a reload, the Pictures
// window, and a save all keep it. Signed out, a picture in a section's text is inlined until the page is saved.
// Needs both Workers running locally, like publish.test.mjs.
import { createHash } from "node:crypto";
import { assert, canvas_box, open_paint, select_tool } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const sites = process.env.SITE_BUILDER_SITES_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("pictures: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `pics-${Date.now().toString(36)}`;
const settings = { site, secret, editor_url: editor, page: "index.html", remember_secret: true };
const seed = (/** @type {any} */ arg) => { localStorage.setItem("jspaint site publish settings", JSON.stringify(arg)); };
const { page, close } = await open_paint({ init: seed, init_arg: settings });
const c = await canvas_box(page);

// A 2400×1600 photo (bigger than the page copy's 1200px)
const photo = Buffer.from(await page.evaluate(() => {
	const canvas = document.createElement("canvas");
	canvas.width = 2400;
	canvas.height = 1600;
	const ctx = canvas.getContext("2d");
	const gradient = ctx.createLinearGradient(0, 0, 2400, 1600);
	gradient.addColorStop(0, "#ff8800");
	gradient.addColorStop(1, "#0044ff");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 2400, 1600);
	ctx.fillStyle = "#fff";
	ctx.fillRect(600, 400, 1200, 800);
	return canvas.toDataURL("image/png").split(",")[1];
}), "base64");
const hash = createHash("sha1").update(photo).digest("hex");

// The Pictures window (the toolbox's Pictures tool): Upload… puts the photo on the site and on the page as a sticker
await select_tool(page, "Pictures");
await page.waitForSelector(".pictures-window", { timeout: 10000 });
await page.waitForFunction(() => /No pictures on your site yet/.test(document.querySelector(".pictures-window .pictures-grid")?.textContent || ""), null, { timeout: 15000 });
await page.setInputFiles(".pictures-window input[type=file]", { name: "photo.png", mimeType: "image/png", buffer: photo });
await page.waitForFunction(() => (current_history_node.stickers || []).length === 1, null, { timeout: 60000 });
const sticker = await page.evaluate(() => current_history_node.stickers[0]);
assert.equal(sticker.href, `${sites}/~${site}/gifs/${hash}.png`, "the sticker links to the full-size photo");
assert.equal(`${sticker.width}x${sticker.height}`, "800x533", "shown at page width (from the 1200px copy)");
assert.equal(await page.evaluate(async () => (await import("/src/stickers.js")).get_sticker_source(current_history_node.stickers[0].source_id).path), `gifs/${hash}.w1200.png`, "its picture is the site's page-size copy");
const headers = { Authorization: `Bearer ${secret}` };
const listed = async () => (await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json()).files.map((/** @type {{ path: string }} */ f) => f.path).sort();
assert.deepEqual(await listed(), [`gifs/${hash}.png`, `gifs/${hash}.w1200.png`, `gifs/${hash}.w240.png`], "original, page copy, thumbnail");
// …and lists it, with the thumbnail and a photo badge
await page.waitForSelector(`.pictures-window .picture-tile[data-path="gifs/${hash}.png"]`, { timeout: 15000 });
assert.match(await page.getAttribute(`.pictures-window .picture-tile[data-path="gifs/${hash}.png"] img`, "src"), new RegExp(`/gifs/${hash}\\.w240\\.png$`));
assert.equal(await page.$eval(`.pictures-window .picture-tile[data-path="gifs/${hash}.png"] .picture-badge`, (el) => el.textContent), "photo");

// Into a section's text: the page-size copy, linking to the original (the site's public addresses)
await select_tool(page, "Section");
await page.mouse.click(c.x + 40, c.y + 560);
await page.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
await page.keyboard.type("My photo: ");
await page.click(`.pictures-window .picture-tile[data-path="gifs/${hash}.png"]`);
await page.waitForFunction((hash) => new RegExp(`w1200\\.png" alt=""></a>`).test((current_history_node.blocks || []).find((b) => b.flow)?.html || "") && hash, hash, { timeout: 15000 });
await page.keyboard.press("Escape");
const html = () => page.evaluate(() => (current_history_node.blocks || []).find((b) => b.flow).html);
assert.match(await html(), new RegExp(`My photo:(?: |&nbsp;)<a href="${sites}/~${site}/gifs/${hash}\\.png"><img src="${sites}/~${site}/gifs/${hash}\\.w1200\\.png" alt=""></a>`), await html());
await page.waitForFunction(() => { const img = document.querySelector(".block-layer.flow img"); return img && img.complete && img.naturalWidth === 1200; }, null, { timeout: 15000 }); // the copy shows in the editor

// A reload keeps both (the text's addresses are the site's; the sticker's picture and its path are in the sidecar)
await page.waitForFunction(() => /#local:/.test(location.hash), null, { timeout: 5000 });
await page.waitForTimeout(1200);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (current_history_node.stickers || []).length === 1 && (current_history_node.blocks || []).length === 1, null, { timeout: 20000 });
assert.match(await html(), new RegExp(`gifs/${hash}\\.w1200\\.png`));
assert.equal(await page.evaluate(async () => (await import("/src/stickers.js")).get_sticker_source(current_history_node.stickers[0].source_id).path), `gifs/${hash}.w1200.png`);

// Save: nothing is uploaded twice; the page links the photo both ways
await page.evaluate(async () => { (await import("/src/my-site.js")).save_page_to_site("index.html"); });
await page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
const log = await page.$eval(".site-publish-log", (el) => el.innerText);
assert.match(log, /Done!/, log);
assert.match(log, /1 reused/, log);
const published = await (await fetch(`${sites}/~${site}/`)).text();
assert.match(published, new RegExp(`<a class="sticker" href="${sites}/~${site}/gifs/${hash}\\.png" style="[^"]*"><img src="gifs/${hash}\\.w1200\\.png" alt=""></a>`), "the sticker: page copy, linking to the original");
assert.match(published, new RegExp(`My photo:(?: |&nbsp;)<a href="${sites}/~${site}/gifs/${hash}\\.png"><img src="${sites}/~${site}/gifs/${hash}\\.w1200\\.png" alt=""></a>`), "the text: the same");
assert.equal((await listed()).filter((path) => path.startsWith("gifs/")).length, 3, "no second copy of anything");
await close();

// Signed out: a picture in a section's text is inlined (a data: URL), and survives a reload
{
	const { page: visitor, close: close_visitor } = await open_paint();
	const vc = await canvas_box(visitor);
	await select_tool(visitor, "Section");
	await visitor.mouse.click(vc.x + 40, vc.y + 100);
	await visitor.waitForSelector(".block-layer.flow.editing", { timeout: 5000 });
	await visitor.keyboard.type("Look: ");
	await visitor.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 20;
		canvas.height = 10;
		canvas.getContext("2d").fillStyle = "#f0f";
		canvas.getContext("2d").fillRect(0, 0, 20, 10);
		const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
		await (await import("/src/pictures.js")).insert_picture_blob(blob);
	});
	await visitor.keyboard.press("Escape");
	const inline = () => visitor.evaluate(() => (current_history_node.blocks || []).find((b) => b.flow).html);
	assert.match(await inline(), /Look:(?: |&nbsp;)<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="">/, await inline());
	await visitor.waitForFunction(() => /#local:/.test(location.hash), null, { timeout: 5000 });
	await visitor.waitForTimeout(1200);
	await visitor.reload({ waitUntil: "domcontentloaded" });
	await visitor.waitForFunction(() => (current_history_node.blocks || []).length === 1, null, { timeout: 20000 });
	assert.match(await inline(), /<img src="data:image\/png;base64,/);
	await visitor.waitForFunction(() => { const img = document.querySelector(".block-layer.flow img"); return img && img.complete && img.naturalWidth === 20; }, null, { timeout: 15000 });
	await close_visitor();
}

// Clean up
for (const path of await listed()) {
	await fetch(`${editor}/api/sites/${site}/files/${path}`, { method: "DELETE", headers });
}
console.log("pictures: ok");
