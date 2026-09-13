// @ts-check
/* global $toolbox, file_name, localize, system_file_handle */
// The globe at the bottom of the toolbox: your site in one click. Not signed in → the Sign In dialog, then a
// "My Site" view: your address, this page, and buttons to browse the site's files, save, share, or sign out.
// A guest (share link) sees whose page they're on and how to pass the link along. The globe itself is a web-1.0
// spinning earth: continents scroll behind a round pixel mask (and hold still for prefers-reduced-motion).
import { $DialogWindow } from "./$ToolWindow.js";
import { $G, E } from "./helpers.js";
import { end_all_loading } from "./loading-veil.js";
import { SITE_LIMIT, open_site_from_url, public_url, show_my_site_dialog, show_new_site_dialog, show_sign_in_dialog, sign_out, switch_site } from "./my-site.js";
import { current_site_page, guest_info, show_share_dialog } from "./share.js";
import { ROOT_SITE, site_public_url } from "./site-constants.js";
import { get_site_editor_url, is_signed_in, load_settings, show_publish_dialog } from "./site-publish.js";

const GLOBE = 32; // px
const RADIUS = 15.5;
const STRIP = 64; // the continents strip is two globes wide and wraps

/** @param {string} body @param {number} width @param {number} [height] */
const svg_url = (body, width, height = width) => `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${body}</svg>`)}")`;
/** @param {Iterable<[number, number]>} pixels @param {string} fill */
const path_of = (pixels, fill) => `<path d="${[...pixels].map(([x, y]) => `M${x} ${y}h1v1h-1z`).join("")}" fill="${fill}"/>`;

// Continents ("#" = land) on the 64×32 strip; the right half wraps around to the left as the globe turns.
const LAND_ROWS = [
	"................................................................",
	"................................................................",
	"................................................................",
	"................................................................",
	".......##.#...........#..#....###...#...........................",
	".....######.#.........################..........................",
	"....#########........###################..#.##..................",
	"....##########........############################..............",
	"....#########............##########################.............",
	"....##########..........############################............",
	".....#.#####.............##########################.............",
	".......##..................#######################..............",
	"............##...............##########..#########..............",
	"..........####...............#.#####......##.###................",
	".........######.................####............................",
	"..........#######.............########..........................",
	".........#########............########..........................",
	"...........######............##########.........................",
	"...........########...........########..........................",
	"............#######..........##########.........................",
	"...........########..........##########.........#..#............",
	"............######...........#########..........####............",
	"...........#######............########.........######...........",
	"...........#######..............#####...........................",
	".............#####..............##.#............................",
	"............#####...............................................",
	".............#.##...............................................",
	"................................................................",
	"................................................................",
	"................................................................",
	"................................................................",
	"................................................................",
];

/** Pixel art for the disc mask, and for the outline/highlight/shade overlay, from the circle's geometry. */
function globe_artwork() {
	const disc = /** @type {[number, number][]} */ ([]);
	const outline = /** @type {[number, number][]} */ ([]);
	const highlight = /** @type {[number, number][]} */ ([]);
	const shade = /** @type {[number, number][]} */ ([]);
	for (let y = 0; y < GLOBE; y++) {
		for (let x = 0; x < GLOBE; x++) {
			const dx = x + 0.5 - GLOBE / 2, dy = y + 0.5 - GLOBE / 2;
			const d = Math.hypot(dx, dy);
			if (d > RADIUS) { continue; }
			disc.push([x, y]);
			const angle = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
			if (d > RADIUS - 1.2) {
				outline.push([x, y]);
			} else if (d > RADIUS - 3.6 && angle >= 105 && angle <= 160) {
				highlight.push([x, y]); // the shine, upper left
			} else if (d > RADIUS - 3.4 && angle >= 250 && angle <= 350) {
				shade.push([x, y]); // the dark rim, lower right
			}
		}
	}
	const land = /** @type {[number, number][]} */ ([]);
	LAND_ROWS.forEach((row, y) => { [...row].forEach((ch, x) => { if (ch === "#") { land.push([x, y]); } }); });
	return {
		mask: svg_url(path_of(disc, "#fff"), GLOBE),
		land: svg_url(path_of(land, "#00a000"), STRIP, GLOBE),
		overlay: svg_url(path_of(outline, "#000") + path_of(highlight, "#fff") + path_of(shade, "#000060"), GLOBE),
	};
}

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $view = null;

/** The My Site view (after signing in if needed). */
async function show_site_view() {
	if ($view) {
		$view.bringToFront();
		return;
	}
	const guest = guest_info();
	if (!guest && !is_signed_in()) {
		if (!await show_sign_in_dialog()) { return; }
	}
	const settings = load_settings();
	const page = current_site_page();
	const $w = $view = $DialogWindow(localize("My Site"));
	$w.addClass("site-view-window squish");
	$w.on("close", () => { $view = null; });
	const $main = $w.$main;
	/** @param {string} href @param {string} text */
	const link = (href, text) => $(E("a")).attr({ href, target: "_blank", rel: "noopener" }).text(text);
	/** @param {string} label @param {JQuery} $value */
	const row = (label, $value) => {
		const $row = $(E("div")).addClass("site-view-row").appendTo($main);
		$(E("span")).addClass("site-view-label").text(label).appendTo($row);
		$value.addClass("site-view-value").appendTo($row);
	};
	$(E("div")).addClass("site-view-heading").append($(E("span")).addClass("site-globe site-globe-static"), $(E("span")).text(guest ? `~${guest.site}` : `~${settings.site}`)).appendTo($main);
	// Who's here: visitors who loaded a page of the site in the last few minutes (the sites Worker counts page loads —
	// pages have no scripts), and people in its pages' live rooms
	const site = guest ? guest.site : settings.site;
	const $presence = $(E("span")).addClass("site-view-presence").text("…");
	row(localize("Right now:"), $presence);
	Promise.all([
		fetch(public_url("x/stats.json", site), { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
		fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/presence`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
	]).then(([stats, presence]) => {
		if ($w.closed) { return; }
		const viewing = stats ? `👁 ${stats.viewing} viewing (${stats.today} today)` : `👁 ${localize("viewers unknown")}`;
		const editing = presence ? `✏️ ${presence.editing} editing` : `✏️ ${localize("editors unknown")}`;
		$presence.text(`${viewing} · ${editing}`).attr("title", localize("Viewing: loaded a page of the site in the last 5 minutes. Editing: in a page's live room."));
	});
	if (guest) {
		const page_url = site_public_url(guest.site, page || "index.html");
		$(E("p")).addClass("site-view-blurb").text(localize("You're drawing on this page as a guest, through a share link. Ctrl+S saves it to the site.")).appendTo($main);
		row(localize("Page:"), page ? link(page_url, page) : $(E("span")).text("—"));
		$w.$Button(localize("Share Page…"), () => { $w.close(); show_share_dialog(); }, { type: "submit" });
		$w.$Button(localize("Sign In to My Site…"), async () => {
			$w.close();
			if (await show_sign_in_dialog()) { show_site_view(); }
		});
	} else {
		row(localize("Address:"), link(public_url(), public_url()));
		if (settings.account) {
			row(localize("Account:"), $(E("span")).text(`${settings.account.email || settings.account.name} (Google)`));
			// My sites: the account's, the current one marked; another one is a click away; New Site… while there's room
			const sites = settings.account.sites.includes(settings.site) ? settings.account.sites : [settings.site, ...settings.account.sites];
			const $sites = $(E("span")).addClass("site-view-sites");
			for (const site of sites) {
				const current = site === settings.site;
				$(E("button")).attr({ type: "button", "data-site": site, title: current ? localize("The site you're on") : localize("Switch to ~%1", site) }).addClass("site-view-site").toggleClass("current", current).prop("disabled", current)
					.text(`~${site}`)
					.on("click", async () => {
						$w.close();
						await switch_site(site);
					})
					.appendTo($sites);
			}
			if (sites.length < SITE_LIMIT) {
				$(E("button")).attr({ type: "button" }).addClass("site-view-new-site").text(localize("New Site…")).on("click", async () => {
					$w.close();
					const name = await show_new_site_dialog();
					if (name) { await switch_site(name); }
				})
					.appendTo($sites);
			}
			row(localize("Your sites (%1 of %2):", String(sites.length), String(SITE_LIMIT)), $sites);
		}
		row(localize("Editor:"), $(E("span")).text(get_site_editor_url()));
		const copy_of = system_file_handle && typeof system_file_handle === "object" && typeof system_file_handle.copy_of === "string" ? system_file_handle.copy_of : "";
		row(localize("This page:"), copy_of ?
			$(E("span")).text(localize("%1 — a copy of %2. Save to My Site puts it on your site.", page, site_public_url(copy_of, page || "index.html"))) :
			page ? link(public_url(page), page) : $(E("span")).text(localize("not saved to the site yet")));
		$w.$Button(localize("My Site…"), () => { $w.close(); show_my_site_dialog(); }, { type: "submit" });
		$w.$Button(page ? localize("Save Page…") : localize("Save to My Site…"), () => { $w.close(); show_publish_dialog(); });
		if (page) { $w.$Button(localize("Share…"), () => { $w.close(); show_share_dialog(); }); }
		$w.$Button(localize("Sign Out"), () => {
			sign_out();
			$w.close();
			$G.triggerHandler("site-settings-changed");
		});
	}
	$w.$Button(localize("Close"), () => { $w.close(); });
	$w.$content.css({ width: "min(420px, 92vw)" });
	$w.center();
}

/**
 * The page's address, in a slim bar right above the canvas area (never over the page, and there on a phone too):
 * "~jack/about.html", "coolpaint.world/index.html", a guest's page, a copy of someone's page, or the file's name when
 * it isn't on a site. Clicking it opens the site view.
 */
function init_page_label() {
	const area = document.querySelector(".canvas-area");
	if (!area || !area.parentNode || document.querySelector(".page-path-bar")) { return; }
	// The bar and the canvas area share a column in the row of toolboxes (the row's rules don't mind)
	const column = E("div");
	column.className = "canvas-column";
	area.parentNode.insertBefore(column, area);
	const $bar = $(E("div")).addClass("page-path-bar").appendTo(column);
	column.append(area);
	const $label = $(E("button")).attr({ type: "button", title: localize("This page — click for the site view") }).addClass("page-path-label").appendTo($bar);
	$label.on("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
	$label.on("click", () => { show_site_view(); });
	const refresh = () => {
		const guest = guest_info();
		const page = current_site_page();
		const settings = load_settings();
		const copy_of = system_file_handle && typeof system_file_handle === "object" && typeof system_file_handle.copy_of === "string" ? system_file_handle.copy_of : "";
		let text;
		if (guest) {
			text = `~${guest.site}/${page || "…"} ${localize("(guest)")}`;
		} else if (page && copy_of) {
			text = localize("%1 — a copy of ~%2's", page, copy_of);
		} else if (page && settings.site) {
			const site_label = settings.site === ROOT_SITE ? new URL(public_url("")).host : `~${settings.site}`;
			text = `${site_label}/${page}`;
		} else {
			text = `${file_name || localize("untitled")} — ${localize("not on a site")}`;
		}
		$label.text(text);
		$bar.toggleClass("has-site", !!page);
	};
	$G.on("site-page-opened site-page-restored site-settings-changed session-update history-update", refresh);
	refresh();
}

/** Call once the toolbox exists (app.js): adds the globe at its bottom. */
function init_site_button() {
	const art = globe_artwork();
	const $button = $(E("button")).addClass("site-globe-button").attr({ type: "button", "aria-label": localize("My Site") }).appendTo($toolbox);
	$(E("span")).addClass("site-globe").appendTo($button);
	const $name = $(E("span")).addClass("site-globe-name").appendTo($button); // the site's name, small, under the globe
	$button.on("mousedown", (e) => { e.preventDefault(); }); // don't take focus from a text box being edited
	$button.on("click", () => { show_site_view(); });
	const refresh_title = () => {
		const guest = guest_info();
		const title = guest ?
			localize("My Site — you're a guest on ~%1", guest.site) :
			is_signed_in() ? localize("My Site — ~%1", load_settings().site) : localize("My Site — sign in to put pages on the web");
		$button.attr("title", title);
		$name.text(guest ? `~${guest.site}` : is_signed_in() ? `~${load_settings().site}` : localize("sign in"));
	};
	$G.on("site-page-opened site-page-restored site-settings-changed", refresh_title);
	refresh_title();
	init_page_label();
	// Sent here by edit.<domain>/~name? Open that site (after a pending share-link join, which runs at 400 ms).
	$G.one("app-ready", () => {
		setTimeout(() => { // after a share-link join
			if (guest_info()) { end_all_loading(); } else { open_site_from_url(); }
		}, 300);
	});

	$("<style>").text(`
		.site-globe-button {
			width: 50px;
			height: 50px;
			margin-top: 4px;
			padding: 0;
			display: inline-flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 1px;
			flex-shrink: 0;
		}
		.site-globe-name {
			display: block;
			max-width: 46px;
			font: 8px/9px Arial, Helvetica, sans-serif;
			letter-spacing: 0.2px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			color: var(--ButtonText, #000);
		}
		.canvas-column {
			display: flex;
			flex-direction: column;
			flex: 1 1 0;
			min-width: 0;
			min-height: 0;
		}
		.canvas-column > .canvas-area {
			flex: 1 1 0;
			min-height: 0;
		}
		.page-path-bar {
			display: flex;
			align-items: center;
			flex: none;
			height: 18px;
			padding: 0 2px;
			background: var(--ButtonFace, #c0c0c0);
		}
		.page-path-label {
			max-width: 100%;
			min-width: 0;
			height: 16px;
			padding: 0 6px;
			font: 11px/14px Arial, Helvetica, sans-serif;
			color: var(--ButtonText, #000);
			background: var(--Window, #fff);
			border: 1px solid;
			border-color: var(--ButtonShadow, #808080) var(--ButtonHilight, #fff) var(--ButtonHilight, #fff) var(--ButtonShadow, #808080);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			cursor: default;
			text-align: left;
		}
		.site-globe {
			position: relative;
			display: inline-block;
			width: ${GLOBE}px;
			height: ${GLOBE}px;
			background-color: #0000c0;
			background-image: ${art.overlay}, ${art.land};
			background-repeat: no-repeat, repeat-x;
			background-size: ${GLOBE}px ${GLOBE}px, ${STRIP}px ${GLOBE}px;
			background-position: 0 0, 0 0;
			image-rendering: pixelated;
			-webkit-mask-image: ${art.mask};
			mask-image: ${art.mask};
			-webkit-mask-size: ${GLOBE}px ${GLOBE}px;
			mask-size: ${GLOBE}px ${GLOBE}px;
			animation: site-globe-spin 8s steps(${STRIP / 2}) infinite;
		}
		.site-globe-button:hover .site-globe {
			animation-duration: 2s;
		}
		.site-globe-static {
			animation: none;
			vertical-align: middle;
			margin-right: 8px;
		}
		@keyframes site-globe-spin {
			from { background-position: 0 0, 0 0; }
			to { background-position: 0 0, -${STRIP}px 0; }
		}
		@media (prefers-reduced-motion: reduce) {
			.site-globe { animation: none; }
		}
		.site-view-presence {
			white-space: nowrap;
		}
		.site-view-sites {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
		.site-view-site.current {
			font-weight: bold;
		}
		.site-view-heading {
			display: flex;
			align-items: center;
			font-weight: bold;
			font-size: 15px;
			margin-bottom: 8px;
		}
		.site-view-blurb {
			margin: 0 0 8px;
		}
		.site-view-row {
			display: flex;
			gap: 6px;
			margin: 4px 0;
			font-size: 12px;
		}
		.site-view-label {
			flex: 0 0 70px;
			color: var(--GrayText, #808080);
		}
		.site-view-value {
			flex: 1;
			min-width: 0;
			overflow-wrap: anywhere;
		}
	`).appendTo(document.head);
}

export { init_site_button, show_site_view };
