// @ts-check
/* global localize */
// The link dialog: where a link should go — an address, one of your pages (picked from its thumbnail), or a section
// of a page. One dialog for both kinds of link: an element (a GIF, a picture, web text, a text box — Edit › Add Link
// to Element…, the toolbox's Link tool) and the selected words of a section being edited (Ctrl+K, the Font toolbar's
// link button, the Link tool). What it links is the caller's business: `target.apply(href)`.
import { $DialogWindow } from "./$ToolWindow.js";
import { E } from "./helpers.js";
import { render_page_tiles, select_page_tile } from "./page-tiles.js";
import { current_site, get_site_editor_url, is_signed_in, load_settings } from "./site-publish.js";

/**
 * @typedef {object} LinkTarget
 * @property {string} href - the link there is now ("" for none)
 * @property {string} prompt - what's being linked, as a question ("Where should clicking this GIF go?")
 * @property {{ id: string, text: string }[]} [sections] - this page's other sections, for "#anchor" links
 * @property {(href: string) => void} apply - sets the link; "" removes it
 */

/** @param {LinkTarget} target */
function show_link_dialog(target) {
	const $w = $DialogWindow(localize("Link"));
	$w.addClass("link-window squish");
	const $main = $w.$main;
	$(E("p")).addClass("link-prompt").text(target.prompt).appendTo($main);
	/** @param {string} label @param {JQuery} $input */
	const row = (label, $input) => {
		const $row = $(E("label")).addClass("link-row").appendTo($main);
		$(E("span")).addClass("link-label").text(label).appendTo($row);
		$input.appendTo($row);
	};
	const $url = $(E("input")).attr({ type: "text", spellcheck: "false", placeholder: localize("https://…, a page below, or #section"), name: "link-url" }).val(target.href);
	row(localize("Address:"), $url);
	$(E("div")).addClass("link-pages-label").text(localize("Your pages:")).appendTo($main);
	const $pages = $(E("div")).addClass("my-site-pages inset-deep link-pages").attr({ role: "listbox", "aria-label": localize("Your pages") }).appendTo($main);
	const $sections = /** @type {JQuery<HTMLSelectElement>} */ ($(E("select")).attr({ name: "link-section" }));
	row(localize("Section:"), $sections);
	/** @param {string} text */
	const note = (text) => { $pages.empty().append($(E("div")).addClass("my-site-empty my-site-pages-empty").text(text)); };

	/** @param {{ id: string, text: string }[]} sections @param {string} first - the placeholder option */
	const fill_sections = (sections, first) => {
		$sections.empty().append($(E("option")).val("").text(first));
		for (const section of sections) { $sections.append($(E("option")).val(`#${section.id}`).text(section.text || section.id)); }
		$sections.prop("disabled", sections.length === 0);
	};
	fill_sections(target.sections || [], localize("(a section of this page…)"));

	const site = current_site();
	/** @type {import("./page-tiles.js").SiteFile[]} */
	let pages = [];
	/** The tile of the page the address names, if any */
	const highlight = () => {
		const value = String($url.val()).replace(/#.*$/, "");
		const match = pages.find((page) => value && value === new URL(page.url).pathname);
		select_page_tile($pages, match ? match.path : null);
	};
	/** @param {import("./page-tiles.js").SiteFile} file */
	const pick = async (file) => {
		$url.val(new URL(file.url).pathname);
		select_page_tile($pages, file.path);
		fill_sections([], localize("(a section of it…)"));
		try {
			// That page's sections, from its markup (any <div class="block section" id="…">)
			const html = await (await fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files/${file.path}?optional`)).text();
			const found = [];
			for (const match of html.matchAll(/<(?:div|p|h[1-6])[^>]*class="block section"[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:div|p|h[1-6])>/g)) {
				found.push({ id: match[1], text: match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) });
			}
			if (!$w.closed && String($url.val()).startsWith(new URL(file.url).pathname)) { fill_sections(found, localize("(a section of it…)")); }
		} catch (_error) { /* no sections to offer */ }
	};
	if (site && is_signed_in()) {
		note(localize("Loading your pages…"));
		fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files`, { headers: { Authorization: `Bearer ${load_settings().secret}` } })
			.then((response) => (response.ok ? response.json() : null))
			.then((listing) => {
				if ($w.closed) { return; }
				if (!listing) { note(localize("Couldn't list your pages. The address still works.")); return; }
				const files = listing.files.filter((/** @type {{ path: string }} */ file) => !file.path.startsWith("versions/"));
				pages = files.filter((/** @type {{ path: string }} */ file) => /\.html?$/i.test(file.path));
				render_page_tiles($pages, files, { on_pick: (file) => { pick(file); }, on_open: (file) => { pick(file); $ok.trigger("click"); }, empty: localize("No pages on your site yet.") });
				highlight();
			})
			.catch(() => { if (!$w.closed) { note(localize("Couldn't list your pages. The address still works.")); } });
	} else {
		note(localize("Sign in to My Site to pick one of your pages."));
	}
	$url.on("input", () => {
		highlight();
		if (!String($url.val()).replace(/^#.*$/, "")) { fill_sections(target.sections || [], localize("(a section of this page…)")); }
	});
	$sections.on("change", () => {
		const hash = String($sections.val());
		if (!hash) { return; }
		$url.val(`${String($url.val()).replace(/#.*$/, "")}${hash}`);
	});
	const $ok = $w.$Button(localize("OK"), () => {
		const href = String($url.val()).trim();
		if (!href) { $url.focus(); return; }
		$w.close();
		target.apply(href);
	}, { type: "submit" });
	if (target.href) {
		$w.$Button(localize("Remove Link"), () => { $w.close(); target.apply(""); });
	}
	$w.$Button(localize("Cancel"), () => { $w.close(); });
	$w.$content.css({ width: "min(520px, 92vw)" });
	$w.center();
	$url.focus();
}

$("<style>").text(`
	.link-prompt { margin: 0 0 6px; }
	.link-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
	.link-label { flex: 0 0 64px; }
	.link-row input, .link-row select { flex: 1 1 auto; width: 100%; min-width: 0; box-sizing: border-box; }
	.link-pages-label { font-size: 11px; opacity: 0.8; margin-bottom: 2px; }
	.link-pages { height: 176px; margin-bottom: 6px; }
`).appendTo(document.head);

export { show_link_dialog };
