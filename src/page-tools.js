// @ts-check
/* global localize, systemHooks */
// The page tools: the second half of the toolbox. A Pointer for selecting, moving, and editing elements,
// and one tool per kind of page element (heading, paragraph, marquee, divider, GIF, image, table, box,
// guestbook, counter, music, raw HTML). Element tools work like the Text tool: click, or drag out a box,
// where the element should go. See blocks.js for what an element is and block-kinds.js for the kinds.
import { add_block } from "./blocks.js";
import { image_formats } from "./file-format-data.js";
import { show_error_message } from "./functions.js";
import { E } from "./helpers.js";
import { toggle_gif_picker } from "./gif-picker.js";
import { add_sticker_from_blob } from "./stickers.js";

const TOOL_POINTER = "TOOL_POINTER";
const TOOL_GIF_PICKER = "TOOL_GIF_PICKER";
const TOOL_IMAGE_UPLOAD = "TOOL_IMAGE_UPLOAD";

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
	// (Headings are a paragraph with a bigger font; scrolling text is the Marquee toggle in the Font toolbar. Both
	// kinds still exist — Page › Insert — for pages that have them.)
	element_tool("paragraph", "paragraph", localize("Text Box"), localize("Places text on the page. Click or drag a box, then type; the Font toolbar sets font, size, bold, and scrolling (marquee)."), ["paragraph", "add paragraph", "add text block", "body text", "text box", "add text box", "heading", "add heading"]),
	element_tool("section", "section", localize("Section"), localize("Adds a section of writing. Sections stack in a column, grow with their text, and move with ↑/↓ or by dragging. Headings, lists, and links come from the Font toolbar."), ["section", "add section", "new section", "add a section", "paragraph section", "blog section", "post section"]),
	element_tool("divider", "divider", localize("Divider"), localize("Places a horizontal rule on the page."), ["divider", "horizontal rule", "add divider", "separator", "add line break"]),
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
		name: localize("Image"),
		speech_recognition: ["image", "add image", "insert image", "upload image", "add picture", "insert picture", "image from file"],
		help_icon: "",
		icon_svg: data_url(ICONS.image),
		description: localize("Puts an image file (GIF, PNG, JPEG) on the page as an element you can move and link."),
		cursor: ["precise", [16, 16], "crosshair"],
		page_tool: true,
		async action() {
			const { file } = await systemHooks.showOpenFileDialog({ formats: image_formats });
			if (!file) { return; }
			try {
				await add_sticker_from_blob(file);
			} catch (error) {
				show_error_message(localize("Paint cannot read this file."), error);
			}
		},
		$options: $(E("div")),
	},
	element_tool("table", "table", localize("Table"), localize("Places a table on the page. Click into a cell to type."), ["table", "add table", "insert table", "grid"]),
	element_tool("box", "box", localize("Colored Box"), localize("Places a colored box with a border you can type in."), ["box", "colored box", "add box", "text box with border", "panel"]),
	element_tool("x-guestbook", "guestbook", localize("Guestbook"), localize("Places a guestbook visitors can sign. Entries are kept by your site."), ["guestbook", "guest book", "add guestbook", "sign my guestbook"]),
	element_tool("x-counter", "counter", localize("Visitor Counter"), localize("Places a visitor counter that counts up on the published page."), ["counter", "visitor counter", "hit counter", "add counter"]),
	element_tool("x-music", "music", localize("Music"), localize("Places background music with a play button on the published page."), ["music", "add music", "background music", "add song", "midi"]),
	element_tool("x-folder", "folder", localize("Folder View"), localize("Lists the pages in a folder of your site (your posts, say) on the published page, newest first."), ["folder", "folder view", "list of pages", "posts list", "add posts list", "blog index", "add folder view"]),
	element_tool("raw", "html", localize("HTML"), localize("Places a box of raw HTML on the page. Anything goes (except scripts)."), ["html", "raw html", "add html", "custom html", "code"]),
];

export { TOOL_GIF_PICKER, TOOL_IMAGE_UPLOAD, TOOL_POINTER, block_tool_id, page_tools };
