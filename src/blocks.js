// @ts-check
/* global localize, $status_text, system_file_handle, main_canvas, show_font_box:writable */
/* global $canvas_area, current_history_node, main_ctx, magnification, selected_colors, text_tool_font, textbox */
// Blocks: page elements (headings, paragraphs, marquees, dividers, tables, <x-*> elements, raw HTML) that live
// on the canvas like stickers and text layers do — positioned, resizable, undoable — and that stay real HTML.
// The page IS the Paint document: the bitmap is the background, and every element floats over it
// (docs/DESIGN.md §3). Blocks are placed with the toolbox's element tools (page-tools.js), selected and
// moved with the Pointer tool, and text blocks edit in place (contenteditable) with the Font toolbar and
// the color box applying to the selected text. Serialized as `.collage > .block` elements (collage-format.js).
import { $FontBox } from "./$FontBox.js";
import { Handles } from "./Handles.js";
import { $DialogWindow } from "./$ToolWindow.js";
import { OnCanvasObject } from "./OnCanvasObject.js";
import { OnCanvasTextBox } from "./OnCanvasTextBox.js";
import { BLOCK_KINDS, block_kind_for, element_from_html, escape_html, get_block_kind, sanitize_html_fragment } from "./block-kinds.js";
import { get_tool_by_id, make_or_update_undoable, select_tool, undoable } from "./functions.js";
import { $G, E, get_help_folder_icon, get_icon_for_tool, get_rgba_from_color, make_canvas, make_css_cursor, to_canvas_coords } from "./helpers.js";
import { deselect_sticker } from "./stickers.js";
import { deselect_text_layer } from "./text-layers.js";
import { get_page_properties, set_page_properties } from "./page-properties.js";
import { site_public_url } from "./site-constants.js";
import { show_link_dialog } from "./link-dialog.js";
import { current_site, get_site_files_base } from "./site-publish.js";

/** @type {OnCanvasBlock[]} bottom to top */
let blocks = [];
/** @type {OnCanvasBlock | null} */
let selected_block = null;
/** @type {OnCanvasBlock | null} the block whose text is being edited in place */
let editing_block = null;
/** @type {HistoryNode | null} the history node collecting the current in-place edit's keystrokes */
let edit_history_node = null;
let next_block_id = 1;
/** @type {(block_id: string) => string | null} who (if anyone) is editing a block elsewhere — set by live-session.js */
let remote_editor_of = () => null;

/** Default text styling of a page, mirrored by the exported page's stylesheet (collage-format.js). */
const BLOCK_BASE_CSS = "margin:0;box-sizing:border-box;overflow:hidden;line-height:normal;display:block;font:16px 'Times New Roman',Times,serif;color:#000";

/** @param {string} kind_id */
function kind_icon(kind_id) {
	const tool = get_tool_by_id(/** @type {ToolID} */ (`TOOL_BLOCK_${kind_id}`)) || get_tool_by_id("TOOL_POINTER");
	return tool ? get_icon_for_tool(tool) : get_help_folder_icon("p_blank.png");
}

/**
 * The element's markup as it goes in the page: `<tag attrs class="block" style="left:…">inner</tag>`.
 * @param {BlockSnapshot} snapshot
 * @param {object} [options]
 * @param {boolean} [options.positioned=true] - include the class and position style
 * @param {boolean} [options.column=false] - a section inside the page's column: class only, no position
 */
function block_markup(snapshot, { positioned = true, column = false } = {}) {
	const attrs = Object.entries(snapshot.attrs)
		.filter(([name]) => !/^(class|style|contenteditable)$/i.test(name) && !/^on/i.test(name))
		.map(([name, value]) => value === "" ? ` ${name}` : ` ${name}="${escape_html(value)}"`).join("");
	// A section in the page's column has no position of its own: it stacks (collage-format.js).
	const position = column ? ` class="block section"` : positioned ? ` class="block" style="left:${snapshot.x}px;top:${snapshot.y}px;width:${snapshot.width}px;height:${snapshot.height}px"` : "";
	const void_tag = /^(hr|br|img|input)$/.test(snapshot.tag);
	return void_tag ? `<${snapshot.tag}${attrs}${position}>` : `<${snapshot.tag}${attrs}${position}>${snapshot.html}</${snapshot.tag}>`;
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blob_to_data_url(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => { resolve(/** @type {string} */(reader.result)); };
		reader.onerror = () => { reject(reader.error); };
		reader.readAsDataURL(blob);
	});
}

/**
 * Renders a block to a canvas the way text layers are rendered: as XHTML inside an SVG image.
 * Remote images can't load inside an SVG image (they're left out); blob: URLs are inlined first.
 * @param {BlockSnapshot} snapshot
 * @returns {Promise<HTMLCanvasElement>}
 */
async function render_block_to_canvas(snapshot) {
	const template = document.createElement("template");
	template.innerHTML = block_markup(snapshot, { positioned: false });
	const root = template.content.firstElementChild;
	const canvas = make_canvas(Math.max(1, snapshot.width), Math.max(1, snapshot.height));
	if (!root) { return canvas; }
	root.removeAttribute("contenteditable");
	root.setAttribute("style", `${BLOCK_BASE_CSS};width:${snapshot.width}px;height:${snapshot.height}px`);
	for (const img of root.querySelectorAll("img[src^='blob:']")) {
		try {
			const blob = await (await fetch(img.getAttribute("src"))).blob();
			img.setAttribute("src", await blob_to_data_url(blob));
		} catch (_error) {
			img.remove();
		}
	}
	// XMLSerializer gives XHTML (xmlns, self-closed void elements); HTML entities that XML lacks must go.
	const xhtml = new XMLSerializer().serializeToString(root).replace(/&nbsp;/g, "&#160;");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${snapshot.width}" height="${snapshot.height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			try {
				canvas.ctx.drawImage(img, 0, 0);
			} catch (_error) { /* leave it blank */ }
			resolve(canvas);
		};
		img.onerror = () => { resolve(canvas); }; // unrenderable markup: an empty raster rather than a failure
		img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	});
}

class OnCanvasBlock extends OnCanvasObject {
	/**
	 * @param {BlockSnapshot} snapshot
	 */
	constructor(snapshot) {
		super(snapshot.x, snapshot.y, snapshot.width, snapshot.height, false);
		this.id = snapshot.id;
		this.tag = snapshot.tag;
		this.attrs = { ...snapshot.attrs };
		this.html = snapshot.html;
		this.kind = block_kind_for(this.tag, this.attrs);
		/** @type {boolean} a section: laid out by reflow_sections in the page's column (x, y, width, height are derived) */
		this.flow = !!snapshot.flow;
		/** @type {HTMLCanvasElement} rasterized copy, for Flatten and exports */
		this.canvas = make_canvas(Math.max(1, this.width), Math.max(1, this.height));
		/** @type {Promise<void>} */
		this.raster_promise = Promise.resolve();
		this.editing = false;

		this.$el.addClass("block-layer").attr({ "data-kind": this.kind.id, "data-tag": this.tag }).toggleClass("x-element", this.tag.startsWith("x-")).toggleClass("flow", this.flow);
		// Blocks stack under stickers and text layers, whatever order they were added in.
		const $above = $canvas_area.children(".sticker, .text-layer").first();
		if ($above.length) { this.$el.insertBefore($above); }
		this.$content = $(E("div")).addClass("block-content").appendTo(this.$el);
		this.$content.css({ cursor: make_css_cursor("move", [8, 8], "move"), touchAction: "none" });
		/** @type {HTMLElement} the page element itself */
		this.el = /** @type {HTMLElement} */ (E("div"));
		this.render();

		this.handles = new Handles({
			$handles_container: this.$el,
			$object_container: $canvas_area,
			outset: 2,
			get_rect: () => ({ x: this.x, y: this.y, width: this.width, height: this.height }),
			set_rect: ({ x, y, width, height }) => {
				undoable({ name: `Resize ${this.kind.label}`, icon: kind_icon(this.kind.id), soft: true }, () => {
					this.x = x;
					this.y = y;
					this.width = Math.max(1, width);
					this.height = Math.max(1, height);
					this.position();
					this.refresh_raster();
				});
			},
			get_ghost_offset_left: () => parseFloat($canvas_area.css("padding-left")) + 1,
			get_ghost_offset_top: () => parseFloat($canvas_area.css("padding-top")) + 1,
		});
		this.handles.hide();

		let mox = 0, moy = 0;
		let moves_column = false; // decided when the drag starts: the first section drags the column, the others reorder
		const pointermove = (/** @type {JQuery.TriggeredEvent} */ e) => {
			make_or_update_undoable({
				// XXX: Localization hazard: logic based on English action names
				match: (history_node) => history_node.name === "Move Element",
				name: "Move Element",
				update_name: true,
				icon: kind_icon(this.kind.id),
				soft: true,
			}, () => {
				const m = to_canvas_coords(e);
				if (this.flow) {
					if (moves_column) {
						set_page_properties({ column_left: Math.max(0, Math.round(m.x - mox)), column_top: Math.max(0, Math.round(m.y - moy)) });
					} else {
						move_section_toward(this, m.y); // the others change their place in the column
					}
					return;
				}
				this.x = m.x - mox;
				this.y = m.y - moy;
				this.position();
			});
		};
		let last_pointerdown_time = 0;
		this.$content.on("pointerdown", (e) => {
			if (e.button !== 0) { return; }
			e.stopPropagation(); // the canvas area would deselect us
			if (this.editing) {
				return; // let the browser place the caret
			}
			e.preventDefault(); // (also suppresses the browser's dblclick event, hence the timing below)
			select_block(this);
			const now = performance.now();
			if (now - last_pointerdown_time < 400 && this.kind.editable) {
				last_pointerdown_time = 0;
				this.begin_edit(/** @type {PointerEvent} */ (e.originalEvent));
				return;
			}
			last_pointerdown_time = now;
			const m = to_canvas_coords(e);
			mox = m.x - this.x;
			moy = m.y - this.y;
			moves_column = this.flow && blocks.find((other) => other.flow) === this; // the first section is the column
			$G.on("pointermove", pointermove);
			$G.one("pointerup pointercancel", () => { $G.off("pointermove", pointermove); });
		});

		this.position();
	}
	position() {
		super.position(true);
		// The content is laid out at document size and scaled, so text renders identically at any zoom.
		this.$content.css({ transform: `scale(${magnification})`, transformOrigin: "left top", width: this.width, height: this.height });
		this.el.style.width = `${this.width}px`;
		this.el.style.height = this.flow ? "auto" : `${this.height}px`;
	}
	/** Rebuilds the page element from the model (tag, attributes, inner HTML) and refreshes the raster. */
	render() {
		const el = /** @type {HTMLElement} */ (E(this.tag));
		for (const [name, value] of Object.entries(this.attrs)) {
			if (/^(class|style|contenteditable)$/i.test(name) || /^on/i.test(name)) { continue; }
			el.setAttribute(name, value);
		}
		el.className = "block-el";
		el.innerHTML = sanitize_html_fragment(this.html);
		// Pictures inside the text (gifs/…) live on the site: show them from there (the model keeps the relative path).
		const base = get_site_files_base();
		if (base) {
			for (const img of el.querySelectorAll("img[src]")) {
				const src = img.getAttribute("src") || "";
				if (!/^(?:[a-z]+:|\/\/|\/)/i.test(src)) { img.setAttribute("src", base + src); }
			}
		}
		el.style.width = `${this.width}px`;
		el.style.height = this.flow ? "auto" : `${this.height}px`;
		if (this.flow && section_resize_observer) {
			section_resize_observer.unobserve(this.el);
			section_resize_observer.observe(el);
		}
		this.el.replaceWith(el);
		this.el = el;
		this.$content.append(el);
		this.$el.attr("title", this.tag.startsWith("x-") ? `<${this.tag}> — rendered by your site when published` : null);
		$G.triggerHandler("block-rendered", [this]); // (cards.js readies the cards in a section)
		this.refresh_raster();
		if (this.flow && blocks.includes(this)) { reflow_sections(); }
	}
	/** Re-rasterizes for Flatten and exports (async; `raster_promise` resolves when it's current). */
	refresh_raster() {
		const snapshot = this.snapshot();
		this.raster_promise = render_block_to_canvas(snapshot).then((canvas) => {
			if (this.html === snapshot.html && this.width === snapshot.width && this.height === snapshot.height) {
				this.canvas = canvas;
			}
		}, () => { /* keep the previous copy */ });
		return this.raster_promise;
	}
	/** @param {boolean} selected */
	set_selected(selected) {
		this.$el.toggleClass("selected", selected);
		if (selected) {
			if (!this.flow) { this.handles.show(); } // a section's size comes from the column and its text
		} else {
			this.handles.hide();
			if (this.editing) { this.end_edit(); }
		}
	}
	/**
	 * Starts editing the text in place.
	 * @param {PointerEvent} [event] - where the caret goes; without it, the whole text is selected
	 */
	begin_edit(event) {
		if (this.editing || !this.kind.editable) { return; }
		const remote_editor = remote_editor_of(this.id);
		if (remote_editor) {
			// Someone else has this text open in the live session: a soft lock, so two people don't type over each other.
			this.$el.addClass("remote-editing-flash");
			setTimeout(() => this.$el.removeClass("remote-editing-flash"), 600);
			$G.triggerHandler("status-message", `${remote_editor} is editing this right now.`);
			return;
		}
		if (editing_block && editing_block !== this) { editing_block.end_edit(); }
		this.editing = true;
		editing_block = this;
		edit_history_node = null;
		this.$el.addClass("editing");
		this.el.setAttribute("contenteditable", "true");
		// Enter makes a paragraph in a section (a <div> can hold <p>, <h2>, lists…); in a <p>/<h*> block the wrappers the
		// browser makes ("div" — "br" isn't a valid value in Chrome) become <br>s when the edit is recorded.
		try {
			document.execCommand("defaultParagraphSeparator", false, this.is_container() ? "p" : "div");
		} catch (_error) { /* not supported: normalize_block_lines covers it */ }
		this.el.addEventListener("keydown", this._on_keydown = (e) => {
			if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
				e.preventDefault();
				show_text_link_dialog();
			}
		});
		this.el.setAttribute("spellcheck", "false");
		/** @type {any} */ (this.el).stop?.(); // marquee: hold still while typing
		this.el.focus();
		const selection = document.getSelection();
		if (event && selection) {
			// @ts-ignore (caretRangeFromPoint is WebKit/Blink; caretPositionFromPoint is the standard)
			const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
			if (range && this.el.contains(range.startContainer)) {
				selection.removeAllRanges();
				selection.addRange(range);
			}
		} else if (selection) {
			const range = document.createRange();
			range.selectNodeContents(this.el);
			selection.removeAllRanges();
			selection.addRange(range);
		}
		this.el.addEventListener("input", this._on_input = () => { this.record_edit(); });
		editing_block = this;
		sync_font_from_selection(); // before the toolbar shows, so it opens on this text's font
		show_font_toolbar();
		$G.triggerHandler("block-editing-changed");
	}
	/** Whether the element can hold paragraphs, headings, and lists (a section, a table cell…) — a <p>/<h*> block can't. */
	is_container() {
		return this.flow || /^(div|td|th|blockquote|li|marquee)$/.test(this.tag);
	}
	/** Records the current in-place edit as (one coalesced) history step. */
	record_edit() {
		const html = this.is_container() ? normalize_container_html(this.el.innerHTML) : normalize_block_lines(this.el.innerHTML);
		if (html === this.html) { return; }
		make_or_update_undoable({
			match: (history_node) => history_node === edit_history_node,
			name: "Edit Text",
			icon: kind_icon(this.kind.id),
		}, () => {
			this.html = html;
		});
		edit_history_node = current_history_node;
		if (this.flow) { reflow_sections(); } // the text grew or shrank
	}
	end_edit() {
		if (!this.editing) { return; }
		if (this._on_keydown) { this.el.removeEventListener("keydown", this._on_keydown); }
		this.record_edit();
		if (this.flow && !this.attrs.id && edit_history_node) {
			// Its anchor, from what was written this first time (part of the same history step)
			make_or_update_undoable({ match: (history_node) => history_node === edit_history_node, name: "Edit Text", icon: kind_icon(this.kind.id) }, () => { ensure_section_id(this); });
		}
		this.editing = false;
		if (editing_block === this) { editing_block = null; }
		edit_history_node = null;
		this.$el.removeClass("editing");
		this.el.removeAttribute("contenteditable");
		this.el.removeAttribute("spellcheck");
		this.el.removeEventListener("input", this._on_input);
		/** @type {any} */ (this.el).start?.();
		if (document.activeElement === this.el) { this.el.blur(); }
		document.getSelection()?.removeAllRanges();
		if (!textbox) { OnCanvasTextBox.$fontbox?.hide(); }
		this.refresh_raster();
		$G.triggerHandler("block-editing-changed");
	}
	/** @returns {BlockSnapshot} */
	snapshot() {
		return { id: this.id, kind: this.kind.id, tag: this.tag, attrs: { ...this.attrs }, html: this.html, x: this.x, y: this.y, width: this.width, height: this.height, ...(this.flow ? { flow: true } : {}) };
	}
	/** @param {CanvasRenderingContext2D} ctx */
	draw(ctx) {
		ctx.drawImage(this.canvas, this.x, this.y, this.width, this.height);
	}
	destroy() {
		if (this.editing) { this.end_edit(); }
		section_resize_observer?.unobserve(this.el);
		if (selected_block === this) { selected_block = null; }
		this.handles.hide();
		super.destroy();
	}
}

// ---- the Font toolbar and color box apply to the text being edited ----

/** @type {Record<number, number>} <font size=1..7> in points, roughly */
const LEGACY_SIZE_PT = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 18, 6: 24, 7: 36 };
/** @type {{ family: string, size: number, bold: boolean, italic: boolean, underline: boolean, color: string } | null} */
let synced_font = null;
/** @type {Range | null} */
let saved_range = null;

/** @param {number} pt */
function legacy_size_for(pt) {
	let best = 3;
	for (const [legacy, size] of Object.entries(LEGACY_SIZE_PT)) {
		if (Math.abs(size - pt) < Math.abs(LEGACY_SIZE_PT[best] - pt)) { best = Number(legacy); }
	}
	return best;
}
/** @param {string} family - as queryCommandValue("fontName") reports it */
function quote_family(family) {
	const first = (family || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
	return first ? `"${first}"` : "";
}
/** @param {string | CanvasPattern} color */
function color_string(color) {
	return typeof color === "string" ? `rgba(${get_rgba_from_color(color).join(", ")})` : "";
}

function show_font_toolbar() {
	if (OnCanvasTextBox.$fontbox && OnCanvasTextBox.$fontbox.closed) {
		OnCanvasTextBox.$fontbox = null;
	}
	if (!OnCanvasTextBox.$fontbox) {
		const $fb = OnCanvasTextBox.$fontbox = $FontBox();
		$fb.on("close", (e) => {
			// Hide instead of closing, so View > Text Toolbar can bring it back (same as OnCanvasTextBox).
			e.preventDefault();
			$fb.hide();
			show_font_box = false;
		});
	}
	OnCanvasTextBox.$fontbox.toggle(show_font_box);
}

/** Reads the formatting at the caret into the Font toolbar (one direction: text → toolbar). */
function sync_font_from_selection() {
	const block = editing_block;
	const selection = document.getSelection();
	if (!block || !selection || !selection.anchorNode || !block.el.contains(selection.anchorNode)) { return; }
	saved_range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
	const family = quote_family(document.queryCommandValue("fontName"));
	const legacy = parseInt(document.queryCommandValue("fontSize"), 10);
	const state = {
		family: family || text_tool_font.family,
		size: LEGACY_SIZE_PT[legacy] || text_tool_font.size,
		bold: document.queryCommandState("bold"),
		italic: document.queryCommandState("italic"),
		underline: document.queryCommandState("underline"),
		color: color_string(selected_colors.foreground),
	};
	text_tool_font.family = state.family;
	text_tool_font.size = state.size;
	text_tool_font.bold = state.bold;
	text_tool_font.italic = state.italic;
	text_tool_font.underline = state.underline;
	synced_font = state;
	$G.triggerHandler("text-tool-font-changed");
}

/** Applies whatever changed in the Font toolbar or the color box to the selected text (toolbar → text). */
function apply_font_to_selection() {
	const block = editing_block;
	if (!block || !synced_font) { return; }
	const wanted = {
		family: text_tool_font.family,
		size: text_tool_font.size,
		bold: text_tool_font.bold,
		italic: text_tool_font.italic,
		underline: text_tool_font.underline,
		color: color_string(selected_colors.foreground),
	};
	const changed = Object.keys(wanted).filter((key) => wanted[key] !== synced_font[key]);
	if (changed.length === 0) { return; }
	const selection = document.getSelection();
	const selection_in_block = selection && selection.anchorNode && block.el.contains(selection.anchorNode);
	if (selection && !selection_in_block && saved_range && block.el.contains(saved_range.startContainer)) {
		// Clicking the toolbar took the selection away (or focus went to a button): put it back where it was.
		block.el.focus();
		selection.removeAllRanges();
		selection.addRange(saved_range);
	} else if (selection_in_block && document.activeElement !== block.el) {
		block.el.focus();
	}
	document.execCommand("styleWithCSS", false, "false"); // <font face color size>, <b>, <i>, <u>: real web-1.0 markup
	for (const key of changed) {
		// (The Font toolbar reports a null family until its font list has loaded, and an empty size mid-edit.)
		if (key === "family" && wanted.family) { document.execCommand("fontName", false, String(wanted.family).replace(/^"|"$/g, "")); }
		if (key === "size" && Number.isFinite(wanted.size) && wanted.size > 0) { document.execCommand("fontSize", false, String(legacy_size_for(wanted.size))); }
		if (key === "bold" || key === "italic" || key === "underline") { document.execCommand(key); }
		if (key === "color" && wanted.color) { document.execCommand("foreColor", false, wanted.color); }
	}
	synced_font = wanted;
	saved_range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : saved_range;
	block.record_edit();
}

// ---- anchors: a section's #name ----

/** A short lowercase name from text: "My trip to Ohio!" → "my-trip-to-ohio". @param {string} text */
function slugify(text) {
	const plain = text.toLowerCase().replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
	const words = plain.split(/\s+/).filter(Boolean);
	return words.slice(0, 6).join("-").slice(0, 40).replace(/-+$/, "") || "section";
}

/** @param {string} base @param {OnCanvasBlock | null} except */
function unique_block_id(base, except) {
	let id = base;
	let n = 2;
	while (blocks.some((other) => other !== except && other.attrs.id === id)) { id = `${base}-${n++}`; }
	return id;
}

/**
 * Gives a section its anchor — from its heading, else its first words — if it has none. Stable afterwards, so links
 * to it keep working when the title changes (Element Properties changes it on purpose).
 * @param {OnCanvasBlock} block
 * @returns {string} the id
 */
function ensure_section_id(block) {
	if (block.attrs.id) { return block.attrs.id; }
	const template = document.createElement("template");
	template.innerHTML = block.html;
	const heading = template.content.querySelector("h1, h2, h3, h4, h5, h6");
	block.attrs.id = unique_block_id(slugify((heading ? heading.textContent : template.content.textContent) || ""), block);
	block.el.setAttribute("id", block.attrs.id);
	return block.attrs.id;
}

/** Every section gets its anchor before the page is written out. */
function ensure_section_ids() {
	for (const block of blocks) {
		if (block.flow) { ensure_section_id(block); }
	}
}

/**
 * The link to a section: the page's address plus #anchor (just "#anchor" for a picture that isn't on a site yet).
 * @param {OnCanvasBlock} block
 */
function section_link(block) {
	const id = ensure_section_id(block);
	const page = system_file_handle && typeof system_file_handle === "object" && typeof system_file_handle.site_page === "string" ? system_file_handle.site_page : "";
	const site = current_site();
	return page && site ? `${site_public_url(site, page)}#${id}` : `#${id}`;
}

/** Page › Copy Link to Section: the selected section's link, on the clipboard. */
async function copy_section_link() {
	const block = selected_block;
	if (!block || !block.flow) { return false; }
	const link = section_link(block);
	try {
		await navigator.clipboard.writeText(link);
		$status_text.text(localize("Copied %1", link));
	} catch (_error) {
		$status_text.text(localize("Link to this section: %1", link)); // (no clipboard here: it's in the status bar to copy by hand)
	}
	return true;
}

// ---- links and styles while editing ----

/**
 * Runs an editing command with the selection back where it was (clicking a toolbar button or dialog takes it away),
 * then records the edit.
 * @param {OnCanvasBlock} block
 * @param {() => void} command
 * @param {Range | null} [range] - exactly this selection (a dialog's, from when it opened), not whatever focus left behind
 */
function with_selection_restored(block, command, range = null) {
	const selection = document.getSelection();
	const selection_in_block = selection && selection.anchorNode && block.el.contains(selection.anchorNode);
	if (selection && range && block.el.contains(range.startContainer)) {
		block.el.focus();
		selection.removeAllRanges();
		selection.addRange(range);
	} else if (selection && !selection_in_block && saved_range && block.el.contains(saved_range.startContainer)) {
		block.el.focus();
		selection.removeAllRanges();
		selection.addRange(saved_range);
	} else if (selection_in_block && document.activeElement !== block.el) {
		block.el.focus();
	}
	document.execCommand("styleWithCSS", false, "false");
	command();
	saved_range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : saved_range;
	block.record_edit();
	$G.triggerHandler("block-style-changed");
}

const BLOCK_STYLES = ["p", "h1", "h2", "h3", "blockquote", "pre"];

/** What the caret's line is: "p" (plain), "h1".."h3", "blockquote", or "pre". */
function current_block_style() {
	const value = String(document.queryCommandValue("formatBlock") || "").toLowerCase();
	return BLOCK_STYLES.includes(value) ? value : "p";
}

/** Font toolbar Style: makes the caret's line a heading, a quote, code, or plain again (sections and cells only). @param {string} style */
function apply_block_style(style) {
	const block = editing_block;
	if (!block || !block.is_container() || !BLOCK_STYLES.includes(style)) { return false; }
	with_selection_restored(block, () => { document.execCommand("formatBlock", false, `<${style}>`); });
	return true;
}

/** Font toolbar list buttons. @param {boolean} ordered */
function apply_list(ordered) {
	const block = editing_block;
	if (!block || !block.is_container()) { return false; }
	with_selection_restored(block, () => { document.execCommand(ordered ? "insertOrderedList" : "insertUnorderedList"); });
	return true;
}

/** Font toolbar rule button: a <hr> at the caret. */
function insert_rule() {
	const block = editing_block;
	if (!block || !block.is_container()) { return false; }
	with_selection_restored(block, () => { document.execCommand("insertHorizontalRule"); });
	return true;
}

/** Puts markup at the caret (a GIF from the picker, say). @param {string} html */
function insert_html_at_caret(html) {
	const block = editing_block;
	if (!block) { return false; }
	with_selection_restored(block, () => { document.execCommand("insertHTML", false, html); });
	return true;
}

/**
 * Puts a node at the caret (a picture, say), as a node: insertHTML would dress it in inline styles.
 * @param {Node} node
 */
function insert_node_at_caret(node) {
	const block = editing_block;
	if (!block) { return false; }
	with_selection_restored(block, () => {
		const selection = document.getSelection();
		if (!selection || !selection.rangeCount) { return; }
		const range = selection.getRangeAt(0);
		const last = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node.lastChild : node; // (a fragment empties itself into the range)
		range.deleteContents();
		range.insertNode(node);
		if (last) { range.setStartAfter(last); }
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
	});
	return true;
}

/** Whether the text being edited can take headings, lists, and pictures (see is_container). */
function is_editing_container() {
	return !!editing_block && editing_block.is_container();
}

/** The link around the caret, if any. @param {OnCanvasBlock} block */
function link_at_caret(block) {
	const selection = document.getSelection();
	const node = selection && selection.anchorNode && block.el.contains(selection.anchorNode) ? selection.anchorNode : saved_range?.startContainer;
	const el = node && node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node?.parentElement;
	const a = el?.closest("a");
	return a && block.el.contains(a) ? /** @type {HTMLAnchorElement} */ (a) : null;
}

/**
 * Ctrl+K / the Font toolbar's link button / the Link tool while editing: links the selected words — to a page of
 * your site, a section, or any address — through the link dialog (link-dialog.js).
 */
function show_text_link_dialog() {
	const block = editing_block;
	if (!block) { return; }
	const selection = document.getSelection();
	if (selection && selection.rangeCount && block.el.contains(selection.anchorNode)) { saved_range = selection.getRangeAt(0).cloneRange(); }
	const range = saved_range ? saved_range.cloneRange() : null; // the words to link, as they were when the dialog opened
	const existing = link_at_caret(block);
	// This page's other sections, for "#anchor" links
	const sections = blocks.filter((other) => other.flow && other !== block).map((other) => ({ id: ensure_section_id(other), text: other.el.textContent?.trim().slice(0, 40) || "" }));
	show_link_dialog({
		href: existing ? existing.getAttribute("href") || "" : "",
		prompt: range && !range.collapsed ? localize("Where should the selected words go?") : existing ? localize("Where should this link go?") : localize("Nothing is selected: the address itself goes in, as a link."),
		sections,
		apply: (href) => {
			with_selection_restored(block, () => {
				const current = document.getSelection();
				if (!href) {
					if (!existing) { return; }
					const whole_link = document.createRange();
					whole_link.selectNodeContents(existing);
					current?.removeAllRanges();
					current?.addRange(whole_link);
					document.execCommand("unlink");
				} else if (current && current.isCollapsed && !existing) {
					// Nothing selected: the address itself becomes the link text (a plain node — insertHTML would add inline styles)
					const a = document.createElement("a");
					a.setAttribute("href", href);
					a.textContent = href;
					const at = current.getRangeAt(0);
					at.insertNode(a);
					at.setStartAfter(a);
					at.collapse(true);
					current.removeAllRanges();
					current.addRange(at);
				} else if (existing && current && current.isCollapsed) {
					existing.setAttribute("href", href);
				} else {
					document.execCommand("createLink", false, href);
				}
			}, range);
		},
	});
}

// ---- model operations ----

/**
 * Places a new block of a kind, as an undoable step, selects it, and switches to the Pointer tool
 * (like Paste switches to Select). Text kinds start editing right away with their placeholder selected.
 * @param {string} kind_id
 * @param {{ x: number, y: number, width?: number, height?: number }} rect - canvas coordinates; width/height default to the kind's
 * @param {Partial<Pick<BlockSnapshot, "tag" | "attrs" | "html">> & { edit?: boolean }} [overrides] - `edit: false` places it without starting to edit
 * @returns {OnCanvasBlock}
 */
function add_block(kind_id, rect, overrides = {}) {
	const kind = get_block_kind(kind_id) || block_kind_for(kind_id, {});
	/** @type {OnCanvasBlock} */
	let block;
	if (kind.flow && !blocks.some((other) => other.flow)) {
		// The first section starts the column where you clicked (or dragged a box)
		const dragged = (rect.width || 0) >= 8 && (rect.height || 0) >= 8;
		set_page_properties({ column_left: Math.round(rect.x), column_top: Math.round(rect.y), ...(dragged ? { column_width: Math.round(/** @type {number} */ (rect.width)) } : {}) }, false);
	}
	undoable({ name: `Add ${kind.label}`, icon: kind_icon(kind.id) }, () => {
		block = new OnCanvasBlock({
			id: `b${next_block_id++}`,
			kind: kind.id,
			tag: overrides.tag || kind.tag,
			attrs: overrides.attrs || { ...kind.attrs },
			html: overrides.html ?? kind.html,
			x: rect.x,
			y: rect.y,
			width: Math.max(8, rect.width || kind.width),
			height: Math.max(8, rect.height || kind.height),
			...(kind.flow ? { flow: true } : {}),
		});
		blocks.push(block);
		if (block.flow) { reflow_sections(); } // it takes its place at the end of the column
		select_block(block);
	});
	select_tool(get_tool_by_id("TOOL_POINTER"));
	if (kind.editable && overrides.edit !== false) {
		block.begin_edit();
	}
	return block;
}

/** @returns {BlockSnapshot[]} */
function snapshot_blocks() {
	return blocks.map((block) => block.snapshot());
}

/**
 * Rebuilds the block layer from a history node's snapshot.
 * @param {BlockSnapshot[] | null | undefined} snapshots
 */
function restore_blocks(snapshots) {
	const selected_id = selected_block?.id;
	for (const block of blocks) {
		block.destroy();
	}
	blocks = (snapshots || []).map((snapshot) => new OnCanvasBlock(snapshot));
	for (const snapshot of snapshots || []) {
		next_block_id = Math.max(next_block_id, parseInt(snapshot.id.slice(1), 10) + 1 || next_block_id);
	}
	reflow_sections();
	select_block(blocks.find((block) => block.id === selected_id) || null);
	$G.triggerHandler("layers-changed");
}

function clear_blocks() {
	restore_blocks([]);
}

/** @param {OnCanvasBlock | null} block */
function select_block(block) {
	if (selected_block && selected_block !== block) {
		selected_block.set_selected(false);
	}
	selected_block = block;
	if (block) {
		deselect_sticker();
		deselect_text_layer();
		block.set_selected(true);
	}
	$G.triggerHandler("layers-changed");
}

function deselect_block() {
	select_block(null);
}

/** @returns {OnCanvasBlock | null} */
function get_selected_block() {
	return selected_block;
}

/** @returns {readonly OnCanvasBlock[]} */
function get_blocks() {
	return blocks;
}

/** @returns {boolean} whether a block's text is being edited in place */
function is_editing_block() {
	return !!editing_block;
}

/** Finishes in-place editing (the block stays selected). */
function end_block_editing() {
	editing_block?.end_edit();
}

/** Starts editing the selected block's text, if it has any. */
function edit_selected_block() {
	if (selected_block?.kind.editable) {
		selected_block.begin_edit();
		return true;
	}
	return false;
}

/**
 * @param {OnCanvasBlock} block
 */
function delete_block(block) {
	undoable({ name: `Delete ${block.kind.label}`, icon: get_help_folder_icon("p_delete.png") }, () => {
		blocks = blocks.filter((other) => other !== block);
		block.destroy();
	});
	$G.triggerHandler("layers-changed");
}

function delete_selected_block() {
	if (!selected_block) { return false; }
	delete_block(selected_block);
	return true;
}

/**
 * @param {number} dx
 * @param {number} dy
 */
function nudge_selected_block(dx, dy) {
	const block = selected_block;
	if (!block) { return false; }
	if (block.flow) {
		// A section has no free position: up/down move it in the column
		if (dy) { reorder_section(block, dy > 0 ? 1 : -1); }
		return true;
	}
	make_or_update_undoable({
		match: (history_node) => history_node.name === "Move Element",
		name: "Move Element",
		update_name: true,
		icon: kind_icon(block.kind.id),
		soft: true,
	}, () => {
		block.x += dx;
		block.y += dy;
		block.position();
	});
	return true;
}

/** Re-appends block elements so DOM order matches the model (bottom to top), under stickers and text. */
function apply_block_order() {
	const $above = $canvas_area.children(".sticker, .text-layer").first();
	for (const block of blocks) {
		if ($above.length) { block.$el.insertBefore($above); } else { block.$el.appendTo($canvas_area); }
	}
	reflow_sections();
	$G.triggerHandler("layers-changed");
}

/**
 * @param {OnCanvasBlock} block
 * @param {1 | -1} direction
 */
function reorder_block(block, direction) {
	const index = blocks.indexOf(block);
	const target = index + direction;
	if (index === -1 || target < 0 || target >= blocks.length) { return false; }
	undoable({ name: direction > 0 ? "Raise Element" : "Lower Element", icon: kind_icon(block.kind.id) }, () => {
		blocks.splice(index, 1);
		blocks.splice(target, 0, block);
		apply_block_order();
	});
	return true;
}

// ---- sections: the page's column ----
// A section (kind "section", or any block with `flow`) doesn't sit at an x, y of its own: sections stack in the
// page's column (Page Properties: left, top, width), each as tall as its text, in the order they appear among the
// blocks. Published as <div class="column"><div class="block section">…</div>…</div> (collage-format.js), so on the
// live page they're in normal flow — longer text on a reader's fonts pushes the next section down, never over it.
const SECTION_GAP = 16;

/** The column sections stack in: Page Properties, or defaults from the page width. */
function get_column_geometry() {
	const props = get_page_properties();
	return {
		left: props.column_left || 40,
		top: props.column_top || 40,
		width: props.column_width || Math.max(120, Math.min(main_canvas.width - 80, main_canvas.width - (props.column_left || 40) - 20)),
	};
}

/** Lays the sections out: column position and width, measured heights, one under the other. */
/** Sections re-stack when their contents change height (a picture loads, a toggle opens) — measured, so observed. */
const section_resize_observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
	if (reflow_scheduled) { return; }
	reflow_scheduled = true;
	requestAnimationFrame(() => { reflow_scheduled = false; reflow_sections(); });
}) : null;
let reflow_scheduled = false;

function reflow_sections() {
	const sections = blocks.filter((block) => block.flow);
	if (!sections.length) { return; }
	const column = get_column_geometry();
	let y = column.top;
	for (const block of sections) {
		block.x = column.left;
		block.width = column.width;
		block.el.style.width = `${column.width}px`;
		block.el.style.setProperty("--column-left", `${column.left}px`);
		block.el.style.setProperty("--page-width", `${main_canvas.width}px`);
		block.el.style.height = "auto";
		block.height = Math.max(24, block.el.offsetHeight || 0);
		block.y = y;
		block.position();
		y += block.height + SECTION_GAP;
	}
}

/**
 * Puts a section at another place in the column (0 = first).
 * @param {OnCanvasBlock} block
 * @param {number} target - index among the sections
 */
function place_section(block, target) {
	const others = blocks.filter((other) => other.flow && other !== block);
	const anchor = others[Math.max(0, Math.min(others.length, target))];
	blocks = blocks.filter((other) => other !== block);
	blocks.splice(anchor ? blocks.indexOf(anchor) : blocks.length, 0, block);
	apply_block_order();
}

/**
 * Moves a section up or down the column (↑/↓ with a section selected).
 * @param {OnCanvasBlock} block
 * @param {1 | -1} direction
 */
function reorder_section(block, direction) {
	const sections = blocks.filter((other) => other.flow);
	const index = sections.indexOf(block);
	const target = index + direction;
	if (index === -1 || target < 0 || target >= sections.length) { return false; }
	undoable({ name: direction > 0 ? "Move Section Down" : "Move Section Up", icon: kind_icon(block.kind.id) }, () => {
		place_section(block, target);
	});
	return true;
}

/**
 * Dragging a section: it goes where the pointer is among the other sections (one coalesced history step).
 * @param {OnCanvasBlock} block
 * @param {number} pointer_y - canvas coordinates
 */
function move_section_toward(block, pointer_y) {
	const sections = blocks.filter((other) => other.flow);
	const index = sections.indexOf(block);
	const target = sections.filter((other) => other !== block && other.y + other.height / 2 < pointer_y).length;
	if (index === -1 || target === index) { return; }
	place_section(block, target);
}

/**
 * Rasterizes one block into the bitmap and removes it.
 * @param {OnCanvasBlock} block
 */
async function flatten_block(block) {
	await block.raster_promise;
	if (!blocks.includes(block)) { return; }
	undoable({ name: `Flatten ${block.kind.label}`, icon: kind_icon(block.kind.id) }, () => {
		block.draw(main_ctx);
		blocks = blocks.filter((other) => other !== block);
		block.destroy();
	});
}

/** Rasterizes all blocks into the bitmap and removes them, as one undoable step. */
async function flatten_blocks() {
	if (blocks.length === 0) { return false; }
	await ensure_blocks_rendered();
	undoable({ name: "Flatten Elements", icon: kind_icon("raw") }, () => {
		draw_blocks(main_ctx);
		for (const block of blocks) {
			block.destroy();
		}
		blocks = [];
	});
	return true;
}

/**
 * Draws every block (rasterized copies), bottom to top.
 * @param {CanvasRenderingContext2D} ctx
 */
function draw_blocks(ctx) {
	for (const block of blocks) {
		block.draw(ctx);
	}
}

/** Resolves once every block's rasterized copy is current (exports call this first). */
function ensure_blocks_rendered() {
	return Promise.all(blocks.map((block) => block.raster_promise)).then(() => {});
}

/**
 * Replaces a block's markup (tag, attributes, inner HTML), keeping its place. Used by the HTML and
 * Properties dialogs.
 * @param {OnCanvasBlock} block
 * @param {{ tag?: string, attrs?: Record<string, string>, html?: string }} changes
 * @param {string} [name]
 */
function set_block_source(block, changes, name = "Edit Element") {
	block.end_edit();
	undoable({ name, icon: kind_icon(block.kind.id) }, () => {
		if (changes.tag) { block.tag = changes.tag.toLowerCase(); }
		if (changes.attrs) { block.attrs = { ...changes.attrs }; }
		if (changes.html !== undefined) { block.html = changes.html; }
		block.kind = block_kind_for(block.tag, block.attrs);
		block.$el.attr({ "data-kind": block.kind.id, "data-tag": block.tag }).toggleClass("x-element", block.tag.startsWith("x-"));
		block.render();
	});
	$G.triggerHandler("layers-changed");
}

/**
 * The link on a block, if its whole content is one link.
 * @param {OnCanvasBlock} block
 */
function get_block_link(block) {
	const template = document.createElement("template");
	template.innerHTML = block.html;
	const only = template.content.childElementCount === 1 && template.content.firstElementChild;
	const text_outside = [...template.content.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
	return only && only.tagName === "A" && !text_outside ? only.getAttribute("href") || "" : "";
}

/**
 * Links the selected block: the selected text while editing, otherwise the whole block. Empty removes.
 * @param {string} href
 */
function set_selected_block_link(href) {
	const block = selected_block;
	if (!block) { return false; }
	const selection = document.getSelection();
	if (block.editing && selection && !selection.isCollapsed && selection.anchorNode && block.el.contains(selection.anchorNode)) {
		document.execCommand("styleWithCSS", false, "false");
		if (href) {
			document.execCommand("createLink", false, href);
		} else {
			document.execCommand("unlink");
		}
		block.record_edit();
		return true;
	}
	const current = get_block_link(block);
	if (href === current) { return false; }
	let html = block.html;
	if (current) {
		const template = document.createElement("template");
		template.innerHTML = html;
		html = template.content.firstElementChild.innerHTML;
	}
	if (href) {
		html = `<a href="${escape_html(href)}">${html}</a>`;
	}
	set_block_source(block, { html }, href ? "Set Element Link" : "Remove Element Link");
	return true;
}

// ---- remote changes (live-session.js) ----

/**
 * Creates or updates a block from a snapshot (a remote editor's), in place; a block being edited here keeps
 * its text (the lock should prevent that case anyway).
 * @param {BlockSnapshot} snapshot
 */
function upsert_block_from_snapshot(snapshot) {
	let block = blocks.find((other) => other.id === snapshot.id);
	if (!block) {
		block = new OnCanvasBlock(snapshot);
		blocks.push(block);
		next_block_id = Math.max(next_block_id, parseInt(snapshot.id.slice(1), 10) + 1 || next_block_id);
	} else {
		block.x = snapshot.x;
		block.y = snapshot.y;
		block.width = Math.max(1, snapshot.width);
		block.height = Math.max(1, snapshot.height);
		block.flow = !!snapshot.flow;
		block.$el.toggleClass("flow", block.flow);
		block.position();
		const markup_changed = block.tag !== snapshot.tag || JSON.stringify(block.attrs) !== JSON.stringify(snapshot.attrs) || block.html !== snapshot.html;
		if (markup_changed && !block.editing) {
			block.tag = snapshot.tag;
			block.attrs = { ...snapshot.attrs };
			block.html = snapshot.html;
			block.kind = block_kind_for(block.tag, block.attrs);
			block.$el.attr({ "data-kind": block.kind.id, "data-tag": block.tag }).toggleClass("x-element", block.tag.startsWith("x-"));
			block.render();
		} else if (markup_changed) {
			block.refresh_raster();
		}
	}
	reflow_sections();
	$G.triggerHandler("layers-changed");
	return block;
}

/** @param {string} id */
function remove_block_by_id(id) {
	const block = blocks.find((other) => other.id === id);
	if (!block) { return false; }
	blocks = blocks.filter((other) => other !== block);
	block.destroy();
	reflow_sections();
	$G.triggerHandler("layers-changed");
	return true;
}

/** @param {string[]} ids */
function order_blocks(ids) {
	const by_id = new Map(blocks.map((block) => [block.id, block]));
	const ordered = ids.map((id) => by_id.get(id)).filter(Boolean);
	for (const block of blocks) {
		if (!ordered.includes(block)) { ordered.push(block); }
	}
	blocks = ordered;
	apply_block_order();
}

/**
 * Lets the live session say who is editing a block elsewhere (its text is then locked here), and mark it.
 * @param {(block_id: string) => string | null} lookup
 */
function set_remote_editor_lookup(lookup) {
	remote_editor_of = lookup;
	for (const block of blocks) {
		const who = lookup(block.id);
		block.$el.toggleClass("remote-editing", !!who).attr("data-remote-editor", who || null);
	}
}

/** The block being edited in place here, if any. */
function get_editing_block() {
	return editing_block;
}

/** Whether the text being edited in place scrolls (is a <marquee>). */
function is_editing_block_marquee() {
	return !!editing_block && editing_block.tag === "marquee";
}

/**
 * The Font toolbar's Marquee toggle: turns the text block being edited into scrolling text (a <marquee>), or
 * back into what it was. Editing continues afterwards.
 */
function toggle_editing_block_marquee() {
	const block = editing_block;
	if (!block) { return false; }
	const attrs = { ...block.attrs };
	let tag;
	if (block.tag === "marquee") {
		tag = /^(h[1-6]|p|div)$/.test(attrs["data-was"] || "") ? attrs["data-was"] : "p";
		for (const name of ["data-was", "behavior", "direction", "scrollamount", "scrolldelay", "loop", "truespeed"]) { delete attrs[name]; }
	} else {
		tag = "marquee";
		attrs["data-was"] = block.tag;
		attrs.behavior = attrs.behavior || "scroll";
		attrs.scrollamount = attrs.scrollamount || "4";
		delete attrs["data-kind"];
	}
	set_block_source(block, { tag, attrs }, tag === "marquee" ? "Marquee On" : "Marquee Off");
	block.begin_edit();
	$G.triggerHandler("block-editing-changed");
	return true;
}

// ---- dialogs ----

/** Page > Edit Element HTML…: the element's markup, editable as text. */
function show_block_html_dialog(block = selected_block) {
	if (!block) { return; }
	block.end_edit();
	const $w = $DialogWindow("Edit Element HTML");
	$w.addClass("block-html-window squish");
	$(E("p")).text("The element as it goes in the page (position and size stay as they are):").appendTo($w.$main);
	const $text = $(E("textarea")).addClass("inset-deep block-html-editor").attr({ spellcheck: "false" }).val(block_markup(block.snapshot(), { positioned: false })).appendTo($w.$main);
	const $error = $(E("div")).addClass("block-html-error").appendTo($w.$main);
	$w.$Button("OK", () => {
		const el = element_from_html(String($text.val()));
		if (!el) {
			$error.text("That isn't an element. Start with a tag, like <p> or <marquee>.");
			return;
		}
		/** @type {Record<string, string>} */
		const attrs = {};
		for (const attr of el.attributes) {
			if (!/^(class|style|contenteditable)$/i.test(attr.name)) { attrs[attr.name.toLowerCase()] = attr.value; }
		}
		set_block_source(block, { tag: el.tagName.toLowerCase(), attrs, html: el.innerHTML }, "Edit Element HTML");
		$w.close();
	}, { type: "submit" });
	$w.$Button("Cancel", () => { $w.close(); });
	$w.$content.css({ width: "min(560px, 92vw)" });
	$w.center();
	$text.focus();
}

/** Page > Element Properties…: the attributes that matter for this kind of element. */
function show_block_properties_dialog(block = selected_block) {
	if (!block) { return; }
	block.end_edit();
	const kind = block.kind;
	const $w = $DialogWindow(`${kind.label} Properties`);
	$w.addClass("block-properties-window squish");
	/** @type {{ attr: string, get: () => string }[]} */
	const fields = [];
	const $rows = $(E("div")).addClass("block-properties-rows").appendTo($w.$main);
	if (kind.id === "heading") {
		const $row = $(E("label")).addClass("block-properties-row").text("Level: ").appendTo($rows);
		const $level = $(E("select")).appendTo($row);
		for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
			$(E("option")).val(level).text(level.toUpperCase()).appendTo($level);
		}
		$level.val(block.tag);
		fields.push({ attr: "__tag", get: () => String($level.val()) });
	}
	for (const prop of kind.props) {
		const $row = $(E("label")).addClass("block-properties-row").text(`${prop.label}: `).appendTo($rows);
		const value = block.attrs[prop.attr] ?? "";
		/** @type {JQuery<HTMLInputElement | HTMLSelectElement>} */
		let $input;
		if (prop.type === "select") {
			$input = $(E("select")).appendTo($row);
			for (const option of prop.options || []) {
				$(E("option")).val(option).text(option === "" ? "(default)" : option).appendTo($input);
			}
			$input.val(value);
		} else if (prop.type === "color") {
			$input = $(E("input")).attr({ type: "text", placeholder: "#ff69b4 or a color name", spellcheck: "false" }).val(value).appendTo($row);
		} else {
			$input = $(E("input")).attr({ type: prop.type === "number" ? "number" : "text", spellcheck: "false" }).val(value).appendTo($row);
		}
		fields.push({ attr: prop.attr, get: () => String($input.val()).trim() });
	}
	if (fields.length === 0) {
		$(E("p")).text("This element has no settings. Use Edit Element HTML… to change its markup.").appendTo($rows);
	}
	$w.$Button("OK", () => {
		const attrs = { ...block.attrs };
		let tag = block.tag;
		for (const field of fields) {
			const value = field.get();
			if (field.attr === "__tag") {
				tag = value;
			} else if (value === "") {
				delete attrs[field.attr];
			} else {
				attrs[field.attr] = value;
			}
		}
		set_block_source(block, { tag, attrs }, `${kind.label} Properties`);
		$w.close();
	}, { type: "submit" });
	$w.$Button("Cancel", () => { $w.close(); });
	$w.$content.css({ width: "min(420px, 92vw)" });
	$w.center();
	$rows.find("input, select").first().trigger("focus");
}

/** Call once the canvas area exists (app.js). */
/**
 * Line breaks as <br>, never <div> or <p>: contenteditable wraps new lines in <div>s (or <p>s), which are not
 * allowed inside <p>/<h1>… — a browser parsing the published page closes the block early and the rest of the text
 * falls out of it. Top-level wrappers become <br>-separated lines (an all-<br> wrapper is an empty line).
 * @param {string} html
 */
function normalize_block_lines(html) {
	if (!/<(?:div|p)[\s>]/i.test(html)) { return html; }
	const template = document.createElement("template");
	template.innerHTML = html;
	const out = document.createElement("div");
	const flatten = (/** @type {ParentNode} */ parent) => {
		for (const node of [...parent.childNodes]) {
			if (node.nodeType === Node.ELEMENT_NODE && /^(DIV|P)$/.test(/** @type {Element} */ (node).tagName)) {
				const only_br = node.childNodes.length === 1 && node.firstChild?.nodeName === "BR";
				if (out.childNodes.length > 0) { out.appendChild(document.createElement("br")); }
				if (!only_br) { flatten(/** @type {Element} */ (node)); }
			} else {
				out.appendChild(node);
			}
		}
	};
	flatten(template.content);
	return out.innerHTML;
}

/**
 * Inside a section, a list or a heading can't live in a paragraph (the browser editing commands sometimes leave
 * <p><ul>…</ul></p>, which a parser would split into an empty paragraph and the list). Unwrap those paragraphs.
 * @param {string} html
 */
function normalize_container_html(html) {
	if (!/<p[\s>]|contenteditable|<details/i.test(html)) { return html; }
	const template = document.createElement("template");
	template.innerHTML = html;
	// Editing-time attributes (cards are atomic, their text regions typable, toggles open) stay out of the model
	for (const el of template.content.querySelectorAll("[contenteditable]")) { el.removeAttribute("contenteditable"); }
	for (const el of template.content.querySelectorAll("details[data-card][open]")) { el.removeAttribute("open"); }
	for (const p of [...template.content.querySelectorAll("p")]) {
		if (p.querySelector("ul, ol, h1, h2, h3, h4, h5, h6, pre, blockquote, div, hr, table, p, figure, details")) {
			p.replaceWith(...p.childNodes);
		} else if (!p.childNodes.length) {
			p.remove(); // an empty <p></p> the editing commands left behind shows as nothing anyway
		}
	}
	return template.innerHTML;
}

function init_blocks() {
	$G.on("page-properties-changed resize", () => { reflow_sections(); });
	document.addEventListener("selectionchange", () => {
		if (editing_block) { $G.triggerHandler("block-style-changed"); }
	});
	// (Enter inside a <p>/<h*> block: see begin_edit and normalize_block_lines.)
	// Clicking anywhere that isn't a block deselects it (and ends in-place editing). Capture phase, so it runs
	// before the tools do: an element a tool creates on this very click (e.g. the Text tool finishing a web text
	// layer) stays selected.
	$canvas_area[0].addEventListener("pointerdown", (e) => {
		if (!$(e.target).closest(".block-layer").length) {
			deselect_block();
		}
	}, { capture: true });
	document.addEventListener("selectionchange", () => {
		if (editing_block) { sync_font_from_selection(); }
	});
	$G.on("option-changed", () => {
		if (editing_block) { apply_font_to_selection(); }
	});
	$("<style>").text(`
		/* Elements are click-through while painting, except the selected one; the Pointer tool makes them all live. */
		.sticker, .text-layer, .block-layer {
			pointer-events: none;
		}
		.sticker.selected, .text-layer.selected, .block-layer.selected,
		body.pointer-tool .sticker, body.pointer-tool .text-layer, body.pointer-tool .block-layer {
			pointer-events: auto;
		}
		.block-layer {
			z-index: 3;
			display: block !important;
			box-sizing: border-box;
		}
		.block-content {
			position: absolute;
			left: 0;
			top: 0;
			overflow: hidden;
		}
		.block-content > .block-el {
			${BLOCK_BASE_CSS.replace(/;/g, " !important;")} !important;
			user-select: none;
			-webkit-user-select: none;
		}
		.block-content > hr.block-el {
			height: auto !important;
		}
		.block-layer.editing .block-content > .block-el {
			user-select: text;
			-webkit-user-select: text;
			outline: none;
			cursor: text;
		}
		.block-layer.selected {
			outline: 1px dashed #000;
		}
		.block-layer.editing {
			outline: 1px solid #000080;
		}
		.block-layer.x-element .block-content > .block-el {
			outline: 1px dotted #000080;
			outline-offset: -1px;
		}
		.block-layer.remote-editing {
			outline: 2px solid #ff69b4;
		}
		.block-layer.remote-editing::before {
			content: attr(data-remote-editor) " is editing";
			position: absolute;
			left: 0;
			top: -14px;
			font: 9px sans-serif;
			line-height: 12px;
			padding: 0 4px;
			background: #ff69b4;
			color: #fff;
			white-space: nowrap;
			pointer-events: none;
		}
		.block-layer.remote-editing-flash {
			outline: 2px solid #ff0000;
		}
		.block-layer.x-element::after {
			content: attr(data-tag);
			position: absolute;
			right: 0;
			top: 0;
			font: 9px monospace;
			line-height: 11px;
			padding: 0 3px;
			background: #000080;
			color: #fff;
			pointer-events: none;
			opacity: 0.85;
		}
		.block-html-editor {
			display: block;
			width: 100%;
			height: 220px;
			box-sizing: border-box;
			font: 12px "Courier New", monospace;
			white-space: pre-wrap;
			resize: vertical;
		}
		.block-html-error {
			color: #a00000;
			min-height: 1.2em;
			margin-top: 4px;
		}
		.block-properties-row {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-bottom: 6px;
		}
		.block-properties-row input, .block-properties-row select {
			flex: 1;
			min-width: 0;
		}
	`).appendTo(document.head);
}

export {
	BLOCK_KINDS,
	OnCanvasBlock,
	add_block,
	apply_block_style,
	apply_list,
	block_markup,
	clear_blocks,
	copy_section_link,
	current_block_style,
	delete_block,
	delete_selected_block,
	deselect_block,
	draw_blocks,
	edit_selected_block,
	end_block_editing,
	ensure_blocks_rendered,
	ensure_section_ids,
	flatten_block,
	flatten_blocks,
	get_block_link,
	get_blocks,
	get_column_geometry,
	get_editing_block,
	insert_html_at_caret,
	insert_node_at_caret,
	insert_rule,
	get_selected_block,
	init_blocks,
	is_editing_block,
	is_editing_block_marquee,
	is_editing_container,
	legacy_size_for,
	nudge_selected_block,
	order_blocks,
	remove_block_by_id,
	render_block_to_canvas,
	reflow_sections,
	reorder_block,
	reorder_section,
	restore_blocks,
	section_link,
	select_block,
	set_block_source,
	set_remote_editor_lookup,
	set_selected_block_link,
	show_block_html_dialog,
	show_block_properties_dialog,
	show_text_link_dialog,
	snapshot_blocks,
	toggle_editing_block_marquee,
	upsert_block_from_snapshot
};
