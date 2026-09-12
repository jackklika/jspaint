// @ts-check
/* global localize */
// The GIF picker (the "GIFs" button under the tools, or View > GIF Picker): search GifCities — the
// Internet Archive's collection of GeoCities GIFs — and click or drag a result onto the canvas to add
// it as an animated sticker (stickers.js). gifcities.org has no API or CORS, so requests go through
// the editor Worker's proxy (worker/editor/index.js).
import { $DialogWindow } from "./$ToolWindow.js";
import { track_app_event } from "./app-analytics.js";
import { current_site, get_site_editor_url } from "./site-publish.js";
import { show_error_message } from "./functions.js";
import { $G, E } from "./helpers.js";
import { is_editing_container } from "./blocks.js";
import { insert_picture_blob } from "./pictures.js";
import { add_sticker_from_blob } from "./stickers.js";

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
			const url = `${proxy_base()}${result.url}`;
			const $tile = $(E("button")).addClass("gif-tile").attr({
				type: "button",
				draggable: "true",
				title: `${result.width}×${result.height} — ${localize("click to add, or drag onto the picture")}`,
			}).appendTo($results);
			$(E("img")).attr({ src: url, alt: "", loading: "lazy", draggable: "false" }).appendTo($tile);
			$tile.on("click", () => { add_gif_from_url(url); });
			$tile.on("dragstart", (event) => {
				const dt = /** @type {DragEvent} */ (event.originalEvent).dataTransfer;
				dt.setData(GIF_DRAG_TYPE, url);
				dt.setData("text/uri-list", url);
				dt.effectAllowed = "copy";
			});
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

	const $search_row = $(E("div")).addClass("gif-picker-search").appendTo($main);
	$query = /** @type {JQuery<HTMLInputElement>} */ ($(E("input")).attr({ type: "search", placeholder: localize("Search GifCities (e.g. sparkle, under construction)"), spellcheck: "false" }).appendTo($search_row));
	$query.on("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			search(String($query.val()).trim());
		}
	});
	$(E("button")).attr({ type: "button" }).text(localize("Search")).appendTo($search_row).on("click", () => { search(String($query.val()).trim()); });

	$results = $(E("div")).addClass("gif-picker-results inset-deep").appendTo($main);
	const $footer = $(E("div")).addClass("gif-picker-footer").appendTo($main);
	$status = $(E("span")).addClass("gif-picker-status").text(localize("Type a word and press Enter.")).appendTo($footer);
	$more = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).attr({ type: "button" }).text(localize("More")).prop("disabled", true).appendTo($footer));
	$more.on("click", () => { search(current_query, true); });
	$(E("div")).addClass("gif-picker-credit").html('GIFs from <a href="https://gifcities.org" target="_blank" rel="noopener">GifCities</a>, the Internet Archive\'s GeoCities collection.').appendTo($main);

	$picker.$Button(localize("Close"), () => { $picker.close(); });
	$picker.$content.css({ width: "min(440px, 90vw)" });
	$picker.css({ left: 70, top: 60 });
	$picker.on("close", () => {
		$picker = null;
		$results = null;
		$status = null;
		$more = null;
		$query = null;
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
		width: 64px;
		height: 64px;
		padding: 2px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: #fff;
		cursor: grab;
	}
	.gif-tile img {
		max-width: 100%;
		max-height: 100%;
		image-rendering: pixelated;
		pointer-events: none;
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
