// @ts-check
/* global $bottom, localize, redos, undos */
// Undo and Redo buttons in the bottom bar, next to the colors (with the pan joystick). Same undo tree as Ctrl+Z
// and Edit › Undo / Repeat; handy on a phone, where there's no keyboard. (Extras › Eye Gaze Mode has its own big
// floating Undo button for that mode; this pair is always there.)
import { redo, undo } from "./functions.js";
import { $G, E } from "./helpers.js";

/** @type {JQuery<HTMLElement> | null} */
let $container = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $undo = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $redo = null;

/**
 * A square icon from rows of pixel art ("#" = ink), in one color. `etched` adds the Windows disabled look: a white
 * copy one pixel down and right, under a grey glyph.
 * @param {string[]} rows @param {string} color @param {boolean} [etched]
 */
function pixel_icon(rows, color, etched = false) {
	const path = rows.flatMap((row, y) => [...row].map((ch, x) => (ch === "#" ? `M${x} ${y}h1v1h-1z` : "")).filter(Boolean)).join("");
	const glyph = (/** @type {string} */ fill, /** @type {number} */ offset) => `<path d="${path}" fill="${fill}"${offset ? ` transform="translate(${offset} ${offset})"` : ""}/>`;
	const body = etched ? glyph("#fff", 1) + glyph("#808080", 0) : glyph(color, 0);
	const size = rows.length;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${body}</svg>`)}`;
}

// Curved arrows, 24px: a round 3–4px arc over the top with a clean triangular head — undo bends back to the left
// (navy), redo forward to the right (green): two different arrows, not one and its shadow.
const UNDO_ROWS = [
	"........................",
	"........................",
	"........................",
	"........................",
	"........########........",
	"......############......",
	".....##############.....",
	"....######....######....",
	"....####........####....",
	"...####..........####...",
	"...####..........####...",
	"..####............####..",
	"..####............####..",
	"..####............####..",
	"..####............####..",
	"########................",
	".######.................",
	".######.................",
	"..####..................",
	"...##...................",
	"........................",
	"........................",
	"........................",
	"........................",
];
const REDO_ROWS = UNDO_ROWS.map((row) => [...row].reverse().join(""));
const UNDO_COLOR = "#000080";
const REDO_COLOR = "#008000";
const UNDO_ICON = pixel_icon(UNDO_ROWS, UNDO_COLOR);
const REDO_ICON = pixel_icon(REDO_ROWS, REDO_COLOR);
const UNDO_ICON_DISABLED = pixel_icon(UNDO_ROWS, UNDO_COLOR, true);
const REDO_ICON_DISABLED = pixel_icon(REDO_ROWS, REDO_COLOR, true);

function update_enabled() {
	$undo?.prop("disabled", undos.length < 1);
	$redo?.prop("disabled", redos.length < 1);
}

/** The bottom-right group of controls (Undo, Redo, and the pan joystick appends itself here). */
function get_quick_buttons_container() {
	return $container;
}

/** Call once the bottom component area exists (app.js). */
function init_quick_buttons() {
	$container = $(E("div")).addClass("quick-buttons").appendTo($bottom);
	/** @param {string} label @param {string} title @param {string} icon @param {string} disabled_icon @param {() => void} action */
	const button = (label, title, icon, disabled_icon, action) => {
		const $b = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).addClass("quick-button").attr({ type: "button", title, "aria-label": label }).appendTo($container));
		$(E("span")).addClass("quick-button-icon").css({ "--icon": `url("${icon}")`, "--icon-disabled": `url("${disabled_icon}")` }).appendTo($b);
		$b.on("mousedown", (e) => { e.preventDefault(); }); // don't take focus from a text box being edited
		$b.on("click", () => { action(); });
		return $b;
	};
	$undo = button(localize("Undo"), `${localize("Undo")} (Ctrl+Z)`, UNDO_ICON, UNDO_ICON_DISABLED, () => { undo(); });
	$redo = button(localize("Redo"), `${localize("Repeat")} (Ctrl+Y)`, REDO_ICON, REDO_ICON_DISABLED, () => { redo(); });
	$G.on("history-update", update_enabled);
	update_enabled();

	$("<style>").text(`
		.component-area.bottom {
			position: relative;
		}
		.quick-buttons {
			position: absolute;
			right: 6px;
			top: 50%;
			transform: translateY(-50%);
			display: flex;
			align-items: center;
			gap: 6px;
			z-index: 5;
		}
		.quick-button {
			width: 30px;
			height: 30px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}
		.quick-button-icon {
			display: block;
			width: 24px;
			height: 24px;
			background-image: var(--icon);
			background-repeat: no-repeat;
			background-size: 24px 24px;
			image-rendering: pixelated;
		}
		.quick-button:disabled .quick-button-icon {
			background-image: var(--icon-disabled, var(--icon)); /* etched grey, like every disabled Windows glyph */
		}
	`).appendTo(document.head);
}

export { get_quick_buttons_container, init_quick_buttons };
