// Publishes a collage through the editor Worker and reads it back from the sites Worker.
// Needs both Workers running locally (in worker/: `npm run dev:editor` on :8787 with editor/.dev.vars, `npm run dev:sites` on :8788):
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=dev-secret-123
import { assert, click_menu_item, make_gif, open_paint, paste_file, type_text_box } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const sites = process.env.SITE_BUILDER_SITES_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !sites || !secret) {
	console.log("publish: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SITES_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `test-${Date.now().toString(36)}`;

const { page, close } = await open_paint({ init: () => { localStorage.setItem("jspaint web text mode", "true"); } });
await paste_file(page, await make_gif(page, { width: 40, height: 30 }), "a.gif");
await page.waitForSelector(".sticker", { timeout: 5000 });
await type_text_box(page, "Published text", { x: 300, y: 200, width: 220, height: 60 });
await page.waitForSelector(".text-layer", { timeout: 5000 });

await click_menu_item(page, "Save to My Site...");
await page.waitForSelector(".site-publish-window", { timeout: 5000 });
const fill = (label, value) => page.fill(`.site-publish-window label:has-text("${label}") input`, value);
await fill("Site name", site);
await fill("Page file", "index.html");
await fill("Edit secret", secret);
await fill("Editor URL", editor);
await page.click(".site-publish-window button[type=submit]");
await page.waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 60000 });
const log = await page.$eval(".site-publish-log", (el) => el.innerText);
assert.match(log, /Done!/, log);
assert.match(log, /2 assets uploaded, 0 reused/, log); // the bitmap and the sticker
const url = await page.$eval(".site-publish-log a", (a) => a.href);
assert.equal(url, `${sites.replace(/\/+$/, "")}/~${site}/`);

// The page is live on the sites Worker with the collage, the sticker as a real GIF, and the text as text
const response = await fetch(url);
assert.equal(response.status, 200);
assert.match(response.headers.get("content-security-policy") || "", /script-src 'none'|default-src 'none'/);
const html = await response.text();
assert.match(html, /class="collage"/);
assert.match(html, /<img class="sticker" src="gifs\/[0-9a-f]{40}\.gif"/);
assert.match(html, /class="bitmap" src="collages\/index\.png\?v=[0-9a-f]{12}"/); // versioned so a re-save shows at once
assert.match(html, /<span class="text"[^>]*>Published text<\/span>/);
const gif_path = /src="(gifs\/[0-9a-f]{40}\.gif)"/.exec(html)[1];
const gif = await fetch(`${sites}/~${site}/${gif_path}`);
assert.equal(gif.status, 200);
assert.equal(gif.headers.get("content-type"), "image/gif");
assert.match(gif.headers.get("cache-control") || "", /immutable/);

// Saving again reuses the hashed asset
await page.click(".site-publish-window button[type=submit]");
await page.waitForFunction(() => (document.querySelector(".site-publish-log")?.textContent || "").split("Done!").length > 1, null, { timeout: 60000 });
assert.match(await page.$eval(".site-publish-log", (el) => el.innerText), /1 asset uploaded, 1 reused/); // bitmap re-uploaded, sticker reused

// Clean up the test site
const headers = { Authorization: `Bearer ${secret}` };
const listing = await (await fetch(`${editor}/api/sites/${site}/files`, { headers })).json();
for (const file of listing.files) {
	await fetch(`${editor}/api/sites/${site}/files/${file.path}`, { method: "DELETE", headers });
}
assert.equal((await fetch(url)).status, 404);

await close();
console.log("publish: ok");
