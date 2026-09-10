// @ts-check
/* global $canvas, $canvas_area, localize, magnification, main_canvas, selected_tool */
// Getting around a tall page: a button under the picture that makes the page longer (a web page grows
// downward; the canvas handles are fiddly, especially on a phone), Page menu items for longer/shorter, and
// panning by dragging bare canvas with the Pointer tool (one finger on a phone, where the wheel and the
// scrollbars aren't there — two fingers still pan and zoom as before).
import { resize_canvas_and_save_dimensions, resize_canvas_without_saving_dimensions } from "./functions.js";
import { $G, E, get_help_folder_icon } from "./helpers.js";
import { TOOL_POINTER } from "./page-tools.js";
import { PAGE_WIDTH } from "./site-constants.js";

const PAGE_STEP = 300; // px added or removed per click
const MIN_HEIGHT = 100;
const MIN_WIDTH = 240;
const PHONE_WIDTH = 390; // a typical phone's CSS width

/**
 * The page width that fits this screen: the canvas area's width (a phone shows a phone-wide page), up to the
 * classic PAGE_WIDTH on bigger screens. Used as the default size of new documents.
 */
function fit_page_width() {
	const area = $canvas_area[0];
	const padding = parseFloat($canvas_area.css("padding-left")) || 3;
	const handles_room = 16; // the canvas's resize handles (and their grab ring) sit just outside its right edge
	const available = Math.floor((area.clientWidth || window.innerWidth) - padding * 2 - handles_room);
	if (!available || available >= PAGE_WIDTH) { return PAGE_WIDTH; }
	return Math.max(MIN_WIDTH, Math.floor(available / 2) * 2);
}

/**
 * Sets the page width, keeping the height (Page › Page Size). Remembered as the default for new pages.
 * @param {"phone" | "classic" | "screen" | number} width
 */
function set_page_width(width) {
	const px = width === "phone" ? PHONE_WIDTH : width === "classic" ? PAGE_WIDTH : width === "screen" ? fit_page_width() : width;
	resize_canvas_and_save_dimensions(px, main_canvas.height, { name: localize("Page Width"), icon: get_help_folder_icon("p_stretch_h.png") });
}

/** @type {JQuery<HTMLButtonElement> | null} */
let $extend = null;

/**
 * Makes the page taller (an undoable canvas resize) and scrolls to the new bottom.
 * @param {number} [px]
 */
function make_page_longer(px = PAGE_STEP) {
	// (Doesn't become the default size for new pages — growing this page isn't a preference.)
	resize_canvas_without_saving_dimensions(main_canvas.width, main_canvas.height + px, { name: localize("Make Page Longer"), icon: get_help_folder_icon("p_stretch_v.png") });
	requestAnimationFrame(() => {
		$canvas_area.stop().animate({ scrollTop: $canvas_area[0].scrollHeight }, 200);
	});
}

/**
 * Makes the page shorter (cropping the bottom; undoable).
 * @param {number} [px]
 */
function make_page_shorter(px = PAGE_STEP) {
	resize_canvas_without_saving_dimensions(main_canvas.width, Math.max(MIN_HEIGHT, main_canvas.height - px), { name: localize("Make Page Shorter"), icon: get_help_folder_icon("p_stretch_v.png") });
}

/** Puts the button just under the picture, centered under the part of it you can see (a phone shows a slice). */
function position_extend_button() {
	if (!$extend) { return; }
	const offset_left = parseFloat($canvas_area.css("padding-left"));
	const offset_top = parseFloat($canvas_area.css("padding-top"));
	const width = Math.round(magnification * main_canvas.width);
	const button_width = $extend.outerWidth();
	const area = $canvas_area[0];
	const center = Math.min(offset_left + width / 2, area.scrollLeft + area.clientWidth / 2);
	$extend.css({
		left: Math.round(Math.max(offset_left, Math.min(offset_left + width - button_width, center - button_width / 2))),
		top: offset_top + Math.round(magnification * main_canvas.height) + 10,
	});
}

/**
 * Pointer tool on bare canvas: drag to pan the view (touch-action is none on the canvas, so the browser won't).
 * @param {JQuery.TriggeredEvent} e
 */
function start_canvas_pan(e) {
	const start_x = e.clientX;
	const start_y = e.clientY;
	const start_left = $canvas_area.scrollLeft();
	const start_top = $canvas_area.scrollTop();
	let panned = false;
	const move = (/** @type {JQuery.TriggeredEvent} */ ev) => {
		const dx = ev.clientX - start_x;
		const dy = ev.clientY - start_y;
		if (!panned && Math.abs(dx) + Math.abs(dy) < 3) { return; }
		panned = true;
		$canvas_area.scrollLeft(start_left - dx);
		$canvas_area.scrollTop(start_top - dy);
	};
	$G.on("pointermove", move);
	$G.one("pointerup pointercancel", () => { $G.off("pointermove", move); });
}

/** Call once the canvas area exists (app.js). */
function init_page_scroll() {
	$extend = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).addClass("page-extend-button").attr({
		type: "button",
		title: localize("Makes the page %1 px longer (you can also drag the picture's bottom handle, or use Page › Make Page Longer)", String(PAGE_STEP)),
		"aria-label": localize("Make the page longer"),
	}).appendTo($canvas_area));
	$(E("span")).addClass("page-extend-arrow").text("▼").appendTo($extend);
	$(E("span")).text(` ${localize("Make page %1 px longer", String(PAGE_STEP))}`).appendTo($extend);
	$extend.on("pointerdown", (e) => { e.stopPropagation(); }); // not a canvas-area click: don't deselect anything
	$extend.on("click", () => { make_page_longer(); });
	$canvas_area.on("resize scroll", position_extend_button);
	$G.on("resize theme-load", position_extend_button);
	position_extend_button();

	$canvas.on("pointerdown", (e) => {
		if (e.button === 0 && selected_tool && selected_tool.id === TOOL_POINTER) {
			start_canvas_pan(e);
		}
	});

	$("<style>").text(`
		.canvas-area {
			padding-bottom: 90px !important; /* room to scroll past the bottom of the page and reach the button */
		}
		.page-extend-button {
			position: absolute;
			z-index: 1;
			font: 12px sans-serif;
			padding: 3px 10px;
			white-space: nowrap;
		}
		.page-extend-arrow {
			font-size: 9px;
			vertical-align: 1px;
		}
	`).appendTo(document.head);
}

export { PHONE_WIDTH, fit_page_width, init_page_scroll, make_page_longer, make_page_shorter, set_page_width };
