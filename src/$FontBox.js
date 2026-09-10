// @ts-check
/* global localize, text_tool_font */
import { $ToolWindow } from "./$ToolWindow.js";
// import { localize } from "./app-localization.js";
import { $G, E, supports_vertical_writing_mode } from "./helpers.js";
import { is_editing_block, is_editing_block_marquee, toggle_editing_block_marquee } from "./blocks.js";
import { is_web_text_mode, set_web_text_mode } from "./text-layers.js";

const eachFont = async (callback, afterAllCallback) => {
	function localFontAccessUnavailable() {
		FontDetective.each(callback);
		FontDetective.all(afterAllCallback);
	}
	if (window.queryLocalFonts) {
		let availableFonts;
		try {
			availableFonts = await window.queryLocalFonts();
		} catch (error) {
			console.log("queryLocalFonts failed:", error, "\nFalling back to FontDetective.");
			localFontAccessUnavailable();
			return;
		}
		if (availableFonts.length === 0) {
			console.log("queryLocalFonts returned no fonts; falling back to FontDetective.");
			localFontAccessUnavailable();
			return;
		}
		const familyNames = new Set();
		for (const font of availableFonts) {
			if (familyNames.has(font.family)) {
				continue;
			}
			familyNames.add(font.family);
			callback({
				name: font.family,
				toString() {
					return '"' + this.name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + '"';
				},
			});
			// This class is not exported by FontDetective.
			// That said, this queryLocalFonts functionality should be moved into FontDetective.
			// callback(new FontDetective.Font(font.family));
		}
		afterAllCallback();
	} else {
		console.log("queryLocalFonts unavailable; falling back to FontDetective.");
		localFontAccessUnavailable();
	}
};

/**
 * @returns {OSGUI$Window}
 */
function $FontBox() {
	const $fb = $(E("div")).addClass("font-box");

	// This complex cast tells it that jQuery's val() method can return a string and not an array of strings.
	// See the types for val().
	const $family = /** @type {JQuery<HTMLSelectElement & { type: "select-one" }>} */(
		$(E("select")).addClass("inset-deep").attr({
			"aria-label": "Font Family",
			"aria-description": localize("Selects the font used by the text."),
		})
	);
	const $size = $(E("input")).addClass("inset-deep").attr({
		type: "number",
		min: 8,
		max: 72,
		value: text_tool_font.size,
		"aria-label": "Font Size",
		"aria-description": localize("Selects the point size of the text."),
	}).css({
		maxWidth: 50,
	});
	const $button_group = $(E("span")).addClass("text-toolbar-button-group");
	// @TODO: localized labels
	const $bold = $Toggle(0, "bold", "Bold", localize("Sets or clears the text bold attribute."));
	const $italic = $Toggle(1, "italic", "Italic", localize("Sets or clears the text italic attribute."));
	const $underline = $Toggle(2, "underline", "Underline", localize("Sets or clears the text underline attribute."));
	// The original text from MS Paint is simply not true: browsers that support vertical writing also work with Latin text
	// However, vertical-lr is a bit weird for Latin text.
	// const $vertical = $Toggle(3, "vertical", "Vertical Writing Mode", localize("Only a Far East font can be used for vertical editing."));
	// So alternate text, which we won't have translations for...
	const $vertical = $Toggle(3, "vertical", "Vertical Writing Mode", localize("Vertical writing is intended for Far East scripts."));
	// const $vertical = $Toggle(3, "vertical", "Vertical Writing Mode", localize("Vertical writing works best with Far East scripts."));
	$vertical.prop("disabled", !supports_vertical_writing_mode());

	// Web text: keep finished text as an editable, linkable layer instead of pixels (see text-layers.js).
	const $web_text = $(E("button")).addClass("toggle web-text-toggle").attr({
		type: "button",
		"aria-pressed": String(is_web_text_mode()),
		"aria-label": "Web Text",
		title: localize("Keeps the text as text (editable, can be a link) instead of drawing it as pixels."),
	}).text("Web");
	$web_text.on("mousedown", (e) => { e.preventDefault(); }); // keep focus in the text editor
	$web_text.on("click", () => { set_web_text_mode(!is_web_text_mode()); });
	$G.on("web-text-mode-changed", () => { $web_text.attr("aria-pressed", String(is_web_text_mode())); });
	// Marquee: scrolling text, a style like bold — for a page text block being edited in place (blocks.js).
	const $marquee = $(E("button")).addClass("toggle marquee-toggle").attr({
		type: "button",
		"aria-pressed": String(is_editing_block_marquee()),
		"aria-label": "Marquee",
		title: localize("Makes the text scroll across its box, like a <marquee> (for text on the page)."),
	}).text("«»");
	$marquee.on("mousedown", (e) => { e.preventDefault(); });
	$marquee.on("click", () => { toggle_editing_block_marquee(); });
	const update_marquee = () => {
		$marquee.prop("disabled", !is_editing_block()).attr("aria-pressed", String(is_editing_block_marquee())).toggleClass("selected", is_editing_block_marquee());
	};
	$G.on("block-editing-changed", update_marquee);
	update_marquee();
	$button_group.append($bold, $italic, $underline, $vertical, $marquee, $web_text);
	$fb.append($family, $size, $button_group);

	const update_font = () => {
		text_tool_font.size = Number($size.val());
		text_tool_font.family = $family.val();
		$G.trigger("option-changed");
	};

	const originalFamily = text_tool_font.family;
	// The classic web-safe fonts go first, in this order, above a separator; everything else is alphabetical below it.
	// (Web text layers render in the visitor's browser, so these are the ones that look the same everywhere.)
	const classic_families = ["Arial", "Comic Sans MS", "Courier New", "Georgia", "Impact", "Times New Roman", "Trebuchet MS", "Verdana"];
	const $separator = $(E("option")).prop("disabled", true).text("──────────").addClass("font-separator");
	eachFont((font) => {
		const $option = $(E("option"));
		$option.val(font).text(font.name);
		const classic_index = classic_families.indexOf(font.name);
		if (classic_index !== -1) {
			if (!$separator.parent().length) {
				$family.prepend($separator);
			}
			// Insert among the classic fonts, in classic order
			/** @type {JQuery<HTMLElement>} */
			let $before = $separator;
			for (const $classic of $family.children("option.classic-font").toArray().map((el) => $(el))) {
				if (classic_families.indexOf($classic.text()) > classic_index) {
					$before = $classic;
					break;
				}
			}
			$option.addClass("classic-font").insertBefore($before);
		} else {
			// Insert in alphabetical order, after the separator
			const $options = $family.children("option").not(".classic-font").not(".font-separator");
			let i = 0;
			for (; i < $options.length; i++) {
				if ($options.eq(i).text().localeCompare(font.name) > 0) {
					break;
				}
			}
			if ($options.eq(i).length) {
				$options.eq(i).before($option);
			} else {
				$family.append($option);
			}
		}
		// Select the first known-available font, just in case FontDetective.each is slow.
		if (!text_tool_font.family) {
			update_font();
		}
	}, () => {
		// All fonts have been added to the list. Now we can select the font — the one in use right now, which may
		// have changed since this box was created (a page element being edited reports the font at its caret).
		$family.val(text_tool_font.family || originalFamily);
		// Liberation Sans is designed to be metrically compatible with Arial,
		// and is available in free operating systems like Ubuntu.
		if (!$family.val()) {
			$family.val('"Liberation Sans"');
		}
		// Fallback to the first font in the list. At least it's something.
		if (!$family.val()) {
			$family.val($family.children("option").eq(0).val());
		}
		update_font();
	});

	if (text_tool_font.family) {
		$family.val(text_tool_font.family);
	}

	$family.on("change", update_font);
	$size.on("change", update_font);
	// Blocks being edited in place report the formatting at the caret (blocks.js) — reflect it without re-triggering.
	$G.on("text-tool-font-changed", () => {
		$size.val(text_tool_font.size);
		if (text_tool_font.family) {
			// The text's font may not be installed here (a page font like Comic Sans MS on a machine without it):
			// list it anyway, so the box shows it and update_font() doesn't swap it for whatever was selected.
			if (!$family.find(`option[value='${text_tool_font.family.replace(/'/g, "\\'")}']`).length) {
				$family.prepend($(E("option")).val(text_tool_font.family).text(text_tool_font.family.replace(/^"|"$/g, "")).addClass("classic-font"));
			}
			$family.val(text_tool_font.family);
		}
		$button_group.find(".toggle[data-font-prop]").each((_i, button) => {
			const on = !!text_tool_font[/** @type {HTMLElement} */ (button).dataset.fontProp];
			$(button).toggleClass("selected", on).attr("aria-pressed", String(on));
		});
	});

	const $w = $ToolWindow();
	$w.title(localize("Fonts"));
	$w.$content.append($fb);
	$w.center();

	// Hotfix for bug where the font dropdown would close immediately when clicked in Chrome.
	// Code in $Window.js (from os-gui.js but PATCHED) is trying to focus the dropdown when it's already focused,
	// or focusing the window content area. Either can cause the dropdown to close.
	// The code patches in $Window.js specific to this repo may be related to why this is happening.
	// See: "PATCHED; I want focus tracking in a tool window"
	// Maybe I don't want it for the font window! (What tool window did I want it for? A history panel, or...?)
	// I could probably adjust my patch to not apply to the font box, but this is a quick fix.
	$family[0].focus = () => {
		// console.trace("$FontBox: Font family select focus() called");
	};
	$w.$content[0].focus = () => {
		// console.trace("$FontBox: Font box window content area focus() called");
	};

	return $w;


	function $Toggle(xi, thing, label, description) {
		const $button = $(E("button")).addClass("toggle").attr({
			"aria-pressed": false,
			"aria-label": label,
			"aria-description": description,
			"data-font-prop": thing,
		});
		const $icon = $(E("span")).addClass("icon").appendTo($button);
		$button.css({
			width: 23,
			height: 22,
			padding: 0,
			display: "inline-flex",
			alignContent: "center",
			alignItems: "center",
			justifyContent: "center",
		});
		$icon.css({
			flex: "0 0 auto",
			display: "block",
			width: 16,
			height: 16,
			"--icon-index": xi,
		});
		$button.on("click", () => {
			$button.toggleClass("selected");
			text_tool_font[thing] = $button.hasClass("selected");
			$button.attr("aria-pressed", $button.hasClass("selected") ? "true" : "false");
			update_font();
		});
		if (text_tool_font[thing]) {
			$button.addClass("selected").attr("aria-pressed", "true");
		}
		return $button;
	}
}

export { $FontBox };

