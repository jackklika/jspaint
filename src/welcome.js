// @ts-check
/* global localize */
// The Welcome window: the first thing someone who isn't signed in sees at edit.<domain>/ (over the starter page —
// my-site.js open_starter_page). What this is, what saving does, a way in with Google, a look at the site's own
// homepage — and a checkbox to not see it again. Win98 through and through; small enough not to be in the way.
import { $DialogWindow } from "./$ToolWindow.js";
import { E } from "./helpers.js";

const SEEN_KEY = "jspaint welcome seen"; // localStorage: "1" once someone unchecks "Show this next time"

function welcome_dismissed() {
	try { return localStorage.getItem(SEEN_KEY) === "1"; } catch (_error) { return false; }
}

/**
 * @param {object} links
 * @param {string} links.editor - the editor's address (to ask /auth/methods whether Google sign-in is set up)
 * @param {string} links.google_url - where "Sign in with Google" goes (the save resumes on the way back)
 * @param {string} links.homepage_url - the site's own homepage, in Paint (edit.<domain>/~root/)
 * @param {string} links.site_host - coolpaint.world
 */
function show_welcome({ editor, google_url, homepage_url, site_host }) {
	const $w = $DialogWindow(localize("Welcome to Cool Paint World"));
	$w.addClass("welcome-window squish");
	const $main = $w.$main;
	$(E("p")).addClass("welcome-lead").text(localize("This is Paint, and this page is yours. Draw on it, write in it, drop GIFs on it.")).appendTo($main);
	const $save = $(E("p")).addClass("welcome-save").appendTo($main);
	$save.append(document.createTextNode(`${localize("When you save, pick a name and it's live at")} `));
	$(E("b")).text(`${site_host}/~name/`).appendTo($save);
	const $homepage = $(E("p")).addClass("welcome-homepage").appendTo($main);
	$homepage.append(document.createTextNode(`${localize("Or")} `));
	$(E("a")).attr({ href: homepage_url }).text(localize("play with the site's homepage")).appendTo($homepage);
	$homepage.append(document.createTextNode("."));
	const $google = $(E("a"))
		.addClass("google-sign-in welcome-google")
		.attr({ href: google_url, role: "button" })
		.text(localize("Sign in with Google"))
		.hide()
		.appendTo($main);
	// (98.css draws a checkbox through the <label for> that follows the <input>)
	const $again = $(E("div")).addClass("welcome-again").appendTo($main);
	const $checkbox = $(E("input")).attr({ type: "checkbox", name: "welcome-again", id: "welcome-again-checkbox" }).prop("checked", true).appendTo($again);
	$(E("label")).attr({ for: "welcome-again-checkbox" }).text(localize("Show this next time")).appendTo($again);
	$checkbox.on("change", () => {
		try {
			if ($checkbox.prop("checked")) { localStorage.removeItem(SEEN_KEY); } else { localStorage.setItem(SEEN_KEY, "1"); }
		} catch (_error) { /* no storage: it shows again */ }
	});
	$w.$Button(localize("Start drawing"), () => { $w.close(); }, { type: "submit" });
	// Google, when the editor has it set up (the Sign In dialog asks the same)
	fetch(`${editor}/auth/methods`).then((response) => response.json()).then((methods) => {
		if (!$w.closed && methods && methods.google) { $google.show(); }
	}).catch(() => { /* no editor to ask: Save asks to sign in anyway */ });
	$w.$content.css({ width: "min(400px, 92vw)" });
	$w.center();
	$w.$main.find("button, a").first().trigger("focus");
	return $w;
}

$(() => {
	$("<style>").text(`
		.welcome-window .welcome-lead {
			margin: 4px 0 8px;
			font-size: 13px;
		}
		.welcome-window .welcome-save,
		.welcome-window .welcome-homepage {
			margin: 0 0 8px;
		}
		.welcome-window .welcome-google {
			display: inline-block;
			margin: 4px 0 10px;
		}
		.welcome-window .welcome-again {
			display: block;
			margin-top: 6px;
		}
	`).appendTo(document.head);
});

export { show_welcome, welcome_dismissed };
