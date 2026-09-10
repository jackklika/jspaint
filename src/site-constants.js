// @ts-check
// Constants shared by the Paint app, the page editor, and the Workers (see docs/DESIGN.md).

/** Fixed width of a page's centered column, in CSS pixels. The one layout constant; user-choosable later. */
export const PAGE_WIDTH = 800;

/** Longest animated GIF export, in milliseconds. Sticker timelines longer than this are cut at the cap. */
export const GIF_EXPORT_MAX_DURATION_MS = 10000;

/** Most frames an animated GIF export will contain; longer timelines are quantized to fit. */
export const GIF_EXPORT_MAX_FRAMES = 200;

/** The hosted editor Worker (Paint app + publish API + GifCities proxy). Overridable in File > Save to My Site. */
export const DEFAULT_EDITOR_URL = "https://edit.coolpaint.world";

/**
 * The editor Worker this copy of Paint talks to when nothing is configured: its own origin when the editor Worker
 * is serving it (worker/build-editor.mjs marks that copy with a meta tag), otherwise the hosted one.
 * A fresh browser opening a share link on any hostname (old or new domain, localhost) thus joins the right room.
 */
export function default_editor_url() {
	const meta = document.querySelector('meta[name="jspaint-editor"]');
	return meta && meta.getAttribute("content") === "self" ? location.origin : DEFAULT_EDITOR_URL;
}

/** Where published sites live: `${DEFAULT_SITES_URL}/~name/`, and the root site at `${DEFAULT_SITES_URL}/`. */
export const DEFAULT_SITES_URL = "https://coolpaint.world";

/** The site served at the domain itself (mirrors ROOT_SITE in worker/shared/names.js). */
export const ROOT_SITE = "root";

/**
 * Public URL of a page or file of a site: the root site is the domain itself, others live at /~name/
 * (mirrors site_base in worker/shared/names.js — the built app can't import worker code).
 * @param {string} site @param {string} [path] @param {string} [sites_url]
 */
export function site_public_url(site, path = "index.html", sites_url = DEFAULT_SITES_URL) {
	const base = sites_url.replace(/\/+$/, "");
	const file = path === "index.html" ? "" : path;
	return site === ROOT_SITE ? `${base}/${file}` : `${base}/~${site}/${file}`;
}

// app-state.js (not a module) reads the page width for the default canvas size.
/** @type {any} */ (window).PAGE_WIDTH = PAGE_WIDTH;
