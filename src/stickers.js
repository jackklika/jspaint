// @ts-check
/* global selection:writable */
/* global $canvas_area, main_canvas, main_ctx, magnification */
// Stickers: animated GIFs that live on top of the bitmap as their own layer instead of being rasterized.
//
// Pasting or dropping an animated GIF creates an OnCanvasSticker (see paste_image_from_file and the drop
// handler in app.js) — a positioned <img>, so the browser keeps animating it — with handles to move and
// resize it. Stickers are recorded on history nodes (`stickers`, like the `textbox_*` fields) so they undo
// and redo, and they're serialized as `img.sticker` elements in the collage format (docs/DESIGN.md §3.3).
// The bitmap stays the base layer; raster tools paint under stickers. "Flatten" draws them into the bitmap.
import { Handles } from "./Handles.js";
import { $DialogWindow } from "./$ToolWindow.js";
import { OnCanvasObject } from "./OnCanvasObject.js";
import { make_or_update_undoable, undoable } from "./functions.js";
import { $G, E, get_help_folder_icon, make_css_cursor, to_canvas_coords } from "./helpers.js";
import { deselect_text_layer } from "./text-layers.js";

/**
 * @typedef {object} StickerSource
 * @property {string} id
 * @property {Blob} blob
 * @property {string} url - object URL for the blob
 * @property {number} width - natural size
 * @property {number} height
 */

/** @type {Map<string, StickerSource>} */
const sticker_sources = new Map();
/** @type {OnCanvasSticker[]} bottom to top */
let stickers = [];
/** @type {OnCanvasSticker | null} */
let selected_sticker = null;
let next_sticker_id = 1;
let next_source_id = 1;

const sticker_icon = () => get_help_folder_icon("p_paste.png");

/**
 * Cheap, decoder-free check: GIF89a with more than one Graphic Control Extension block (0x21 0xF9 0x04)
 * means more than one frame. Static GIFs have at most one (for transparency).
 * @param {Blob} blob
 * @returns {Promise<boolean>}
 */
async function is_animated_gif(blob) {
	if (blob.type && blob.type !== "image/gif" && blob.type !== "application/octet-stream" && blob.type !== "") {
		return false;
	}
	const bytes = new Uint8Array(await blob.arrayBuffer());
	if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38) {
		return false; // not "GIF8"
	}
	let graphic_control_extensions = 0;
	for (let i = 13; i < bytes.length - 2; i++) {
		if (bytes[i] === 0x21 && bytes[i + 1] === 0xF9 && bytes[i + 2] === 0x04) {
			graphic_control_extensions++;
			if (graphic_control_extensions > 1) {
				return true;
			}
		}
	}
	return false;
}

/**
 * @param {Uint8Array} head - the first bytes of a file
 * @returns {string | null} MIME type by magic number
 */
function sniff_image_type(head) {
	if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) { return "image/gif"; }
	if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E) { return "image/png"; }
	if (head[0] === 0xFF && head[1] === 0xD8) { return "image/jpeg"; }
	if (head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42) { return "image/webp"; }
	return null;
}

/**
 * @param {Blob} blob
 * @returns {Promise<StickerSource>}
 */
async function register_sticker_source(blob) {
	// Fetched images often arrive as application/octet-stream; the collage format relies on a real type.
	const type = sniff_image_type(new Uint8Array(await blob.slice(0, 12).arrayBuffer())) || blob.type || "image/png";
	if (blob.type !== type) {
		blob = new Blob([blob], { type });
	}
	const url = URL.createObjectURL(blob);
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const source = { id: `g${next_source_id++}`, blob, url, width: img.naturalWidth, height: img.naturalHeight };
			sticker_sources.set(source.id, source);
			resolve(source);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Couldn't decode the GIF."));
		};
		img.src = url;
	});
}

/**
 * @param {string} source_id
 * @returns {StickerSource | undefined}
 */
function get_sticker_source(source_id) {
	return sticker_sources.get(source_id);
}

class OnCanvasSticker extends OnCanvasObject {
	/**
	 * @param {StickerSnapshot} snapshot
	 */
	constructor(snapshot) {
		super(snapshot.x, snapshot.y, snapshot.width, snapshot.height, false);
		this.id = snapshot.id;
		this.source_id = snapshot.source_id;
		this.flip_x = !!snapshot.flip_x;
		this.flip_y = !!snapshot.flip_y;
		this.rotation = snapshot.rotation || 0;
		this.href = snapshot.href || "";

		const source = sticker_sources.get(this.source_id);
		this.$el.addClass("sticker");
		this.$img = $(E("img")).attr({ src: source ? source.url : "", alt: "", draggable: "false" }).appendTo(this.$el);
		this.$img.css({ cursor: make_css_cursor("move", [8, 8], "move"), touchAction: "none" });
		this.update_transform();

		this.handles = new Handles({
			$handles_container: this.$el,
			$object_container: $canvas_area,
			outset: 2,
			get_rect: () => ({ x: this.x, y: this.y, width: this.width, height: this.height }),
			set_rect: ({ x, y, width, height }) => {
				undoable({
					name: "Resize Sticker",
					icon: sticker_icon(),
					soft: true,
				}, () => {
					this.x = x;
					this.y = y;
					this.width = Math.max(1, width);
					this.height = Math.max(1, height);
					this.position();
				});
			},
			get_ghost_offset_left: () => parseFloat($canvas_area.css("padding-left")) + 1,
			get_ghost_offset_top: () => parseFloat($canvas_area.css("padding-top")) + 1,
		});
		this.handles.hide();

		// Dragging: bound to the image (a child) rather than $el, so the handles (siblings) don't start a drag.
		let mox = 0, moy = 0;
		const pointermove = (/** @type {JQuery.TriggeredEvent} */ e) => {
			make_or_update_undoable({
				// XXX: Localization hazard: logic based on English action names
				match: (history_node) => history_node.name === "Move Sticker",
				name: "Move Sticker",
				update_name: true,
				icon: sticker_icon(),
				soft: true,
			}, () => {
				const m = to_canvas_coords(e);
				this.x = m.x - mox;
				this.y = m.y - moy;
				this.position();
			});
		};
		this.$img.on("pointerdown", (e) => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			e.stopPropagation(); // don't let the canvas area deselect us
			select_sticker(this);
			const m = to_canvas_coords(e);
			mox = m.x - this.x;
			moy = m.y - this.y;
			$G.on("pointermove", pointermove);
			$G.one("pointerup pointercancel", () => {
				$G.off("pointermove", pointermove);
			});
		});

		this.position();
	}
	position() {
		super.position(true);
	}
	/** Applies rotation, flips, and the link marker. Rotation is on the image, so the handles stay axis-aligned. */
	update_transform() {
		this.$img.css({ transform: `rotate(${this.rotation}deg) scale(${this.flip_x ? -1 : 1}, ${this.flip_y ? -1 : 1})` });
		this.$el.toggleClass("has-link", !!this.href).attr("title", this.href || null);
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
	/** @returns {StickerSnapshot} */
	snapshot() {
		return { id: this.id, source_id: this.source_id, x: this.x, y: this.y, width: this.width, height: this.height, flip_x: this.flip_x, flip_y: this.flip_y, rotation: this.rotation, href: this.href };
	}
	/**
	 * Draws the sticker's current frame (the first frame, per the canvas spec) into a context.
	 * @param {CanvasRenderingContext2D} ctx
	 */
	draw(ctx) {
		const img = /** @type {HTMLImageElement} */ (this.$img[0]);
		if (!img.complete || !img.naturalWidth) {
			return;
		}
		ctx.save();
		ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
		ctx.rotate(this.rotation * Math.PI / 180);
		ctx.scale(this.flip_x ? -1 : 1, this.flip_y ? -1 : 1);
		ctx.drawImage(img, -this.width / 2, -this.height / 2, this.width, this.height);
		ctx.restore();
	}
	destroy() {
		if (selected_sticker === this) {
			selected_sticker = null;
		}
		this.handles.hide();
		super.destroy();
	}
}

/**
 * Adds a sticker for an animated GIF, as an undoable step, and selects it.
 * @param {Blob} blob
 * @param {{ x?: number, y?: number }} [position] - canvas coordinates; defaults to the visible top-left, like Paste
 * @returns {Promise<OnCanvasSticker>}
 */
async function add_sticker_from_blob(blob, { x, y } = {}) {
	const source = await register_sticker_source(blob);
	// Keep the natural size, but fit oversized GIFs within the canvas.
	const scale = Math.min(1, main_canvas.width / source.width, main_canvas.height / source.height);
	const width = Math.max(1, Math.round(source.width * scale));
	const height = Math.max(1, Math.round(source.height * scale));
	const default_x = Math.max(0, Math.ceil($canvas_area.scrollLeft() / magnification));
	const default_y = Math.max(0, Math.ceil($canvas_area.scrollTop() / magnification));
	/** @type {OnCanvasSticker} */
	let sticker;
	undoable({
		name: "Add Sticker",
		icon: sticker_icon(),
	}, () => {
		sticker = new OnCanvasSticker({
			id: `s${next_sticker_id++}`,
			source_id: source.id,
			x: x ?? default_x,
			y: y ?? default_y,
			width,
			height,
			flip_x: false,
			flip_y: false,
			rotation: 0,
			href: "",
		});
		stickers.push(sticker);
		select_sticker(sticker);
	});
	return sticker;
}

/** @returns {StickerSnapshot[]} */
function snapshot_stickers() {
	return stickers.map((sticker) => sticker.snapshot());
}

/**
 * Rebuilds the sticker layer from a history node's snapshot (sources stay in memory by id).
 * @param {StickerSnapshot[] | null | undefined} snapshots
 */
function restore_stickers(snapshots) {
	const selected_id = selected_sticker?.id;
	for (const sticker of stickers) {
		sticker.destroy();
	}
	stickers = (snapshots || []).filter((snapshot) => sticker_sources.has(snapshot.source_id)).map((snapshot) => new OnCanvasSticker(snapshot));
	for (const snapshot of snapshots || []) {
		next_sticker_id = Math.max(next_sticker_id, parseInt(snapshot.id.slice(1), 10) + 1 || next_sticker_id);
	}
	const previously_selected = stickers.find((sticker) => sticker.id === selected_id);
	select_sticker(previously_selected || null);
	$G.triggerHandler("layers-changed");
}

function clear_stickers() {
	restore_stickers([]);
}

/** @param {OnCanvasSticker | null} sticker */
function select_sticker(sticker) {
	if (selected_sticker && selected_sticker !== sticker) {
		selected_sticker.set_selected(false);
	}
	selected_sticker = sticker;
	if (sticker) {
		deselect_text_layer();
		sticker.set_selected(true);
	}
	$G.triggerHandler("layers-changed");
}

function deselect_sticker() {
	select_sticker(null);
}

/** @returns {OnCanvasSticker | null} */
function get_selected_sticker() {
	return selected_sticker;
}

/** @returns {readonly OnCanvasSticker[]} */
function get_stickers() {
	return stickers;
}

function delete_selected_sticker() {
	const sticker = selected_sticker;
	if (!sticker) {
		return false;
	}
	undoable({
		name: "Delete Sticker",
		icon: get_help_folder_icon("p_delete.png"),
	}, () => {
		stickers = stickers.filter((other) => other !== sticker);
		sticker.destroy();
	});
	return true;
}

/**
 * @param {number} dx
 * @param {number} dy
 */
function nudge_selected_sticker(dx, dy) {
	const sticker = selected_sticker;
	if (!sticker) {
		return false;
	}
	make_or_update_undoable({
		match: (history_node) => history_node.name === "Move Sticker",
		name: "Move Sticker",
		update_name: true,
		icon: sticker_icon(),
		soft: true,
	}, () => {
		sticker.x += dx;
		sticker.y += dy;
		sticker.position();
	});
	return true;
}

/** @param {"x" | "y"} axis */
function flip_selected_sticker(axis) {
	const sticker = selected_sticker;
	if (!sticker) {
		return false;
	}
	undoable({
		name: axis === "x" ? "Flip Sticker Horizontal" : "Flip Sticker Vertical",
		icon: get_help_folder_icon(axis === "x" ? "p_fliph.png" : "p_flipv.png"),
	}, () => {
		if (axis === "x") {
			sticker.flip_x = !sticker.flip_x;
		} else {
			sticker.flip_y = !sticker.flip_y;
		}
		sticker.update_transform();
	});
	return true;
}

/**
 * Rotates the selected sticker by some degrees (clockwise), as an undoable step.
 * @param {number} degrees
 */
function rotate_selected_sticker(degrees) {
	const sticker = selected_sticker;
	if (!sticker) {
		return false;
	}
	set_sticker_rotation(sticker, sticker.rotation + degrees);
	return true;
}

/**
 * @param {OnCanvasSticker} sticker
 * @param {number} degrees - absolute, clockwise
 */
function set_sticker_rotation(sticker, degrees) {
	const rotation = ((Math.round(degrees) % 360) + 360) % 360;
	if (rotation === sticker.rotation) {
		return;
	}
	undoable({
		name: "Rotate Sticker",
		icon: get_help_folder_icon(degrees >= sticker.rotation ? "p_rotate_cw.png" : "p_rotate_ccw.png"),
	}, () => {
		sticker.rotation = rotation;
		sticker.update_transform();
	});
}

/** Image > Rotate Sticker By Angle…: any angle, clockwise. */
function show_rotate_sticker_dialog() {
	const sticker = selected_sticker;
	if (!sticker) {
		return;
	}
	const $w = $DialogWindow("Rotate Sticker");
	$w.addClass("horizontal-buttons");
	const $label = $(E("label")).text("Angle (degrees, clockwise): ").appendTo($w.$main);
	const $input = $(E("input")).attr({ type: "number", step: "1", min: "-360", max: "360" }).val(String(sticker.rotation)).css({ width: 70 }).appendTo($label);
	$w.$Button("OK", () => {
		$w.close();
		const degrees = Number($input.val());
		if (Number.isFinite(degrees)) {
			set_sticker_rotation(sticker, degrees);
		}
	}, { type: "submit" });
	$w.$Button("Cancel", () => { $w.close(); });
	$w.center();
	$input.focus();
	/** @type {HTMLInputElement} */ ($input[0]).select();
}

/**
 * Sets or removes the selected sticker's link.
 * @param {string} href
 */
function set_selected_sticker_link(href) {
	const sticker = selected_sticker;
	if (!sticker || href === sticker.href) {
		return false;
	}
	undoable({
		name: href ? "Set Sticker Link" : "Remove Sticker Link",
		icon: sticker_icon(),
	}, () => {
		sticker.href = href;
		sticker.update_transform();
	});
	return true;
}

/**
 * Image > Make Sticker from Selection: turns the current selection (any pasted or selected image)
 * into a sticker layer, so it can be rotated, linked, and kept as a real image on the page.
 */
async function make_sticker_from_selection() {
	if (!selection) {
		return false;
	}
	const { x, y, width, height } = selection;
	const blob = await new Promise((resolve) => selection.canvas.toBlob(resolve, "image/png"));
	const source = await register_sticker_source(blob);
	if (!selection) {
		return false; // it went away while encoding
	}
	undoable({
		name: "Make Sticker",
		icon: sticker_icon(),
	}, () => {
		selection.destroy(); // without drawing it back into the picture
		selection = null;
		const sticker = new OnCanvasSticker({
			id: `s${next_sticker_id++}`,
			source_id: source.id,
			x,
			y,
			width,
			height,
			flip_x: false,
			flip_y: false,
			rotation: 0,
			href: "",
		});
		stickers.push(sticker);
		select_sticker(sticker);
	});
	return true;
}

/**
 * Draws every sticker (first frames) onto a context, bottom to top. Used by Flatten and static exports.
 * @param {CanvasRenderingContext2D} ctx
 */
function draw_stickers(ctx) {
	for (const sticker of stickers) {
		sticker.draw(ctx);
	}
}

/** Re-appends sticker elements so DOM order matches the model (bottom to top). */
function apply_sticker_order() {
	for (const sticker of stickers) {
		sticker.$el.appendTo($canvas_area);
	}
	$G.triggerHandler("layers-changed");
}

/**
 * Moves a sticker up (+1) or down (-1) in the stacking order, as an undoable step.
 * @param {OnCanvasSticker} sticker
 * @param {1 | -1} direction
 */
function reorder_sticker(sticker, direction) {
	const index = stickers.indexOf(sticker);
	const target = index + direction;
	if (index === -1 || target < 0 || target >= stickers.length) {
		return false;
	}
	undoable({
		name: direction > 0 ? "Raise Sticker" : "Lower Sticker",
		icon: sticker_icon(),
	}, () => {
		stickers.splice(index, 1);
		stickers.splice(target, 0, sticker);
		apply_sticker_order();
	});
	return true;
}

/**
 * Rasterizes one sticker into the bitmap and removes it.
 * @param {OnCanvasSticker} sticker
 */
function flatten_sticker(sticker) {
	undoable({
		name: "Flatten Sticker",
		icon: sticker_icon(),
	}, () => {
		sticker.draw(main_ctx);
		stickers = stickers.filter((other) => other !== sticker);
		sticker.destroy();
	});
}

/**
 * @param {OnCanvasSticker} sticker
 */
function delete_sticker(sticker) {
	undoable({
		name: "Delete Sticker",
		icon: get_help_folder_icon("p_delete.png"),
	}, () => {
		stickers = stickers.filter((other) => other !== sticker);
		sticker.destroy();
	});
}

/** Rasterizes all stickers into the bitmap and removes them, as one undoable step. */
function flatten_stickers() {
	if (stickers.length === 0) {
		return false;
	}
	undoable({
		name: "Flatten Stickers",
		icon: sticker_icon(),
	}, () => {
		draw_stickers(main_ctx);
		for (const sticker of stickers) {
			sticker.destroy();
		}
		stickers = [];
	});
	return true;
}

/** Call once the canvas area exists (app.js). */
function init_stickers() {
	// Clicking anywhere that isn't a sticker deselects the sticker (painting continues to work normally).
	$canvas_area.on("pointerdown", (e) => {
		if (!$(e.target).closest(".sticker").length) {
			deselect_sticker();
		}
	});
	$("<style>").text(`
		.sticker {
			z-index: 3; /* same layer as the selection */
			display: block !important;
			box-sizing: border-box;
		}
		.sticker > img {
			display: block;
			width: 100%;
			height: 100%;
			image-rendering: pixelated;
			-webkit-user-drag: none;
			user-select: none;
		}
		.sticker.selected {
			outline: 1px dashed #000;
			outline-offset: 0;
		}
		.sticker.has-link::after {
			content: "🔗";
			position: absolute;
			right: -4px;
			top: -4px;
			font-size: 10px;
			line-height: 1;
			pointer-events: none;
		}
	`).appendTo(document.head);
}

export {
	OnCanvasSticker,
	add_sticker_from_blob,
	clear_stickers,
	delete_selected_sticker,
	delete_sticker,
	deselect_sticker,
	draw_stickers,
	flatten_sticker,
	flatten_stickers,
	flip_selected_sticker,
	get_selected_sticker,
	get_sticker_source,
	get_stickers,
	init_stickers,
	is_animated_gif,
	make_sticker_from_selection,
	nudge_selected_sticker,
	register_sticker_source,
	reorder_sticker,
	restore_stickers,
	rotate_selected_sticker,
	select_sticker,
	set_selected_sticker_link,
	show_rotate_sticker_dialog,
	snapshot_stickers
};
