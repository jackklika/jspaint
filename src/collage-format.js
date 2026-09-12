// @ts-check
// eslint-disable-next-line no-unused-vars
/* global current_history_node:writable, file_format:writable, file_name:writable, system_file_handle:writable */
/* global main_canvas */
// The page file format: a page in the HTML dialect (docs/DESIGN.md §3) containing one `div.collage` — the
// Paint document — with the bitmap, the page elements (blocks), the stickers, and the text layers as
// positioned children. Saving locally produces a self-contained .html (assets as data URLs); the same
// markup is what gets written into a site's page with file references instead.
//
//   <body bgcolor="#ffffd9"><center>
//   <div class="collage" style="width:800px;height:600px">
//     <img class="bitmap" src="…png">
//     <h1 class="block" style="left:20px;top:10px;width:400px;height:48px"><font face="Comic Sans MS">hi</font></h1>
//     <x-counter class="block" style="…">You are visitor number <b>?????</b></x-counter>
//     <img class="sticker" src="…gif" style="left:20px;top:30px;width:64px;height:64px;transform:scale(-1, 1)">
//     <span class="text" style="…">~ est. 1999 ~</span>
//   </div>
//   </center></body>
import { block_markup, ensure_section_ids, get_blocks, get_column_geometry, restore_blocks, snapshot_blocks } from "./blocks.js";
import { block_kind_for, sanitize_html_fragment } from "./block-kinds.js";
import { open_from_image_info, read_image_file, show_error_message, write_image_file } from "./functions.js";
import { get_page_properties, set_page_properties } from "./page-properties.js";
import { PAGE_WIDTH } from "./site-constants.js";
import { get_sticker_source, get_stickers, register_sticker_source, restore_stickers, snapshot_stickers } from "./stickers.js";
import { font_css, get_text_layers, restore_text_layers, snapshot_text_layers } from "./text-layers.js";

const HTML_FORMAT_ID = "text/html";

// Every page carries this so it renders identically anywhere, with no external stylesheet.
const COLLAGE_CSS = `
body > center { line-height: 0; }
.collage { position: relative; display: inline-block; overflow: hidden; line-height: 0; text-align: left; }
.collage > .bitmap { display: block; image-rendering: pixelated; }
.collage > .sticker, .collage > .text, .collage > .block { position: absolute; }
.collage > .sticker { image-rendering: pixelated; }
.collage > a.sticker { display: block; }
.collage > a.sticker > img { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
.collage > .text { box-sizing: border-box; margin: 0; padding: 0; white-space: pre-wrap; overflow-wrap: break-word; overflow: hidden; text-decoration: none; }
.collage > a.text { text-decoration: underline; }
.collage > .block { display: block; margin: 0; box-sizing: border-box; overflow: hidden; line-height: normal; font: 16px "Times New Roman", Times, serif; color: #000; }
.collage > hr.block { height: auto !important; }
.collage.has-column { overflow: visible; }
.collage > .column { position: absolute; }
.column > .section { display: block; position: static; margin: 0 0 16px; box-sizing: border-box; line-height: normal; font: 16px "Times New Roman", Times, serif; color: #000; }
.column > .section img { max-width: 100%; height: auto; }
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
 * Serializes the document (bitmap + blocks + stickers + text layers) as a page.
 * @param {object} [options]
 * @param {HTMLCanvasElement} [options.canvas] - defaults to the main canvas; another canvas (e.g. a selection) gets no layers
 * @param {string} [options.title]
 * @param {(blob: Blob, kind: "bitmap" | "sticker", index: number, path?: string) => Promise<string>} [options.asset_url] - where assets go; defaults to data URLs. `path`: where a sticker's picture already is on the site, if known
 * @returns {Promise<string>}
 */
async function serialize_collage_html({ canvas = main_canvas, title = file_name, asset_url = (blob) => blob_to_data_url(blob) } = {}) {
	const bitmap_src = await asset_url(await canvas_to_png_blob(canvas), "bitmap", 0);
	if (canvas === main_canvas) { ensure_section_ids(); }
	const all_blocks = canvas === main_canvas ? get_blocks() : [];
	/** Pictures put into text while signed out are blob: or data: URLs; they go to the site like stickers do. @param {BlockSnapshot} snapshot */
	const with_uploaded_pictures = async (snapshot) => {
		const sources = [...snapshot.html.matchAll(/src="((?:blob|data):[^"]+)"/g)].map((match) => match[1]);
		if (!sources.length) { return snapshot; }
		let html = snapshot.html;
		for (const [index, source] of [...new Set(sources)].entries()) {
			try {
				const blob = await (await fetch(source)).blob();
				const path = await asset_url(blob, "sticker", 1000 + index);
				html = html.split(`src="${source}"`).join(`src="${escape_html(path)}"`);
			} catch (_error) { /* leave it; the browser shows a broken picture rather than losing the text */ }
		}
		return { ...snapshot, html };
	};
	// Sections stack in the page's column (normal flow on the live page); everything else sits where it was put.
	const sections = all_blocks.filter((block) => block.flow);
	const column = get_column_geometry();
	const column_tags = sections.length ? [
		`\t\t<div class="column" style="left:${column.left}px;top:${column.top}px;width:${column.width}px">`,
		...await Promise.all(sections.map(async (block) => `\t\t\t${block_markup(await with_uploaded_pictures(block.snapshot()), { positioned: false, column: true })}`)),
		"\t\t</div>",
	] : [];
	const block_tags = await Promise.all(all_blocks.filter((block) => !block.flow).map(async (block) => `\t\t${block_markup(await with_uploaded_pictures(block.snapshot()))}`));
	const sticker_tags = [];
	if (canvas === main_canvas) {
		let index = 0;
		for (const sticker of get_stickers()) {
			const source = get_sticker_source(sticker.source_id);
			if (!source) { continue; }
			const src = await asset_url(source.blob, "sticker", index++, source.path || "");
			const transforms = [];
			if (sticker.rotation) { transforms.push(`rotate(${sticker.rotation}deg)`); }
			if (sticker.flip_x || sticker.flip_y) { transforms.push(`scale(${sticker.flip_x ? -1 : 1}, ${sticker.flip_y ? -1 : 1})`); }
			const style = `left:${sticker.x}px;top:${sticker.y}px;width:${sticker.width}px;height:${sticker.height}px${transforms.length ? `;transform:${transforms.join(" ")}` : ""}`;
			if (sticker.href) {
				sticker_tags.push(`\t\t<a class="sticker" href="${escape_html(sticker.href)}" style="${style}"><img src="${src}" alt=""></a>`);
			} else {
				sticker_tags.push(`\t\t<img class="sticker" src="${src}" alt="" style="${style}">`);
			}
		}
	}
	const text_tags = [];
	if (canvas === main_canvas) {
		for (const layer of get_text_layers()) {
			const style = `left:${layer.x}px;top:${layer.y}px;width:${layer.width}px;height:${layer.height}px;` +
				Object.entries(font_css(layer.font)).map(([k, v]) => `${k}:${v}`).join(";");
			const tag = layer.href ? "a" : "span";
			const href = layer.href ? ` href="${escape_html(layer.href)}"` : "";
			text_tags.push(`\t\t<${tag} class="text"${href} style="${escape_html(style)}">${escape_html(layer.text)}</${tag}>`);
		}
	}
	// The page's title: its first section's heading if it has one (a post's title), else the file name without folders
	const heading = sections.map((block) => /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(block.html)).find(Boolean);
	const heading_text = heading ? heading[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
	const page_title = heading_text || title.slice(title.lastIndexOf("/") + 1).replace(/\.(bmp|dib|a?png|gif|jpe?g|jpe|jfif|tiff?|webp|raw|html?)$/i, "") || "Untitled";
	const props = get_page_properties();
	const body_attrs = [
		props.bgcolor ? ` bgcolor="${escape_html(props.bgcolor)}"` : "",
		props.text_color ? ` text="${escape_html(props.text_color)}"` : "",
		props.background ? ` background="${escape_html(props.background)}"` : "",
	].join("");
	return `<!DOCTYPE html>
<html data-page-width="${PAGE_WIDTH}">
<head>
<meta charset="utf-8">
<meta name="generator" content="JS Paint site builder">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape_html(page_title)}</title>
<style>
${COLLAGE_CSS}
</style>
</head>
<body${body_attrs}>
<center>
	<div class="collage${sections.length ? " has-column" : ""}" style="width:${canvas.width}px;height:${canvas.height}px">
		<img class="bitmap" src="${bitmap_src}" width="${canvas.width}" height="${canvas.height}" alt="">
${[...column_tags, ...block_tags, ...sticker_tags, ...text_tags].join("\n")}
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
 * @property {{ src: string, x: number, y: number, width: number, height: number, flip_x: boolean, flip_y: boolean, rotation: number, href: string }[]} stickers
 * @property {TextLayerSnapshot[]} text_layers
 * @property {BlockSnapshot[]} blocks
 * @property {string} title
 * @property {{ bgcolor: string, text_color: string, background: string, column_left: number, column_top: number, column_width: number }} page_properties
 */

/**
 * Pages saved before blocks.js normalize_block_lines can have <div> line breaks inside <p>/<h*> blocks; an HTML
 * parser would close the block at the first <div> and drop the rest of the text. Turn them into <br>s first.
 * @param {string} html
 */
function repair_block_lines(html) {
	return html.replace(/<(p|h[1-6])( class="block"[^>]*)>([\s\S]*?)<\/\1>/g, (_m, tag, attrs, inner) => {
		if (!/<div[\s>]/i.test(inner)) { return `<${tag}${attrs}>${inner}</${tag}>`; }
		const lines = inner
			.replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, "<br>")
			.replace(/<div>([\s\S]*?)<\/div>/gi, "<br>$1")
			.replace(/^(<br>)+/, "");
		return `<${tag}${attrs}>${lines}</${tag}>`;
	});
}

/**
 * @param {string} html
 * @returns {ParsedCollage | null} null if this isn't a collage page
 */
function parse_collage_html(html) {
	const doc = new DOMParser().parseFromString(repair_block_lines(html), "text/html");
	const collage = doc.querySelector(".collage");
	const bitmap = collage?.querySelector("img.bitmap");
	if (!collage || !bitmap) {
		return null;
	}
	const px = (/** @type {string} */ value) => parseFloat(value) || 0;
	const stickers = [];
	for (const el of collage.querySelectorAll(".sticker")) {
		const style = /** @type {HTMLElement} */ (el).style;
		const transform = style.transform || "";
		const scale_match = /scale\(\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+))?\s*\)/.exec(transform);
		const rotate_match = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec(transform);
		const is_link = el.tagName === "A";
		const img = is_link ? el.querySelector("img") : el;
		if (!img) { continue; }
		stickers.push({
			src: img.getAttribute("src") || "",
			href: is_link ? el.getAttribute("href") || "" : "",
			rotation: rotate_match ? ((Math.round(parseFloat(rotate_match[1])) % 360) + 360) % 360 : 0,
			x: px(style.left),
			y: px(style.top),
			width: px(style.width),
			height: px(style.height),
			flip_x: /scaleX\(\s*-1/.test(transform) || (scale_match ? parseFloat(scale_match[1]) < 0 : false),
			flip_y: /scaleY\(\s*-1/.test(transform) || (scale_match ? parseFloat(scale_match[2] ?? scale_match[1]) < 0 : false),
		});
	}
	/** @type {TextLayerSnapshot[]} */
	const text_layers = [];
	for (const [index, el] of [...collage.querySelectorAll(".text")].entries()) {
		const style = /** @type {HTMLElement} */ (el).style;
		const size_match = /^([\d.]+)(pt|px)$/.exec(style.fontSize || "");
		const size = size_match ? (size_match[2] === "px" ? parseFloat(size_match[1]) * 0.75 : parseFloat(size_match[1])) : 12;
		const line_height = px(style.lineHeight);
		text_layers.push({
			id: `t${index + 1}`,
			x: px(style.left),
			y: px(style.top),
			width: px(style.width),
			height: px(style.height),
			text: el.textContent || "",
			font: {
				family: normalize_font_family(style.fontFamily),
				size,
				line_scale: line_height && size ? line_height / size : 20 / 12,
				bold: /bold|[6-9]00/.test(style.fontWeight),
				italic: style.fontStyle === "italic",
				underline: /underline/.test(style.textDecoration || style.textDecorationLine || ""),
				color: style.color || "#000",
				background: style.background && style.background !== "transparent" ? style.backgroundColor || style.background : "",
			},
			href: el.getAttribute("href") || "",
		});
	}
	/** @type {BlockSnapshot[]} */
	const blocks = [];
	const column_el = /** @type {HTMLElement | null} */ (collage.querySelector(":scope > .column"));
	/** @param {Element} el @param {boolean} flow */
	const block_from = (el, flow) => {
		const style = /** @type {HTMLElement} */ (el).style;
		const tag = el.tagName.toLowerCase();
		/** @type {Record<string, string>} */
		const attrs = {};
		for (const attr of el.attributes) {
			if (!/^(class|style|contenteditable)$/i.test(attr.name) && !/^on/i.test(attr.name)) {
				attrs[attr.name.toLowerCase()] = attr.value;
			}
		}
		if (flow && !attrs["data-kind"]) { attrs["data-kind"] = "section"; }
		return {
			id: `b${blocks.length + 1}`,
			kind: block_kind_for(tag, attrs).id,
			tag,
			attrs,
			html: sanitize_html_fragment(el.innerHTML),
			x: px(style.left),
			y: px(style.top),
			width: px(style.width) || 100,
			height: px(style.height) || 24,
			...(flow ? { flow: true } : {}),
		};
	};
	for (const child of collage.children) {
		if (child === column_el) {
			for (const section of child.children) { blocks.push(block_from(section, true)); } // in column order
		} else if (child.classList.contains("block")) {
			blocks.push(block_from(child, false));
		}
	}
	const style = /** @type {HTMLElement} */ (collage).style;
	return {
		text_layers,
		blocks,
		title: doc.title || "",
		page_properties: {
			bgcolor: doc.body.getAttribute("bgcolor") || "",
			text_color: doc.body.getAttribute("text") || "",
			background: doc.body.getAttribute("background") || "",
			column_left: column_el ? px(column_el.style.left) : 0,
			column_top: column_el ? px(column_el.style.top) : 0,
			column_width: column_el ? px(column_el.style.width) : 0,
		},
		width: px(style.width) || Number(bitmap.getAttribute("width")) || 0,
		height: px(style.height) || Number(bitmap.getAttribute("height")) || 0,
		bitmap_src: bitmap.getAttribute("src") || "",
		stickers,
	};
}

/**
 * The Text tool keeps font families quoted (`"Arial"`, as FontDetective reports them); CSSOM strips the quotes.
 * @param {string} family
 */
function normalize_font_family(family) {
	const first = (family || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
	return first ? `"${first}"` : '"Arial"';
}

/**
 * @param {string} html
 */
function is_collage_html(html) {
	return /class=["']?collage\b/.test(html);
}

/**
 * Loads a page (from File > Open, drag and drop, My Site, etc.) as the current document.
 * @param {Blob} file
 * @param {object} [options]
 * @param {string} [options.base_url] - where relative asset paths resolve (a site's files); standalone files need data URLs
 * @param {string} [options.site_page] - the page's path on My Site, so Save puts it back there
 * @returns {Promise<boolean>} whether it opened
 */
async function open_collage_from_file(file, { base_url, site_page } = {}) {
	let parsed;
	try {
		parsed = parse_collage_html(await file.text());
	} catch (error) {
		show_error_message("Paint cannot open this file.", error);
		return false;
	}
	if (!parsed) {
		show_error_message("This web page doesn't contain a collage (a <div class=\"collage\"> with an <img class=\"bitmap\">), so Paint can't open it.");
		return false;
	}
	const load_blob = async (/** @type {string} */ src) => {
		if (!/^(data|blob|https?):/.test(src) && !base_url) {
			throw new Error(`Can't load a relative asset from a standalone file: ${src}`);
		}
		const response = await fetch(new URL(src, base_url || location.href).href);
		if (!response.ok) { throw new Error(`HTTP ${response.status} loading ${src.slice(0, 80)}`); }
		return response.blob();
	};
	let bitmap_blob;
	try {
		bitmap_blob = await load_blob(parsed.bitmap_src);
	} catch (error) {
		show_error_message("Paint cannot open this page's bitmap.", error);
		return false;
	}
	return new Promise((resolve) => read_image_file(bitmap_blob, (error, info) => {
		if (error) {
			show_error_message("Paint cannot open this page's bitmap.", error);
			resolve(false);
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
						rotation: sticker.rotation,
						href: sticker.href,
					});
				} catch (error) {
					show_error_message("Couldn't load one of the collage's stickers; skipping it.", error);
				}
			}
			restore_blocks(parsed.blocks);
			restore_stickers(snapshots);
			restore_text_layers(parsed.text_layers);
			set_page_properties(parsed.page_properties, false);
			// The layers are part of the opened state, not a change to it.
			current_history_node.blocks = snapshot_blocks();
			current_history_node.stickers = snapshot_stickers();
			current_history_node.text_layers = snapshot_text_layers();
			file_format = HTML_FORMAT_ID; // so File > Save writes the web page again
			if (site_page) {
				file_name = site_page;
				system_file_handle = { site_page }; // so File > Save puts it back on the site (my-site.js)
			}
			resolve(true);
		}, () => resolve(false));
	}));
}

export { COLLAGE_CSS, HTML_FORMAT_ID, is_collage_html, open_collage_from_file, parse_collage_html, repair_block_lines, serialize_collage_html };
