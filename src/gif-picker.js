// @ts-check
/* global localize */
// The GIF picker (the "GIFs" button under the tools, or View > GIF Picker): search GifCities — the
// Internet Archive's collection of GeoCities GIFs — and click or drag a result onto the canvas to add
// it as an animated sticker (stickers.js). gifcities.org has no API or CORS, so requests go through
// the editor Worker's proxy (worker/editor/index.js). A ♥ on each GIF keeps it in the Favorites tab
// (this browser's, in localStorage — by GifCities id, so they're the same GIFs on any editor).
import { $DialogWindow } from "./$ToolWindow.js";
import { track_app_event as track_event } from "./app-analytics.js";
import { current_site, get_site_editor_url } from "./site-publish.js";
import { show_error_message } from "./functions.js";
import { $G, E } from "./helpers.js";
import { is_editing_container } from "./blocks.js";
import { insert_picture_blob } from "./pictures.js";
import { add_sticker_from_blob } from "./stickers.js";

/**
 * Analytics, best effort: the picker must work where PostHog isn't (a dev server, a browser that blocks it — the
 * snippet then never defines the global, and app-analytics.js reaches for it as a bare identifier).
 * @param {string} name @param {Record<string, any>} [props]
 */
function track_app_event(name, props) {
	try {
		track_event(name, props);
	} catch (_error) { /* no analytics here */ }
}

/** The GifCities proxy: the editor Worker. */
function proxy_base() {
	return get_site_editor_url();
}

// Opening the picker shows one of these right away, so there's something to grab before typing.
const STARTER_QUERIES = ["under construction", "welcome", "sparkle", "dancing", "email", "new", "fire", "stars", "rainbow", "cat", "hamster", "skull", "flower", "spinning", "counter", "guestbook", "cool", "hearts", "alien", "computer"];

/**
 * Remembers that a GifCities GIF was used (POST /api/gifs/used: per site and overall — for "top GIFs" later).
 * Best effort; nothing waits on it.
 * @param {string} url
 */
function record_gif_use(url) {
	const match = /\/api\/gifcities\/gif\/([A-Z0-9]{20,40})/.exec(url);
	if (!match) { return; }
	fetch(`${proxy_base()}/api/gifs/used`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ gif: match[1], site: current_site() || "" }),
		keepalive: true,
	}).catch(() => { /* ignore */ });
}

/** dataTransfer type for dragging a result from the picker onto the canvas (handled in app.js) */
const GIF_DRAG_TYPE = "application/x-jspaint-gif-url";
const PAGE_SIZE = 40;
const FAVORITES_KEY = "jspaint favorite gifs";
const MAX_FAVORITES = 300;

/** @typedef {{ id: string, width: number, height: number, at: number }} FavoriteGif - a GifCities id (the proxy serves it) */

/** @returns {FavoriteGif[]} newest first */
function load_favorites() {
	try {
		const list = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
		return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string") : [];
	} catch (_error) {
		return [];
	}
}
/** @param {FavoriteGif[]} list */
function save_favorites(list) {
	try {
		localStorage.setItem(FAVORITES_KEY, JSON.stringify(list.slice(0, MAX_FAVORITES)));
	} catch (_error) { /* full or blocked: the heart still shows for this visit */ }
}
/** @param {string} id */
function is_favorite(id) {
	return load_favorites().some((item) => item.id === id);
}
/**
 * Hearts or un-hearts a GIF.
 * @param {{ id: string, width: number, height: number }} gif
 * @returns {boolean} whether it's a favorite now
 */
function toggle_favorite(gif) {
	const list = load_favorites();
	const index = list.findIndex((item) => item.id === gif.id);
	const on = index === -1;
	if (on) {
		list.unshift({ id: gif.id, width: gif.width, height: gif.height, at: Date.now() });
	} else {
		list.splice(index, 1);
	}
	save_favorites(list);
	track_app_event("gif_favorite", { on, site: current_site() || null });
	$G.triggerHandler("gif-favorites-changed");
	return on;
}
/** The GifCities id in a proxy URL, if it is one. @param {string} url */
function gif_id_of(url) {
	return /\/api\/gifcities\/gif\/([A-Z0-9]{20,40})/.exec(url)?.[1] || "";
}

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $picker = null;
/** @type {JQuery<HTMLElement> | null} */
let $results = null;
/** @type {JQuery<HTMLElement> | null} */
let $status = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $more = null;
/** @type {JQuery<HTMLInputElement> | null} */
let $query = null;
/** @type {JQuery<HTMLElement> | null} the Favorites tab's grid */
let $favorites = null;
/** @type {JQuery<HTMLElement> | null} */
let $favorites_tab = null;
let current_query = "";
/** @type {number | null} */
let next_offset = 0;
let searching = false;

/**
 * Fetches a GIF (through the proxy) and adds it to the canvas as a sticker.
 * @param {string} url
 * @param {{ x?: number, y?: number }} [position]
 */
async function add_gif_from_url(url, position) {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const blob = await response.blob();
		if (is_editing_container() && !position) {
			// Writing a section: the GIF goes into the text at the caret — on the site first when signed in (pictures.js)
			await insert_picture_blob(blob);
		} else {
			await add_sticker_from_blob(blob, position);
		}
		record_gif_use(url);
	} catch (error) {
		show_error_message("Couldn't add the GIF as a sticker.", error);
	}
}

/**
 * @param {string} query
 * @param {boolean} [append] - load the next page of the same query
 * @param {{ starter?: boolean }} [options] - the automatic search when the picker opens isn't a user search
 */
async function search(query, append = false, { starter = false } = {}) {
	if (!$results || !$status || searching) { return; }
	if (!starter) {
		// User searches only (Enter, the Search button, More) — the starter search on open is covered by gif_picker_opened.
		track_app_event("gif_search", { query: query.slice(0, 100), append, site: current_site() || null });
	}
	if (!append) {
		current_query = query;
		next_offset = 0;
		$results.empty();
	}
	if (next_offset === null) { return; }
	searching = true;
	$status.text(localize("Searching..."));
	$more?.prop("disabled", true);
	try {
		const response = await fetch(`${proxy_base()}/api/gifcities/search?q=${encodeURIComponent(current_query)}&offset=${next_offset}&page_size=${PAGE_SIZE}`);
		if (!response.ok) {
			throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
		}
		const data = await response.json();
		for (const result of data.results) {
			make_tile({ url: `${proxy_base()}${result.url}`, width: result.width, height: result.height }).appendTo($results);
		}
		next_offset = data.next_offset;
		const shown = $results.children().length;
		$status.text(shown ? `${shown} GIF${shown === 1 ? "" : "s"}${next_offset === null ? "" : " …"}` : localize("No GIFs found."));
		$more?.prop("disabled", next_offset === null);
	} catch (error) {
		$status.text(`${localize("Search failed:")} ${error.message}`);
	} finally {
		searching = false;
	}
}

/**
 * A GIF in a grid: click or drag it onto the page; the ♥ in its corner keeps it in Favorites.
 * @param {{ url: string, width: number, height: number }} gif
 */
function make_tile({ url, width, height }) {
	const id = gif_id_of(url);
	const $tile = $(E("span")).addClass("gif-tile").attr({
		role: "button",
		tabindex: "0",
		draggable: "true",
		"data-gif": id || null,
		title: `${width}×${height} — ${localize("click to add, or drag onto the picture")}`,
	});
	$(E("img")).attr({ src: url, alt: "", loading: "lazy", draggable: "false" }).appendTo($tile);
	$tile.on("click", () => { add_gif_from_url(url); });
	$tile.on("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); add_gif_from_url(url); } });
	$tile.on("dragstart", (event) => {
		const dt = /** @type {DragEvent} */ (event.originalEvent).dataTransfer;
		dt.setData(GIF_DRAG_TYPE, url);
		dt.setData("text/uri-list", url);
		dt.effectAllowed = "copy";
	});
	if (id) {
		const $heart = $(E("span")).addClass("gif-heart").attr({ role: "button", tabindex: "0" }).appendTo($tile);
		const show = (/** @type {boolean} */ on) => {
			$heart.text(on ? "♥" : "♡").toggleClass("on", on).attr({ "aria-pressed": String(on), "aria-label": on ? localize("Remove from favorites") : localize("Add to favorites"), title: on ? localize("A favorite — click to remove it") : localize("Keep in Favorites") });
		};
		show(is_favorite(id));
		$heart.on("mousedown", (e) => { e.stopPropagation(); });
		$heart.on("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
		$heart.on("click", (e) => {
			e.stopPropagation();
			e.preventDefault();
			show(toggle_favorite({ id, width, height }));
		});
		$heart.on("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.stopPropagation();
				e.preventDefault();
				show(toggle_favorite({ id, width, height }));
			}
		});
		$tile.on("gif-favorites-changed", () => { show(is_favorite(id)); });
	}
	return $tile;
}

/** The Favorites tab's grid: every ♥ GIF, newest first. */
function render_favorites() {
	if (!$favorites || !$favorites_tab) { return; }
	const list = load_favorites();
	$favorites.empty();
	for (const item of list) {
		make_tile({ url: `${proxy_base()}/api/gifcities/gif/${item.id}`, width: item.width, height: item.height }).appendTo($favorites);
	}
	if (!list.length) {
		$(E("p")).addClass("gif-picker-empty").text(localize("No favorites yet. Click the ♥ on a GIF to keep it here.")).appendTo($favorites);
	}
	$favorites_tab.text(list.length ? `${localize("Favorites")} ♥ ${list.length}` : `${localize("Favorites")} ♡`);
}

function show_gif_picker() {
	if ($picker) {
		$picker.bringToFront();
		$query?.focus();
		return;
	}
	track_app_event("gif_picker_opened", { site: current_site() || null });
	$picker = $DialogWindow(localize("GIFs"));
	$picker.addClass("gif-picker-window squish");
	const $main = $picker.$main;

	// Two tabs, a property sheet like My Site's: Search (GifCities) and Favorites (the ♥ ones)
	const $tabs = $(E("div")).addClass("gif-picker-tabs").attr({ role: "tablist" }).appendTo($main);
	const $panels = $(E("div")).addClass("gif-picker-panels").appendTo($main);
	const tab = (/** @type {string} */ id, /** @type {string} */ label) => $(E("div")).addClass("gif-picker-tab").attr({ role: "tab", tabindex: "-1", "aria-selected": "false", "data-tab": id }).text(label).appendTo($tabs);
	const $search_tab = tab("search", localize("Search"));
	$favorites_tab = tab("favorites", localize("Favorites"));
	const $search_panel = $(E("div")).addClass("gif-picker-panel").attr({ role: "tabpanel", "data-tab": "search" }).appendTo($panels);
	const $favorites_panel = $(E("div")).addClass("gif-picker-panel").attr({ role: "tabpanel", "data-tab": "favorites" }).hide().appendTo($panels);
	const select_tab = (/** @type {"search" | "favorites"} */ tab) => {
		/** @type {[JQuery<HTMLElement>, JQuery<HTMLElement>, string][]} */
		const pairs = [[$search_tab, $search_panel, "search"], [$favorites_tab, $favorites_panel, "favorites"]];
		for (const [$tab, $panel, name] of pairs) {
			$tab.toggleClass("selected", name === tab).attr({ "aria-selected": String(name === tab), tabindex: name === tab ? "0" : "-1" });
			$panel.toggle(name === tab);
		}
		if (tab === "favorites") { render_favorites(); } else { $query?.focus(); }
	};
	$search_tab.on("click", () => { select_tab("search"); });
	$favorites_tab.on("click", () => { select_tab("favorites"); });
	$tabs.on("keydown", (e) => {
		if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			e.preventDefault();
			select_tab($favorites_tab?.hasClass("selected") ? "search" : "favorites");
			$tabs.children(".selected").trigger("focus");
		}
	});
	select_tab("search");

	const $search_row = $(E("div")).addClass("gif-picker-search").appendTo($search_panel);
	$query = /** @type {JQuery<HTMLInputElement>} */ ($(E("input")).attr({ type: "search", placeholder: localize("Search GifCities (e.g. sparkle, under construction)"), spellcheck: "false" }).appendTo($search_row));
	$query.on("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			search(String($query.val()).trim());
		}
	});
	$(E("button")).attr({ type: "button" }).text(localize("Search")).appendTo($search_row).on("click", () => { search(String($query.val()).trim()); });

	$results = $(E("div")).addClass("gif-picker-results inset-deep").appendTo($search_panel);
	const $footer = $(E("div")).addClass("gif-picker-footer").appendTo($search_panel);
	$status = $(E("span")).addClass("gif-picker-status").text(localize("Type a word and press Enter.")).appendTo($footer);
	$more = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).attr({ type: "button" }).text(localize("More")).prop("disabled", true).appendTo($footer));
	$more.on("click", () => { search(current_query, true); });
	$favorites = $(E("div")).addClass("gif-picker-results gif-picker-favorites inset-deep").appendTo($favorites_panel);
	$(E("div")).addClass("gif-picker-credit").html('GIFs from <a href="https://gifcities.org" target="_blank" rel="noopener">GifCities</a>, the Internet Archive\'s GeoCities collection.').appendTo($main);
	render_favorites(); // (the tab's count)
	const on_favorites_changed = () => {
		render_favorites();
		$results?.children(".gif-tile").each((_index, tile) => { $(tile).triggerHandler("gif-favorites-changed"); }); // (a heart on a search result follows the Favorites tab; triggerHandler: no bubbling back up here)
	};
	$G.on("gif-favorites-changed", on_favorites_changed);

	$picker.$Button(localize("Close"), () => { $picker.close(); });
	$picker.$content.css({ width: "min(440px, 90vw)" });
	$picker.css({ left: 70, top: 60 });
	$picker.on("close", () => {
		$G.off("gif-favorites-changed", on_favorites_changed);
		$picker = null;
		$results = null;
		$status = null;
		$more = null;
		$query = null;
		$favorites = null;
		$favorites_tab = null;
		$G.triggerHandler("gif-picker-toggled");
	});
	$G.triggerHandler("gif-picker-toggled");
	$query.focus();
	// Something to look at right away
	const starter = STARTER_QUERIES[Math.floor(Math.random() * STARTER_QUERIES.length)];
	$query.val(starter);
	search(starter, false, { starter: true });
	$query.select();
}

function toggle_gif_picker() {
	if ($picker) {
		$picker.close();
	} else {
		show_gif_picker();
	}
}

function is_gif_picker_open() {
	return !!$picker;
}

$("<style>").text(`
	.gif-picker-tabs {
		display: flex;
		align-items: flex-end;
		padding: 0 2px;
		position: relative;
		z-index: 1;
	}
	.gif-picker-tab {
		padding: 3px 10px 2px;
		margin-right: -1px;
		background: var(--ButtonFace, #c0c0c0);
		color: var(--ButtonText, #000);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) transparent var(--ButtonHilight, #fff);
		box-shadow: inset -1px 0 var(--ButtonShadow, #808080);
		border-radius: 3px 3px 0 0;
		cursor: default;
		user-select: none;
		white-space: nowrap;
	}
	.gif-picker-tab.selected {
		padding: 4px 12px 4px;
		margin: -2px 0 -1px -2px;
		position: relative;
		z-index: 2;
	}
	.gif-picker-tab:focus-visible {
		outline: 1px dotted currentColor;
		outline-offset: -4px;
	}
	.gif-picker-panels {
		background: var(--ButtonFace, #c0c0c0);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) var(--ButtonDkShadow, #000) var(--ButtonHilight, #fff);
		box-shadow: inset -1px -1px var(--ButtonShadow, #808080);
		padding: 8px;
	}
	.gif-picker-search {
		display: flex;
		gap: 4px;
		margin-bottom: 6px;
	}
	.gif-picker-search input {
		flex: 1;
		min-width: 0;
	}
	.gif-picker-results {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-content: flex-start;
		height: 260px;
		overflow: auto;
		padding: 6px;
		background: #fff;
	}
	.gif-tile {
		position: relative;
		width: 64px;
		height: 64px;
		padding: 2px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: #fff;
		border: 1px solid var(--ButtonShadow, #808080);
		box-sizing: border-box;
		cursor: grab;
	}
	.gif-tile:hover,
	.gif-tile:focus-visible {
		outline: 1px dotted #000;
	}
	.gif-tile img {
		max-width: 100%;
		max-height: 100%;
		image-rendering: pixelated;
		pointer-events: none;
	}
	.gif-heart {
		position: absolute;
		right: 1px;
		top: 1px;
		width: 16px;
		height: 16px;
		display: block;
		font: 13px/16px Arial, Helvetica, sans-serif;
		text-align: center;
		color: #ff1493;
		background: rgba(255, 255, 255, 0.85);
		border-radius: 8px;
		cursor: pointer;
		opacity: 0.6;
	}
	.gif-heart.on,
	.gif-tile:hover .gif-heart,
	.gif-heart:focus-visible {
		opacity: 1;
	}
	.gif-picker-empty {
		width: 100%;
		margin: 24px 8px;
		text-align: center;
		color: #444;
		font: 12px Arial, Helvetica, sans-serif;
	}
	.gif-picker-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		margin-top: 6px;
	}
	.gif-picker-credit {
		margin-top: 6px;
		font-size: 11px;
		opacity: 0.8;
	}
	.tool-box .gif-picker-button {
		display: block;
		width: calc(100% - 4px);
		margin: 4px 2px 0;
		font: bold 11px sans-serif;
	}
`).appendTo(document.head);

export { GIF_DRAG_TYPE, add_gif_from_url, is_gif_picker_open, show_gif_picker, toggle_gif_picker };
