import { assert, make_gif, open_paint, paste_file, type_text_box } from "./helpers.mjs";

const { page, close } = await open_paint();
await paste_file(page, await make_gif(page, { width: 40, height: 30 }), "a.gif");
await page.waitForSelector(".sticker", { timeout: 5000 });
await page.keyboard.press("Shift+ArrowRight");
await type_text_box(page, "Survives reload", { x: 300, y: 200, width: 200, height: 60, tool: "Web Text" });
await page.waitForSelector(".text-layer", { timeout: 5000 });
await page.waitForTimeout(600); // autosave debounce
const snapshot = () => page.evaluate(() => ({
	hash: location.hash,
	stickers: (current_history_node.stickers || []).map((s) => `${s.x},${s.y} ${s.width}x${s.height}`),
	text: (current_history_node.text_layers || []).map((t) => `${t.text}@${t.x},${t.y}`),
}));
const before = await snapshot();
// The sidecar (sticker blobs) and the picture's backup live in IndexedDB, not localStorage (quota).
assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("layers#") || k.startsWith("image#")).length), 0, "nothing big in localStorage");
const stored_keys = () => page.evaluate(() => new Promise((resolve) => {
	const open = indexedDB.open("jspaint-site-builder");
	open.onsuccess = () => {
		const request = open.result.transaction("layers").objectStore("layers").getAllKeys();
		request.onsuccess = () => resolve(request.result.map((k) => String(k).replace(/#.*$/, "#")).sort());
	};
}));
assert.deepEqual(await stored_keys(), ["image#", "layers#"]);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".main-canvas", { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll(".sticker").length === 1 && document.querySelectorAll(".text-layer").length === 1, null, { timeout: 15000 });
// The canvas was veiled ("Loading…") until the picture and its layers were in; now it isn't
await page.waitForFunction(() => !document.body.classList.contains("page-loading") && !document.querySelector(".page-loading-panel"), null, { timeout: 15000 });
await page.waitForTimeout(300);
const after = await snapshot();
assert.equal(after.hash, before.hash, "same session");
assert.deepEqual(after.stickers, before.stickers);
assert.deepEqual(after.text, before.text);
assert.equal(await page.evaluate(() => undos.length), 0, "layers are part of the loaded state, not a history step");

await close();
console.log("autosave: ok");
