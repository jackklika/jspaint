// @ts-check
/* global localize */
// The page tools: the second half of the toolbox. A Pointer for selecting, moving, and editing elements,
// Select Elements (a box over the page picks several elements: element-selection.js), one tool per kind of page
// element (text box, section, divider, GIF, image, table, guestbook, counter, last updated, folder view, contents),
// Link, which links the selected element or words, and Page Style (the page's colors and column). Element tools
// work like the Text tool: click, or drag out a box, where the element should go. See blocks.js for what an
// element is and block-kinds.js for the kinds. Kept to an even count: the toolbox is two columns.
// (Colored Box, Music, and raw HTML lost their tools on 2026-09-13 — Jack; the kinds stay for pages that have them,
// and Page › Insert › Raw HTML remains for the determined.)
import { add_block } from "./blocks.js";
import { link_tool } from "./element-link.js";
import { TOOL_SELECT_ELEMENTS } from "./element-selection.js";
import { $G, E } from "./helpers.js";
import { LINK_ICON_SVG } from "./icons.js";
import { show_page_properties_dialog } from "./page-properties.js";
import { toggle_gif_picker } from "./gif-picker.js";
import { show_pictures_window } from "./pictures.js";

const TOOL_POINTER = "TOOL_POINTER";
const TOOL_GIF_PICKER = "TOOL_GIF_PICKER";
const TOOL_IMAGE_UPLOAD = "TOOL_IMAGE_UPLOAD";
const TOOL_LINK = "TOOL_LINK";
const TOOL_PAGE_STYLE = "TOOL_PAGE_STYLE";

/** Element tools are `TOOL_BLOCK_<kind id>`. @param {string} kind_id */
const block_tool_id = (kind_id) => /** @type {ToolID} */ (`TOOL_BLOCK_${kind_id}`);

// 16×16 pixel-style icons (crisp edges, Win98 palette), one per tool, inlined so themes need no sprite changes.
const svg = (/** @type {string} */ body) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`;
/**
 * Rects for a little bitmap drawn as text rows ("#" = pixel).
 * @param {string[]} rows @param {number} x @param {number} y @param {string} color
 */
const pixel_rects = (rows, x, y, color) => rows.map((row, dy) => [...row].map((c, dx) => c === "#" ? `<rect x="${x + dx}" y="${y + dy}" width="1" height="1" fill="${color}"/>` : "").join("")).join("");
const ICONS = {
	pointer: svg('<path d="M3 1v11l3-3 2 5 2-1-2-5h4z" fill="#fff" stroke="#000" stroke-width="1"/>'),
	heading: svg('<rect x="2" y="2" width="3" height="12" fill="#000"/><rect x="10" y="2" width="3" height="12" fill="#000"/><rect x="5" y="7" width="5" height="2" fill="#000"/><rect x="14" y="10" width="1" height="4" fill="#000080"/><rect x="13" y="11" width="1" height="1" fill="#000080"/>'),
	section: svg('<rect x="0" y="1" width="1" height="14" fill="#000080"/><rect x="3" y="2" width="11" height="3" fill="#000"/><rect x="3" y="7" width="11" height="1" fill="#000"/><rect x="3" y="9" width="11" height="1" fill="#000"/><rect x="3" y="11" width="7" height="1" fill="#000"/><rect x="3" y="14" width="11" height="1" fill="#808080"/>'),
	folder: svg('<path d="M1.5 3.5h5l1 1.5h7v8h-13z" fill="#ffcc00" stroke="#000"/><rect x="1" y="6" width="14" height="1" fill="#000"/><rect x="3" y="8" width="7" height="1" fill="#000080"/><rect x="3" y="10" width="9" height="1" fill="#000080"/>'),
	paragraph: svg('<rect x="2" y="3" width="12" height="2" fill="#000"/><rect x="2" y="7" width="12" height="2" fill="#000"/><rect x="2" y="11" width="7" height="2" fill="#000"/>'),
	marquee: svg('<rect x="1" y="4" width="14" height="8" fill="#fff" stroke="#000"/><path d="M8 6v1H7v1h1v1H7v1h1v1H6v-1H5V9h1V8H5V7h1V6zM12 6v1h-1v1h1v1h-1v1h1v1h-2v-1H9V9h1V8H9V7h1V6z" fill="#000080"/>'),
	divider: svg('<rect x="1" y="6" width="14" height="1" fill="#808080"/><rect x="1" y="7" width="14" height="1" fill="#fff"/><rect x="1" y="9" width="14" height="1" fill="#808080"/><rect x="1" y="10" width="14" height="1" fill="#fff"/>'),
	gif: svg(`<rect x="0.5" y="2.5" width="15" height="11" fill="#fff" stroke="#000"/>${pixel_rects([
		".###..###.####..",
		"#..#...#..#.....",
		"#......#..#.....",
		"#.##...#..###...",
		"#..#...#..#.....",
		"#..#...#..#.....",
		".###..###.#.....",
	], 1, 4, "#000080")}`),
	image: svg('<rect x="1" y="4" width="14" height="10" fill="#fff" stroke="#000"/><path d="M2 12l3-4 2 2 2-3 4 5z" fill="#808080"/><rect x="7" y="1" width="2" height="6" fill="#000080"/><path d="M5 3h6L8 0z" fill="#000080"/>'),
	table: svg('<rect x="1" y="2" width="14" height="12" fill="#fff" stroke="#000"/><rect x="1" y="2" width="14" height="3" fill="#000080"/><rect x="5" y="2" width="1" height="12" fill="#000"/><rect x="10" y="2" width="1" height="12" fill="#000"/><rect x="1" y="9" width="14" height="1" fill="#000"/>'),
	box: svg('<rect x="1" y="2" width="14" height="12" fill="#ffffcc" stroke="#ff69b4" stroke-width="2"/><rect x="4" y="6" width="8" height="1" fill="#000"/><rect x="4" y="9" width="6" height="1" fill="#000"/>'),
	guestbook: svg('<path d="M1 3h6l1 1 1-1h6v10H9l-1 1-1-1H1z" fill="#fff" stroke="#000"/><rect x="8" y="3" width="1" height="10" fill="#808080"/><rect x="3" y="6" width="3" height="1" fill="#000080"/><rect x="3" y="8" width="3" height="1" fill="#000080"/><rect x="10" y="6" width="3" height="1" fill="#000080"/><rect x="10" y="8" width="2" height="1" fill="#000080"/>'),
	counter: svg('<rect x="1" y="4" width="14" height="8" fill="#000" stroke="#808080"/><rect x="3" y="6" width="2" height="4" fill="#00ff00"/><rect x="7" y="6" width="2" height="4" fill="#00ff00"/><rect x="11" y="6" width="2" height="4" fill="#00ff00"/>'),
	music: svg('<rect x="6" y="2" width="1" height="9" fill="#000"/><rect x="12" y="1" width="1" height="9" fill="#000"/><rect x="6" y="2" width="7" height="2" fill="#000"/><rect x="3" y="10" width="4" height="3" fill="#000"/><rect x="9" y="9" width="4" height="3" fill="#000"/>'),
	html: svg('<path d="M5 4v1H4v1H3v1H2v2h1v1h1v1h1v1H4v-1H3v-1H2V9H1V7h1V6h1V5h1V4zM11 4v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h1v-1h1v-1h1V9h1V7h-1V6h-1V5h-1V4z" fill="#000080"/><path d="M9 3h1L7 13H6z" fill="#000"/>'),
	// two chain links (the Font toolbar's link button wears the same glyph — icons.js)
	link: LINK_ICON_SVG,
	// a dashed box with an arrow in it: select elements
	select_elements: svg(`${pixel_rects([
		"#.#.#.#.#.#.#.#.",
		"................",
		"#..............#",
		"................",
		"#..............#",
		"................",
		"#..............#",
		"................",
		"#..............#",
		"................",
		"#..............#",
		"................",
		"#..............#",
		"................",
		"#.#.#.#.#.#.#.#.",
		"................",
	], 0, 0, "#000")}<path d="M5 3v9l2.5-2.5 1.5 3.5 1.5-.5-1.5-3.5H12z" fill="#fff" stroke="#000" stroke-width="1"/>`),
	// a page with a paint splash: page style
	page_style: svg('<path d="M3.5 1.5h7l3 3v10h-10z" fill="#fff" stroke="#000"/><path d="M10.5 1.5v3h3" fill="none" stroke="#000"/><rect x="5" y="7" width="6" height="5" fill="#ff69b4"/><rect x="7" y="6" width="2" height="1" fill="#ff69b4"/><rect x="4" y="9" width="1" height="2" fill="#ff69b4"/><rect x="11" y="8" width="1" height="2" fill="#ff69b4"/><rect x="6" y="12" width="2" height="1" fill="#ff69b4"/>'),
	// a clock: "last updated"
	updated: svg('<circle cx="8" cy="8" r="6.5" fill="#fff" stroke="#000"/><rect x="8" y="3" width="1" height="5" fill="#000"/><rect x="8" y="8" width="4" height="1" fill="#000080"/><rect x="7" y="7" width="2" height="2" fill="#000"/>'),
	// a contents list: a title line, then indented entries
	toc: svg('<rect x="2" y="2" width="12" height="2" fill="#000"/><rect x="4" y="6" width="2" height="1" fill="#000080"/><rect x="7" y="6" width="7" height="1" fill="#000"/><rect x="4" y="9" width="2" height="1" fill="#000080"/><rect x="7" y="9" width="5" height="1" fill="#000"/><rect x="4" y="12" width="2" height="1" fill="#000080"/><rect x="7" y="12" width="7" height="1" fill="#000"/>'),
};
/** @param {string} markup */
const data_url = (markup) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

/**
 * @param {string} kind_id
 * @param {keyof typeof ICONS} icon
 * @param {string} name
 * @param {string} description
 * @param {string[]} speech
 * @returns {Tool}
 */
function element_tool(kind_id, icon, name, description, speech) {
	return {
		id: block_tool_id(kind_id),
		name,
		speech_recognition: speech,
		help_icon: "",
		icon_svg: data_url(ICONS[icon]),
		description,
		cursor: ["precise", [16, 16], "crosshair"],
		page_tool: true,
		selectBox(rect_x, rect_y, rect_width, rect_height) {
			// A click (no real drag) places the element at its default size.
			const dragged = rect_width >= 8 && rect_height >= 8;
			add_block(kind_id, dragged ? { x: rect_x, y: rect_y, width: rect_width, height: rect_height } : { x: rect_x, y: rect_y });
		},
		$options: $(E("div")),
	};
}

/** @type {Tool[]} */
const page_tools = [
	{
		id: TOOL_POINTER,
		name: localize("Pointer"),
		speech_recognition: ["pointer", "arrow", "select element", "move element", "pointer tool", "arrow tool", "arrange", "arrange elements"],
		help_icon: "",
		icon_svg: data_url(ICONS.pointer),
		description: localize("Selects, moves, resizes, and edits the elements on the page (GIFs, text, headings…)."),
		cursor: ["default", [1, 1], "default"],
		page_tool: true,
		// Clicking bare canvas deselects (the layers handle that); dragging an element moves it (the element handles that).
		pointerdown() { },
		$options: $(E("div")),
	},
	{
		id: TOOL_SELECT_ELEMENTS,
		name: localize("Select Elements"),
		speech_recognition: ["select elements", "select several elements", "select multiple elements", "box select", "marquee select", "rubber band"],
		help_icon: "",
		icon_svg: data_url(ICONS.select_elements),
		description: localize("Selects the page elements inside a box you drag (Shift adds). Drag them to move together, arrow keys nudge, Delete removes, Ctrl+A selects every element."),
		cursor: ["precise", [16, 16], "crosshair"],
		page_tool: true,
		// tools.js gives select-box tools the drag rectangle; the pick itself happens in element-selection.js
		selectBox(rect_x, rect_y, rect_width, rect_height) {
			$G.triggerHandler("element-select-box", [rect_x, rect_y, rect_width, rect_height]);
		},
		$options: $(E("div")),
	},
	// (Headings are a paragraph with a bigger font; scrolling text is the Marquee toggle in the Font toolbar. Both
	// kinds still exist — Page › Insert — for pages that have them.)
	element_tool("paragraph", "paragraph", localize("Text Box"), localize("Places text on the page. Click or drag a box, then type; the Font toolbar sets font, size, bold, and scrolling (marquee)."), ["paragraph", "add paragraph", "add text block", "body text", "text box", "add text box", "heading", "add heading"]),
	element_tool("section", "section", localize("Section"), localize("Adds a section of writing. Sections stack in a column, grow with their text, and move with ↑/↓ or by dragging. Headings, lists, and links come from the Font toolbar."), ["section", "add section", "new section", "add a section", "paragraph section", "blog section", "post section"]),
	element_tool("divider", "divider", localize("Divider"), localize("Places a horizontal rule on the page."), ["divider", "horizontal rule", "add divider", "separator", "add line break"]),
	{
		id: TOOL_LINK,
		name: localize("Link"),
		speech_recognition: ["link", "add link", "make link", "link this", "link to page", "hyperlink"],
		help_icon: "",
		icon_svg: data_url(ICONS.link),
		description: localize("Links the selected picture, text, or element — or the selected words while editing — to a page of your site, a section, or an address."),
		cursor: ["default", [1, 1], "default"],
		page_tool: true,
		keep_focus: true, // the words being edited stay selected
		action() { link_tool(); },
		$options: $(E("div")),
	},
	{
		id: TOOL_GIF_PICKER,
		name: localize("GIF Picker"),
		speech_recognition: ["gif picker", "find gifs", "search gifs", "gifcities", "add gif", "add a gif", "animated gif"],
		help_icon: "",
		icon_svg: data_url(ICONS.gif),
		description: localize("GIFs: finds animated GIFs (GifCities) to put on the page. Click one, or drag it onto the page."),
		cursor: ["precise", [16, 16], "crosshair"],
		page_tool: true,
		action() { toggle_gif_picker(); },
		$options: $(E("div")),
	},
	{
		id: TOOL_IMAGE_UPLOAD,
		name: localize("Pictures"),
		speech_recognition: ["pictures", "picture", "photos", "photo", "image", "add image", "insert image", "upload image", "add picture", "insert picture", "image from file", "my pictures"],
		help_icon: "",
		icon_svg: data_url(ICONS.image),
		description: localize("Your site's pictures and photos: click one to put it on the page, or upload new ones. Big photos are shown at page size and open full-size."),
		cursor: ["precise", [16, 16], "crosshair"],
		page_tool: true,
		action() { show_pictures_window(); },
		$options: $(E("div")),
	},
	element_tool("table", "table", localize("Table"), localize("Places a table on the page. Click into a cell to type."), ["table", "add table", "insert table", "grid"]),
	element_tool("x-guestbook", "guestbook", localize("Guestbook"), localize("Places a guestbook visitors can sign. Entries are kept by your site."), ["guestbook", "guest book", "add guestbook", "sign my guestbook"]),
	element_tool("x-counter", "counter", localize("Visitor Counter"), localize("Places a visitor counter that counts up with each visit."), ["counter", "visitor counter", "hit counter", "add counter"]),
	element_tool("x-updated", "updated", localize("Last Updated"), localize("Places a \"last updated\" stamp that follows your saves."), ["last updated", "updated", "add last updated", "date stamp", "updated stamp"]),
	element_tool("x-folder", "folder", localize("Folder View"), localize("Lists the pages in a folder of your site (your posts, say), newest first. Double-click it to pick the folder."), ["folder", "folder view", "list of pages", "posts list", "add posts list", "blog index", "add folder view"]),
	element_tool("x-toc", "toc", localize("Contents"), localize("Lists the page's sections, each a link to it."), ["contents", "table of contents", "add contents", "section list", "toc"]),
	{
		id: TOOL_PAGE_STYLE,
		name: localize("Page Style"),
		speech_recognition: ["page style", "page properties", "page background", "background color", "page colors"],
		help_icon: "",
		icon_svg: data_url(ICONS.page_style),
		description: localize("The page's background color, wallpaper, and where the sections stack."),
		cursor: ["default", [1, 1], "default"],
		page_tool: true,
		action() { show_page_properties_dialog(); },
		$options: $(E("div")),
	},
];

export { TOOL_GIF_PICKER, TOOL_IMAGE_UPLOAD, TOOL_LINK, TOOL_PAGE_STYLE, TOOL_POINTER, TOOL_SELECT_ELEMENTS, block_tool_id, page_tools };
