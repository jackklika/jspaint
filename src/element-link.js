// @ts-check
/* global localize */
// Edit > Add Link to Element…: the selected sticker or text layer becomes a link (or loses its link).
// Links are kept on the layer and written into the collage page as <a> elements (collage-format.js).
import { $DialogWindow } from "./$ToolWindow.js";
import { E } from "./helpers.js";
import { get_selected_sticker, set_selected_sticker_link } from "./stickers.js";
import { get_selected_text_layer, set_selected_text_layer_link } from "./text-layers.js";

/** @returns {{ kind: "sticker" | "text", href: string, set: (href: string) => void } | null} */
function get_linkable_element() {
	const sticker = get_selected_sticker();
	if (sticker) {
		return { kind: "sticker", href: sticker.href, set: set_selected_sticker_link };
	}
	const layer = get_selected_text_layer();
	if (layer) {
		return { kind: "text", href: layer.href, set: set_selected_text_layer_link };
	}
	return null;
}

function has_linkable_element() {
	return !!get_linkable_element();
}

function show_element_link_dialog() {
	const element = get_linkable_element();
	if (!element) {
		return;
	}
	const $w = $DialogWindow(localize("Add Link to Element"));
	$w.addClass("horizontal-buttons");
	$(E("p")).text(element.kind === "sticker" ? localize("Where should clicking this sticker go?") : localize("Where should clicking this text go?")).appendTo($w.$main);
	const $label = $(E("label")).text(localize("Address (URL): ")).appendTo($w.$main);
	const $input = $(E("input")).attr({ type: "text", spellcheck: "false", placeholder: "https://example.com/ or about.html" }).val(element.href).css({ width: 300 }).appendTo($label);
	const apply = (/** @type {string} */ href) => {
		$w.close();
		if (href !== element.href) {
			element.set(href);
		}
	};
	$w.$Button(localize("OK"), () => { apply(String($input.val()).trim()); }, { type: "submit" });
	if (element.href) {
		$w.$Button(localize("Remove Link"), () => { apply(""); });
	}
	$w.$Button(localize("Cancel"), () => { $w.close(); });
	$w.center();
	$input.focus();
}

export { has_linkable_element, show_element_link_dialog };
