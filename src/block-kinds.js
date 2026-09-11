// @ts-check
// Block kinds: the page elements you can place on the canvas with the toolbox (blocks.js), what markup each
// one is in the page (docs/DESIGN.md §3.2), and how the editor edits it. `<x-*>` kinds come from the same
// registry the Workers render from (worker/shared/x-elements/); the copy here is the offline default and is
// refreshed from the editor's /api/x-elements when Paint is signed in to a site.
import { get_site_editor_url } from "./site-publish.js";

/**
 * @typedef {object} BlockProp - one attribute in an element's Properties dialog
 * @property {string} attr
 * @property {string} label
 * @property {"text" | "number" | "color" | "select"} type
 * @property {string[]} [options]
 */
/**
 * @typedef {object} BlockKind
 * @property {string} id - "heading", "marquee", "x-counter", …
 * @property {string} label
 * @property {string} description - status bar text
 * @property {string} tag - element tag name (lowercase)
 * @property {Record<string, string>} attrs - default attributes (never class or style)
 * @property {string} html - default inner HTML
 * @property {number} width - default size when placed with a click
 * @property {number} height
 * @property {boolean} editable - text edits in place (contenteditable)
 * @property {BlockProp[]} props
 * @property {string} [icon] - glyph for the Layers window
 * @property {boolean} [flow] - a section: stacks in the page's column and grows with its text (blocks.js reflow_sections)
 * @property {boolean} [linkable] - the whole element can be a link (Add Link to Element); default: yes, except x-* elements
 */

const CLASSIC_FONTS = ["Arial", "Comic Sans MS", "Courier New", "Georgia", "Impact", "Times New Roman", "Trebuchet MS", "Verdana"];

const MARQUEE_PROPS = /** @type {BlockProp[]} */ ([
	{ attr: "behavior", label: "Behavior", type: "select", options: ["scroll", "slide", "alternate"] },
	{ attr: "direction", label: "Direction", type: "select", options: ["left", "right", "up", "down"] },
	{ attr: "scrollamount", label: "Speed (pixels per step)", type: "number" },
	{ attr: "bgcolor", label: "Background color", type: "color" },
]);
const TABLE_PROPS = /** @type {BlockProp[]} */ ([
	{ attr: "bgcolor", label: "Background color", type: "color" },
	{ attr: "border", label: "Border width", type: "number" },
	{ attr: "bordercolor", label: "Border color", type: "color" },
	{ attr: "cellpadding", label: "Cell padding", type: "number" },
]);

/** @type {BlockKind[]} */
const BLOCK_KINDS = [
	{
		id: "heading",
		label: "Heading",
		description: "Places a heading on the page. Click or drag a box, then type.",
		tag: "h1",
		attrs: {},
		html: '<font face="Comic Sans MS" color="#ff1493">Welcome to my page</font>',
		width: 420,
		height: 48,
		editable: true,
		icon: "H",
		props: [{ attr: "align", label: "Alignment", type: "select", options: ["left", "center", "right"] }],
	},
	{
		id: "paragraph",
		label: "Text Box",
		description: "Places text on the page. Click or drag a box, then type; the Font toolbar sets font, size, bold, and scrolling (marquee).",
		tag: "p",
		attrs: {},
		html: "Write something here.",
		width: 320,
		height: 80,
		editable: true,
		icon: "¶",
		props: [{ attr: "align", label: "Alignment", type: "select", options: ["left", "center", "right", "justify"] }],
	},
	{
		id: "section",
		label: "Section",
		description: "A section of writing: sections stack in a column, grow with their text, and can be reordered.",
		tag: "div",
		attrs: { "data-kind": "section" },
		html: "<h2>New section</h2>Write here. Headings, lists, and links come from the Font toolbar.",
		width: 720,
		height: 60,
		editable: true,
		flow: true,
		icon: "§",
		props: [{ attr: "id", label: "Anchor (links to this section end in #this)", type: "text" }],
	},
	{
		id: "marquee",
		label: "Marquee",
		description: "Places scrolling text on the page.",
		tag: "marquee",
		attrs: { behavior: "scroll", scrollamount: "4" },
		html: "~*~ welcome to my page ~*~",
		width: 400,
		height: 24,
		editable: true,
		icon: "«»",
		props: MARQUEE_PROPS,
	},
	{
		id: "divider",
		linkable: false,
		label: "Divider",
		description: "Places a horizontal rule on the page.",
		tag: "hr",
		attrs: { size: "3", color: "#ff69b4" },
		html: "",
		width: 400,
		height: 8,
		editable: false,
		icon: "—",
		props: [{ attr: "size", label: "Thickness", type: "number" }, { attr: "color", label: "Color", type: "color" }, { attr: "noshade", label: "Flat (noshade)", type: "select", options: ["", "noshade"] }],
	},
	{
		id: "table",
		linkable: false,
		label: "Table",
		description: "Places a table on the page. Click into a cell to type.",
		tag: "table",
		attrs: { border: "1", cellpadding: "4", cellspacing: "0", bgcolor: "#ffffff", width: "100%" },
		html: "<tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr>",
		width: 300,
		height: 80,
		editable: true,
		icon: "▦",
		props: TABLE_PROPS,
	},
	{
		id: "box",
		label: "Colored Box",
		description: "Places a colored box with a border you can type in.",
		tag: "table",
		attrs: { "data-kind": "box", border: "2", cellpadding: "8", cellspacing: "0", bgcolor: "#ffffcc", bordercolor: "#ff69b4", width: "100%", height: "100%" },
		html: '<tr><td valign="top">Anything goes here.</td></tr>',
		width: 300,
		height: 120,
		editable: true,
		icon: "▣",
		props: TABLE_PROPS,
	},
	{
		id: "x-guestbook",
		label: "Guestbook",
		description: "Places a guestbook visitors can sign. Entries are kept by your site.",
		tag: "x-guestbook",
		attrs: {},
		html: "<b>Sign my guestbook!</b> <i>(the form appears on the published page)</i>",
		width: 500,
		height: 200,
		editable: false,
		icon: "📖",
		props: [{ attr: "title", label: "Title", type: "text" }, { attr: "max", label: "Entries shown", type: "number" }],
	},
	{
		id: "x-counter",
		label: "Visitor Counter",
		description: "Places a visitor counter that counts up on the published page.",
		tag: "x-counter",
		attrs: {},
		html: "You are visitor number <b>000123</b>",
		width: 300,
		height: 28,
		editable: false,
		icon: "#",
		props: [{ attr: "label", label: "Label", type: "text" }, { attr: "digits", label: "Digits", type: "number" }],
	},
	{
		id: "x-music",
		label: "Music",
		description: "Places background music with a play button on the published page.",
		tag: "x-music",
		attrs: { loop: "yes" },
		html: "♫ <i>music</i>",
		width: 300,
		height: 40,
		editable: false,
		icon: "♫",
		props: [{ attr: "src", label: "Audio file (URL, or midi/song.mp3 on your site)", type: "text" }, { attr: "autoplay", label: "Autoplay", type: "select", options: ["", "yes"] }, { attr: "loop", label: "Loop", type: "select", options: ["yes", ""] }],
	},
	{
		id: "x-updated",
		label: "Last Updated",
		description: "Places a \"last updated\" stamp that follows your saves.",
		tag: "x-updated",
		attrs: {},
		html: "Last updated: <i>sometime in the 90s</i>",
		width: 300,
		height: 24,
		editable: false,
		icon: "🕒",
		props: [{ attr: "label", label: "Label", type: "text" }, { attr: "format", label: "Format", type: "select", options: ["short", "long"] }],
	},
	{
		id: "x-folder",
		label: "Folder View",
		description: "Lists the pages in a folder of your site (a posts folder, say), newest first, on the published page.",
		tag: "x-folder",
		attrs: { path: "posts", show: "title,date", order: "newest" },
		html: "<b>Posts</b><br><i>(the pages in the folder are listed here on the published page)</i>",
		width: 360,
		height: 120,
		editable: false,
		icon: "≡",
		props: [
			{ attr: "path", label: "Folder", type: "text" },
			{ attr: "show", label: "Show", type: "select", options: ["title", "title,date"] },
			{ attr: "order", label: "Order", type: "select", options: ["newest", "oldest", "name"] },
			{ attr: "limit", label: "At most", type: "number" },
			{ attr: "title", label: "Heading", type: "text" },
		],
	},
	{
		id: "x-toc",
		label: "Table of Contents",
		description: "Lists the page's sections, each a link to it, on the published page.",
		tag: "x-toc",
		attrs: {},
		html: "<b>Contents</b><br><i>(the page's sections are listed here on the published page)</i>",
		width: 240,
		height: 100,
		editable: false,
		icon: "☰",
		props: [{ attr: "title", label: "Heading", type: "text" }],
	},
	{
		id: "raw",
		linkable: false,
		label: "HTML",
		description: "Places a box of raw HTML on the page. Anything goes (except scripts).",
		tag: "div",
		attrs: { "data-kind": "raw" },
		html: '<center><blink><font color="#00ff00">under construction</font></blink></center>',
		width: 300,
		height: 60,
		editable: true,
		icon: "</>",
		props: [],
	},
];

/** @param {string} id */
function get_block_kind(id) {
	return BLOCK_KINDS.find((kind) => kind.id === id);
}

/**
 * Which kind an element in a page is, from its tag and data-kind.
 * @param {string} tag
 * @param {Record<string, string>} attrs
 * @returns {BlockKind}
 */
function block_kind_for(tag, attrs) {
	const by_data = attrs["data-kind"] && get_block_kind(attrs["data-kind"]);
	if (by_data) { return by_data; }
	if (/^h[1-6]$/.test(tag)) { return get_block_kind("heading"); }
	if (tag === "p" || tag === "div" && !attrs["data-kind"]) { return tag === "p" ? get_block_kind("paragraph") : get_block_kind("raw"); }
	const by_tag = BLOCK_KINDS.find((kind) => kind.tag === tag && !kind.attrs["data-kind"]);
	if (by_tag) { return by_tag; }
	if (tag.startsWith("x-")) {
		// An <x-*> element we don't know: still a block; its fallback content shows.
		return { id: tag, label: tag, description: "", tag, attrs: {}, html: "", width: 300, height: 40, editable: false, icon: "x", props: [] };
	}
	return get_block_kind("raw");
}

/**
 * Refreshes the <x-*> kinds from the editor Worker's registry (labels, fallbacks, attributes), so a new
 * element on the server shows up in the Page › Insert menu without a Paint release. Silent on failure.
 */
async function refresh_x_element_kinds() {
	try {
		const response = await fetch(`${get_site_editor_url()}/api/x-elements`);
		if (!response.ok) { return; }
		/** @type {{ tag: string, attrs: string[], editor: { label: string, description: string, fallback: string } }[]} */
		const definitions = await response.json();
		for (const definition of definitions) {
			if (!/^x-[a-z0-9-]+$/.test(definition.tag)) { continue; }
			const existing = BLOCK_KINDS.find((kind) => kind.id === definition.tag);
			const props = definition.attrs.map((attr) => existing?.props.find((prop) => prop.attr === attr) || { attr, label: attr, type: /** @type {const} */ ("text") });
			if (existing) {
				existing.label = definition.editor.label || existing.label;
				existing.description = definition.editor.description || existing.description;
				existing.props = props;
			} else {
				BLOCK_KINDS.push({ id: definition.tag, label: definition.editor.label, description: definition.editor.description, tag: definition.tag, attrs: {}, html: definition.editor.fallback, width: 300, height: 40, editable: false, icon: "x", props });
			}
		}
	} catch (_error) { /* offline, or no editor configured */ }
}

const BLOCKED_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "form", "input", "button", "textarea", "select", "noscript", "meta", "link", "style", "template"]);
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data:text\/html|data:application)/i;

/**
 * Removes anything executable from a parsed element tree, in place. The Workers sanitize again on save and
 * on serve; this keeps Paint's own origin safe when opening a page from anywhere.
 * @param {Element | DocumentFragment} root
 */
function sanitize_tree(root) {
	for (const el of [...root.querySelectorAll("*")]) {
		if (BLOCKED_TAGS.has(el.tagName.toLowerCase())) {
			el.remove();
			continue;
		}
		for (const attr of [...el.attributes]) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || name === "srcdoc" || name === "contenteditable" || (/^(href|src|action|background|xlink:href|usemap|poster|data)$/.test(name) && DANGEROUS_URL.test(attr.value))) {
				el.removeAttribute(attr.name);
			}
		}
	}
}

/**
 * Parses one element's markup, sanitized, without loading anything (template content is inert).
 * @param {string} html
 * @returns {Element | null}
 */
function element_from_html(html) {
	const template = document.createElement("template");
	template.innerHTML = html.trim();
	sanitize_tree(template.content);
	return template.content.firstElementChild;
}

/**
 * Sanitizes a fragment of inner HTML.
 * @param {string} html
 */
function sanitize_html_fragment(html) {
	const template = document.createElement("template");
	template.innerHTML = html;
	sanitize_tree(template.content);
	return template.innerHTML;
}

/** @param {string} text */
function escape_html(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

export { BLOCK_KINDS, CLASSIC_FONTS, block_kind_for, element_from_html, escape_html, get_block_kind, refresh_x_element_kinds, sanitize_html_fragment, sanitize_tree };
