// Shared helpers for the site-builder UI tests (Playwright driving the real JS Paint page).
// Run with `npm run test:site-builder` (starts a static server on :11822) or point JSPAINT_URL at a running one.
import assert from "node:assert/strict";
import { chromium } from "playwright";

export const BASE_URL = process.env.JSPAINT_URL || "http://localhost:11822/";
export { assert };

/**
 * Opens JS Paint in a fresh headless Chromium page and waits for the canvas.
 * @param {{ init?: (arg?: any) => void, init_arg?: any, viewport?: { width: number, height: number }, query?: string, url?: string }} [options] - `init` runs before the page's scripts (e.g. to seed localStorage), with `init_arg`; `query` is appended to the URL (e.g. "?site=yourname"); `url` loads Paint from somewhere other than BASE_URL (e.g. the editor Worker)
 */
export async function open_paint({ init, init_arg, viewport = { width: 1280, height: 800 }, query = "", url = BASE_URL } = {}) {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport });
	const errors = [];
	page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() === "error") { errors.push(`console: ${message.text().slice(0, 300)}`); }
	});
	if (init) { await page.addInitScript(init, init_arg); }
	await page.goto(url + query, { waitUntil: "domcontentloaded", timeout: 60000 });
	await page.waitForSelector(".main-canvas", { timeout: 60000 });
	await page.waitForTimeout(800);
	return {
		browser,
		page,
		errors,
		/** Closes the browser and fails the test if the page logged errors. */
		async close() {
			await browser.close();
			assert.deepEqual(errors, [], "page errors");
		},
	};
}

/**
 * Builds a GIF in the page with the gif.js encoder JS Paint ships, so tests need no binary fixtures.
 * @param {import("playwright").Page} page
 * @param {{ width?: number, height?: number, frames?: string[], delay?: number }} [options] - `frames` are CSS colors, one per frame
 * @returns {Promise<number[]>} the GIF bytes
 */
export function make_gif(page, { width = 40, height = 30, frames = ["#f00", "#0f0", "#00f"], delay = 100 } = {}) {
	return page.evaluate(async ({ width, height, frames, delay }) => {
		const gif = new GIF({ workers: 1, workerScript: "lib/gif.js/gif.worker.js", width, height, repeat: 0 });
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		for (const color of frames) {
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, width, height);
			gif.addFrame(canvas, { delay, copy: true });
		}
		const blob = await new Promise((resolve) => { gif.on("finished", resolve); gif.render(); });
		return [...new Uint8Array(await blob.arrayBuffer())];
	}, { width, height, frames, delay });
}

/**
 * Pastes bytes into JS Paint as a file, via a synthetic clipboard event.
 * @param {import("playwright").Page} page
 * @param {number[]} bytes
 * @param {string} [name]
 * @param {string} [type]
 */
export function paste_file(page, bytes, name = "test.gif", type = "image/gif") {
	return page.evaluate(([bytes, name, type]) => {
		const dt = new DataTransfer();
		dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	}, [bytes, name, type]);
}

/**
 * Drops bytes onto the canvas as a file at canvas-relative coordinates.
 * @param {import("playwright").Page} page
 * @param {number[]} bytes
 * @param {number} x
 * @param {number} y
 */
export function drop_file(page, bytes, x, y, name = "drop.gif", type = "image/gif") {
	return page.evaluate(([bytes, x, y, name, type]) => {
		const dt = new DataTransfer();
		dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
		const target = document.querySelector(".main-canvas");
		const rect = target.getBoundingClientRect();
		for (const kind of ["dragenter", "dragover", "drop"]) {
			target.dispatchEvent(new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y }));
		}
	}, [bytes, x, y, name, type]);
}

/** @param {import("playwright").Page} page @param {string} label */
export function click_menu_item(page, label) {
	return page.evaluate((label) => {
		const item = document.querySelector(`[role=menuitem][aria-label="${label}"], [role=menuitemcheckbox][aria-label="${label}"]`);
		if (!item) { throw new Error(`No menu item "${label}"`); }
		item.click();
	}, label);
}

/** Replaces the save dialog with a capture of what would be saved. */
export function capture_saves(page) {
	return page.evaluate(() => {
		window.__saved = [];
		window.systemHooks.showSaveFileDialog = async ({ getBlob, defaultFileFormatID, defaultFileName }) => {
			const blob = await getBlob(defaultFileFormatID);
			window.__saved.push({ format: defaultFileFormatID, name: defaultFileName, type: blob.type, size: blob.size, text: blob.type.startsWith("text/") ? await blob.text() : null, bytes: blob.type.startsWith("image/") ? [...new Uint8Array(await blob.arrayBuffer())] : null });
			return true;
		};
	});
}

/** @param {import("playwright").Page} page */
export const canvas_box = async (page) => (await page.$(".main-canvas")).boundingBox();

/** Selects a tool by its toolbox button label (e.g. "Text", "Web Text"). */
export async function select_tool(page, name) {
	await page.evaluate((name) => {
		const button = [...document.querySelectorAll(".tool")].find((el) => (el.getAttribute("aria-label") || el.getAttribute("title")) === name);
		if (!button) { throw new Error(`No tool "${name}"`); }
		button.click();
	}, name);
	await page.waitForTimeout(200);
}

/** Draws a text box with the Text tool, types into it, and commits by clicking elsewhere. */
export async function type_text_box(page, text, { x = 50, y = 50, width = 250, height = 70, tool = "Text" } = {}) {
	await select_tool(page, tool);
	const c = await canvas_box(page);
	await page.mouse.move(c.x + x, c.y + y);
	await page.mouse.down();
	await page.mouse.move(c.x + x + width, c.y + y + height, { steps: 5 });
	await page.mouse.up();
	await page.waitForSelector(".textbox", { timeout: 5000 });
	await page.keyboard.type(text);
	await commit_by_clicking_bare_canvas(page, { x, y, width, height });
}

/**
 * Commits the open text box by clicking a spot on the canvas that's outside the box and not under a tool window
 * (the Font toolbar floats over the bottom-right, and its size depends on how many toggles it has).
 * @param {import("playwright").Page} page
 * @param {{ x: number, y: number, width: number, height: number }} box - the text box, in canvas coordinates
 */
export async function commit_by_clicking_bare_canvas(page, box) {
	const c = await canvas_box(page);
	const candidates = [[600, 350], [600, 200], [380, 300], [380, 30], [30, 300], [30, 500]];
	for (const [dx, dy] of candidates) {
		const px = c.x + Math.min(dx, c.width - 10), py = c.y + Math.min(dy, c.height - 10);
		const inside_box = px >= c.x + box.x - 10 && px <= c.x + box.x + box.width + 10 && py >= c.y + box.y - 10 && py <= c.y + box.y + box.height + 10;
		if (inside_box) { continue; }
		const bare = await page.evaluate(([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return !!el && !el.closest(".window, .textbox, .text-layer, .block-layer, .sticker-layer");
		}, [px, py]);
		if (bare) {
			await page.mouse.click(px, py);
			return;
		}
	}
	throw new Error("no bare canvas spot found to commit the text box");
}
