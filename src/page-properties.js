// @ts-check
// eslint-disable-next-line no-unused-vars
/* global saved:writable */
/* global $canvas_area, localize */
// Page properties (Page > Page Properties…): the <body>'s bgcolor, text color, and tiled wallpaper — what
// shows around and behind the 800px page on the published site. Saved in the page file (collage-format.js);
// not part of undo history, but they do mark the document unsaved.
import { $DialogWindow } from "./$ToolWindow.js";
import { update_title } from "./functions.js";
import { E } from "./helpers.js";
import { get_site_files_base } from "./site-publish.js";

/** @typedef {{ bgcolor: string, text_color: string, background: string }} PageProperties */

/** @type {PageProperties} */
const page_properties = { bgcolor: "", text_color: "", background: "" };

/** @returns {PageProperties} */
function get_page_properties() {
	return { ...page_properties };
}

/**
 * @param {Partial<PageProperties>} props
 * @param {boolean} [mark_unsaved=true]
 */
function set_page_properties(props, mark_unsaved = true) {
	Object.assign(page_properties, props);
	if (mark_unsaved) {
		saved = false;
		update_title();
	}
	apply_page_properties_preview();
}

function reset_page_properties() {
	set_page_properties({ bgcolor: "", text_color: "", background: "" }, false);
}

/** The area around the canvas previews the page's background, when one is set. */
function apply_page_properties_preview() {
	const { bgcolor, background } = page_properties;
	let image = "";
	if (background) {
		const url = /^(?:[a-z]+:|\/\/|data:)/i.test(background) ? background : `${get_site_files_base() || ""}${background}`;
		image = get_site_files_base() || /^(?:[a-z]+:|\/\/)/i.test(background) ? `url("${url.replace(/"/g, "%22")}")` : "";
	}
	$canvas_area.css({
		background: bgcolor || "",
		backgroundImage: image,
		backgroundRepeat: image ? "repeat" : "",
	});
	$canvas_area.toggleClass("page-background-preview", !!(bgcolor || image));
}

function show_page_properties_dialog() {
	const $w = $DialogWindow(localize("Page Properties"));
	$w.addClass("page-properties-window squish");
	/** @param {string} label @param {string} value @param {string} placeholder */
	const field = (label, value, placeholder) => {
		const $row = $(E("label")).addClass("page-properties-row").text(`${label} `).appendTo($w.$main);
		return $(E("input")).attr({ type: "text", spellcheck: "false", placeholder }).val(value).appendTo($row);
	};
	const $bgcolor = field(localize("Background color:"), page_properties.bgcolor, "#ffffd9 (empty for white)");
	const $text = field(localize("Text color:"), page_properties.text_color, "#000000");
	const $background = field(localize("Wallpaper (tiled image):"), page_properties.background, "gifs/stars.gif on your site, or a URL");
	$(E("p")).addClass("page-properties-note").text(localize("The page itself is the picture; these show around it on the published page.")).appendTo($w.$main);
	$w.$Button(localize("OK"), () => {
		set_page_properties({
			bgcolor: String($bgcolor.val()).trim(),
			text_color: String($text.val()).trim(),
			background: String($background.val()).trim(),
		});
		$w.close();
	}, { type: "submit" });
	$w.$Button(localize("Cancel"), () => { $w.close(); });
	$w.$content.css({ width: "min(420px, 92vw)" });
	$w.center();
	$bgcolor.focus();
}

$("<style>").text(`
	.page-properties-row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 6px;
	}
	.page-properties-row input {
		flex: 1;
		min-width: 0;
	}
	.page-properties-note {
		font-size: 11px;
		opacity: 0.8;
	}
`).appendTo(document.head);

export { get_page_properties, reset_page_properties, set_page_properties, show_page_properties_dialog };
