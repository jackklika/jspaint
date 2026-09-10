// @ts-check
/* global $bottom, $canvas_area, localize */
// A pan joystick at the bottom right of the color bar, for phones: drag the knob to scroll the page in that
// direction (further = faster). Shown on touch screens and narrow windows by default; View › Pan Joystick
// forces it on or off. Desktop users have the wheel and scrollbars; the Pointer tool drags bare canvas too.
import { $G, E } from "./helpers.js";
import { get_quick_buttons_container } from "./quick-buttons.js";

const SETTING_KEY = "jspaint pan joystick"; // "auto" | "on" | "off"
const RADIUS = 14; // knob travel in px
const SPEED = 0.45; // px scrolled per frame per px of knob travel (≈ 6 px/frame at full tilt)

/** @type {JQuery<HTMLElement> | null} */
let $joystick = null;
/** @type {JQuery<HTMLElement> | null} */
let $knob = null;
let vx = 0, vy = 0;
let frame = 0;

/** @returns {"auto" | "on" | "off"} */
function get_setting() {
	try {
		const value = localStorage.getItem(SETTING_KEY);
		return value === "on" || value === "off" ? value : "auto";
	} catch (_error) {
		return "auto";
	}
}
/** @param {"auto" | "on" | "off"} value */
function set_setting(value) {
	try {
		localStorage.setItem(SETTING_KEY, value);
	} catch (_error) { /* ignore */ }
	update_visibility();
}
function should_show() {
	const setting = get_setting();
	if (setting !== "auto") { return setting === "on"; }
	return window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 900;
}
function is_pan_joystick_shown() {
	return !!$joystick && $joystick.is(":visible");
}
/** View › Pan Joystick: toggles between forced on and forced off (from auto, it goes to the opposite of what's shown). */
function toggle_pan_joystick() {
	set_setting(should_show() ? "off" : "on");
}
function update_visibility() {
	$joystick?.toggle(should_show());
}

function tick() {
	if (vx === 0 && vy === 0) {
		frame = 0;
		return;
	}
	const area = $canvas_area[0];
	area.scrollLeft += vx;
	area.scrollTop += vy;
	frame = requestAnimationFrame(tick);
}

/** Call once the bottom component area exists (app.js). */
function init_pan_joystick() {
	// Sits with the Undo/Redo buttons at the bottom right (quick-buttons.js), or alone if those aren't there.
	$joystick = $(E("div")).addClass("pan-joystick").attr({ role: "slider", "aria-label": localize("Pan joystick: drag to scroll the page"), title: localize("Drag to scroll the page") }).appendTo(get_quick_buttons_container() || $bottom);
	$joystick.toggleClass("pan-joystick-alone", !get_quick_buttons_container());
	$knob = $(E("div")).addClass("pan-joystick-knob").appendTo($joystick);
	$joystick.css("touch-action", "none");

	let center_x = 0, center_y = 0;
	const move = (/** @type {PointerEvent} */ e) => {
		let dx = e.clientX - center_x;
		let dy = e.clientY - center_y;
		const distance = Math.hypot(dx, dy);
		if (distance > RADIUS) {
			dx *= RADIUS / distance;
			dy *= RADIUS / distance;
		}
		$knob.css({ transform: `translate(${dx}px, ${dy}px)` });
		vx = dx * SPEED;
		vy = dy * SPEED;
		if (!frame) { frame = requestAnimationFrame(tick); }
	};
	const release = () => {
		vx = 0;
		vy = 0;
		$knob.css({ transform: "" });
		$joystick.removeClass("active");
	};
	$joystick[0].addEventListener("pointerdown", (e) => {
		if (e.button !== 0) { return; }
		e.preventDefault();
		e.stopPropagation();
		const rect = $joystick[0].getBoundingClientRect();
		center_x = rect.left + rect.width / 2;
		center_y = rect.top + rect.height / 2;
		$joystick.addClass("active");
		$joystick[0].setPointerCapture(e.pointerId);
		move(e);
	});
	$joystick[0].addEventListener("pointermove", (e) => { if ($joystick.hasClass("active")) { move(e); } });
	$joystick[0].addEventListener("pointerup", release);
	$joystick[0].addEventListener("pointercancel", release);
	$joystick[0].addEventListener("lostpointercapture", release);
	$G.on("resize", update_visibility);
	update_visibility();

	$("<style>").text(`
		.component-area.bottom {
			position: relative;
		}
		.pan-joystick {
			position: relative;
			flex: none;
			width: 44px;
			height: 44px;
			border-radius: 50%;
			box-sizing: border-box;
			background: var(--ButtonFace, #c0c0c0);
			border: 2px solid;
			border-color: var(--ButtonShadow, #808080) var(--ButtonHilight, #fff) var(--ButtonHilight, #fff) var(--ButtonShadow, #808080);
			z-index: 5;
			cursor: grab;
			user-select: none;
			-webkit-user-select: none;
		}
		.pan-joystick.pan-joystick-alone {
			position: absolute;
			right: 6px;
			top: 50%;
			transform: translateY(-50%);
		}
		.pan-joystick.active {
			cursor: grabbing;
		}
		.pan-joystick-knob {
			position: absolute;
			left: 50%;
			top: 50%;
			width: 20px;
			height: 20px;
			margin: -10px 0 0 -10px;
			border-radius: 50%;
			box-sizing: border-box;
			background: var(--ButtonFace, #c0c0c0);
			border: 2px solid;
			border-color: var(--ButtonHilight, #fff) var(--ButtonShadow, #808080) var(--ButtonShadow, #808080) var(--ButtonHilight, #fff);
			pointer-events: none;
		}
		.pan-joystick::before {
			content: "✥";
			position: absolute;
			left: 0; right: 0; top: 0; bottom: 0;
			text-align: center;
			line-height: 40px;
			font-size: 26px;
			color: var(--ButtonShadow, #808080);
			opacity: 0.5;
		}
	`).appendTo(document.head);
}

export { init_pan_joystick, is_pan_joystick_shown, toggle_pan_joystick };
