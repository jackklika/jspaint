// @ts-check
// Paint as a window: the jspaint app runs in a frame, and talks to the desktop with postMessage
// (see src/desktop-bridge.js): the desktop sends collages to open, Paint sends back finished ones.
import { show_window } from "./desktop.js";

/** @type {{ resolve: (html: string) => void } | null} whoever is waiting for the next collage from Paint */
let pending_collage = null;
/** @type {HTMLIFrameElement | null} */
let frame = null;

/** Opens (or focuses) the Paint window. Resolves once the app inside is ready for messages. */
export function open_paint() {
	const $w = show_window("paint", "Paint", "../images/icons/16x16.png", () => {
		const $window = $Window({ title: "untitled - Paint", icons: { 16: "../images/icons/16x16.png", 32: "../images/icons/32x32.png" }, resizable: true, innerWidth: Math.min(960, innerWidth - 40), innerHeight: Math.min(680, innerHeight - 80) });
		frame = document.createElement("iframe");
		frame.className = "app-frame";
		frame.src = "../index.html?desktop=1";
		frame.title = "Paint";
		$window.$content.append(frame);
		$window.css({ left: 90, top: 20 });
		$window.on("close", () => { frame = null; });
		return $window;
	});
	return new Promise((resolve) => {
		const check = () => {
			if (frame?.contentWindow) {
				frame.contentWindow.postMessage({ type: "desktop:ping" }, "*");
			}
		};
		const on_message = (/** @type {MessageEvent} */ e) => {
			if (e.data?.type === "paint:ready") {
				window.removeEventListener("message", on_message);
				clearInterval(timer);
				resolve($w);
			}
		};
		window.addEventListener("message", on_message);
		const timer = setInterval(check, 300);
		check();
	});
}

/**
 * Opens a collage (page markup) in Paint and resolves with the edited collage HTML when the user sends it back.
 * @param {string | null} collage_html - a `div.collage` (or a whole page containing one), assets as absolute or data URLs; null = whatever is in Paint
 * @returns {Promise<string>}
 */
export async function edit_collage_in_paint(collage_html) {
	await open_paint();
	if (collage_html) {
		frame.contentWindow.postMessage({ type: "desktop:open-collage", html: collage_html }, "*");
	}
	return new Promise((resolve) => { pending_collage = { resolve }; });
}

window.addEventListener("message", (e) => {
	if (e.data?.type === "paint:collage" && typeof e.data.html === "string") {
		const waiter = pending_collage;
		pending_collage = null;
		if (waiter) {
			waiter.resolve(e.data.html);
		} else {
			document.dispatchEvent(new CustomEvent("paint-collage", { detail: e.data.html }));
		}
	}
	if (e.data?.type === "paint:title" && frame) {
		const $w = $(frame).closest(".window");
		$w.find(".window-title").text(e.data.title);
	}
});
