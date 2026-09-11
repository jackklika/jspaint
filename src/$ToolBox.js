// @ts-check
/* global $canvas, $left, $right, $status_text, get_direction, localize, main_canvas, return_to_tools, selected_tool, selected_tools */
import { $Component } from "./$Component.js";
// import { get_direction, localize } from "./app-localization.js";
import { select_tool, select_tools } from "./functions.js";
import { $G, E, make_css_cursor } from "./helpers.js";
import { TOOL_POINTER } from "./page-tools.js";
import { get_theme } from "./theme.js";


let theme_dev_blob_url;

/**
 * @param {Tool[]} tools
 * @param {boolean=} is_extras
 * @returns {JQuery<HTMLDivElement> & I$ToolBox & I$Component}
 */
function $ToolBox(tools, is_extras) {
	const $tools = $(E("div")).addClass("tools");
	const $tool_options = $(E("div")).addClass("tool-options");

	let showing_tooltips = false;
	$tools.on("pointerleave", () => {
		showing_tooltips = false;
		$status_text.default();
	});

	let divider_added = false;
	const $buttons = $($.map(tools, (tool, i) => {
		if (tool.page_tool && !divider_added) {
			// The page tools (Pointer, headings, GIFs, guestbook…) sit below the paint tools, behind a groove.
			$(E("div")).addClass("tool-divider").attr({ role: "separator", title: localize("Page elements") }).appendTo($tools);
			divider_added = true;
		}
		const $b = $(E("div")).addClass("tool");
		$b.appendTo($tools);
		tool.$button = $b;

		$b.attr("title", tool.name);

		const $icon = $(E("span")).addClass("tool-icon");
		$icon.appendTo($b);
		if (tool.icon_svg) {
			$icon.addClass("custom-tool-icon").css("--custom-icon", `url("${tool.icon_svg}")`);
		}
		const update_css = () => {
			const use_svg = !theme_dev_blob_url && (
				(
					get_theme() === "modern.css" || get_theme() === "modern-dark.css" ?
						// only use raster when screen pixels line up with image pixels exactly
						(window.devicePixelRatio !== 1) :
						// with nearest neighbor scaling, favor raster at larger integer sizes as well, for retro look
						(window.devicePixelRatio >= 3 || (window.devicePixelRatio % 1) !== 0)
				) ||
				$("body").hasClass("enlarge-ui")
			);
			$icon.css({
				display: "block",
				position: "absolute",
				left: 4,
				top: 4,
				width: 16,
				height: 16,
				backgroundImage: theme_dev_blob_url ? `url(${theme_dev_blob_url})` : "",
				"--icon-index": i.toString(),
			});
			$icon.toggleClass("use-svg", use_svg);
		};
		update_css();
		$G.on("theme-load resize", update_css);

		$b.on("mousedown", (e) => {
			if (tool.keep_focus) {
				e.preventDefault(); // the Link tool acts on the words selected in the text being edited: don't take focus
			}
		});
		$b.on("click", (e) => {
			if (tool.action) {
				// A one-shot tool (GIF picker, image file): does its thing, doesn't stay selected.
				tool.action();
				return;
			}
			if (e.shiftKey || e.ctrlKey) {
				select_tool(tool, true);
				return;
			}
			if (selected_tool === tool && tool.deselect) {
				select_tools(return_to_tools);
			} else {
				select_tool(tool);
			}
		});

		$b.on("pointerenter", () => {
			const show_tooltip = () => {
				showing_tooltips = true;
				$status_text.text(tool.description);
			};
			if (showing_tooltips) {
				show_tooltip();
			} else {
				const tid = setTimeout(show_tooltip, 300);
				$b.on("pointerleave", () => {
					clearTimeout(tid);
				});
			}
		});

		return $b[0];
	}));

	/**
	 * @typedef {Object} I$ToolBox
	 * @prop {() => void} update_selected_tool
	 */

	const $c = /** @type {JQuery<HTMLDivElement> & I$Component & I$ToolBox} **/ ($Component(
		is_extras ? "Extra Tools" : localize("Tools"),
		is_extras ? "tools-component extra-tools-component" : "tools-component",
		"tall",
		$tools.add($tool_options)
	));
	$c.appendTo(get_direction() === "rtl" ? $right : $left); // opposite ColorBox by default
	$c.update_selected_tool = () => {
		$buttons.removeClass("selected");
		selected_tools.forEach((selected_tool) => {
			selected_tool.$button.addClass("selected");
		});
		$tool_options.children().detach();
		$tool_options.append(selected_tool.$options);
		$tool_options.children().trigger("update");
		$canvas.css({
			cursor: make_css_cursor(...selected_tool.cursor),
		});
		// With the Pointer tool every element on the page is live; otherwise only the selected one is (blocks.js CSS).
		$("body").toggleClass("pointer-tool", selected_tools.some((tool) => tool.id === TOOL_POINTER));
	};
	$c.update_selected_tool();

	if (is_extras) {
		$c.height(80);
	}

	return $c;
}

let dev_theme_tool_icons = false;
try {
	dev_theme_tool_icons = localStorage.dev_theme_tool_icons === "true";
} catch (_error) { /* ignore */ }
if (dev_theme_tool_icons) {
	let last_update_id = 0;
	$G.on("session-update", () => {
		last_update_id += 1;
		const this_update_id = last_update_id;
		main_canvas.toBlob((blob) => {
			// avoid a race condition particularly when loading the document initially when the default canvas size is large, giving a larger PNG
			if (this_update_id !== last_update_id) {
				return;
			}
			URL.revokeObjectURL(theme_dev_blob_url);
			theme_dev_blob_url = URL.createObjectURL(blob);
			$G.triggerHandler("theme-load");
		});
	});
}

$("<style>").text(`
	/* The toolbox grows to fit the page tools (the classic theme fixes .tools at 8 rows). */
	.tools-component {
		height: auto !important;
		padding-bottom: 3px;
	}
	.tools {
		height: auto !important;
	}
	.tool-divider {
		width: 100%;
		height: 2px;
		margin: 3px 0;
		border-top: 1px solid var(--ButtonShadow, #808080);
		border-bottom: 1px solid var(--ButtonHilight, #fff);
		box-sizing: border-box;
	}
	.tool-icon.custom-tool-icon,
	.tool-icon.custom-tool-icon.use-svg,
	.enlarge-ui .tool-icon.custom-tool-icon.use-svg {
		background-image: var(--custom-icon) !important;
		background-position: 0 0 !important;
		background-size: 16px 16px !important;
		background-repeat: no-repeat !important;
		-webkit-mask-image: none !important;
		mask-image: none !important;
	}
`).appendTo(document.head);

export { $ToolBox };

