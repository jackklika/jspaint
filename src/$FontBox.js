// @ts-check
/* global textbox, localize, text_tool_font */
import { $ToolWindow } from "./$ToolWindow.js";
// import { localize } from "./app-localization.js";
import { $G, E, supports_vertical_writing_mode } from "./helpers.js";
import { apply_block_style, apply_list, current_block_style, insert_rule, is_editing_block, is_editing_block_marquee, is_editing_container, show_text_link_dialog, toggle_editing_block_marquee } from "./blocks.js";

// The Marquee toggle's icon: a box of text with a scroll arrow (same size as the B/I/U sprites).
const MARQUEE_ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 16 16\" shape-rendering=\"crispEdges\"><rect x=\"1\" y=\"4\" width=\"14\" height=\"7\" fill=\"#fff\"/><path d=\"M0 3h1v1h-1zM1 3h1v1h-1zM2 3h1v1h-1zM3 3h1v1h-1zM4 3h1v1h-1zM5 3h1v1h-1zM6 3h1v1h-1zM7 3h1v1h-1zM8 3h1v1h-1zM9 3h1v1h-1zM10 3h1v1h-1zM11 3h1v1h-1zM12 3h1v1h-1zM13 3h1v1h-1zM14 3h1v1h-1zM15 3h1v1h-1zM0 4h1v1h-1zM15 4h1v1h-1zM0 5h1v1h-1zM5 5h1v1h-1zM6 5h1v1h-1zM7 5h1v1h-1zM8 5h1v1h-1zM9 5h1v1h-1zM11 5h1v1h-1zM12 5h1v1h-1zM13 5h1v1h-1zM15 5h1v1h-1zM0 6h1v1h-1zM3 6h1v1h-1zM15 6h1v1h-1zM0 7h1v1h-1zM2 7h1v1h-1zM3 7h1v1h-1zM4 7h1v1h-1zM5 7h1v1h-1zM6 7h1v1h-1zM8 7h1v1h-1zM9 7h1v1h-1zM10 7h1v1h-1zM11 7h1v1h-1zM15 7h1v1h-1zM0 8h1v1h-1zM3 8h1v1h-1zM15 8h1v1h-1zM0 9h1v1h-1zM5 9h1v1h-1zM6 9h1v1h-1zM7 9h1v1h-1zM9 9h1v1h-1zM10 9h1v1h-1zM11 9h1v1h-1zM12 9h1v1h-1zM13 9h1v1h-1zM15 9h1v1h-1zM0 10h1v1h-1zM15 10h1v1h-1zM0 11h1v1h-1zM1 11h1v1h-1zM2 11h1v1h-1zM3 11h1v1h-1zM4 11h1v1h-1zM5 11h1v1h-1zM6 11h1v1h-1zM7 11h1v1h-1zM8 11h1v1h-1zM9 11h1v1h-1zM10 11h1v1h-1zM11 11h1v1h-1zM12 11h1v1h-1zM13 11h1v1h-1zM14 11h1v1h-1zM15 11h1v1h-1z\" fill=\"#000\"/></svg>";

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

	// Marquee: scrolling text, a style like bold. For a page text block being edited in place it switches the block
	// to/from <marquee> (blocks.js); while typing in the Text tool's box it makes finishing produce a <marquee> element.
	const $marquee = $(E("button")).addClass("toggle marquee-toggle").attr({
		type: "button",
		"aria-pressed": "false",
		"aria-label": "Marquee",
		"aria-description": localize("Makes the text scroll across its box, like a <marquee>."),
		title: localize("Marquee: the text scrolls across its box."),
	});
	$(E("span")).addClass("icon marquee-icon").appendTo($marquee);
	$marquee.css({ width: 23, height: 22, padding: 0, display: "inline-flex", alignContent: "center", alignItems: "center", justifyContent: "center" });
	const marquee_on = () => (is_editing_block() ? is_editing_block_marquee() : !!(textbox && /** @type {any} */ (textbox).marquee));
	const update_marquee = () => {
		const on = marquee_on();
		$marquee.prop("disabled", !is_editing_block() && !textbox).attr("aria-pressed", String(on)).toggleClass("selected", on);
	};
	$marquee.on("mousedown", (e) => { e.preventDefault(); }); // keep focus in the text editor
	$marquee.on("click", () => {
		if (is_editing_block()) {
			toggle_editing_block_marquee();
		} else if (textbox) {
			/** @type {any} */ (textbox).marquee = !(/** @type {any} */ (textbox).marquee);
		}
		update_marquee();
	});
	$G.on("block-editing-changed textbox-changed", update_marquee);
	update_marquee();
	$button_group.append($bold, $italic, $underline, $vertical, $marquee);

	// Writing tools, for a section (or a table cell) being edited: what the line is, lists, a rule, a link.
	const $block_group = $(E("span")).addClass("text-toolbar-button-group block-tools");
	const $style = /** @type {JQuery<HTMLSelectElement>} */ ($(E("select")).addClass("inset-deep block-style").attr({ "aria-label": "Style", title: localize("What this line is: plain text, a heading, a quote, or code.") }));
	for (const [value, label] of [["p", localize("Normal")], ["h1", localize("Heading 1")], ["h2", localize("Heading 2")], ["h3", localize("Heading 3")], ["blockquote", localize("Quote")], ["pre", localize("Code")]]) {
		$(E("option")).val(value).text(label).appendTo($style);
	}
	$style.on("mousedown", (e) => { e.stopPropagation(); });
	$style.on("change", () => { apply_block_style(String($style.val())); });
	/** @param {string} label @param {string} title @param {string} svg @param {() => void} action */
	const icon_button = (label, title, svg, action) => {
		const $button = $(E("button")).addClass("toggle block-tool").attr({ type: "button", "aria-label": label, title });
		$(E("span")).addClass("icon block-tool-icon").css({ backgroundImage: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")` }).appendTo($button);
		$button.css({ width: 23, height: 22, padding: 0, display: "inline-flex", alignContent: "center", alignItems: "center", justifyContent: "center" });
		$button.on("mousedown", (e) => { e.preventDefault(); }); // keep focus in the text
		$button.on("click", action);
		return $button;
	};
	const px = (/** @type {string} */ d, /** @type {string} */ fill = "#000") => `<path d="${d}" fill="${fill}"/>`;
	const svg16 = (/** @type {string} */ body) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`;
	const $bullets = icon_button("Bulleted List", localize("Bulleted list"), svg16(px("M2 3h2v2H2zM6 3h8v2H6zM2 7h2v2H2zM6 7h8v2H6zM2 11h2v2H2zM6 11h8v2H6z")), () => { apply_list(false); });
	const $numbers = icon_button("Numbered List", localize("Numbered list"), svg16(px("M2 2h2v4H3V3H2zM6 3h8v2H6zM2 7h2v1H3v1h1v1H2v1h2V7zM6 7h8v2H6zM6 11h8v2H6zM2 11h2v1H2v1h2v1H2z")), () => { apply_list(true); });
	const $rule = icon_button("Rule", localize("A line across (horizontal rule)"), svg16(px("M2 7h12v1H2z", "#808080") + px("M2 8h12v1H2z", "#fff")), () => { insert_rule(); });
	const $link = icon_button("Link", localize("Link the selected words to a page, a section, or an address (Ctrl+K)"), svg16(px("M6 4h5v1h1v1h1v3h-1v1h-1v1H9v-1h2V9h1V7h-1V6H9V5H6zM3 6h4v1H5v1H4v2h1v1h2v1H3v-1H2V7h1zM5 8h6v1H5z", "#000080")), () => { show_text_link_dialog(); });
	$block_group.append($style, $bullets, $numbers, $rule, $link);
	const update_block_tools = () => {
		const container = is_editing_container();
		$block_group.toggle(is_editing_block());
		$style.prop("disabled", !container);
		$bullets.prop("disabled", !container);
		$numbers.prop("disabled", !container);
		$rule.prop("disabled", !container);
		if (container) { $style.val(current_block_style()); }
	};
	$G.on("block-editing-changed block-style-changed", update_block_tools);
	update_block_tools();
	$("<style>").text(`
		.font-box .block-tools {
			margin-left: 4px;
		}
		.font-box .block-style {
			height: 22px;
			max-width: 110px;
			vertical-align: top;
		}
		.font-box .block-tool-icon,
		.font-box .toggle .block-tool-icon {
			display: block;
			width: 16px;
			height: 16px;
			flex: 0 0 auto;
			background-position: 0 0 !important;
			background-size: 16px 16px !important;
			background-repeat: no-repeat !important;
			-webkit-mask-image: none !important;
			mask-image: none !important;
			image-rendering: pixelated;
		}
		.font-box .marquee-icon,
		.font-box .toggle .marquee-icon {
			display: block;
			width: 16px;
			height: 16px;
			flex: 0 0 auto;
			background-image: url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(MARQUEE_ICON_SVG)}") !important;
			background-position: 0 0 !important;
			background-size: 16px 16px !important;
			background-repeat: no-repeat !important;
			-webkit-mask-image: none !important;
			mask-image: none !important;
			image-rendering: pixelated;
		}
	`).appendTo(document.head);
	$fb.append($family, $size, $button_group, $block_group);

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

