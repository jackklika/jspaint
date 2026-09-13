// @ts-check
// What the site shows, on the canvas: an <x-*> element (a visitor counter, a folder view, a guestbook, contents,
// last updated) is rendered by the sites Worker when a page is served — so in the editor it shows what visitors
// see right now, not a placeholder: the real count, the folder's pages, the sections. The page's own site renders
// it (POST …/x/preview, a look that doesn't count as a visit); the element's fallback content stays what's saved
// into the page and shows while the answer is on its way, or when there's no site to ask (signed out, a copy).
import { block_markup, get_blocks } from "./blocks.js";
import { $G } from "./helpers.js";
import { current_site_page_path, public_url } from "./my-site.js";
import { get_site_files_base, load_settings } from "./site-publish.js";

const FRESH_MS = 15000; // a preview this recent isn't asked for again on a re-render
/** @type {Map<string, { html: string, at: number }>} by what was asked (tag, attributes, page, the sections for a contents list) */
const previews = new Map();
/** @type {Map<string, Promise<string | null>>} */
const in_flight = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let refresh_timer = null;

/** The page's sections as the site would see them, for <x-toc>. */
function sections_markup() {
	return `<div class="column">${get_blocks().filter((block) => block.flow).map((block) => block_markup(block.snapshot(), { positioned: false, column: true })).join("")}</div>`;
}

/**
 * @param {import("./blocks.js").OnCanvasBlock} block
 * @param {string} page
 */
function key_of(block, page) {
	return JSON.stringify([load_settings().site, page, block.tag, block.attrs, block.tag === "x-toc" ? sections_markup() : ""]);
}

/**
 * Puts the site's rendering into the element on the canvas (display only: the model keeps the fallback).
 * @param {import("./blocks.js").OnCanvasBlock} block
 * @param {string} html
 */
function show(block, html) {
	const el = block.el;
	if (!el || el.innerHTML === html) { return; }
	el.innerHTML = html;
	// Files of the site (a song, a picture) by their site address; the page's links are only looked at here
	const base = get_site_files_base();
	if (base) {
		for (const media of el.querySelectorAll("img[src], audio[src], source[src]")) {
			const src = media.getAttribute("src") || "";
			if (!/^(?:[a-z]+:|\/\/|\/)/i.test(src)) { media.setAttribute("src", base + src); }
		}
	}
	// Its links and forms are for visitors; here a click selects the element (and a double-click opens its settings)
	el.addEventListener("click", (event) => {
		if (/** @type {HTMLElement} */ (event.target).closest("a, button, input[type=submit]")) { event.preventDefault(); }
	});
	for (const form of el.querySelectorAll("form")) { form.addEventListener("submit", (event) => { event.preventDefault(); }); }
}

/**
 * Asks the page's site how it renders this element now, and shows that.
 * @param {import("./blocks.js").OnCanvasBlock} block
 * @param {boolean} [force] - ask again even if the last answer is recent
 */
async function refresh_block(block, force = false) {
	if (!block.tag.startsWith("x-")) { return; }
	const site = load_settings().site;
	const page = current_site_page_path();
	if (!site || !page) { return; }
	const key = key_of(block, page);
	const cached = previews.get(key);
	if (cached) {
		show(block, cached.html);
		if (!force && Date.now() - cached.at < FRESH_MS) { return; }
	}
	let request = in_flight.get(key);
	if (!request) {
		request = fetch(public_url("x/preview", site), {
			method: "POST", // (a string body is text/plain: no preflight)
			body: JSON.stringify({ page, tag: block.tag, attrs: block.attrs, page_html: block.tag === "x-toc" ? sections_markup() : undefined }),
		}).then(async (response) => {
			if (!response.ok) { return null; }
			const data = await response.json();
			return typeof data.html === "string" ? data.html : null;
		}).catch(() => null).finally(() => { in_flight.delete(key); });
		in_flight.set(key, request);
	}
	const html = await request;
	if (html === null) { return; }
	previews.set(key, { html, at: Date.now() });
	if (previews.size > 200) { previews.delete(/** @type {string} */ (previews.keys().next().value)); }
	// Still that element, still asking the same thing?
	if (get_blocks().includes(block) && key_of(block, page) === key) { show(block, html); }
}

/** Every <x-*> element on the page, again. @param {boolean} [force] */
function refresh_all(force = false) {
	for (const block of get_blocks()) {
		if (block.tag.startsWith("x-")) { refresh_block(block, force); }
	}
}

/** Called once from app.js. */
function init_x_previews() {
	$G.on("block-rendered", (_event, block) => { refresh_block(block); });
	// The sections changed (a contents list follows them); the page was saved or opened (a folder view, the date)
	$G.on("layers-changed history-update", () => {
		if (refresh_timer) { clearTimeout(refresh_timer); }
		refresh_timer = setTimeout(() => { refresh_timer = null; refresh_all(); }, 600);
	});
	$G.on("site-page-opened site-page-restored site-settings-changed", () => { previews.clear(); refresh_all(true); });
}

export { init_x_previews, refresh_all as refresh_x_previews };
