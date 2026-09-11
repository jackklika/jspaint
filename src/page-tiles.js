// @ts-check
// Pages as tiles — Windows 98 "large icons": each page's saved bitmap in a 3D frame with its name under it, the
// front page (index.html ★) first. My Site › Pages browses them; the link dialog picks one. The thumbnail is the
// site's own copy of the page's bitmap (collages/<page>.png), so it's the published look.
import { E } from "./helpers.js";

/** @typedef {{ path: string, size: number, uploaded: string, url: string }} SiteFile - one entry of the site's listing */

const is_page = (/** @type {string} */ path) => /\.html?$/i.test(path);
const is_index = (/** @type {string} */ path) => /^index\.html?$/i.test(path);
const kb = (/** @type {number} */ bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Fills a box (class my-site-pages) with a tile per page of the site.
 * @param {JQuery} $box - emptied first
 * @param {SiteFile[]} files - the site's listing (the pages, and their collages/ bitmaps for the thumbnails)
 * @param {object} [options]
 * @param {(file: SiteFile) => void} [options.on_pick] - a click on a tile (or focus)
 * @param {(file: SiteFile) => void} [options.on_open] - a double-click (or Enter)
 * @param {{ label: string, action: () => void }} [options.plus] - a + tile at the end
 * @param {string} [options.empty] - what to say when the site has no pages
 */
function render_page_tiles($box, files, { on_pick, on_open, plus, empty } = {}) {
	$box.empty();
	const by_path = new Map(files.map((file) => [file.path, file]));
	const pages = files.filter((file) => is_page(file.path)).sort((a, b) => (is_index(a.path) ? -1 : is_index(b.path) ? 1 : a.path.localeCompare(b.path)));
	if (pages.length === 0 && empty) {
		$(E("div")).addClass("my-site-empty my-site-pages-empty").text(empty).appendTo($box);
	}
	for (const file of pages) {
		const bitmap = by_path.get(`collages/${file.path.replace(/\.html?$/i, "")}.png`);
		const $tile = $(E("div")).addClass("my-site-tile").attr({ role: "option", tabindex: "0", "data-path": file.path, title: `${file.path} · ${kb(file.size)} · ${new Date(file.uploaded).toLocaleString()}` }).appendTo($box);
		const $thumb = $(E("div")).addClass("my-site-thumb").appendTo($tile);
		if (bitmap) {
			$(E("img")).attr({ src: `${bitmap.url}?v=${Date.parse(bitmap.uploaded) || 0}`, alt: "", draggable: "false" }).appendTo($thumb); // (?v= so a new save shows)
		} else {
			$thumb.addClass("my-site-thumb-blank").text("📄");
		}
		$(E("span")).addClass("my-site-tile-name").text(is_index(file.path) ? `${file.path} ★` : file.path).appendTo($tile);
		$tile.on("click focus", () => { on_pick?.(file); });
		$tile.on("dblclick", () => { on_open?.(file); });
		$tile.on("keydown", (e) => { if (e.key === "Enter") { on_open?.(file); } });
	}
	if (plus) {
		const $new = $(E("div")).addClass("my-site-tile my-site-new").attr({ role: "button", tabindex: "0", title: plus.label }).appendTo($box);
		$(E("div")).addClass("my-site-thumb my-site-thumb-blank").text("+").appendTo($new);
		$(E("span")).addClass("my-site-tile-name").text(plus.label).appendTo($new);
		$new.on("click", () => { plus.action(); });
		$new.on("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); plus.action(); } });
	}
}

/** Highlights one tile (by the page's path), or none. @param {JQuery} $box @param {string | null} path */
function select_page_tile($box, path) {
	$box.find(".my-site-tile").each((_i, el) => { $(el).toggleClass("selected", !!path && el.dataset.path === path); });
}

$("<style>").text(`
	/* Pages: large icons */
	.my-site-pages {
		display: grid;
		grid-template-columns: repeat(auto-fill, 104px);
		justify-content: start;
		align-content: start;
		gap: 4px;
		height: 240px;
		overflow: auto;
		padding: 6px;
		background: var(--Window, #fff);
		color: var(--WindowText, #222);
	}
	.my-site-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		padding: 4px 2px;
		cursor: default;
		user-select: none;
	}
	.my-site-thumb {
		width: 90px;
		height: 68px;
		padding: 2px;
		box-sizing: border-box;
		background: var(--ButtonFace, #c0c0c0);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) var(--ButtonDkShadow, #000) var(--ButtonHilight, #fff);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.my-site-thumb img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: #fff;
		border: 1px solid #000;
		box-sizing: border-box;
		image-rendering: auto;
	}
	.my-site-thumb-blank {
		font-size: 32px;
		line-height: 1;
	}
	.my-site-new .my-site-thumb {
		border-style: dashed;
		border-color: var(--ButtonShadow, #808080);
		background: transparent;
		font-size: 36px;
	}
	.my-site-tile-name {
		max-width: 100px;
		padding: 0 2px;
		font-size: 11px;
		text-align: center;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.my-site-tile.selected .my-site-tile-name {
		background: var(--Hilight, #000080);
		color: var(--HilightText, #fff);
	}
	.my-site-tile:focus-visible {
		outline: none;
	}
	.my-site-tile:focus-visible .my-site-tile-name {
		outline: 1px dotted currentColor;
	}
	.my-site-empty {
		padding: 8px;
		opacity: 0.7;
	}
	.my-site-pages-empty {
		grid-column: 1 / -1;
	}
`).appendTo(document.head);

export { is_index, is_page, kb, render_page_tiles, select_page_tile };
