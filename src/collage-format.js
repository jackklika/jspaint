// @ts-check
// eslint-disable-next-line no-unused-vars
/* global current_history_node:writable, file_format:writable */
/* global file_name, main_canvas */
// The collage file format: a page in the HTML dialect (docs/DESIGN.md §3.3) containing one `div.collage`
// with the bitmap and the sticker layers. Saving produces a self-contained .html (assets as data URLs);
// the same markup is what gets written into a site's page with file references instead.
//
//   <div class="collage" style="width:600px;height:400px">
//     <img class="bitmap" src="…png">
//     <img class="sticker" src="…gif" style="left:20px;top:30px;width:64px;height:64px;transform:scale(-1, 1)">
//   </div>
import { open_from_image_info, read_image_file, show_error_message, write_image_file } from "./functions.js";
import { PAGE_WIDTH } from "./site-constants.js";
import { get_sticker_source, get_stickers, register_sticker_source, restore_stickers, snapshot_stickers } from "./stickers.js";

const HTML_FORMAT_ID = "text/html";

// Every collage page carries this so it renders identically anywhere, with no external stylesheet.
const COLLAGE_CSS = `
.collage { position: relative; display: inline-block; overflow: hidden; line-height: 0; }
.collage > .bitmap { display: block; image-rendering: pixelated; }
.collage > .sticker, .collage > .text { position: absolute; }
.collage > .sticker { image-rendering: pixelated; }
.collage > .text { line-height: normal; white-space: pre; }
`.trim();

/**
 * @param {string} text
 */
function escape_html(text) {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blob_to_data_url(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => { resolve(/** @type {string} */(reader.result)); };
		reader.onerror = () => { reject(reader.error); };
		reader.readAsDataURL(blob);
	});
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvas_to_png_blob(canvas) {
	return new Promise((resolve) => {
		// UPNG.js gives smaller PNGs than the browser's encoder, but its Blob has no MIME type; the data URL needs one.
		write_image_file(canvas, "image/png", (blob) => resolve(new Blob([blob], { type: "image/png" })));
	});
}

/**
 * Serializes the document (bitmap + stickers) as a collage page.
 * @param {object} [options]
 * @param {HTMLCanvasElement} [options.canvas] - defaults to the main canvas; another canvas (e.g. a selection) gets no stickers
 * @param {string} [options.title]
 * @param {(blob: Blob, kind: "bitmap" | "sticker", index: number) => Promise<string>} [options.asset_url] - where assets go; defaults to data URLs
 * @returns {Promise<string>}
 */
async function serialize_collage_html({ canvas = main_canvas, title = file_name, asset_url = (blob) => blob_to_data_url(blob) } = {}) {
	const bitmap_src = await asset_url(await canvas_to_png_blob(canvas), "bitmap", 0);
	const sticker_tags = [];
	if (canvas === main_canvas) {
		let index = 0;
		for (const sticker of get_stickers()) {
			const source = get_sticker_source(sticker.source_id);
			if (!source) { continue; }
			const src = await asset_url(source.blob, "sticker", index++);
			const transform = sticker.flip_x || sticker.flip_y ? `;transform:scale(${sticker.flip_x ? -1 : 1}, ${sticker.flip_y ? -1 : 1})` : "";
			sticker_tags.push(`\t\t<img class="sticker" src="${src}" alt="" style="left:${sticker.x}px;top:${sticker.y}px;width:${sticker.width}px;height:${sticker.height}px${transform}">`);
		}
	}
	const page_title = title.replace(/\.(bmp|dib|a?png|gif|jpe?g|jpe|jfif|tiff?|webp|raw|html?)$/i, "") || "Untitled";
	return `<!DOCTYPE html>
<html data-page-width="${PAGE_WIDTH}">
<head>
<meta charset="utf-8">
<meta name="generator" content="JS Paint collage">
<title>${escape_html(page_title)}</title>
<style>
${COLLAGE_CSS}
</style>
</head>
<body>
<center>
	<div class="collage" style="width:${canvas.width}px;height:${canvas.height}px">
		<img class="bitmap" src="${bitmap_src}" width="${canvas.width}" height="${canvas.height}" alt="">
${sticker_tags.join("\n")}
	</div>
</center>
</body>
</html>
`;
}

/**
 * @typedef {object} ParsedCollage
 * @property {number} width
 * @property {number} height
 * @property {string} bitmap_src
 * @property {{ src: string, x: number, y: number, width: number, height: number, flip_x: boolean, flip_y: boolean }[]} stickers
 */

/**
 * @param {string} html
 * @returns {ParsedCollage | null} null if this isn't a collage page
 */
function parse_collage_html(html) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const collage = doc.querySelector(".collage");
	const bitmap = collage?.querySelector("img.bitmap");
	if (!collage || !bitmap) {
		return null;
	}
	const px = (/** @type {string} */ value) => parseFloat(value) || 0;
	const stickers = [];
	for (const el of collage.querySelectorAll("img.sticker")) {
		const style = /** @type {HTMLElement} */ (el).style;
		const transform = style.transform || "";
		const scale_match = /scale\(\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+))?\s*\)/.exec(transform);
		stickers.push({
			src: el.getAttribute("src") || "",
			x: px(style.left),
			y: px(style.top),
			width: px(style.width),
			height: px(style.height),
			flip_x: /scaleX\(\s*-1/.test(transform) || (scale_match ? parseFloat(scale_match[1]) < 0 : false),
			flip_y: /scaleY\(\s*-1/.test(transform) || (scale_match ? parseFloat(scale_match[2] ?? scale_match[1]) < 0 : false),
		});
	}
	const style = /** @type {HTMLElement} */ (collage).style;
	return {
		width: px(style.width) || Number(bitmap.getAttribute("width")) || 0,
		height: px(style.height) || Number(bitmap.getAttribute("height")) || 0,
		bitmap_src: bitmap.getAttribute("src") || "",
		stickers,
	};
}

/**
 * @param {string} html
 */
function is_collage_html(html) {
	return /class=["']?collage\b/.test(html);
}

/**
 * Loads a collage page (from File > Open, drag and drop, etc.) as the current document.
 * @param {Blob} file
 */
async function open_collage_from_file(file) {
	let parsed;
	try {
		parsed = parse_collage_html(await file.text());
	} catch (error) {
		show_error_message("Paint cannot open this file.", error);
		return;
	}
	if (!parsed) {
		show_error_message("This web page doesn't contain a collage (a <div class=\"collage\"> with an <img class=\"bitmap\">), so Paint can't open it.");
		return;
	}
	const base = file instanceof File && !/^data:/.test(parsed.bitmap_src) ? null : location.href;
	const load_blob = async (/** @type {string} */ src) => {
		if (!/^(data|blob|https?):/.test(src)) {
			throw new Error(`Can't load a relative asset from a standalone file: ${src}`);
		}
		const response = await fetch(new URL(src, base || location.href).href);
		if (!response.ok) { throw new Error(`HTTP ${response.status} loading ${src.slice(0, 80)}`); }
		return response.blob();
	};
	let bitmap_blob;
	try {
		bitmap_blob = await load_blob(parsed.bitmap_src);
	} catch (error) {
		show_error_message("Paint cannot open this collage's bitmap.", error);
		return;
	}
	read_image_file(bitmap_blob, (error, info) => {
		if (error) {
			show_error_message("Paint cannot open this collage's bitmap.", error);
			return;
		}
		info.source_blob = file; // so the document takes the .html file's name
		open_from_image_info(info, async () => {
			/** @type {StickerSnapshot[]} */
			const snapshots = [];
			for (const [index, sticker] of parsed.stickers.entries()) {
				try {
					const source = await register_sticker_source(await load_blob(sticker.src));
					snapshots.push({
						id: `s${index + 1}`,
						source_id: source.id,
						x: sticker.x,
						y: sticker.y,
						width: sticker.width || source.width,
						height: sticker.height || source.height,
						flip_x: sticker.flip_x,
						flip_y: sticker.flip_y,
					});
				} catch (error) {
					show_error_message("Couldn't load one of the collage's stickers; skipping it.", error);
				}
			}
			restore_stickers(snapshots);
			// The stickers are part of the opened state, not a change to it.
			current_history_node.stickers = snapshot_stickers();
			file_format = HTML_FORMAT_ID; // so File > Save writes the web page again
		});
	});
}

export { HTML_FORMAT_ID, is_collage_html, open_collage_from_file, parse_collage_html, serialize_collage_html };
