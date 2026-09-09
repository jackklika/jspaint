// @ts-check
// The Page Editor window: a page from the site, shown as its stack of blocks in an 800px column.
// Text blocks edit in place with a <font>-toolbar (execCommand, on purpose: it writes real web-1.0 markup),
// images come from the GIFs window or uploads, collages round-trip through Paint, <x-*> elements come from
// the registry, and Save writes the page back through the API as the HTML dialect.
import { list_files, list_x_elements, load_settings, public_url, read_file, upload_asset, write_file } from "./api.js";
import { blank_page_html, block_kind, escape_html, parse_page, rewrite_urls, sanitize_tree, serialize_page } from "./dialect.js";
import { ensure_signed_in, show_window } from "./desktop.js";
import { GIF_DRAG_TYPE, open_gif_window } from "./gif-window.js";
import { edit_collage_in_paint } from "./paint-window.js";

const CLASSIC_FONTS = ["Arial", "Comic Sans MS", "Courier New", "Georgia", "Impact", "Times New Roman", "Trebuchet MS", "Verdana"];
const TEXT_KINDS = new Set(["heading", "paragraph", "marquee", "list", "table"]);

/** @type {{ path: string, model: import("./dialect.js").PageModel, dirty: boolean } | null} */
let current = null;
/** @type {OSGUI$Window | null} */
let $editor = null;
/** @type {JQuery<HTMLElement>} */
let $canvas;
/** @type {JQuery<HTMLElement>} */
let $status;
/** @type {JQuery<HTMLSelectElement>} */
let $pages;
/** @type {Element | null} the selected block's element (the model element, not the wrapper) */
let selected = null;
/** @type {{ tag: string, attrs: string[], editor: { label: string, description: string, fallback: string } }[]} */
let registry = [];

/**
 * Site files are shown in the editor through the editor's own API (same origin, reads are public, and it's
 * the very R2 the editor just wrote to), not the sites Worker. Pages are saved with site-relative URLs.
 */
const display_base = () => `${load_settings().editor_url}/api/sites/${encodeURIComponent(load_settings().site)}/files/`;

/** @param {string} text */
function set_status(text) {
	$status?.text(text);
}

function mark_dirty() {
	if (current && !current.dirty) {
		current.dirty = true;
		$editor?.title(`${current.path} * — Page Editor`);
	}
}

// ---- rendering blocks ----

/**
 * @param {Element} el
 * @returns {HTMLElement} the wrapper
 */
function render_block(el) {
	const kind = block_kind(el);
	const wrapper = document.createElement("div");
	wrapper.className = `block block-${kind}`;
	wrapper.append(Object.assign(document.createElement("span"), { className: "block-kind", textContent: kind === "x" ? el.tagName.toLowerCase() : kind }));
	if (TEXT_KINDS.has(kind)) {
		el.setAttribute("contenteditable", "true");
		el.addEventListener("input", mark_dirty);
		el.addEventListener("focus", () => { select_block(el); if (el.tagName === "MARQUEE") { /** @type {any} */ (el).stop?.(); } });
		el.addEventListener("blur", () => { if (el.tagName === "MARQUEE") { /** @type {any} */ (el).start?.(); } });
	}
	wrapper.append(el);
	const tools = document.createElement("span");
	tools.className = "block-tools";
	/** @type {[string, string, () => void][]} */
	const buttons = [
		["▲", "Move up", () => move_block(el, -1)],
		["▼", "Move down", () => move_block(el, 1)],
	];
	if (kind === "collage") { buttons.push(["✎ Paint", "Edit in Paint", () => edit_collage_block(el)]); }
	if (kind === "image") { buttons.push(["🔗", "Link…", () => link_image_block(el)]); }
	if (kind === "x") { buttons.push(["✎", "Settings…", () => edit_x_block(el)]); }
	if (kind === "raw" || kind === "table" || kind === "list") { buttons.push(["</>", "Edit HTML…", () => edit_raw_block(el)]); }
	buttons.push(["✕", "Delete", () => delete_block(el)]);
	for (const [label, title, action] of buttons) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.title = title;
		button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection/focus
		button.addEventListener("click", (e) => { e.stopPropagation(); action(); });
		tools.append(button);
	}
	wrapper.append(tools);
	wrapper.addEventListener("click", () => select_block(el));
	return wrapper;
}

function render_all() {
	if (!current) { return; }
	$canvas.empty();
	$canvas.css({ background: current.model.bgcolor || "#fff", color: current.model.text_color || "", backgroundImage: current.model.background ? `url("${display_base()}${current.model.background}")` : "" });
	for (const el of current.model.blocks) {
		$canvas.append(render_block(el));
	}
	if (current.model.blocks.length === 0) {
		$canvas.append($("<div>").css({ padding: 40, opacity: 0.6, fontFamily: "Arial" }).text("Empty page. Add a block from the toolbar above."));
	}
}

/** @param {Element | null} el */
function select_block(el) {
	selected = el;
	$canvas.find("> .block").each((_, wrapper) => {
		wrapper.classList.toggle("selected", !!el && wrapper.contains(el));
	});
	update_format_toolbar();
}

/** @param {Element} el @param {-1 | 1} direction */
function move_block(el, direction) {
	if (!current) { return; }
	const blocks = current.model.blocks;
	const index = blocks.indexOf(el);
	const target = index + direction;
	if (index === -1 || target < 0 || target >= blocks.length) { return; }
	blocks.splice(index, 1);
	blocks.splice(target, 0, el);
	mark_dirty();
	render_all();
	select_block(el);
}

/** @param {Element} el */
function delete_block(el) {
	if (!current) { return; }
	current.model.blocks = current.model.blocks.filter((other) => other !== el);
	mark_dirty();
	render_all();
	select_block(null);
}

/**
 * Inserts a block after the selected one (or at the end) and selects it.
 * @param {Element} el
 */
function insert_block(el) {
	if (!current) { return; }
	sanitize_tree(el);
	const blocks = current.model.blocks;
	const index = selected ? blocks.indexOf(selected) + 1 : blocks.length;
	blocks.splice(index || blocks.length, 0, el);
	mark_dirty();
	render_all();
	select_block(el);
	el.scrollIntoView({ block: "nearest" });
	if (TEXT_KINDS.has(block_kind(el)) && el instanceof HTMLElement) {
		el.focus();
	}
}

/**
 * A copy of an element that won't load anything: <template> content is inert, so rewriting an <img>'s src
 * there doesn't trigger a fetch (setting src on a detached <img> in the document would).
 * @param {Element} el
 */
function inert_clone(el) {
	const template = document.createElement("template");
	template.innerHTML = el.outerHTML;
	return /** @type {Element} */ (template.content.firstElementChild);
}

/** @param {string} html - one element */
function element_from_html(html) {
	const template = document.createElement("template");
	template.innerHTML = html.trim();
	return template.content.firstElementChild;
}

// ---- block kinds ----

function add_heading() { insert_block(element_from_html('<h2><font face="Comic Sans MS" color="#0000aa">New heading</font></h2>')); }
function add_paragraph() { insert_block(element_from_html("<p>Write something here.</p>")); }
function add_marquee() { insert_block(element_from_html('<marquee behavior="scroll" scrollamount="4">~*~ welcome to my page ~*~</marquee>')); }
function add_rule() { insert_block(element_from_html('<hr width="80%">')); }
function add_raw() {
	const el = element_from_html('<div class="raw"><table border="1" bgcolor="#ffffff" cellpadding="6"><tr><td>Anything goes here.</td></tr></table></div>');
	insert_block(el);
	edit_raw_block(el);
}

/** @param {string} tag */
function add_x_element(tag) {
	const definition = registry.find((d) => d.tag === tag);
	if (!definition) { return; }
	insert_block(element_from_html(`<${tag}>${definition.editor.fallback}</${tag}>`));
}

/**
 * Adds an image block from a site-relative path (already uploaded).
 * @param {string} path
 */
function add_image_from_path(path) {
	const el = element_from_html(`<img src="${escape_html(display_base() + path)}" alt="">`);
	insert_block(el);
}

/**
 * Uploads an image (from the GIFs window or a file) and adds it as a block.
 * @param {Blob} blob
 */
async function add_image_from_blob(blob) {
	if (!await ensure_signed_in()) { return; }
	set_status("Uploading…");
	try {
		const path = await upload_asset(blob);
		add_image_from_path(path);
		set_status(`Added ${path}`);
	} catch (error) {
		set_status(`Couldn't upload: ${error.message}`);
	}
}

/** @param {string} url */
async function add_image_from_url(url) {
	try {
		const response = await fetch(url);
		if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
		await add_image_from_blob(await response.blob());
	} catch (error) {
		set_status(`Couldn't fetch the GIF: ${error.message}`);
	}
}

/** @param {Element} el */
function link_image_block(el) {
	const img = el.tagName === "IMG" ? el : el.querySelector("img");
	const link = el.tagName === "A" ? el : null;
	// eslint-disable-next-line no-alert
	const href = prompt("Link this image to (URL, or a page like about.html; empty to remove):", link?.getAttribute("href") || "");
	if (href === null || !current || !img) { return; }
	const index = current.model.blocks.indexOf(el);
	let replacement = el;
	if (href.trim() && !link) {
		replacement = document.createElement("a");
		replacement.setAttribute("href", href.trim());
		replacement.append(img);
	} else if (href.trim() && link) {
		link.setAttribute("href", href.trim());
	} else if (!href.trim() && link) {
		replacement = img;
	}
	current.model.blocks[index] = replacement;
	mark_dirty();
	render_all();
	select_block(replacement);
}

/** @param {Element} el */
function edit_x_block(el) {
	const definition = registry.find((d) => d.tag === el.tagName.toLowerCase());
	if (!definition) { return; }
	for (const attr of definition.attrs) {
		// eslint-disable-next-line no-alert
		const value = prompt(`<${definition.tag}> ${attr}:`, el.getAttribute(attr) || "");
		if (value === null) { return; }
		if (value.trim()) { el.setAttribute(attr, value.trim()); } else { el.removeAttribute(attr); }
	}
	mark_dirty();
}

/** @param {Element} el */
function edit_raw_block(el) {
	const $w = $Window({ title: "Edit HTML", resizable: true, innerWidth: 520, innerHeight: 340 });
	$w.$content.html(`<div class="dialog-body" style="height:100%;box-sizing:border-box"><textarea style="flex:1;font:12px 'Courier New',monospace;white-space:pre" spellcheck="false"></textarea></div><div class="dialog-buttons"><button type="button" class="ok default">OK</button><button type="button" class="cancel">Cancel</button></div>`);
	const clone = inert_clone(el);
	clone.removeAttribute("contenteditable");
	rewrite_urls(clone, display_base(), "relative");
	const $text = $w.$content.find("textarea").val(clone.outerHTML);
	$w.$content.find(".ok").on("click", () => {
		const replacement = element_from_html(String($text.val()));
		if (!replacement || !current) { $w.close(); return; }
		sanitize_tree(replacement);
		rewrite_urls(replacement, display_base(), "absolute");
		current.model.blocks[current.model.blocks.indexOf(el)] = replacement;
		mark_dirty();
		render_all();
		select_block(replacement);
		$w.close();
	});
	$w.$content.find(".cancel").on("click", () => $w.close());
	$w.center();
	$text.focus();
}

// ---- collages via Paint ----

/**
 * Takes a collage document from Paint (assets as data URLs), uploads the assets, and returns the `div.collage`
 * element with site-relative asset paths rewritten to absolute for display.
 * @param {string} html
 */
async function import_collage(html) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const collage = doc.querySelector(".collage");
	if (!collage) { throw new Error("Paint didn't send a collage."); }
	sanitize_tree(collage);
	const existing = new Set((await list_files()).files.map((file) => file.path));
	for (const img of collage.querySelectorAll("img[src^='data:']")) {
		const blob = await (await fetch(img.getAttribute("src"))).blob();
		const path = await upload_asset(blob, existing);
		img.setAttribute("src", display_base() + path);
	}
	return /** @type {Element} */ (document.importNode(collage, true));
}

async function add_collage() {
	if (!await ensure_signed_in()) { return; }
	set_status("Draw in Paint, then File › Send to Page Editor.");
	const html = await edit_collage_in_paint(null); // whatever's on Paint's canvas becomes the collage
	set_status("Uploading the collage…");
	try {
		insert_block(await import_collage(html));
		set_status("Collage added.");
	} catch (error) {
		set_status(`Couldn't add the collage: ${error.message}`);
	}
}

/** @param {Element} el */
async function edit_collage_block(el) {
	if (!current) { return; }
	const clone = inert_clone(el);
	set_status("Editing in Paint — File › Send to Page Editor when done.");
	const html = await edit_collage_in_paint(`<!DOCTYPE html><html><body><center>${clone.outerHTML}</center></body></html>`);
	try {
		const replacement = await import_collage(html);
		const index = current.model.blocks.indexOf(el);
		if (index !== -1) { current.model.blocks[index] = replacement; } else { current.model.blocks.push(replacement); }
		mark_dirty();
		render_all();
		select_block(replacement);
		set_status("Collage updated.");
	} catch (error) {
		set_status(`Couldn't update the collage: ${error.message}`);
	}
}

// ---- formatting toolbar (text blocks) ----

/** @type {JQuery<HTMLElement>} */
let $format;

function update_format_toolbar() {
	const enabled = !!selected && TEXT_KINDS.has(block_kind(selected));
	$format?.find("button, select, input").prop("disabled", !enabled);
}

/**
 * @param {string} command
 * @param {string} [value]
 */
function format(command, value) {
	document.execCommand("styleWithCSS", false, "false"); // <font> and <b>, not spans with styles
	document.execCommand(command, false, value);
	mark_dirty();
}

// ---- loading / saving ----

/** @param {string} path */
async function load_page(path) {
	if (!await ensure_signed_in()) { return; }
	set_status(`Loading ${path}…`);
	let html;
	try {
		const { files } = await list_files();
		if (files.some((file) => file.path === path)) {
			html = await (await read_file(path)).text();
		} else {
			html = blank_page_html(path.replace(/\.html?$/i, ""));
			set_status(`${path} doesn't exist yet — it will be created when you save.`);
		}
	} catch (error) {
		set_status(`Couldn't load ${path}: ${error.message}`);
		return;
	}
	const model = parse_page(html);
	for (const el of model.blocks) {
		rewrite_urls(el, display_base(), "absolute");
	}
	current = { path, model, dirty: false };
	$editor?.title(`${path} — Page Editor`);
	if (String($pages.val()) !== path) {
		if (!$pages.find(`option[value="${path}"]`).length) {
			$pages.append($("<option>").val(path).text(path));
		}
		$pages.val(path);
	}
	render_all();
	select_block(null);
	set_status(`${path} · ${model.blocks.length} block${model.blocks.length === 1 ? "" : "s"} · ${public_url(path)}`);
}

async function save_page() {
	if (!current) { return; }
	if (!await ensure_signed_in()) { return; }
	set_status("Saving…");
	const model = { ...current.model,
		blocks: current.model.blocks.map((el) => {
			const clone = inert_clone(el);
			clone.removeAttribute("contenteditable");
			for (const nested of clone.querySelectorAll("[contenteditable]")) { nested.removeAttribute("contenteditable"); }
			rewrite_urls(clone, display_base(), "relative");
			return clone;
		}) };
	try {
		const result = await write_file(current.path, serialize_page(model), "text/html");
		current.dirty = false;
		$editor?.title(`${current.path} — Page Editor`);
		set_status(`Saved. ${result.url}`);
	} catch (error) {
		set_status(`Couldn't save: ${error.message}`);
	}
}

async function refresh_page_list() {
	try {
		const { files } = await list_files();
		const pages = files.map((file) => file.path).filter((path) => /\.html?$/i.test(path)).sort();
		if (!pages.includes("index.html")) { pages.unshift("index.html"); }
		const value = current?.path || String($pages.val()) || "index.html";
		$pages.empty();
		for (const path of pages) { $pages.append($("<option>").val(path).text(path)); }
		if (!pages.includes(value)) { $pages.append($("<option>").val(value).text(value)); }
		$pages.val(value);
	} catch (_error) { /* list is a convenience */ }
}

function show_page_properties() {
	if (!current) { return; }
	const model = current.model;
	const $w = $Window({ title: "Page Properties", resizable: false, maximizeButton: false, minimizeButton: false, innerWidth: 360 });
	$w.$content.html(`
		<form class="dialog-body">
			<label><span>Title</span><input type="text" name="title"></label>
			<label><span>Background color</span><input type="color" name="bgcolor"></label>
			<label><span>Text color</span><input type="color" name="text_color"> <input type="checkbox" name="use_text_color"> set</label>
			<label><span>Wallpaper</span><select name="background"><option value="">(none)</option></select></label>
		</form>
		<div class="dialog-buttons"><button type="button" class="ok default">OK</button><button type="button" class="cancel">Cancel</button></div>
	`);
	const $form = $w.$content.find("form");
	$form.find("[name=title]").val(model.title);
	$form.find("[name=bgcolor]").val(/^#[0-9a-f]{6}$/i.test(model.bgcolor) ? model.bgcolor : "#ffffff");
	$form.find("[name=text_color]").val(/^#[0-9a-f]{6}$/i.test(model.text_color) ? model.text_color : "#000000");
	$form.find("[name=use_text_color]").prop("checked", !!model.text_color);
	list_files().then(({ files }) => {
		const $select = $form.find("[name=background]");
		for (const file of files.filter((f) => /^gifs\/.*\.(gif|png|jpe?g|webp)$/i.test(f.path))) {
			$select.append($("<option>").val(file.path).text(file.path));
		}
		$select.val(model.background);
	}).catch(() => {});
	$w.$content.find(".ok").on("click", () => {
		model.title = String($form.find("[name=title]").val());
		model.bgcolor = String($form.find("[name=bgcolor]").val());
		model.text_color = $form.find("[name=use_text_color]").prop("checked") ? String($form.find("[name=text_color]").val()) : "";
		model.background = String($form.find("[name=background]").val());
		mark_dirty();
		render_all();
		$w.close();
	});
	$w.$content.find(".cancel").on("click", () => $w.close());
	$w.center();
}

// ---- the window ----

/** @param {string} [path] */
export function open_page_editor(path) {
	const $w = show_window("page-editor", "Page Editor", "icons/page-editor.svg", () => {
		const $window = $Window({ title: "Page Editor", icons: { 16: "icons/page-editor.svg", 32: "icons/page-editor.svg" }, resizable: true, innerWidth: Math.min(940, innerWidth - 60), innerHeight: Math.min(700, innerHeight - 90) });
		$window.$content.html(`
			<div class="page-editor-body">
				<div class="page-editor-toolbars">
					<div class="toolbar">
						<label>Page: <select class="pages"></select></label>
						<button type="button" class="new-page">New…</button>
						<button type="button" class="save"><b>Save</b></button>
						<button type="button" class="view">View</button>
						<button type="button" class="properties">Page Properties…</button>
						<span class="spacer"></span>
						<span class="status-line" style="flex:2"></span>
					</div>
					<div class="toolbar add">
						<span>Add:</span>
						<button type="button" data-add="heading">Heading</button>
						<button type="button" data-add="paragraph">Paragraph</button>
						<button type="button" data-add="marquee">Marquee</button>
						<button type="button" data-add="rule">Line</button>
						<button type="button" data-add="gif">GIF…</button>
						<button type="button" data-add="upload">Image…</button>
						<button type="button" data-add="collage">Collage (Paint)…</button>
						<button type="button" data-add="raw">HTML</button>
						<span class="x-elements"></span>
						<input type="file" accept="image/gif,image/png,image/jpeg,image/webp" hidden>
					</div>
					<div class="toolbar format">
						<span>Text:</span>
						<select class="font-family"><option value="">font</option>${CLASSIC_FONTS.map((f) => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join("")}</select>
						<select class="font-size"><option value="">size</option>${[1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}">${n}</option>`).join("")}</select>
						<input type="color" class="fore-color" value="#000000" title="Text color">
						<button type="button" data-format="bold"><b>B</b></button>
						<button type="button" data-format="italic"><i>I</i></button>
						<button type="button" data-format="underline"><u>U</u></button>
						<button type="button" data-format="createLink">Link…</button>
						<button type="button" data-format="unlink">Unlink</button>
						<button type="button" data-format="justifyLeft">⇤</button>
						<button type="button" data-format="justifyCenter">⇔</button>
					</div>
				</div>
				<div class="page-scroll"><div class="page-canvas"></div></div>
			</div>
		`);
		$canvas = $window.$content.find(".page-canvas");
		$status = $window.$content.find(".status-line");
		$pages = /** @type {JQuery<HTMLSelectElement>} */ ($window.$content.find(".pages"));
		$format = $window.$content.find(".toolbar.format");
		const $file_input = $window.$content.find("input[type=file]");
		$editor = $window;

		$pages.on("change", () => { load_page(String($pages.val())); });
		$window.$content.find(".save").on("click", save_page);
		$window.$content.find(".view").on("click", () => { if (current) { window.open(public_url(current.path), "_blank", "noopener"); } });
		$window.$content.find(".properties").on("click", show_page_properties);
		$window.$content.find(".new-page").on("click", () => {
			// eslint-disable-next-line no-alert
			const name = prompt("Page file name (like about.html):", "about.html");
			if (!name) { return; }
			load_page(name.trim().replace(/\.html?$/i, "").replace(/[^A-Za-z0-9._-]/g, "-") + ".html");
		});
		$window.$content.find("[data-add]").on("click", (e) => {
			const kind = /** @type {HTMLElement} */ (e.currentTarget).dataset.add;
			({ heading: add_heading, paragraph: add_paragraph, marquee: add_marquee, rule: add_rule, raw: add_raw, collage: add_collage, gif: open_gif_window, upload: () => $file_input.trigger("click") })[kind]?.();
		});
		$file_input.on("change", () => {
			const file = /** @type {HTMLInputElement} */ ($file_input[0]).files?.[0];
			$file_input.val("");
			if (file) { add_image_from_blob(file); }
		});
		$format.find("[data-format]").on("mousedown", (e) => e.preventDefault()).on("click", (e) => {
			const command = /** @type {HTMLElement} */ (e.currentTarget).dataset.format;
			if (command === "createLink") {
				// eslint-disable-next-line no-alert
				const href = prompt("Link to (URL or a page like about.html):", "");
				if (href) { format("createLink", href); }
			} else {
				format(command);
			}
		});
		$format.find(".font-family").on("mousedown", (e) => e.stopPropagation()).on("change", (e) => { const v = String($(e.currentTarget).val()); if (v) { format("fontName", v); } });
		$format.find(".font-size").on("change", (e) => { const v = String($(e.currentTarget).val()); if (v) { format("fontSize", v); } });
		$format.find(".fore-color").on("input", (e) => { format("foreColor", String($(e.currentTarget).val())); });

		// Drops: GIFs from the GIFs window, or image files.
		const $scroll = $window.$content.find(".page-scroll");
		$scroll.on("dragover", (e) => {
			const dt = /** @type {DragEvent} */ (e.originalEvent).dataTransfer;
			if (dt && ([...dt.types].includes(GIF_DRAG_TYPE) || [...dt.types].includes("Files"))) {
				e.preventDefault();
				$canvas.addClass("drop-hint");
			}
		}).on("dragleave drop", () => { $canvas.removeClass("drop-hint"); }).on("drop", (e) => {
			const dt = /** @type {DragEvent} */ (e.originalEvent).dataTransfer;
			if (!dt) { return; }
			const url = dt.getData(GIF_DRAG_TYPE);
			if (url) {
				e.preventDefault();
				add_image_from_url(url);
			} else if (dt.files?.[0]) {
				e.preventDefault();
				add_image_from_blob(dt.files[0]);
			}
		});
		document.addEventListener("insert-gif", (e) => { add_image_from_url(/** @type {CustomEvent} */ (e).detail); });
		document.addEventListener("selectionchange", () => {
			const node = document.getSelection()?.anchorNode;
			const wrapper = node && (node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement)?.closest(".page-canvas > .block");
			if (wrapper) {
				const el = [...wrapper.children].find((child) => !child.classList.contains("block-tools") && !child.classList.contains("block-kind"));
				if (el && el !== selected) { select_block(el); }
			}
		});
		$window.$content.on("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				save_page();
			} else if ((e.key === "Delete" || e.key === "Backspace") && selected && !TEXT_KINDS.has(block_kind(selected)) && !$(e.target).is("input, textarea, [contenteditable=true]")) {
				e.preventDefault();
				delete_block(selected);
			}
		});
		$window.on("close", () => {
			if (current?.dirty) { save_page(); }
			$editor = null;
			current = null;
		});
		$window.css({ left: 100, top: 30 });

		list_x_elements().then((definitions) => {
			registry = definitions;
			const $x = $window.$content.find(".x-elements");
			for (const definition of registry) {
				$("<button type='button'>").text(definition.editor.label).attr("title", definition.editor.description).on("click", () => add_x_element(definition.tag)).appendTo($x);
			}
		}).catch(() => {});
		refresh_page_list();
		return $window;
	});
	if (path || !current) {
		load_page(path || "index.html");
	}
	return $w;
}
