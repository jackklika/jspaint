// @ts-check
/* global textbox:writable, tool_transparent_mode:writable */
/* global $canvas_area, main_ctx, magnification, selected_colors, text_tool_font */
// Text layers: text that stays text. With "Web text" on in the Text tool's options, finishing a textbox
// creates an OnCanvasText layer instead of drawing pixels: a positioned element in the browser's own font
// rendering, movable and resizable, editable again on double-click (it turns back into the Text tool's
// textbox), and optionally a link. Text layers are recorded on history nodes (`text_layers`, like the
// `stickers` field) and serialized as `span.text` / `a.text` in the collage format (docs/DESIGN.md §3.3).
// For flattening and GIF export each layer keeps a rasterized copy of itself, rendered the same way the
// textbox previews text (an SVG <foreignObject>).
import { Handles } from "./Handles.js";
import { OnCanvasObject } from "./OnCanvasObject.js";
import { OnCanvasTextBox } from "./OnCanvasTextBox.js";
import { get_tool_by_id, make_or_update_undoable, select_tool, undoable } from "./functions.js";
import { $G, E, get_help_folder_icon, get_icon_for_tool, get_rgba_from_color, make_canvas, make_css_cursor, to_canvas_coords } from "./helpers.js";
import { deselect_block } from "./blocks.js";
import { deselect_sticker } from "./stickers.js";
import { TOOL_WEB_TEXT } from "./tools.js";

/** @type {OnCanvasText[]} bottom to top */
let text_layers = [];
/** @type {OnCanvasText | null} */
let selected_text_layer = null;
let next_text_layer_id = 1;

const text_icon = () => get_icon_for_tool(get_tool_by_id(TOOL_WEB_TEXT));

/**
 * CSS for a layer's font, shared by the on-canvas element, the rasterized copy, and the collage format.
 * @param {TextLayerFont} font
 * @returns {Record<string, string>}
 */
function font_css(font) {
	return {
		"font-family": font.family,
		"font-size": `${font.size}pt`,
		"font-weight": font.bold ? "bold" : "normal",
		"font-style": font.italic ? "italic" : "normal",
		"text-decoration": font.underline ? "underline" : "none",
		"line-height": `${Math.round(font.size * font.line_scale)}px`,
		"color": font.color,
		"background": font.background || "transparent",
	};
}

/**
 * @param {string} text
 */
function escape_xml(text) {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

/**
 * Renders a text layer to a canvas the way the textbox previews itself: XHTML inside an SVG image.
 * @param {TextLayerSnapshot} snapshot
 * @returns {Promise<HTMLCanvasElement>}
 */
function render_text_layer_to_canvas(snapshot) {
	const css = Object.entries(font_css(snapshot.font)).map(([k, v]) => `${k}:${v}`).join(";");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${snapshot.width}" height="${snapshot.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:${snapshot.width}px;height:${snapshot.height}px;margin:0;padding:0;white-space:pre-wrap;overflow-wrap:break-word;overflow:hidden;${escape_xml(css)}">${escape_xml(snapshot.text)}</div></foreignObject></svg>`;
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const canvas = make_canvas(snapshot.width, snapshot.height);
			canvas.ctx.drawImage(img, 0, 0);
			resolve(canvas);
		};
		img.onerror = () => { reject(new Error("Couldn't render the text layer.")); };
		img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	});
}

class OnCanvasText extends OnCanvasObject {
	/**
	 * @param {TextLayerSnapshot} snapshot
	 */
	constructor(snapshot) {
		super(snapshot.x, snapshot.y, snapshot.width, snapshot.height, false);
		this.id = snapshot.id;
		this.text = snapshot.text;
		this.font = { ...snapshot.font };
		this.href = snapshot.href || "";
		/** @type {HTMLCanvasElement} rasterized copy, for Flatten and exports */
		this.canvas = make_canvas(this.width, this.height);

		this.$el.addClass("text-layer");
		this.$content = $(E("div")).addClass("text-layer-content").appendTo(this.$el);
		this.$content.css({ cursor: make_css_cursor("move", [8, 8], "move"), touchAction: "none" });
		this.render();

		this.handles = new Handles({
			$handles_container: this.$el,
			$object_container: $canvas_area,
			outset: 2,
			get_rect: () => ({ x: this.x, y: this.y, width: this.width, height: this.height }),
			set_rect: ({ x, y, width, height }) => {
				undoable({ name: "Resize Text", icon: text_icon(), soft: true }, () => {
					this.x = x;
					this.y = y;
					this.width = Math.max(1, width);
					this.height = Math.max(1, height);
					this.position();
					this.render();
				});
			},
			get_ghost_offset_left: () => parseFloat($canvas_area.css("padding-left")) + 1,
			get_ghost_offset_top: () => parseFloat($canvas_area.css("padding-top")) + 1,
		});
		this.handles.hide();

		let mox = 0, moy = 0;
		const pointermove = (/** @type {JQuery.TriggeredEvent} */ e) => {
			make_or_update_undoable({
				// XXX: Localization hazard: logic based on English action names
				match: (history_node) => history_node.name === "Move Text",
				name: "Move Text",
				update_name: true,
				icon: text_icon(),
				soft: true,
			}, () => {
				const m = to_canvas_coords(e);
				this.x = m.x - mox;
				this.y = m.y - moy;
				this.position();
			});
		};
		let last_pointerdown_time = 0;
		this.$content.on("pointerdown", (e) => {
			if (e.button !== 0) { return; }
			e.preventDefault(); // (also suppresses the browser's dblclick event, hence the timing below)
			e.stopPropagation();
			select_text_layer(this);
			const now = performance.now();
			if (now - last_pointerdown_time < 400) {
				last_pointerdown_time = 0;
				edit_text_layer(this);
				return;
			}
			last_pointerdown_time = now;
			const m = to_canvas_coords(e);
			mox = m.x - this.x;
			moy = m.y - this.y;
			$G.on("pointermove", pointermove);
			$G.one("pointerup pointercancel", () => { $G.off("pointermove", pointermove); });
		});

		this.position();
	}
	position() {
		super.position(true);
		// The content is laid out at document size and scaled, so the font renders identically at any zoom.
		this.$content.css({ transform: `scale(${magnification})`, transformOrigin: "left top", width: this.width, height: this.height });
	}
	/** Applies text and font to the element and refreshes the rasterized copy. */
	render() {
		this.$content.text(this.text).css({ width: this.width, height: this.height, ...font_css(this.font) });
		this.$el.toggleClass("has-link", !!this.href).attr("title", this.href || null);
		const snapshot = this.snapshot();
		render_text_layer_to_canvas(snapshot).then((canvas) => {
			if (this.text === snapshot.text && this.width === snapshot.width && this.height === snapshot.height) {
				this.canvas = canvas;
			}
		}, () => { /* keep the previous copy */ });
	}
	/** @param {boolean} selected */
	set_selected(selected) {
		this.$el.toggleClass("selected", selected);
		if (selected) {
			this.handles.show();
		} else {
			this.handles.hide();
		}
	}
	/** @returns {TextLayerSnapshot} */
	snapshot() {
		return { id: this.id, x: this.x, y: this.y, width: this.width, height: this.height, text: this.text, font: { ...this.font }, href: this.href };
	}
	/** @param {CanvasRenderingContext2D} ctx */
	draw(ctx) {
		ctx.drawImage(this.canvas, this.x, this.y, this.width, this.height);
	}
	destroy() {
		if (selected_text_layer === this) {
			selected_text_layer = null;
		}
		this.handles.hide();
		super.destroy();
	}
}

/**
 * The font a textbox is currently using, as a layer font (solid colors, no vertical writing).
 * @returns {TextLayerFont}
 */
function font_from_text_tool() {
	const solid = (/** @type {string | CanvasPattern} */ swatch) => `rgba(${get_rgba_from_color(swatch).join(", ")})`;
	return {
		family: text_tool_font.family,
		size: text_tool_font.size,
		line_scale: text_tool_font.line_scale,
		bold: text_tool_font.bold,
		italic: text_tool_font.italic,
		underline: text_tool_font.underline,
		color: solid(selected_colors.foreground),
		background: tool_transparent_mode ? "" : solid(selected_colors.background),
	};
}

/**
 * Turns the Text tool's textbox into a text layer. Called from meld_textbox_into_canvas inside its undoable.
 * @param {{ x: number, y: number, width: number, height: number, $editor: JQuery }} box - the Text tool's textbox
 * @returns {OnCanvasText}
 */
function create_text_layer_from_textbox(box) {
	const extra = /** @type {{ web_text_layer_id?: string, web_text_href?: string }} */ (/** @type {unknown} */ (box));
	const layer = new OnCanvasText({
		id: extra.web_text_layer_id || `t${next_text_layer_id++}`,
		x: box.x,
		y: box.y,
		width: box.width,
		height: box.height,
		text: String(box.$editor.val()),
		font: font_from_text_tool(),
		href: extra.web_text_href || "",
	});
	text_layers.push(layer);
	select_text_layer(layer);
	return layer;
}

/**
 * Reopens a text layer in the Text tool's textbox (with its font and colors), removing the layer meanwhile.
 * @param {OnCanvasText} layer
 */
function edit_text_layer(layer) {
	if (textbox) {
		return; // finish the current text first
	}
	const snapshot = layer.snapshot();
	undoable({ name: "Edit Text", icon: text_icon(), soft: true }, () => {
		text_layers = text_layers.filter((other) => other !== layer);
		layer.destroy();
		for (const key of ["family", "size", "line_scale", "bold", "italic", "underline"]) {
			text_tool_font[key] = snapshot.font[key];
		}
		text_tool_font.vertical = false;
		selected_colors.foreground = snapshot.font.color;
		if (snapshot.font.background) {
			selected_colors.background = snapshot.font.background;
			tool_transparent_mode = false;
		} else {
			tool_transparent_mode = true;
		}
		$G.trigger("option-changed");
		select_tool(get_tool_by_id(TOOL_WEB_TEXT));
		const box = /** @type {OnCanvasTextBox & { web_text?: boolean, web_text_layer_id?: string, web_text_href?: string }} */ (new OnCanvasTextBox(snapshot.x, snapshot.y, snapshot.width, snapshot.height, snapshot.text));
		box.web_text = true;
		box.web_text_layer_id = snapshot.id;
		box.web_text_href = snapshot.href;
		textbox = box;
	});
}

/** @returns {TextLayerSnapshot[]} */
function snapshot_text_layers() {
	return text_layers.map((layer) => layer.snapshot());
}

/**
 * @param {TextLayerSnapshot[] | null | undefined} snapshots
 */
function restore_text_layers(snapshots) {
	const selected_id = selected_text_layer?.id;
	for (const layer of text_layers) {
		layer.destroy();
	}
	text_layers = (snapshots || []).map((snapshot) => new OnCanvasText(snapshot));
	for (const snapshot of snapshots || []) {
		next_text_layer_id = Math.max(next_text_layer_id, parseInt(snapshot.id.slice(1), 10) + 1 || next_text_layer_id);
	}
	select_text_layer(text_layers.find((layer) => layer.id === selected_id) || null);
	$G.triggerHandler("layers-changed");
}

function clear_text_layers() {
	restore_text_layers([]);
}

/** @param {OnCanvasText | null} layer */
function select_text_layer(layer) {
	if (selected_text_layer && selected_text_layer !== layer) {
		selected_text_layer.set_selected(false);
	}
	selected_text_layer = layer;
	if (layer) {
		deselect_sticker();
		deselect_block();
		layer.set_selected(true);
	}
	$G.triggerHandler("layers-changed");
}

function deselect_text_layer() {
	select_text_layer(null);
}

/** @returns {OnCanvasText | null} */
function get_selected_text_layer() {
	return selected_text_layer;
}

/** @returns {readonly OnCanvasText[]} */
function get_text_layers() {
	return text_layers;
}

function delete_selected_text_layer() {
	const layer = selected_text_layer;
	if (!layer) {
		return false;
	}
	undoable({ name: "Delete Text", icon: get_help_folder_icon("p_delete.png") }, () => {
		text_layers = text_layers.filter((other) => other !== layer);
		layer.destroy();
	});
	return true;
}

/**
 * @param {number} dx
 * @param {number} dy
 */
function nudge_selected_text_layer(dx, dy) {
	const layer = selected_text_layer;
	if (!layer) {
		return false;
	}
	make_or_update_undoable({
		match: (history_node) => history_node.name === "Move Text",
		name: "Move Text",
		update_name: true,
		icon: text_icon(),
		soft: true,
	}, () => {
		layer.x += dx;
		layer.y += dy;
		layer.position();
	});
	return true;
}

/**
 * Sets or removes the selected text layer's link.
 * @param {string} href
 */
function set_selected_text_layer_link(href) {
	const layer = selected_text_layer;
	if (!layer || href === layer.href) {
		return false;
	}
	undoable({ name: href ? "Set Text Link" : "Remove Text Link", icon: text_icon() }, () => {
		layer.href = href;
		layer.render();
	});
	return true;
}

// ---- remote changes (live-session.js) ----

/**
 * Creates or updates a text layer from a snapshot (a remote editor's), in place.
 * @param {TextLayerSnapshot} snapshot
 */
function upsert_text_layer_from_snapshot(snapshot) {
	let layer = text_layers.find((other) => other.id === snapshot.id);
	if (!layer) {
		layer = new OnCanvasText(snapshot);
		text_layers.push(layer);
		next_text_layer_id = Math.max(next_text_layer_id, parseInt(snapshot.id.slice(1), 10) + 1 || next_text_layer_id);
	} else {
		layer.x = snapshot.x;
		layer.y = snapshot.y;
		layer.width = Math.max(1, snapshot.width);
		layer.height = Math.max(1, snapshot.height);
		layer.text = snapshot.text;
		layer.font = { ...snapshot.font };
		layer.href = snapshot.href || "";
		layer.position();
		layer.render();
	}
	$G.triggerHandler("layers-changed");
	return layer;
}

/** @param {string} id */
function remove_text_layer_by_id(id) {
	const layer = text_layers.find((other) => other.id === id);
	if (!layer) { return false; }
	text_layers = text_layers.filter((other) => other !== layer);
	layer.destroy();
	$G.triggerHandler("layers-changed");
	return true;
}

/** @param {string[]} ids */
function order_text_layers(ids) {
	const by_id = new Map(text_layers.map((layer) => [layer.id, layer]));
	const ordered = ids.map((id) => by_id.get(id)).filter(Boolean);
	for (const layer of text_layers) {
		if (!ordered.includes(layer)) { ordered.push(layer); }
	}
	text_layers = ordered;
	apply_text_layer_order();
}

/**
 * Draws every text layer (rasterized copies), bottom to top.
 * @param {CanvasRenderingContext2D} ctx
 */
function draw_text_layers(ctx) {
	for (const layer of text_layers) {
		layer.draw(ctx);
	}
}

/** Re-appends text layer elements so DOM order matches the model (bottom to top). Text stays above stickers. */
function apply_text_layer_order() {
	for (const layer of text_layers) {
		layer.$el.appendTo($canvas_area);
	}
	$G.triggerHandler("layers-changed");
}

/**
 * Moves a text layer up (+1) or down (-1) in the stacking order, as an undoable step.
 * @param {OnCanvasText} layer
 * @param {1 | -1} direction
 */
function reorder_text_layer(layer, direction) {
	const index = text_layers.indexOf(layer);
	const target = index + direction;
	if (index === -1 || target < 0 || target >= text_layers.length) {
		return false;
	}
	undoable({ name: direction > 0 ? "Raise Text" : "Lower Text", icon: text_icon() }, () => {
		text_layers.splice(index, 1);
		text_layers.splice(target, 0, layer);
		apply_text_layer_order();
	});
	return true;
}

/**
 * Rasterizes one text layer into the bitmap and removes it.
 * @param {OnCanvasText} layer
 */
function flatten_text_layer(layer) {
	undoable({ name: "Flatten Text", icon: text_icon() }, () => {
		layer.draw(main_ctx);
		text_layers = text_layers.filter((other) => other !== layer);
		layer.destroy();
	});
}

/**
 * @param {OnCanvasText} layer
 */
function delete_text_layer(layer) {
	undoable({ name: "Delete Text", icon: get_help_folder_icon("p_delete.png") }, () => {
		text_layers = text_layers.filter((other) => other !== layer);
		layer.destroy();
	});
}

/** Rasterizes all text layers into the bitmap and removes them, as one undoable step. */
function flatten_text_layers() {
	if (text_layers.length === 0) {
		return false;
	}
	undoable({ name: "Flatten Text Layers", icon: text_icon() }, () => {
		draw_text_layers(main_ctx);
		for (const layer of text_layers) {
			layer.destroy();
		}
		text_layers = [];
	});
	return true;
}

/** Call once the canvas area exists (app.js). */
function init_text_layers() {
	// Capture phase: runs before the Text tool finishes a textbox on this click, so the new layer stays selected.
	$canvas_area[0].addEventListener("pointerdown", (e) => {
		if (!$(e.target).closest(".text-layer").length) {
			deselect_text_layer();
		}
	}, { capture: true });
	$("<style>").text(`
		.text-layer {
			z-index: 3;
			display: block !important;
			box-sizing: border-box;
		}
		.text-layer-content {
			box-sizing: border-box;
			white-space: pre-wrap;
			overflow-wrap: break-word;
			overflow: hidden;
			user-select: none;
		}
		.text-layer.has-link .text-layer-content {
			text-decoration: underline;
		}
		.text-layer.selected {
			outline: 1px dashed #000;
		}
	`).appendTo(document.head);
}

export {
	OnCanvasText,
	clear_text_layers,
	create_text_layer_from_textbox,
	delete_selected_text_layer,
	delete_text_layer,
	deselect_text_layer,
	draw_text_layers,
	edit_text_layer,
	flatten_text_layer,
	flatten_text_layers,
	font_css,
	get_selected_text_layer,
	get_text_layers,
	init_text_layers,
	nudge_selected_text_layer,
	order_text_layers,
	remove_text_layer_by_id,
	render_text_layer_to_canvas,
	reorder_text_layer,
	restore_text_layers,
	select_text_layer,
	set_selected_text_layer_link,
	snapshot_text_layers,
	upsert_text_layer_from_snapshot
};
