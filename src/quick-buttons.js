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

const svg = (/** @type {string} */ body) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`)}`;
// Curved arrows in the toolbox's pixel style: undo bends left, redo bends right.
const UNDO_ICON = svg('<path d="M3 7h1V6h1V5h1V4h1v3h1v1h1v1h1v1h1v1h1v1h1v2h-1v-1h-1v-1h-1v-1H9v-1H8V9H7v3H6v-1H5v-1H4v-1H3zM7 6h3v1h2v1h1v1h1v2h-1v-1h-1V9h-1V8H9V7H7z" fill="#000080"/><path d="M4 7h1V6h1V5h1v2h1v1h1v1h1v1h1v1h1v1h-1v-1h-1v-1H9V9H8V8H7v3H6v-1H5v-1H4z" fill="#fff"/>');
const REDO_ICON = svg('<path d="M13 7h-1V6h-1V5h-1V4H9v3H8v1H7v1H6v1H5v1H4v1H3v2h1v-1h1v-1h1v-1h1v-1h1V9h1v3h1v-1h1v-1h1v-1h1zM9 6H6v1H4v1H3v1H2v2h1v-1h1V9h1V8h1V7h3z" fill="#000080"/><path d="M12 7h-1V6h-1V5H9v2H8v1H7v1H6v1H5v1H4v1h1v-1h1v-1h1V9h1V8h1v3h1v-1h1v-1h1v-1h1z" fill="#fff"/>');

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
	/** @param {string} label @param {string} title @param {string} icon @param {() => void} action */
	const button = (label, title, icon, action) => {
		const $b = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).addClass("quick-button").attr({ type: "button", title, "aria-label": label }).appendTo($container));
		$(E("span")).addClass("quick-button-icon").css({ backgroundImage: `url("${icon}")` }).appendTo($b);
		$b.on("mousedown", (e) => { e.preventDefault(); }); // don't take focus from a text box being edited
		$b.on("click", () => { action(); });
		return $b;
	};
	$undo = button(localize("Undo"), `${localize("Undo")} (Ctrl+Z)`, UNDO_ICON, () => { undo(); });
	$redo = button(localize("Redo"), `${localize("Repeat")} (Ctrl+Y)`, REDO_ICON, () => { redo(); });
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
			width: 16px;
			height: 16px;
			background-repeat: no-repeat;
			background-size: 16px 16px;
			image-rendering: pixelated;
		}
		.quick-button:disabled .quick-button-icon {
			opacity: 0.4;
			filter: grayscale(1);
		}
	`).appendTo(document.head);
}

export { get_quick_buttons_container, init_quick_buttons };
