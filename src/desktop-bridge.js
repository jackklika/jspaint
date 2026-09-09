// @ts-check
/* global file_name */
// When Paint runs inside the site builder's desktop (desktop/paint-window.js), this bridges the two:
// the desktop sends collages to open (`desktop:open-collage`), and File > Send to Page Editor sends the
// current collage back (`paint:collage`) with assets as data URLs; the desktop uploads them.
import { open_collage_from_file, serialize_collage_html } from "./collage-format.js";
import { show_error_message } from "./functions.js";

// Decided once at load: sessions.js rewrites the URL (dropping the query string) as it starts a session.
const in_desktop = window.parent !== window && new URLSearchParams(location.search).get("desktop") === "1";

/** True when Paint is framed by the desktop. */
function is_in_desktop() {
	return in_desktop;
}

async function send_collage_to_desktop() {
	if (!is_in_desktop()) {
		return;
	}
	try {
		const html = await serialize_collage_html({ title: file_name });
		window.parent.postMessage({ type: "paint:collage", html }, "*");
	} catch (error) {
		show_error_message("Couldn't send the collage to the Page Editor.", error);
	}
}

if (is_in_desktop()) {
	window.addEventListener("message", (event) => {
		if (event.source !== window.parent) {
			return;
		}
		const data = event.data || {};
		if (data.type === "desktop:ping") {
			window.parent.postMessage({ type: "paint:ready" }, "*");
		} else if (data.type === "desktop:open-collage" && typeof data.html === "string") {
			open_collage_from_file(new Blob([data.html], { type: "text/html" }));
		}
	});
	window.parent.postMessage({ type: "paint:ready" }, "*");
}

export { is_in_desktop, send_collage_to_desktop };
