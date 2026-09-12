// @ts-check
/* global $status_text, localize */
// Cards: things that sit in the flow of a section's text — a callout, a button, a toggle, a picture with a caption, a
// gallery, one of the site's <x-*> elements — inserted with "/" on an empty line (or the Font toolbar's Insert),
// moved with the grip beside them (↑ ↓, or dragged to another spot or section), and edited in place. A card is one
// element of the section's html, `<… class="card" data-card="kind">`, and the page renders it with no scripts.
// Optional: nothing here shows unless a section is being edited and "/" or Insert is used. This module hooks into the
// editor through events (block-editing-changed, block-rendered) and the exported block helpers — nothing else.
import { $DialogWindow } from "./$ToolWindow.js";
import { get_block_kind } from "./block-kinds.js";
import { apply_block_style, get_blocks, get_editing_block, insert_rule, reflow_sections } from "./blocks.js";
import { $G, E } from "./helpers.js";
import { show_link_dialog } from "./link-dialog.js";

/**
 * @typedef {object} CardKind
 * @property {string} id
 * @property {string} label
 * @property {string} icon - 16×16 SVG body
 * @property {string} [hint] - shown at the right of the menu row
 * @property {"cards" | "site"} group
 * @property {() => HTMLElement} [make] - the card element (a fresh one)
 * @property {() => void} [action] - instead of make: something else happens (a style, a window opens)
 * @property {string[]} [keywords] - for the "/" filter
 */

/** @type {CardKind[]} */
const card_kinds = [];
/** @param {CardKind} kind */
function register_card_kind(kind) {
	const at = card_kinds.findIndex((other) => other.id === kind.id);
	if (at >= 0) { card_kinds.splice(at, 1, kind); } else { card_kinds.push(kind); }
}

const CALLOUT_COLORS = ["#ffffd9", "#e0ffe0", "#e0f0ff", "#ffe0f0", "#f0f0f0", "#ffffff"];
const WIDTHS = ["normal", "wide", "full"];

/** @param {string} html */
function element_from(html) {
	const template = document.createElement("template");
	template.innerHTML = html;
	return /** @type {HTMLElement} */ (template.content.firstElementChild);
}

// ---- the built-in kinds ----

register_card_kind({
	id: "callout",
	label: localize("Callout"),
	group: "cards",
	keywords: ["note", "tip", "warning", "box"],
	icon: '<rect x="1" y="3" width="14" height="10" fill="#ffffd9" stroke="#808080"/><rect x="3" y="5" width="2" height="2" fill="#000080"/><rect x="3" y="8" width="2" height="3" fill="#000080"/><rect x="7" y="6" width="6" height="1" fill="#000"/><rect x="7" y="9" width="4" height="1" fill="#000"/>',
	make: () => element_from(`<div class="card callout" data-card="callout" style="background:${CALLOUT_COLORS[0]}"><span class="callout-emoji card-text">💡</span><div class="callout-text card-text"><p>${localize("Something worth a box.")}</p></div></div>`),
});
register_card_kind({
	id: "button",
	label: localize("Button"),
	group: "cards",
	keywords: ["link", "cta"],
	icon: '<rect x="1" y="4" width="14" height="8" fill="#c0c0c0" stroke="#000"/><rect x="2" y="5" width="12" height="1" fill="#fff"/><rect x="2" y="5" width="1" height="6" fill="#fff"/><rect x="4" y="7" width="8" height="2" fill="#000080"/>',
	make: () => element_from(`<p class="card button-card" data-card="button" align="center"><a class="button card-text" href="#">${localize("Click here")}</a></p>`),
});
register_card_kind({
	id: "toggle",
	label: localize("Toggle"),
	group: "cards",
	keywords: ["details", "collapse", "faq", "accordion"],
	icon: '<path d="M3 4h10l-5 6z" fill="#000"/><rect x="2" y="12" width="12" height="1" fill="#808080"/>',
	make: () => element_from(`<details class="card toggle" data-card="toggle"><summary class="card-text">${localize("Click to open")}</summary><div class="toggle-text card-text"><p>${localize("The details, hidden until the reader wants them.")}</p></div></details>`),
});
register_card_kind({
	id: "quote",
	label: localize("Quote"),
	group: "cards",
	keywords: ["blockquote"],
	icon: '<path d="M3 4h4v4H5v2H3zM9 4h4v4h-2v2H9z" fill="#808080"/>',
	action: () => { apply_block_style("blockquote"); },
});
register_card_kind({
	id: "code",
	label: localize("Code"),
	group: "cards",
	keywords: ["pre", "monospace"],
	icon: '<path d="M5 4v1H4v1H3v1H2v2h1v1h1v1h1v1H4v-1H3v-1H2V9H1V7h1V6h1V5h1V4zM11 4v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h1v-1h1v-1h1V9h1V7h-1V6h-1V5h-1V4z" fill="#000080"/>',
	action: () => { apply_block_style("pre"); },
});
register_card_kind({
	id: "divider",
	label: localize("Divider"),
	group: "cards",
	keywords: ["rule", "line", "hr"],
	icon: '<rect x="1" y="7" width="14" height="1" fill="#808080"/><rect x="1" y="8" width="14" height="1" fill="#fff"/>',
	action: () => { insert_rule(); },
});
// The site's own elements, inside the text (the sites Worker renders them wherever they are)
const X_ICONS = {
	"x-counter": '<rect x="1" y="4" width="14" height="8" fill="#000" stroke="#808080"/><rect x="3" y="6" width="2" height="4" fill="#00ff00"/><rect x="7" y="6" width="2" height="4" fill="#00ff00"/><rect x="11" y="6" width="2" height="4" fill="#00ff00"/>',
	"x-guestbook": '<path d="M1 3h6l1 1 1-1h6v10H9l-1 1-1-1H1z" fill="#fff" stroke="#000"/><rect x="8" y="3" width="1" height="10" fill="#808080"/><rect x="3" y="6" width="3" height="1" fill="#000080"/><rect x="3" y="8" width="3" height="1" fill="#000080"/>',
	"x-music": '<rect x="6" y="2" width="1" height="9" fill="#000"/><rect x="12" y="1" width="1" height="9" fill="#000"/><rect x="6" y="2" width="7" height="2" fill="#000"/><rect x="3" y="10" width="4" height="3" fill="#000"/><rect x="9" y="9" width="4" height="3" fill="#000"/>',
	"x-folder": '<path d="M1.5 3.5h5l1 1.5h7v8h-13z" fill="#ffcc00" stroke="#000"/><rect x="3" y="8" width="7" height="1" fill="#000080"/><rect x="3" y="10" width="9" height="1" fill="#000080"/>',
	"x-toc": '<rect x="2" y="2" width="12" height="2" fill="#000"/><rect x="4" y="6" width="2" height="1" fill="#000080"/><rect x="7" y="6" width="7" height="1" fill="#000"/><rect x="4" y="9" width="2" height="1" fill="#000080"/><rect x="7" y="9" width="5" height="1" fill="#000"/>',
	"x-updated": '<circle cx="8" cy="8" r="6" fill="#fff" stroke="#000"/><rect x="7.5" y="4" width="1" height="4" fill="#000"/><rect x="7.5" y="8" width="3" height="1" fill="#000"/>',
};
// (Their kinds are looked up when a card is made, not now: block-kinds.js may still be loading — modules import in a circle.)
const X_LABELS = { "x-counter": "Visitor Counter", "x-guestbook": "Guestbook", "x-music": "Music", "x-folder": "Folder View", "x-toc": "Table of Contents", "x-updated": "Last Updated" };
for (const [tag, label] of Object.entries(X_LABELS)) {
	register_card_kind({
		id: tag,
		label: localize(label),
		group: "site",
		keywords: [tag.slice(2)],
		icon: X_ICONS[tag] || '<rect x="2" y="2" width="12" height="12" fill="none" stroke="#000080" stroke-dasharray="2 1"/>',
		make: () => {
			const kind = get_block_kind(tag);
			const el = element_from(`<${tag} class="card" data-card="x-element"></${tag}>`);
			for (const [name, value] of Object.entries(kind ? kind.attrs : {})) { el.setAttribute(name, value); }
			el.innerHTML = kind ? kind.html : `&lt;${tag}&gt;`;
			return el;
		},
	});
}

// ---- cards in a section's element ----

/** Cards are atomic while editing; their text regions are typable; toggles are open so their text can be reached. */
function prepare_cards(root) {
	for (const card of root.querySelectorAll("[data-card]")) {
		card.setAttribute("contenteditable", "false");
		for (const region of card.querySelectorAll(".card-text")) { region.setAttribute("contenteditable", "true"); }
		if (card.tagName === "DETAILS") { card.setAttribute("open", ""); }
	}
}
$G.on("block-rendered", (_e, block) => { if (block.flow) { prepare_cards(block.el); } });

/** The card an element is in, if it's in the section being edited. @param {Node | null | undefined} node */
function card_of(node) {
	const block = get_editing_block();
	if (!block || !node) { return null; }
	const el = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
	const card = el?.closest("[data-card]");
	return card && block.el.contains(card) && card !== block.el ? /** @type {HTMLElement} */ (card) : null;
}

/** @type {HTMLElement | null} the card whose grip shows (selected as a whole, or with the caret in its text) */
let active_card = null;
/** @type {boolean} whole-card selection (↑/↓ move it, Backspace removes it) rather than a caret in its text */
let card_selected = false;

/** @param {HTMLElement | null} card @param {boolean} [selected] */
function set_active_card(card, selected = false) {
	active_card = card;
	card_selected = !!card && selected;
	update_grip(); // (the selection shows as an overlay in the layer — nothing is written into the section's markup)
}

/** Whole-card selection: the selection wraps the card (so typing replaces nothing). @param {HTMLElement} card */
function select_card(card) {
	const block = get_editing_block();
	if (!block) { return; }
	const selection = document.getSelection();
	if (selection) {
		const range = document.createRange();
		range.selectNode(card);
		selection.removeAllRanges();
		selection.addRange(range);
	}
	set_active_card(card, true);
}

/** Puts the caret in a text region, selecting its words (typing replaces the placeholder). @param {Element} region */
function focus_region(region) {
	const selection = document.getSelection();
	if (!selection) { return; }
	const range = document.createRange();
	range.selectNodeContents(region.querySelector("p") || region);
	selection.removeAllRanges();
	selection.addRange(range);
	/** @type {HTMLElement} */ (region).focus?.();
}

/** A paragraph to keep writing in, after a card. @param {HTMLElement} card */
function paragraph_after(card) {
	let next = card.nextSibling;
	while (next && next.nodeType === Node.TEXT_NODE && !next.textContent?.trim()) { next = next.nextSibling; }
	if (next && next.nodeType === Node.ELEMENT_NODE && !(/** @type {Element} */ (next)).hasAttribute("data-card")) { return /** @type {HTMLElement} */ (next); }
	const p = document.createElement("p");
	p.innerHTML = "<br>";
	card.after(p);
	return p;
}

/** @param {HTMLElement} el */
function caret_into(el) {
	const selection = document.getSelection();
	if (!selection) { return; }
	const range = document.createRange();
	range.setStart(el, 0);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** The caret's line: the child of the section root that holds the caret (null when the caret isn't in the section). */
function caret_line() {
	const block = get_editing_block();
	const selection = document.getSelection();
	if (!block || !selection || !selection.rangeCount || !block.el.contains(selection.anchorNode)) { return null; }
	let node = selection.anchorNode;
	if (node === block.el) { node = block.el.childNodes[Math.min(selection.anchorOffset, block.el.childNodes.length - 1)] || null; }
	while (node && node.parentNode !== block.el) { node = node.parentNode; }
	return node;
}

/**
 * Puts a card into the section being edited: on the caret's line when it's empty, else right after it; then the
 * caret goes into the card's first text region (or the paragraph after it).
 * @param {HTMLElement} card
 */
function insert_card(card) {
	const block = get_editing_block();
	if (!block || !block.is_container()) { return false; }
	const line = caret_line();
	const line_el = line && line.nodeType === Node.ELEMENT_NODE ? /** @type {HTMLElement} */ (line) : null;
	if (line_el && !line_el.hasAttribute("data-card") && !line_el.textContent?.trim() && !line_el.querySelector("img, hr, x-counter")) {
		line_el.replaceWith(card); // an empty line becomes the card
	} else if (line) {
		/** @type {ChildNode} */ (line).after(card);
	} else {
		block.el.append(card);
	}
	prepare_cards(block.el);
	const region = card.querySelector(".card-text:not(.callout-emoji)") || card.querySelector(".card-text"); // (the emoji is a one-off, not where writing starts)
	if (region) {
		focus_region(region);
	} else {
		caret_into(paragraph_after(card));
	}
	set_active_card(card, false);
	block.record_edit();
	reflow_sections();
	$G.triggerHandler("block-style-changed");
	return true;
}

/** @param {HTMLElement} card @param {-1 | 1} direction */
function move_card(card, direction) {
	const block = get_editing_block();
	if (!block) { return; }
	let sibling = direction < 0 ? card.previousSibling : card.nextSibling;
	while (sibling && sibling.nodeType === Node.TEXT_NODE && !sibling.textContent?.trim()) { sibling = direction < 0 ? sibling.previousSibling : sibling.nextSibling; }
	if (!sibling) { return; }
	if (direction < 0) { sibling.before(card); } else { sibling.after(card); }
	block.record_edit();
	reflow_sections();
	select_card(card);
	card.scrollIntoView?.({ block: "nearest" });
}

/** @param {HTMLElement} card */
function remove_card(card) {
	const block = get_editing_block();
	if (!block) { return; }
	const after = paragraph_after(card);
	card.remove();
	set_active_card(null);
	caret_into(after);
	block.record_edit();
	reflow_sections();
}

// ---- the grip: ↑ ↓, drag, and the card's own buttons ----

/** @type {JQuery | null} */
let $grip = null;
/** @type {JQuery | null} the selected card's outline (an overlay: the card itself is left alone) */
let $outline = null;
/** @type {HTMLElement | null} */
let grip_layer = null;

function update_grip() {
	const block = get_editing_block();
	if (!block || !active_card || !block.el.contains(active_card)) {
		$grip?.hide();
		$outline?.hide();
		return;
	}
	if (!$grip) { $grip = build_grip(); }
	if (!$outline) { $outline = $(E("div")).addClass("card-outline"); }
	const layer = block.$el[0];
	if (grip_layer !== layer) { $grip.appendTo(layer); $outline.appendTo(layer); grip_layer = layer; }
	const card_rect = active_card.getBoundingClientRect();
	const layer_rect = layer.getBoundingClientRect();
	$grip.css({ top: card_rect.top - layer_rect.top, left: -30 }).show();
	$outline.css({ top: card_rect.top - layer_rect.top - 2, left: card_rect.left - layer_rect.left - 2, width: card_rect.width + 4, height: card_rect.height + 4 }).toggleClass("selected", card_selected).show();
	$grip.find(".card-grip-kind").each((_i, el) => { $(el).toggle(el.dataset.for === (active_card?.dataset.card || "")); });
	$grip.attr("title", `${active_card.dataset.card} — ${localize("drag to move; ↑ ↓; ✕ removes")}`);
}

function build_grip() {
	const $g = $(E("div")).addClass("card-grip").attr({ role: "toolbar", "aria-label": localize("Card") });
	/** @param {string} label @param {string} title @param {() => void} action @param {string} [only] - a card kind */
	const button = (label, title, action, only) => {
		const $b = $(E("button")).attr({ type: "button", title, "aria-label": title }).text(label).appendTo($g);
		if (only) { $b.addClass("card-grip-kind").attr("data-for", only); }
		$b.on("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // the text keeps focus; the canvas doesn't deselect
		$b.on("click", (e) => { e.stopPropagation(); if (active_card) { action(); } });
		return $b;
	};
	const $handle = $(E("span")).addClass("card-grip-handle").attr({ title: localize("Drag to move the card") }).text("⋮⋮").appendTo($g);
	$handle.on("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (active_card) { start_drag(active_card, /** @type {PointerEvent} */ (e.originalEvent)); }
	});
	button("↑", localize("Move up"), () => { if (active_card) { move_card(active_card, -1); } });
	button("↓", localize("Move down"), () => { if (active_card) { move_card(active_card, 1); } });
	button("↔", localize("Width: normal, wide, or full"), () => {
		if (!active_card) { return; }
		const next = WIDTHS[(WIDTHS.indexOf(active_card.dataset.width || "normal") + 1) % WIDTHS.length];
		if (next === "normal") { delete active_card.dataset.width; } else { active_card.dataset.width = next; }
		get_editing_block()?.record_edit();
		reflow_sections();
		update_grip();
		$status_text.text(localize("Width: %1", next));
	}, "picture");
	$g.find('[data-for="picture"]').clone(true).attr("data-for", "gallery").appendTo($g);
	button("🎨", localize("Background color"), () => {
		if (!active_card) { return; }
		const current = active_card.style.background || "";
		const at = CALLOUT_COLORS.findIndex((color) => current.toLowerCase().includes(color));
		active_card.style.background = CALLOUT_COLORS[(at + 1) % CALLOUT_COLORS.length];
		get_editing_block()?.record_edit();
	}, "callout");
	button("🔗", localize("Where the button goes"), () => {
		const a = active_card?.querySelector("a");
		const block = get_editing_block();
		if (!a || !block) { return; }
		show_link_dialog({ href: a.getAttribute("href") === "#" ? "" : a.getAttribute("href") || "", prompt: localize("Where should the button go?"), apply: (href) => { a.setAttribute("href", href || "#"); block.record_edit(); } });
	}, "button");
	button("⚙", localize("Settings"), () => { if (active_card) { show_card_properties(active_card); } }, "x-element");
	button("✕", localize("Remove the card"), () => { if (active_card) { remove_card(active_card); } });
	return $g;
}

/** The x-element's attributes, from its kind's props (the same rows as Element Properties). @param {HTMLElement} card */
function show_card_properties(card) {
	const block = get_editing_block();
	const kind = get_block_kind(card.tagName.toLowerCase());
	if (!block || !kind) { return; }
	const $w = $DialogWindow(kind.label);
	$w.addClass("card-properties-window squish");
	if (!kind.props.length) { $(E("p")).text(localize("This element has no settings.")).appendTo($w.$main); }
	/** @type {{ attr: string, $input: JQuery }[]} */
	const fields = [];
	for (const prop of kind.props) {
		const $row = $(E("label")).addClass("card-properties-row").text(`${prop.label}: `).appendTo($w.$main);
		const $input = prop.type === "select" ?
			$(E("select")).append(...(prop.options || []).map((option) => $(E("option")).val(option).text(option || localize("(default)"))[0])).val(card.getAttribute(prop.attr) || "") :
			$(E("input")).attr({ type: prop.type === "number" ? "number" : prop.type === "color" ? "color" : "text" }).val(card.getAttribute(prop.attr) || "");
		$input.appendTo($row);
		fields.push({ attr: prop.attr, $input });
	}
	$w.$Button(localize("OK"), () => {
		for (const { attr, $input } of fields) {
			const value = String($input.val() ?? "").trim();
			if (value) { card.setAttribute(attr, value); } else { card.removeAttribute(attr); }
		}
		$w.close();
		block.record_edit();
	}, { type: "submit" });
	$w.$Button(localize("Cancel"), () => { $w.close(); });
	$w.$content.css({ width: "min(420px, 92vw)" });
	$w.center();
}

// ---- dragging a card to another spot (or another section) ----

/** @type {JQuery | null} */
let $drop_line = null;

/** @param {HTMLElement} card @param {PointerEvent} start */
function start_drag(card, start) {
	const source = get_editing_block();
	if (!source) { return; }
	/** @type {{ block: any, before: Node | null } | null} */
	let target = null;
	if (!$drop_line) { $drop_line = $(E("div")).addClass("card-drop-line").appendTo(document.body); }
	card.classList.add("card-dragging");
	const move = (/** @type {PointerEvent} */ e) => {
		target = null;
		$drop_line?.hide();
		const under = document.elementFromPoint(e.clientX, e.clientY);
		const layer = under?.closest(".block-layer.flow");
		const block = layer && get_blocks().find((other) => other.$el[0] === layer);
		if (!block) { return; }
		const lines = [...block.el.children].filter((child) => child !== card);
		let before = null;
		for (const line of lines) {
			const rect = line.getBoundingClientRect();
			if (e.clientY < rect.top + rect.height / 2) { before = line; break; }
		}
		target = { block, before };
		const edge = before ? before.getBoundingClientRect() : lines.length ? lines[lines.length - 1].getBoundingClientRect() : block.el.getBoundingClientRect();
		const y = before ? edge.top : edge.bottom;
		$drop_line?.css({ left: edge.left, top: y - 1, width: edge.width }).show();
	};
	const up = () => {
		document.removeEventListener("pointermove", move);
		document.removeEventListener("pointerup", up);
		document.removeEventListener("pointercancel", up);
		card.classList.remove("card-dragging");
		$drop_line?.hide();
		if (!target) { return; }
		if (target.before) { /** @type {ChildNode} */ (target.before).before(card); } else { target.block.el.append(card); }
		prepare_cards(target.block.el);
		if (target.block !== source) {
			source.record_edit();
			target.block.record_edit();
			set_active_card(null);
			$status_text.text(localize("Moved to another section."));
		} else {
			source.record_edit();
			select_card(card);
		}
		reflow_sections();
	};
	document.addEventListener("pointermove", move);
	document.addEventListener("pointerup", up);
	document.addEventListener("pointercancel", up);
	move(start);
}

// ---- the Insert menu ("/" on an empty line, or the Font toolbar's Insert) ----

/** @type {{ $menu: JQuery, query: string, index: number, items: CardKind[] } | null} */
let menu = null;

/** @param {{ left: number, top: number, bottom: number }} [anchor] - viewport coordinates; defaults to the caret */
function show_insert_menu(anchor) {
	const block = get_editing_block();
	if (!block || !block.is_container()) {
		$status_text.text(localize("Cards go into a section: double-click into one and put the caret on an empty line."));
		return;
	}
	close_insert_menu();
	let at = anchor;
	if (!at) {
		const selection = document.getSelection();
		const rect = selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
		const base = rect && (rect.width || rect.height) ? rect : block.el.getBoundingClientRect();
		at = { left: base.left, top: base.top, bottom: base.bottom };
	}
	const $menu = $(E("div")).addClass("card-menu").attr({ role: "menu" }).appendTo(document.body);
	$menu.on("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // the text keeps focus
	menu = { $menu, query: "", index: 0, items: [] };
	const left = Math.min(at.left, window.innerWidth - 260);
	const top = at.bottom + 4 + 300 > window.innerHeight ? Math.max(4, at.top - 4 - 300) : at.bottom + 4;
	$menu.css({ left, top });
	render_menu();
}

function render_menu() {
	if (!menu) { return; }
	const { $menu, query } = menu;
	const q = query.trim().toLowerCase();
	menu.items = card_kinds.filter((kind) => !q || kind.label.toLowerCase().includes(q) || kind.id.includes(q) || (kind.keywords || []).some((word) => word.includes(q)));
	menu.index = Math.min(menu.index, Math.max(0, menu.items.length - 1));
	$menu.empty();
	$(E("div")).addClass("card-menu-query").text(query ? `/${query}` : localize("/ Insert")).appendTo($menu);
	let group = "";
	menu.items.forEach((kind, index) => {
		if (kind.group !== group) {
			group = kind.group;
			$(E("div")).addClass("card-menu-group").text(group === "site" ? localize("Your site") : localize("Cards")).appendTo($menu);
		}
		const $item = $(E("div")).addClass("card-menu-item").toggleClass("selected", index === menu?.index).attr({ role: "menuitem", "data-card-kind": kind.id }).appendTo($menu);
		$(E("span")).addClass("card-menu-icon").css({ backgroundImage: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${kind.icon}</svg>`)}")` }).appendTo($item);
		$(E("span")).addClass("card-menu-label").text(kind.label).appendTo($item);
		if (kind.hint) { $(E("span")).addClass("card-menu-hint").text(kind.hint).appendTo($item); }
		$item.on("pointerenter", () => {
			if (!menu) { return; }
			menu.index = index;
			$menu.find(".card-menu-item").removeClass("selected");
			$item.addClass("selected");
		});
		$item.on("click", () => { pick(kind); });
	});
	if (!menu.items.length) { $(E("div")).addClass("card-menu-empty").text(localize("Nothing matches.")).appendTo($menu); }
}

function close_insert_menu() {
	menu?.$menu.remove();
	menu = null;
}

/** @param {CardKind} kind */
function pick(kind) {
	close_insert_menu();
	if (kind.action) { kind.action(); return; }
	if (kind.make) { insert_card(kind.make()); }
}

/** The menu's keys, while it's open (the section keeps focus; nothing is typed). @param {KeyboardEvent} e */
function menu_keydown(e) {
	if (!menu) { return false; }
	const count = Math.max(1, menu.items.length);
	if (e.key === "Escape") {
		close_insert_menu();
	} else if (e.key === "Enter" || e.key === "Tab") {
		const kind = menu.items[menu.index];
		if (kind) { pick(kind); } else { close_insert_menu(); }
	} else if (e.key === "ArrowDown") {
		menu.index = (menu.index + 1) % count;
		render_menu();
	} else if (e.key === "ArrowUp") {
		menu.index = (menu.index - 1 + count) % count;
		render_menu();
	} else if (e.key === "Backspace") {
		if (menu.query) {
			menu.query = menu.query.slice(0, -1);
			render_menu();
		} else {
			close_insert_menu();
		}
	} else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
		menu.query += e.key;
		menu.index = 0;
		render_menu();
	} else {
		return false;
	}
	e.preventDefault();
	e.stopPropagation();
	return true;
}

/** Whether the caret sits on an empty line of the section (where "/" opens the menu). */
function caret_on_empty_line() {
	const line = caret_line();
	if (!line) { return false; }
	if (line.nodeType === Node.TEXT_NODE) { return !line.textContent?.trim(); }
	const el = /** @type {HTMLElement} */ (line);
	return !el.hasAttribute("data-card") && !el.textContent?.trim() && !el.querySelector("img, hr");
}

// ---- wiring: while a section is being edited ----

/** @type {(() => void) | null} */
let teardown = null;

function setup(block) {
	const el = /** @type {HTMLElement} */ (block.el);
	prepare_cards(el);
	const keydown = (/** @type {KeyboardEvent} */ e) => {
		if (menu_keydown(e)) { return; }
		if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && caret_on_empty_line()) {
			e.preventDefault();
			show_insert_menu();
			return;
		}
		if (active_card && card_selected) {
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault();
				move_card(active_card, e.key === "ArrowUp" ? -1 : 1);
				return;
			}
			if (e.key === "Backspace" || e.key === "Delete") {
				e.preventDefault();
				remove_card(active_card);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				set_active_card(null);
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				caret_into(paragraph_after(active_card));
				set_active_card(null);
				return;
			}
		}
		// A toggle's title is a <summary>, which takes Space (and Enter) as "open/close": type the space by hand
		const at = document.getSelection()?.anchorNode;
		const typing_in = at ? (at.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (at) : at.parentElement)?.closest(".card-text") : null;
		if (e.key === " " && typing_in && typing_in.tagName === "SUMMARY") {
			e.preventDefault();
			document.execCommand("insertText", false, " ");
			return;
		}
		// Escape with the caret in a card's text: out of the card first (a second Escape ends editing, as usual)
		if (e.key === "Escape" && active_card) {
			e.preventDefault();
			e.stopPropagation();
			caret_into(paragraph_after(active_card));
			set_active_card(null);
			return;
		}
		// Enter in a one-line region (a caption, a summary, a button's label, the emoji) moves on rather than breaking it
		const selection = document.getSelection();
		const region = selection?.anchorNode ? (selection.anchorNode.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (selection.anchorNode) : selection.anchorNode.parentElement)?.closest(".card-text") : null;
		if (e.key === "Enter" && region && /^(figcaption|summary|a|span)$/i.test(region.tagName)) {
			e.preventDefault();
			const card = card_of(region);
			const regions = card ? [...card.querySelectorAll(".card-text")] : [];
			const next = regions[regions.indexOf(region) + 1];
			if (next) {
				focus_region(next);
			} else if (card) {
				caret_into(paragraph_after(card));
				set_active_card(null);
			}
		}
	};
	const pointerdown = (/** @type {PointerEvent} */ e) => {
		const target = /** @type {Element} */ (e.target);
		const card = card_of(target);
		if (card && !target.closest(".card-text")) {
			e.preventDefault(); // no caret inside the card's chrome: the card as a whole is what's selected
			select_card(card);
		} else if (card) {
			set_active_card(card, false);
		} else if (active_card) {
			set_active_card(null);
		}
	};
	const selectionchange = () => {
		if (menu) { return; }
		const selection = document.getSelection();
		const card = card_of(selection?.anchorNode);
		if (card && !card_selected) {
			set_active_card(card, false);
		} else if (!card && active_card && !card_selected) {
			set_active_card(null);
		} else {
			update_grip();
		}
	};
	const input = () => { requestAnimationFrame(update_grip); };
	el.addEventListener("keydown", keydown);
	el.addEventListener("pointerdown", pointerdown, true);
	el.addEventListener("input", input);
	document.addEventListener("selectionchange", selectionchange);
	teardown = () => {
		el.removeEventListener("keydown", keydown);
		el.removeEventListener("pointerdown", pointerdown, true);
		el.removeEventListener("input", input);
		document.removeEventListener("selectionchange", selectionchange);
		close_insert_menu();
		set_active_card(null);
		teardown = null;
	};
}
$G.on("block-editing-changed", () => {
	teardown?.();
	const block = get_editing_block();
	if (block && block.is_container()) { setup(block); }
});
$G.on("history-update", () => { if (active_card && !document.contains(active_card)) { set_active_card(null); } else { update_grip(); } });

/** Whether a gallery card is the active one (the Pictures window adds to it instead of inserting). */
function active_gallery() {
	return active_card && active_card.dataset.card === "gallery" && get_editing_block()?.el.contains(active_card) ? active_card : null;
}

/** Card kinds, for anything that wants to list them (the Insert menu does). */
function get_card_kinds() {
	return card_kinds.slice();
}

// ---- styles: the cards themselves (shared with the page), and the editor's chrome ----

/**
 * The look of the cards, scoped: the page uses `.column > .section`, the editor `.block-layer.flow .block-el`.
 * @param {string} scope
 */
function card_css(scope) {
	return `
${scope} .card { margin: 12px 0; }
${scope} .card.callout { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border: 1px solid #808080; background: #ffffd9; }
${scope} .callout-emoji { font-size: 22px; line-height: 1; }
${scope} .callout-text { flex: 1; min-width: 0; }
${scope} .callout-text > :first-child, ${scope} .toggle-text > :first-child { margin-top: 0; }
${scope} .callout-text > :last-child, ${scope} .toggle-text > :last-child { margin-bottom: 0; }
${scope} .button-card { text-align: center; }
${scope} a.button { display: inline-block; padding: 6px 16px; border: 2px outset #c0c0c0; background: #c0c0c0; color: #000; text-decoration: none; font-weight: bold; }
${scope} details.card { border: 1px solid #808080; padding: 8px 12px; }
${scope} details.card > summary { cursor: pointer; font-weight: bold; }
${scope} details.card > .toggle-text { margin-top: 8px; }
${scope} figure.card { margin: 12px 0; text-align: center; }
${scope} figure.card img { max-width: 100%; height: auto; }
${scope} figure.card figcaption { font-size: 13px; color: #444; margin-top: 4px; }
${scope} .gallery-pictures { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
${scope} .gallery-pictures a { display: block; }
${scope} .gallery-pictures img { width: 100%; height: 140px; object-fit: cover; display: block; }
${scope} .card[data-width="wide"] { width: 120%; margin-left: -10%; }
${scope} .card[data-width="full"] { width: var(--page-width, 100%); margin-left: calc(-1 * var(--column-left, 0px)); }
${scope} [data-card="x-element"] { display: block; }
`.trim();
}

$("<style>").text(`
	${card_css(".block-layer.flow .block-el")}
	.block-layer.flow .block-el [data-card] { position: relative; }
	.block-layer.flow .block-el [data-card="x-element"] { outline: 1px dotted #000080; outline-offset: 2px; padding: 4px; }
	.card-outline { position: absolute; pointer-events: none; border: 1px dotted #000080; box-sizing: border-box; z-index: 4; }
	.card-outline.selected { border: 2px solid #000080; }
	.block-layer.flow .block-el .card-dragging { opacity: 0.5; }
	.block-layer.flow .block-el .card-text { white-space: pre-wrap; } /* (Chrome swallows spaces typed at the end of a nested editable region otherwise) */
	.block-layer.flow .block-el .card-text:focus { outline: 1px dotted #808080; outline-offset: 1px; }
	.card-grip {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 26px;
		padding: 1px;
		background: var(--ButtonFace, #c0c0c0);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) var(--ButtonDkShadow, #000) var(--ButtonHilight, #fff);
		z-index: 5;
		font-size: 12px;
		line-height: 1;
	}
	.card-grip button {
		width: 22px;
		height: 20px;
		padding: 0;
		font: 12px/1 sans-serif;
		min-width: 0;
	}
	.card-grip-handle {
		display: block;
		text-align: center;
		cursor: grab;
		padding: 2px 0;
		letter-spacing: -2px;
		color: var(--ButtonShadow, #808080);
		user-select: none;
	}
	.card-drop-line {
		position: fixed;
		height: 2px;
		background: #000080;
		pointer-events: none;
		z-index: 1000;
		display: none;
	}
	.card-menu {
		position: fixed;
		z-index: 1000;
		min-width: 220px;
		max-height: 320px;
		overflow: auto;
		background: var(--Menu, #c0c0c0);
		color: var(--MenuText, #000);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) var(--ButtonDkShadow, #000) var(--ButtonHilight, #fff);
		box-shadow: inset -1px -1px var(--ButtonShadow, #808080), 2px 2px 0 rgba(0, 0, 0, 0.3);
		padding: 2px;
		font-size: 12px;
		user-select: none;
	}
	.card-menu-query { padding: 3px 8px; font-family: monospace; color: var(--ButtonShadow, #808080); }
	.card-menu-group { padding: 4px 8px 2px; font-size: 10px; text-transform: uppercase; color: var(--ButtonShadow, #808080); }
	.card-menu-item { display: flex; align-items: center; gap: 8px; padding: 3px 8px; cursor: default; }
	.card-menu-item.selected { background: var(--Hilight, #000080); color: var(--HilightText, #fff); }
	.card-menu-icon { width: 16px; height: 16px; flex: none; background-size: 16px 16px; image-rendering: pixelated; }
	.card-menu-label { flex: 1; }
	.card-menu-hint { font-family: monospace; opacity: 0.7; }
	.card-menu-empty { padding: 6px 8px; opacity: 0.7; }
	.card-properties-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
	.card-properties-row input, .card-properties-row select { flex: 1; min-width: 0; }
`).appendTo(document.head);

export { active_gallery, card_css, get_card_kinds, insert_card, register_card_kind, show_insert_menu };
