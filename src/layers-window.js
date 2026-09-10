// @ts-check
/* global localize */
// The Layers window (View > Layers): text layers, stickers, and page elements (blocks) above the bitmap, top to bottom.
// Click a row to select that layer on the canvas; raise/lower, flatten, or delete it with the row's buttons.
// Text layers stack above stickers, which stack above blocks (separate lists), so reordering is within each kind.
import { $DialogWindow } from "./$ToolWindow.js";
import { delete_block, deselect_block, flatten_block, get_blocks, get_selected_block, reorder_block, select_block } from "./blocks.js";
import { $G, E } from "./helpers.js";
import { delete_sticker, deselect_sticker, flatten_sticker, get_selected_sticker, get_sticker_source, get_stickers, reorder_sticker, select_sticker } from "./stickers.js";
import { delete_text_layer, deselect_text_layer, flatten_text_layer, get_selected_text_layer, get_text_layers, reorder_text_layer, select_text_layer } from "./text-layers.js";

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $layers_window = null;
/** @type {JQuery<HTMLElement> | null} */
let $list = null;

/**
 * @param {string} label
 * @param {string} title
 * @param {() => void} action
 * @param {boolean} [disabled]
 */
function $row_button(label, title, action, disabled = false) {
	return $(E("button")).attr({ type: "button", title, "aria-label": title }).text(label).prop("disabled", disabled)
		.on("click", (e) => {
			e.stopPropagation();
			action();
		});
}

function rebuild() {
	if (!$list) { return; }
	$list.empty();
	const selected_text = get_selected_text_layer();
	const selected_sticker = get_selected_sticker();

	const text_layers = get_text_layers();
	[...text_layers].reverse().forEach((layer, i) => {
		const index = text_layers.length - 1 - i;
		const $row = $(E("li")).addClass("layer-row layer-row-text").toggleClass("selected", layer === selected_text).appendTo($list);
		$row.append($(E("span")).addClass("layer-icon").text("A").css({ font: `bold 14px ${layer.font.family}`, color: layer.font.color }));
		$row.append($(E("span")).addClass("layer-name").text(layer.text.replace(/\s+/g, " ").trim().slice(0, 30) || localize("(empty text)")));
		$row.append($(E("span")).addClass("layer-buttons").append(
			$row_button("▲", localize("Raise"), () => { reorder_text_layer(layer, 1); }, index === text_layers.length - 1),
			$row_button("▼", localize("Lower"), () => { reorder_text_layer(layer, -1); }, index === 0),
			$row_button("⤓", localize("Flatten into the picture"), () => { flatten_text_layer(layer); }),
			$row_button("✕", localize("Delete"), () => { delete_text_layer(layer); }),
		));
		$row.on("click", () => { select_text_layer(layer); });
	});

	const stickers = get_stickers();
	[...stickers].reverse().forEach((sticker, i) => {
		const index = stickers.length - 1 - i;
		const source = get_sticker_source(sticker.source_id);
		const $row = $(E("li")).addClass("layer-row layer-row-sticker").toggleClass("selected", sticker === selected_sticker).appendTo($list);
		$row.append($(E("img")).addClass("layer-icon").attr({ src: source ? source.url : "", alt: "" }));
		$row.append($(E("span")).addClass("layer-name").text(`${localize("Sticker")} ${index + 1} (${sticker.width}×${sticker.height})`));
		$row.append($(E("span")).addClass("layer-buttons").append(
			$row_button("▲", localize("Raise"), () => { reorder_sticker(sticker, 1); }, index === stickers.length - 1),
			$row_button("▼", localize("Lower"), () => { reorder_sticker(sticker, -1); }, index === 0),
			$row_button("⤓", localize("Flatten into the picture"), () => { flatten_sticker(sticker); }),
			$row_button("✕", localize("Delete"), () => { delete_sticker(sticker); }),
		));
		$row.on("click", () => { select_sticker(sticker); });
	});

	const selected_block = get_selected_block();
	const blocks = get_blocks();
	[...blocks].reverse().forEach((block, i) => {
		const index = blocks.length - 1 - i;
		const $row = $(E("li")).addClass("layer-row layer-row-block").toggleClass("selected", block === selected_block).appendTo($list);
		$row.append($(E("span")).addClass("layer-icon").text(block.kind.icon || "▭").css({ font: "bold 12px sans-serif" }));
		const text = block.el.textContent.replace(/\s+/g, " ").trim().slice(0, 24);
		$row.append($(E("span")).addClass("layer-name").text(text ? `${block.kind.label}: ${text}` : block.kind.label));
		$row.append($(E("span")).addClass("layer-buttons").append(
			$row_button("▲", localize("Raise"), () => { reorder_block(block, 1); }, index === blocks.length - 1),
			$row_button("▼", localize("Lower"), () => { reorder_block(block, -1); }, index === 0),
			$row_button("⤓", localize("Flatten into the picture"), () => { flatten_block(block); }),
			$row_button("✕", localize("Delete"), () => { delete_block(block); }),
		));
		$row.on("click", () => { select_block(block); });
	});

	const $bitmap = $(E("li")).addClass("layer-row layer-row-bitmap").toggleClass("selected", !selected_text && !selected_sticker && !selected_block).appendTo($list);
	$bitmap.append($(E("span")).addClass("layer-icon").text("▦"));
	$bitmap.append($(E("span")).addClass("layer-name").text(localize("Picture (pixels)")));
	$bitmap.on("click", () => {
		deselect_sticker();
		deselect_text_layer();
		deselect_block();
	});
}

function show_layers_window() {
	if ($layers_window) {
		$layers_window.bringToFront();
		return;
	}
	$layers_window = $DialogWindow(localize("Layers"));
	$layers_window.addClass("layers-window squish");
	$list = $(E("ul")).addClass("layers-list inset-deep").attr({ role: "listbox" }).appendTo($layers_window.$main);
	$layers_window.$Button(localize("Close"), () => { $layers_window.close(); });
	$layers_window.$content.css({ width: "min(320px, 90vw)" });
	$layers_window.css({
		left: Math.max(0, innerWidth - $layers_window.outerWidth() - 24),
		top: 80,
	});
	const on_change = () => { rebuild(); };
	$G.on("history-update layers-changed", on_change);
	$layers_window.on("close", () => {
		$G.off("history-update layers-changed", on_change);
		$layers_window = null;
		$list = null;
		$G.triggerHandler("layers-window-toggled");
	});
	rebuild();
	$G.triggerHandler("layers-window-toggled");
}

function toggle_layers_window() {
	if ($layers_window) {
		$layers_window.close();
	} else {
		show_layers_window();
	}
}

function is_layers_window_open() {
	return !!$layers_window;
}

$("<style>").text(`
	.layers-list {
		list-style: none;
		margin: 0;
		padding: 2px;
		max-height: 260px;
		overflow: auto;
		background: white;
		color: #222;
	}
	.layer-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px;
		cursor: default;
		user-select: none;
	}
	.layer-row.selected {
		background: #000080;
		color: #fff;
	}
	.layer-icon {
		width: 24px;
		height: 24px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		object-fit: contain;
		image-rendering: pixelated;
		background: #fff;
		border: 1px solid #808080;
		box-sizing: border-box;
	}
	.layer-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.layer-buttons button {
		min-width: 22px;
		padding: 0 3px;
		margin-left: 2px;
	}
`).appendTo(document.head);

export { is_layers_window_open, show_layers_window, toggle_layers_window };
