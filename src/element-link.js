// @ts-check
/* global $status_text, localize */
// Edit > Add Link to Element… and the toolbox's Link tool: the selected sticker, text layer, or page element becomes
// a link (or loses its link) through the link dialog (link-dialog.js). Links are kept on the layer and written into
// the collage page as <a> elements (collage-format.js). Words in a section being edited go through
// show_text_link_dialog (blocks.js) instead — the Link tool picks whichever applies.
import { get_block_link, get_selected_block, is_editing_block, set_selected_block_link, show_text_link_dialog } from "./blocks.js";
import { show_link_dialog } from "./link-dialog.js";
import { get_selected_sticker, set_selected_sticker_link } from "./stickers.js";
import { get_selected_text_layer, set_selected_text_layer_link } from "./text-layers.js";

/** @returns {{ kind: "sticker" | "text" | "block", href: string, prompt: string, set: (href: string) => void } | null} */
function get_linkable_element() {
	const sticker = get_selected_sticker();
	if (sticker) {
		return { kind: "sticker", href: sticker.href, prompt: localize("Where should clicking this picture go?"), set: set_selected_sticker_link };
	}
	const layer = get_selected_text_layer();
	if (layer) {
		return { kind: "text", href: layer.href, prompt: localize("Where should clicking this text go?"), set: set_selected_text_layer_link };
	}
	const block = get_selected_block();
	if (block) {
		// While editing, the link goes on the selected words; otherwise on the whole element — if it makes sense
		// (a counter or a guestbook can't be a link; a section links through its words).
		const selection = document.getSelection();
		const partial = block.editing && selection && !selection.isCollapsed && selection.anchorNode && block.el.contains(selection.anchorNode);
		if (partial) {
			return { kind: "block", href: "", prompt: localize("Where should the selected words go?"), set: set_selected_block_link };
		}
		const linkable = block.kind.linkable ?? !/^x-/.test(block.kind.id);
		if (!linkable || block.flow || block.editing) { return null; }
		return { kind: "block", href: get_block_link(block), prompt: localize("Where should clicking this element go?"), set: set_selected_block_link };
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
	show_link_dialog({
		href: element.href,
		prompt: element.prompt,
		apply: (href) => {
			if (href !== element.href) {
				element.set(href);
			}
		},
	});
}

/** The toolbox's Link tool: the words being edited, else the selected element, else a hint in the status bar. */
function link_tool() {
	if (is_editing_block()) {
		show_text_link_dialog();
		return;
	}
	if (has_linkable_element()) {
		show_element_link_dialog();
		return;
	}
	const block = get_selected_block();
	$status_text.text(block && (block.flow || block.kind.editable) ?
		localize("Double-click into the text and select the words to link.") :
		block ? localize("This element can't be a link. Select a picture, web text, or a text box.") : localize("Select a picture, text, or an element to link — or words in a section being edited."));
}

export { has_linkable_element, link_tool, show_element_link_dialog };
