// @ts-check
/* global localize */
// The GIF picker (the "GIFs" button under the tools, or View > GIF Picker): search GifCities — the
// Internet Archive's collection of GeoCities GIFs — and click or drag a result onto the canvas to add
// it as an animated sticker (stickers.js). gifcities.org has no API or CORS, so requests go through
// the agent server's proxy (agent-server/server.js); the hosted editor will proxy through its Worker.
import { $DialogWindow } from "./$ToolWindow.js";
import { get_server_url } from "./agent-drive.js";
import { show_error_message } from "./functions.js";
import { $G, E } from "./helpers.js";
import { add_sticker_from_blob } from "./stickers.js";

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
		await add_sticker_from_blob(await response.blob(), position);
	} catch (error) {
		show_error_message("Couldn't add the GIF as a sticker.", error);
	}
}

/**
 * @param {string} query
 * @param {boolean} [append] - load the next page of the same query
 */
async function search(query, append = false) {
	if (!$results || !$status || searching) { return; }
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
		const response = await fetch(`${get_server_url()}/api/gifcities/search?q=${encodeURIComponent(current_query)}&offset=${next_offset}&page_size=${PAGE_SIZE}`);
		if (!response.ok) {
			throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
		}
		const data = await response.json();
		for (const result of data.results) {
			const url = `${get_server_url()}${result.url}`;
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
