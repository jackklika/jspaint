// @ts-check
// The page dialect on the client (docs/DESIGN.md §3): parse a page into blocks, serialize blocks back,
// and sanitize what we render (the server sanitizes too; this keeps the editor's own origin safe).

export const PAGE_WIDTH = 800;

/** Base stylesheet every page carries, so it renders the same anywhere. */
export const PAGE_CSS = `
body > center { width: ${PAGE_WIDTH}px; margin: 0 auto; }
.collage { position: relative; display: inline-block; overflow: hidden; line-height: 0; }
.collage > .bitmap { display: block; image-rendering: pixelated; }
.collage > .sticker, .collage > .text { position: absolute; }
.collage > .sticker { image-rendering: pixelated; }
.collage > a.sticker { display: block; }
.collage > a.sticker > img { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
.collage > .text { box-sizing: border-box; margin: 0; padding: 0; white-space: pre-wrap; overflow-wrap: break-word; overflow: hidden; line-height: normal; text-decoration: none; }
.collage > a.text { text-decoration: underline; }
img.doodle { position: absolute; left: 0; top: 0; pointer-events: none; }
`.trim();

const BLOCKED_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "form", "input", "button", "textarea", "select", "noscript"]);
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data:text\/html|data:application)/i;

/**
 * Removes anything executable from a parsed element tree, in place.
 * @param {Element | DocumentFragment} root
 */
export function sanitize_tree(root) {
	for (const el of [...root.querySelectorAll("*")]) {
		const tag = el.tagName.toLowerCase();
		if (BLOCKED_TAGS.has(tag) || (tag === "meta" && el.hasAttribute("http-equiv")) || (tag === "link" && !/^(stylesheet|icon)$/i.test(el.getAttribute("rel") || ""))) {
			el.remove();
			continue;
		}
		for (const attr of [...el.attributes]) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || name === "srcdoc" || (/^(href|src|action|background|xlink:href)$/.test(name) && DANGEROUS_URL.test(attr.value))) {
				el.removeAttribute(attr.name);
			}
		}
	}
}

/**
 * @typedef {object} PageModel
 * @property {string} title
 * @property {string} bgcolor
 * @property {string} text_color
 * @property {string} background - wallpaper path, site-relative
 * @property {Element[]} blocks - top-level elements of <center>, in order
 * @property {string} doodle - img.doodle src, if any
 */

/**
 * @param {string} html
 * @returns {PageModel}
 */
export function parse_page(html) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	sanitize_tree(doc.documentElement);
	const center = doc.querySelector("body > center") || doc.body;
	const doodle = doc.querySelector("body > img.doodle");
	const blocks = [...center.children].filter((el) => !(el.tagName === "IMG" && el.classList.contains("doodle")));
	return {
		title: doc.title || "",
		bgcolor: doc.body.getAttribute("bgcolor") || "#ffffff",
		text_color: doc.body.getAttribute("text") || "",
		background: doc.body.getAttribute("background") || "",
		blocks,
		doodle: doodle?.getAttribute("src") || "",
	};
}

/** @param {string} text */
export function escape_html(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

/**
 * @param {PageModel} model
 * @returns {string}
 */
export function serialize_page(model) {
	const body_attrs = [
		`bgcolor="${escape_html(model.bgcolor || "#ffffff")}"`,
		model.text_color ? `text="${escape_html(model.text_color)}"` : "",
		model.background ? `background="${escape_html(model.background)}"` : "",
	].filter(Boolean).join(" ");
	const blocks = model.blocks.map((el) => `\t${el.outerHTML}`).join("\n");
	return `<!DOCTYPE html>
<html data-page-width="${PAGE_WIDTH}">
<head>
<meta charset="utf-8">
<meta name="generator" content="jspaint site builder">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape_html(model.title || "Untitled")}</title>
<style>
${PAGE_CSS}
</style>
</head>
<body ${body_attrs}>
<center>
${blocks}
</center>
${model.doodle ? `<img class="doodle" src="${escape_html(model.doodle)}" alt="">` : ""}
</body>
</html>
`;
}

/**
 * What kind of block an element is, for the editor's labels and tools.
 * @param {Element} el
 * @returns {"heading" | "paragraph" | "marquee" | "image" | "collage" | "x" | "list" | "table" | "raw"}
 */
export function block_kind(el) {
	const tag = el.tagName.toLowerCase();
	if (/^h[1-6]$/.test(tag)) { return "heading"; }
	if (tag === "p" || tag === "div" && !el.classList.contains("collage") && !el.querySelector("img, table, marquee")) { return "paragraph"; }
	if (tag === "marquee") { return "marquee"; }
	if (tag === "img" || (tag === "a" && el.children.length === 1 && el.firstElementChild?.tagName === "IMG")) { return "image"; }
	if (el.classList.contains("collage")) { return "collage"; }
	if (tag.startsWith("x-")) { return "x"; }
	if (tag === "ul" || tag === "ol") { return "list"; }
	if (tag === "table") { return "table"; }
	return "raw";
}

/**
 * Rewrites site-relative URLs to absolute ones for display, or back.
 * @param {Element} root
 * @param {string} base - the site's public base URL, with trailing slash
 * @param {"absolute" | "relative"} direction
 */
export function rewrite_urls(root, base, direction) {
	for (const el of [root, ...root.querySelectorAll("[src], [href], [background]")]) {
		for (const attr of ["src", "href", "background"]) {
			const value = el.getAttribute(attr);
			if (!value) { continue; }
			if (direction === "absolute") {
				if (!/^(?:[a-z]+:|\/\/|#)/i.test(value)) {
					el.setAttribute(attr, base + value.replace(/^\.?\//, ""));
				}
			} else if (value.startsWith(base)) {
				el.setAttribute(attr, value.slice(base.length) || "index.html");
			}
		}
	}
}

/** A fresh page with one heading, as the dialect. */
export function blank_page_html(title = "My Page") {
	return serialize_page({
		title,
		bgcolor: "#ffffd9",
		text_color: "",
		background: "",
		blocks: [Object.assign(document.createElement("h1"), { innerHTML: `<font face="Comic Sans MS" color="#ff1493">${escape_html(title)}</font>` })],
		doodle: "",
	});
}
