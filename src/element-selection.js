// @ts-check
/* global $canvas_area, current_history_node, magnification, selected_tool, textbox */
// Select Elements — the page's counterpart to Paint's Select: drag a box over the page and every element it touches
// (text boxes, pictures, web text) is selected together; drag any of them and they all move, arrow keys nudge them,
// Delete removes them, Escape lets go — one history step per action. Shift adds to the selection; a box over just
// one element hands it to the usual single selection (handles and all). Sections live in the page's column and
// aren't part of a group. The group lasts while the tool is the current tool.
import { get_blocks, get_selected_block, deselect_block, select_block, remove_block_by_id } from "./blocks.js";
import { get_tool_by_id, make_or_update_undoable, undoable } from "./functions.js";
import { $G, E, get_help_folder_icon, get_icon_for_tool, to_canvas_coords } from "./helpers.js";
import { get_stickers, get_selected_sticker, deselect_sticker, select_sticker, remove_sticker_by_id } from "./stickers.js";
import { get_text_layers, get_selected_text_layer, deselect_text_layer, select_text_layer, remove_text_layer_by_id } from "./text-layers.js";

const TOOL_SELECT_ELEMENTS = "TOOL_SELECT_ELEMENTS";

/** @typedef {"block" | "sticker" | "text"} ElementKind */
/** @typedef {{ kind: ElementKind, id: string }} ElementRef */
/** @typedef {import("./blocks.js").OnCanvasBlock | import("./stickers.js").OnCanvasSticker | import("./text-layers.js").OnCanvasText} PageElement */

/** @type {ElementRef[]} */
let selected = [];
/** @type {JQuery<HTMLElement> | null} the dashed box around the group */
let $group = null;
/** The current "Move Elements" step (a drag, or a run of nudges) — more movement folds into it. @type {HistoryNode | null} */
let move_node = null;

function tool_active() {
	return !!selected_tool && selected_tool.id === TOOL_SELECT_ELEMENTS;
}

/** Every element a group may hold, with its kind. @returns {{ kind: ElementKind, el: PageElement }[]} */
function all_elements() {
	return [
		...get_blocks().filter((block) => !block.flow).map((el) => ({ kind: /** @type {ElementKind} */ ("block"), el })),
		...get_stickers().map((el) => ({ kind: /** @type {ElementKind} */ ("sticker"), el })),
		...get_text_layers().map((el) => ({ kind: /** @type {ElementKind} */ ("text"), el })),
	];
}

/** The group's live objects (ids whose element is gone — deleted, undone away — drop out). */
function members() {
	const live = all_elements();
	const found = selected.map((ref) => live.find((entry) => entry.kind === ref.kind && entry.el.id === ref.id)).filter(Boolean);
	if (found.length !== selected.length) { selected = found.map((entry) => ({ kind: entry.kind, id: entry.el.id })); }
	return found.map((entry) => entry.el);
}

function has_group() {
	return members().length > 0;
}

/** @param {PageElement} el @param {{ x: number, y: number, width: number, height: number }} rect */
function intersects(el, rect) {
	return el.x < rect.x + rect.width && el.x + el.width > rect.x && el.y < rect.y + rect.height && el.y + el.height > rect.y;
}
/** @param {PageElement} el @param {{ x: number, y: number, width: number, height: number }} rect */
function contains_rect(el, rect) {
	return el.x <= rect.x && el.y <= rect.y && el.x + el.width >= rect.x + rect.width && el.y + el.height >= rect.y + rect.height;
}

/**
 * The box's pick: what it touches — except an element the whole box sits inside (a page-wide picture behind everything),
 * unless that's all there is.
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {{ add?: boolean }} [options] - `add`: keep what's selected (Shift)
 */
function select_in_rect(rect, { add = false } = {}) {
	const touched = all_elements().filter((entry) => intersects(entry.el, rect));
	const around = touched.filter((entry) => contains_rect(entry.el, rect));
	const picked = around.length < touched.length ? touched.filter((entry) => !around.includes(entry)) : touched;
	/** @type {ElementRef[]} */
	const refs = picked.map((entry) => ({ kind: entry.kind, id: entry.el.id }));
	const next = add ? [...selected.filter((ref) => !refs.some((other) => other.kind === ref.kind && other.id === ref.id)), ...refs] : refs;
	set_selection(next);
}

/**
 * @param {ElementRef[]} refs
 */
function set_selection(refs) {
	// Leaving the old group
	for (const el of members()) { el.$el.removeClass("multi-selected"); }
	selected = refs;
	const live = members();
	if (live.length === 1) {
		// One element: the usual selection, with its handles
		selected = [];
		const only = live[0];
		const kind = refs[0].kind;
		if (kind === "block") {
			select_block(/** @type {import("./blocks.js").OnCanvasBlock} */ (only));
		} else if (kind === "sticker") {
			select_sticker(/** @type {import("./stickers.js").OnCanvasSticker} */ (only));
		} else {
			select_text_layer(/** @type {import("./text-layers.js").OnCanvasText} */ (only));
		}
		render();
		return;
	}
	if (live.length) {
		deselect_block();
		deselect_sticker();
		deselect_text_layer();
		for (const el of live) { el.$el.addClass("multi-selected"); }
	}
	move_node = null;
	render();
	$G.triggerHandler("element-selection-changed");
}

function clear_selection() {
	if (!selected.length) { return; }
	set_selection([]);
}

/** Every element on the page (Ctrl+A with the tool). */
function select_all() {
	set_selection(all_elements().map((entry) => ({ kind: entry.kind, id: entry.el.id })));
}

/** The dashed box around the group, in canvas-area pixels (like the elements themselves: OnCanvasObject.position). */
function render() {
	const live = members();
	if (!$group) {
		$group = $(E("div")).addClass("element-group").attr({ "aria-hidden": "true" }).appendTo($canvas_area);
	}
	if (!live.length) { $group.hide(); return; }
	const x1 = Math.min(...live.map((el) => el.x)), y1 = Math.min(...live.map((el) => el.y));
	const x2 = Math.max(...live.map((el) => el.x + el.width)), y2 = Math.max(...live.map((el) => el.y + el.height));
	const offset_left = parseFloat($canvas_area.css("padding-left"));
	const offset_top = parseFloat($canvas_area.css("padding-top"));
	$group.show().css({
		left: magnification * x1 + offset_left - 3,
		top: magnification * y1 + offset_top - 3,
		width: magnification * (x2 - x1) + 6,
		height: magnification * (y2 - y1) + 6,
	}).attr({ "data-count": String(live.length) });
}

/**
 * Moves the whole group; more movement in the same gesture (or a run of nudges) is the same history step.
 * @param {(el: PageElement) => void} place - sets each element's x/y
 */
function move_group(place) {
	const live = members();
	if (!live.length) { return; }
	make_or_update_undoable({
		match: (history_node) => !!move_node && history_node === move_node,
		name: "Move Elements",
		update_name: true,
		icon: get_icon_for_tool(get_tool_by_id(TOOL_SELECT_ELEMENTS)), // (the tool's own glyph in the History window)
	}, () => {
		for (const el of live) {
			place(el);
			el.position();
		}
	});
	move_node = current_history_node;
	render();
}

/** @param {number} dx @param {number} dy */
function nudge_group(dx, dy) {
	move_group((el) => {
		el.x += dx;
		el.y += dy;
	});
}

/** Deletes the whole group as one history step. */
function delete_group() {
	const live = all_elements().filter((entry) => selected.some((ref) => ref.kind === entry.kind && ref.id === entry.el.id));
	if (!live.length) { return false; }
	undoable({ name: "Delete Elements", icon: get_help_folder_icon("p_delete.png") }, () => {
		for (const entry of live) {
			if (entry.kind === "block") {
				remove_block_by_id(entry.el.id);
			} else if (entry.kind === "sticker") {
				remove_sticker_by_id(entry.el.id);
			} else {
				remove_text_layer_by_id(entry.el.id);
			}
		}
	});
	selected = [];
	render();
	$G.triggerHandler("element-selection-changed");
	return true;
}

/** The tool's box (tools.js's select-box machinery calls this on pointer up). @param {number} x @param {number} y @param {number} width @param {number} height @param {boolean} add */
function select_box(x, y, width, height, add) {
	if (width < 2 && height < 2) {
		// A click on nothing: let go
		if (!add) { clear_selection(); }
		return;
	}
	select_in_rect({ x, y, width, height }, { add });
}

/**
 * Whether a point (a pointer event, in canvas coordinates) is over an element. By geometry, not by the DOM: with this
 * tool the elements don't take pointer events (the box must start over them), so the pointer lands on the canvas.
 * @param {PageElement} el @param {{ x: number, y: number }} point
 */
function under(el, point) {
	return point.x >= el.x && point.x < el.x + el.width && point.y >= el.y && point.y < el.y + el.height;
}
/** Which of the group's elements a pointer event is over. @param {PointerEvent} event */
function member_at(event) {
	const point = to_canvas_coords(event);
	return members().find((el) => under(el, point)) || null;
}
/** Which element (of any kind) a pointer event is over — the topmost, as they're stacked. @param {PointerEvent} event */
function element_at(event) {
	const point = to_canvas_coords(event);
	const hits = all_elements().filter((entry) => under(entry.el, point));
	return hits.length ? hits[hits.length - 1] : null;
}

/** Call once the canvas area exists (app.js). */
function init_element_selection() {
	let shift_held = false;
	// Dragging a member moves the group; Shift-clicking an element adds it or takes it out. Capture phase: before the
	// element's own handler (which would select it alone) and before the tool's box.
	$canvas_area[0].addEventListener("pointerdown", (e) => {
		if (e.button !== 0) { return; }
		shift_held = e.shiftKey;
		if (!tool_active()) { clear_selection(); return; }
		if (textbox) { return; }
		const hit = element_at(e);
		if (e.shiftKey && hit) {
			e.preventDefault();
			e.stopPropagation();
			const ref = { kind: hit.kind, id: hit.el.id };
			const without = selected.filter((other) => !(other.kind === ref.kind && other.id === ref.id));
			// (a shift-click on a lone single selection folds it into the group too)
			const single = get_selected_block() || get_selected_sticker() || get_selected_text_layer();
			const single_ref = single ? all_elements().find((entry) => entry.el === single) : null;
			const base = without.length === selected.length && single_ref && single_ref.el !== hit.el ? [{ kind: single_ref.kind, id: single_ref.el.id }, ...without] : without;
			set_selection(without.length === selected.length ? [...base, ref] : base);
			return;
		}
		const member = member_at(e);
		if (!member) { return; }
		e.preventDefault();
		e.stopPropagation();
		const start = to_canvas_coords(e);
		const live = members();
		const origins = new Map(live.map((el) => [el, { x: el.x, y: el.y }]));
		move_node = null;
		const pointermove = (/** @type {JQuery.TriggeredEvent} */ ev) => {
			const m = to_canvas_coords(ev);
			const dx = Math.round(m.x - start.x), dy = Math.round(m.y - start.y);
			move_group((el) => {
				const origin = origins.get(el);
				if (origin) { el.x = origin.x + dx; el.y = origin.y + dy; }
			});
		};
		$G.on("pointermove", pointermove);
		$G.one("pointerup pointercancel", () => { $G.off("pointermove", pointermove); });
	}, { capture: true });
	// Keys for the group (before the single-element keys in app.js)
	window.addEventListener("keydown", (e) => {
		if (!tool_active() || !has_group() || textbox) { return; }
		const target = /** @type {HTMLElement} */ (e.target);
		if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) { return; }
		if (e.ctrlKey || e.metaKey || e.altKey) { return; }
		const step = e.shiftKey ? 10 : 1;
		switch (e.key) {
			case "ArrowLeft": nudge_group(-step, 0); break;
			case "ArrowRight": nudge_group(step, 0); break;
			case "ArrowUp": nudge_group(0, -step); break;
			case "ArrowDown": nudge_group(0, step); break;
			case "Delete":
			case "Backspace": delete_group(); break;
			case "Escape": clear_selection(); break;
			default: return;
		}
		e.preventDefault();
		e.stopPropagation();
	}, { capture: true });
	window.addEventListener("keydown", (e) => {
		if (!tool_active() || textbox || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a") { return; }
		const target = /** @type {HTMLElement} */ (e.target);
		if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) { return; }
		e.preventDefault();
		e.stopPropagation();
		select_all();
	}, { capture: true });
	// The elements come and go (undo recreates them): keep the marks and the box current; an element selected on its own
	// ends the group
	$G.on("layers-changed history-update", () => {
		if (!selected.length) { return; }
		if (get_selected_block() || get_selected_sticker() || get_selected_text_layer()) { clear_selection(); return; }
		for (const el of members()) { el.$el.addClass("multi-selected"); }
		render();
	});
	$G.on("resize theme-load", () => { render(); });
	$canvas_area.on("scroll", () => { /* the box is inside the scrolled area: nothing to do */ });
	$G.on("tool-changed", () => { if (!tool_active()) { clear_selection(); } });
	// (the tool's own select-box callback reads the modifier from the pointer that started the drag)
	$G.on("element-select-box", (_event, x, y, width, height) => { select_box(x, y, width, height, shift_held); });

	$("<style>").text(`
		.multi-selected {
			outline: 1px dashed #000080;
			outline-offset: 1px;
		}
		.element-group {
			position: absolute;
			z-index: 5;
			border: 1px dashed #000;
			background: rgba(0, 0, 128, 0.04);
			pointer-events: none;
			box-sizing: border-box;
		}
		.element-group::after {
			content: attr(data-count) " selected";
			position: absolute;
			left: -1px;
			top: -15px;
			font: 9px sans-serif;
			line-height: 12px;
			padding: 0 4px;
			background: #000080;
			color: #fff;
			white-space: nowrap;
		}
	`).appendTo(document.head);
}

/** For the tests and the status bar. */
function get_selected_elements() {
	return members();
}

export { TOOL_SELECT_ELEMENTS, clear_selection, delete_group, get_selected_elements, init_element_selection, nudge_group, select_all, select_in_rect };
