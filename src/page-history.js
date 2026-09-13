// @ts-check
/* global localize */
// Page History: every change to this page, by everyone who edited it, from the page's live room
// (worker/editor/page-room.js) — a tree like Edit › History's, but the page's rather than this copy's.
// Pick a version to see it (a small rendering of the bitmap, the pictures, the text, and where the sections
// were) and go to it: the page becomes that for everyone editing it, and the next change branches from there
// (nothing is thrown away — the versions after it stay, as a branch). Tabs, timeline or tree, arrow keys, Enter.
import { $DialogWindow } from "./$ToolWindow.js";
import { show_document_history } from "./functions.js";
import { $G, E, make_canvas } from "./helpers.js";
import { checkout_version, live_sync_state, request_history, restore_version } from "./live-session.js";
import { get_site_files_base } from "./site-publish.js";

/** @typedef {{ id: number, parent: number, client_id: string, name: string, color: string, at: number, kind: string, label: string, ok: boolean }} Version */
/** @typedef {{ id: number, doc: { width: number, height: number, page_properties: Record<string, any>, layers: Record<string, any[]> }, patches: { x: number, y: number, png: string }[], error?: string }} VersionState */

const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 180;
const STATE_CACHE = 24;
const MODE_KEY = "jspaint page history view";

/** @type {OSGUI$Window | null} */
let $window = null;

/** @param {number} at */
function format_time(at) {
	const date = new Date(at);
	const today = new Date();
	const same_day = date.toDateString() === today.toDateString();
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return same_day ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/**
 * A band of a full picture has no label of its own: the listing folds it into the version before it (a seed, a
 * replace, a resize…), and going to that version means going to its last band.
 * @param {Version} version
 */
function is_part(version) {
	return version.kind === "bitmap" && version.label === "";
}

/**
 * Draws a version as it was: the bitmap from its patches, then the pictures, the text, and the sections' places.
 * @param {VersionState} state
 * @param {HTMLCanvasElement} target
 * @param {Map<string, Promise<HTMLImageElement | null>>} images
 */
async function render_preview(state, target, images) {
	const { doc, patches } = state;
	const width = Math.max(1, doc.width || 800);
	const height = Math.max(1, doc.height || 600);
	const canvas = make_canvas(width, height);
	const ctx = canvas.ctx;
	ctx.fillStyle = doc.page_properties?.bgcolor || "#ffffff";
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	const load = (/** @type {string} */ src) => {
		let promise = images.get(src);
		if (!promise) {
			promise = new Promise((resolve) => {
				const img = new Image();
				img.onload = () => { resolve(img); };
				img.onerror = () => { resolve(null); };
				img.src = src;
			});
			images.set(src, promise);
		}
		return promise;
	};
	for (const patch of patches || []) {
		const img = await load(`data:image/png;base64,${patch.png}`);
		if (img) { ctx.drawImage(img, patch.x, patch.y); }
	}
	for (const item of doc.layers?.stickers || []) {
		if (typeof item.src !== "string") { continue; }
		const img = await load(`${get_site_files_base()}${item.src}`);
		if (!img) { continue; }
		ctx.save();
		ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
		ctx.rotate((item.rotation || 0) * Math.PI / 180);
		ctx.scale(item.flip_x ? -1 : 1, item.flip_y ? -1 : 1);
		ctx.drawImage(img, -item.width / 2, -item.height / 2, item.width, item.height);
		ctx.restore();
	}
	for (const item of doc.layers?.blocks || []) {
		ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
		ctx.fillRect(item.x, item.y, item.width, item.height);
		ctx.strokeStyle = "#9a9a9a";
		ctx.setLineDash([3, 2]);
		ctx.strokeRect(item.x + 0.5, item.y + 0.5, item.width - 1, item.height - 1);
		ctx.setLineDash([]);
		const text = String(item.html || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
		if (text) {
			ctx.fillStyle = "#333";
			ctx.font = "13px Arial, sans-serif";
			ctx.textBaseline = "top";
			fill_wrapped(ctx, text, item.x + 4, item.y + 4, Math.max(20, item.width - 8), Math.max(14, item.height - 8), 16);
		}
	}
	for (const item of doc.layers?.text_layers || []) {
		const font = item.font || {};
		const size = Number(font.size) || 12;
		ctx.fillStyle = font.color || "#000";
		ctx.font = `${font.italic ? "italic " : ""}${font.bold ? "bold " : ""}${size}pt ${font.family || "Arial"}`;
		ctx.textBaseline = "top";
		fill_wrapped(ctx, String(item.text || ""), item.x, item.y, Math.max(10, item.width), Math.max(10, item.height), Math.round(size * (Number(font.line_scale) || 1.2)));
	}
	// Into the preview, keeping the proportions
	const scale = Math.min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height, 1);
	const target_ctx = target.getContext("2d");
	if (!target_ctx) { return; }
	target.width = PREVIEW_WIDTH;
	target.height = PREVIEW_HEIGHT;
	target_ctx.fillStyle = "#808080";
	target_ctx.fillRect(0, 0, target.width, target.height);
	target_ctx.imageSmoothingEnabled = true;
	target_ctx.drawImage(canvas, 0, 0, Math.round(width * scale), Math.round(height * scale));
}

/**
 * Words wrapped into a box, clipped to it.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text @param {number} x @param {number} y @param {number} width @param {number} height @param {number} line_height
 */
function fill_wrapped(ctx, text, x, y, width, height, line_height) {
	const words = text.split(/\s+/);
	let line = "";
	let cy = y;
	for (const word of words) {
		const attempt = line ? `${line} ${word}` : word;
		if (ctx.measureText(attempt).width > width && line) {
			ctx.fillText(line, x, cy, width);
			line = word;
			cy += line_height;
			if (cy + line_height > y + height) { return; }
		} else {
			line = attempt;
		}
	}
	if (line) { ctx.fillText(line, x, cy, width); }
}

/** The Page History window (Edit › Page History…, the globe's site view). One at a time. */
function show_page_history() {
	if ($window) { $window.close(); }
	const $w = $window = $DialogWindow(localize("Page History"));
	$w.addClass("page-history-window squish");
	$w.on("close", () => { if ($window === $w) { $window = null; } });

	const $top = $(E("div")).addClass("page-history-top").appendTo($w.$main);
	const preview = /** @type {HTMLCanvasElement} */ (E("canvas"));
	preview.className = "page-history-preview";
	preview.width = PREVIEW_WIDTH;
	preview.height = PREVIEW_HEIGHT;
	$top.append(preview);
	const $details = $(E("div")).addClass("page-history-details").appendTo($top);
	const $title = $(E("div")).addClass("page-history-title").appendTo($details);
	const $meta = $(E("div")).addClass("page-history-meta").appendTo($details);
	const $go = $(E("button")).attr({ type: "button" }).addClass("page-history-go").text(localize("Go to this version")).appendTo($details);
	const $note = $(E("div")).addClass("page-history-note").appendTo($details);
	const $bar = $(E("div")).addClass("page-history-bar").appendTo($w.$main);
	const $mode_label = $(E("label")).text(localize("View: ")).appendTo($bar);
	const $mode = $(E("select")).addClass("page-history-mode inset-deep").appendTo($mode_label);
	$(E("option")).attr({ value: "linear" }).text(localize("Timeline")).appendTo($mode);
	$(E("option")).attr({ value: "tree" }).text(localize("Tree")).appendTo($mode);
	const $count = $(E("span")).addClass("page-history-count").appendTo($bar);
	const $list = $(E("div")).addClass("page-history-list").attr({ tabindex: "0", role: "listbox", "aria-label": localize("Versions") }).appendTo($w.$main);
	const $empty = $(E("div")).addClass("page-history-empty").appendTo($w.$main);
	const $local = $(E("button")).attr({ type: "button" }).text(localize("This copy's History…")).on("click", () => { $w.close(); show_document_history(); });
	try { $mode.val(localStorage.getItem(MODE_KEY) || "linear"); } catch (_error) { /* no storage */ }

	/** @type {Version[]} */
	let versions = [];
	let head = 0;
	let selected = 0;
	/** @type {Version[]} the entries as listed, top to bottom */
	let shown = [];
	/** @type {Map<number, VersionState>} */
	const states = new Map();
	/** @type {Map<string, Promise<HTMLImageElement | null>>} */
	const images = new Map();
	let render_token = 0;

	const by_id = () => new Map(versions.map((version) => [version.id, version]));
	/** The version a part folds into. @param {Map<number, Version>} map @param {number} id */
	const group_of = (map, id) => {
		let version = map.get(id);
		for (let steps = 0; version && is_part(version) && steps < 1000; steps++) { version = map.get(version.parent); }
		return version ? version.id : id;
	};
	/** The last version of an entry's group: the entry, or the last band of the full picture folded into it. @param {Map<number, Version>} map @param {number} id */
	const tail_of = (map, id) => {
		let tail = id;
		for (const version of versions) {
			if (version.id > tail && is_part(version) && group_of(map, version.id) === id) { tail = version.id; }
		}
		return tail;
	};
	/** @param {Map<number, Version>} map @param {number} id */
	const ancestors_of = (map, id) => {
		const set = new Set();
		for (let version = map.get(id), steps = 0; version && steps < 5000; steps++) { set.add(version.id); version = map.get(version.parent); }
		return set;
	};

	const render_list = () => {
		const map = by_id();
		const mode = String($mode.val() || "linear");
		const entries = versions.filter((version) => !is_part(version));
		const current = group_of(map, head);
		const lineage = ancestors_of(map, head);
		/** @type {Map<number, number>} entry id → depth (tree) */
		const depths = new Map();
		if (mode === "tree") {
			/** @type {Map<number, Version[]>} */
			const children = new Map();
			const roots = [];
			for (const entry of entries) {
				const parent = entry.parent ? group_of(map, entry.parent) : 0;
				if (parent && map.has(parent) && parent !== entry.id) {
					if (!children.has(parent)) { children.set(parent, []); }
					/** @type {Version[]} */ (children.get(parent)).push(entry);
				} else {
					roots.push(entry);
				}
			}
			shown = [];
			const walk = (/** @type {Version} */ entry, /** @type {number} */ depth) => {
				shown.push(entry);
				depths.set(entry.id, depth);
				for (const child of children.get(entry.id) || []) { walk(child, depth + 1); }
			};
			for (const root of roots) { walk(root, 0); }
		} else {
			shown = entries;
		}
		$list.empty();
		for (const entry of shown) {
			const $entry = $(E("div")).addClass("page-history-entry").attr({ role: "option", "data-id": String(entry.id), "data-parent": String(entry.parent), "aria-selected": String(entry.id === selected) });
			$entry.toggleClass("current", entry.id === current);
			$entry.toggleClass("ancestor-of-current", entry.id !== current && lineage.has(entry.id));
			$entry.toggleClass("selected", entry.id === selected);
			$entry.toggleClass("unavailable", !entry.ok);
			if (mode === "tree") { $entry.css({ paddingInlineStart: `${6 + (depths.get(entry.id) || 0) * 10}px` }); }
			$(E("span")).addClass("page-history-dot").css({ background: entry.color || "#808080" }).appendTo($entry);
			$(E("span")).addClass("page-history-who").text(entry.name || localize("Someone")).appendTo($entry);
			$(E("span")).addClass("page-history-what").text(entry.label || entry.kind).appendTo($entry);
			$(E("span")).addClass("page-history-when").text(format_time(entry.at)).appendTo($entry);
			$entry.on("click", () => { select(entry.id); });
			$entry.on("dblclick", () => { go_to(entry.id); });
			$entry.appendTo($list);
		}
		$count.text(entries.length ? localize("%1 versions", String(entries.length)) : "");
		const $current = $list.children(".selected").first();
		if ($current.length) {
			const el = $current[0];
			const view = $list[0];
			if (el.offsetTop < view.scrollTop || el.offsetTop + el.offsetHeight > view.scrollTop + view.clientHeight) {
				view.scrollTop = Math.max(0, el.offsetTop - view.clientHeight / 2);
			}
		}
	};

	const render_details = () => {
		const map = by_id();
		const entry = map.get(selected);
		if (!entry) {
			$title.text("");
			$meta.text("");
			$go.hide();
			return;
		}
		const current = group_of(map, head) === entry.id;
		$title.text(`${entry.name || localize("Someone")} — ${entry.label || entry.kind}`);
		$meta.text(`${localize("Version %1", String(entry.id))} · ${format_time(entry.at)}${current ? ` · ${localize("this is the page now")}` : ""}`);
		$go.toggle(!current).prop("disabled", !entry.ok);
		$note.text(!entry.ok ? localize("Too old to bring back — the picture it was built on is gone.") : current ? "" : localize("Everyone editing the page gets this version; what came after stays as a branch."));
		const tail = tail_of(map, entry.id);
		const state = states.get(tail);
		if (state && !state.error) {
			const token = ++render_token;
			render_preview(state, preview, images).catch(() => { if (token === render_token) { clear_preview(); } });
		} else if (state && state.error) {
			clear_preview(state.error);
		} else {
			clear_preview(localize("Loading…"));
			checkout_version(tail);
		}
	};
	/** @param {string} [text] */
	const clear_preview = (text = "") => {
		const ctx = preview.getContext("2d");
		if (!ctx) { return; }
		ctx.fillStyle = "#808080";
		ctx.fillRect(0, 0, preview.width, preview.height);
		if (text) {
			ctx.fillStyle = "#fff";
			ctx.font = "12px Arial, sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(text, preview.width / 2, preview.height / 2, preview.width - 20);
		}
	};
	/** @param {number} id */
	const select = (id) => {
		selected = id;
		$list.children().each((_index, el) => {
			const mine = el.getAttribute("data-id") === String(id);
			el.classList.toggle("selected", mine);
			el.setAttribute("aria-selected", String(mine));
		});
		render_details();
	};
	/** @param {number} id */
	const go_to = (id) => {
		const map = by_id();
		const entry = map.get(id);
		if (!entry || !entry.ok) { return; }
		$note.text(localize("Going to version %1…", String(id)));
		restore_version(tail_of(map, id));
	};

	const show_state = () => {
		const live = live_sync_state();
		if (!live.connected || !live.room) {
			$top.hide();
			$bar.hide();
			$list.hide();
			$empty.show().empty()
				.append($(E("p")).text(live.room ? localize("Connecting to the page's live room…") : localize("The page's history is kept by its live room: sign in and open a page of your site. Every change, by everyone, will be here.")))
				.append($local);
			return;
		}
		$empty.hide();
		$top.show();
		$bar.show();
		$list.show();
		$w.title(`${localize("Page History")} — ${live.room.page}`);
	};

	/** @param {{ head: number, versions: Version[] }} message */
	const on_history = (_event, message) => {
		if (!message || !Array.isArray(message.versions)) { return; }
		versions = message.versions;
		const head_changed = head !== message.head;
		head = message.head;
		const map = by_id();
		if (!selected || !map.has(selected) || head_changed) { selected = group_of(map, head); }
		states.delete(head); // (the head's state can change underneath: don't keep a stale preview)
		states.delete(tail_of(map, group_of(map, head)));
		render_list();
		render_details();
	};
	/** @param {VersionState} message */
	const on_state = (_event, message) => {
		if (!message || typeof message.id !== "number") { return; }
		states.set(message.id, message);
		if (states.size > STATE_CACHE) { states.delete(/** @type {number} */ (states.keys().next().value)); }
		if (selected && message.id === tail_of(by_id(), selected)) { render_details(); }
	};
	/** @type {ReturnType<typeof setTimeout> | null} */
	let refresh_timer = null;
	const on_version = () => {
		show_state();
		if (refresh_timer) { clearTimeout(refresh_timer); }
		refresh_timer = setTimeout(() => { refresh_timer = null; if (live_sync_state().connected) { request_history(); } }, 400);
	};

	$G.on("live-history", on_history);
	$G.on("live-state", on_state);
	$G.on("live-version", on_version);
	$w.on("close", () => {
		$G.off("live-history", on_history);
		$G.off("live-state", on_state);
		$G.off("live-version", on_version);
		if (refresh_timer) { clearTimeout(refresh_timer); }
	});
	$mode.on("change", () => {
		try { localStorage.setItem(MODE_KEY, String($mode.val())); } catch (_error) { /* no storage */ }
		render_list();
	});
	$go.on("click", () => { go_to(selected); });
	$list.on("keydown", (event) => {
		if (event.ctrlKey || event.altKey || event.metaKey) { return; }
		const index = shown.findIndex((entry) => entry.id === selected);
		if (event.key === "ArrowDown" && shown[index + 1]) {
			select(shown[index + 1].id);
			event.preventDefault();
		} else if (event.key === "ArrowUp" && shown[index - 1]) {
			select(shown[index - 1].id);
			event.preventDefault();
		} else if (event.key === "Enter" && selected) {
			go_to(selected);
			event.preventDefault();
		}
	});
	$w.$Button(localize("Close"), () => { $w.close(); });

	show_state();
	clear_preview();
	if (live_sync_state().connected) { request_history(); }
	$w.center();
	$list.focus();
}

$(() => {
	$("<style>").text(`
		.page-history-window .window-content {
			direction: ltr;
		}
		.page-history-top {
			display: flex;
			gap: 10px;
			padding: 8px 8px 4px;
			align-items: flex-start;
			flex-wrap: wrap;
		}
		.page-history-preview {
			width: ${PREVIEW_WIDTH}px;
			height: ${PREVIEW_HEIGHT}px;
			max-width: 100%;
			border: 1px solid;
			border-color: var(--ButtonShadow, #808080) var(--ButtonHilight, #fff) var(--ButtonHilight, #fff) var(--ButtonShadow, #808080);
			background: #808080;
			flex: none;
		}
		.page-history-details {
			flex: 1 1 180px;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 6px;
			font: 11px/14px Arial, Helvetica, sans-serif;
		}
		.page-history-title {
			font-weight: bold;
			font-size: 12px;
			word-break: break-word;
		}
		.page-history-note {
			color: #333;
		}
		.page-history-go {
			align-self: flex-start;
			min-width: 0;
		}
		.page-history-bar {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 4px 8px;
			font: 11px Arial, Helvetica, sans-serif;
		}
		.page-history-count {
			color: #444;
		}
		.page-history-list {
			width: 460px;
			height: 260px;
			max-width: calc(100vw - 30px);
			max-height: calc(100vh - 360px);
			min-height: 120px;
			overflow: auto;
			position: relative;
			margin: 0 8px 8px;
			background: var(--Window, #fff);
			color: var(--WindowText, #000);
			border: 1px solid;
			border-color: var(--ButtonShadow, #808080) var(--ButtonHilight, #fff) var(--ButtonHilight, #fff) var(--ButtonShadow, #808080);
			font: 11px/14px Arial, Helvetica, sans-serif;
		}
		.page-history-entry {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 3px 6px;
			cursor: pointer;
			white-space: nowrap;
		}
		.page-history-entry:not(.current):not(.ancestor-of-current) {
			color: gray;
		}
		.page-history-entry.current {
			font-weight: bold;
		}
		.page-history-entry.selected {
			background: var(--Highlight, #000080);
			color: var(--HighlightText, #fff);
		}
		.page-history-entry.unavailable {
			font-style: italic;
			opacity: 0.6;
		}
		.page-history-dot {
			flex: none;
			width: 8px;
			height: 8px;
			border-radius: 50%;
			border: 1px solid rgba(0, 0, 0, 0.4);
		}
		.page-history-who {
			flex: none;
			max-width: 90px;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.page-history-what {
			flex: 1 1 auto;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.page-history-when {
			flex: none;
			opacity: 0.8;
		}
		.page-history-empty {
			max-width: 320px;
			padding: 8px 12px;
			font: 11px/14px Arial, Helvetica, sans-serif;
		}
		.page-history-empty button {
			margin-top: 4px;
		}
	`).appendTo(document.head);
});

export { show_page_history };
