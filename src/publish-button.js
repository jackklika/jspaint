// @ts-check
/* global localize, system_file_handle, undos, saved */
// The Publish button, always in view at the right end of the page bar (Jack, 2026-09-23: "multiple places the user
// could discover 'publish'"): one click runs the whole way — sign in if need be, name a site, put the page up — with
// no trip through My Site. Beside it, once per browser, a gentle nudge: after someone has drawn for a while on a page
// that isn't published, a small balloon under the button says so (the classic yellow tooltip), and goes away on its
// own. The funnel events (funnel.js) for the first change and the nudge come from here too.
import { funnel } from "./funnel.js";
import { $G, E } from "./helpers.js";
import { publish_current_page } from "./my-site.js";
import { current_site_page, guest_info } from "./share.js";
import { has_account, is_signed_in, load_settings } from "./site-publish.js";

const NUDGE_SEEN_KEY = "jspaint publish nudge shown"; // localStorage: "1" once it was shown (once per browser, ever)
const NUDGE_DELAY_KEY = "jspaint publish nudge delay ms"; // localStorage: a shorter wait (tests, a dev's look)
const NUDGE_CHANGES = 6; // strokes or elements before the nudge could show…
const NUDGE_DELAY_MS = 90 * 1000; // …and this long since the page opened
const NUDGE_TIMEOUT_MS = 25 * 1000; // then it goes away by itself

/** @type {JQuery<HTMLButtonElement> | null} */
let $publish = null;
/** @type {JQuery<HTMLElement> | null} */
let $nudge = null;
let opened_at = Date.now();
let first_change_sent = false;

/** The current page is on nobody's site yet: a newcomer's starter page, a copy, or a picture that never went up. */
function unpublished() {
	const handle = system_file_handle && typeof system_file_handle === "object" ? system_file_handle : null;
	if (guest_info()) { return false; }
	if (handle && (handle.fresh || typeof handle.copy_of === "string")) { return true; }
	return !current_site_page() || !is_signed_in();
}

/** What the button says of itself, for the state the page is in. */
function describe() {
	const handle = system_file_handle && typeof system_file_handle === "object" ? system_file_handle : null;
	if (guest_info()) { return localize("Publish this page for everyone (you're drawing on it through a share link)"); }
	if (handle && typeof handle.copy_of === "string") { return localize("Publish a copy of this page on your own site"); }
	if (unpublished()) { return localize("Put this page on the web: pick a name, and it's live at …/~name/"); }
	const page = current_site_page();
	return saved ? localize("Published as ~%1/%2 — Publish again to put up your changes", load_settings().site, page) : localize("Publish your changes to ~%1/%2", load_settings().site, page);
}

function refresh() {
	if (!$publish) { return; }
	$publish.attr("title", describe());
	$publish.toggleClass("page-publish-first", unpublished() && !is_signed_in() && !has_account());
	$publish.toggleClass("page-publish-dirty", !unpublished() && !guest_info() && saved === false);
	// The first change to an unpublished page: the funnel's second step (and the nudge starts counting)
	if (!first_change_sent && unpublished() && Array.isArray(undos) && undos.length >= 1) {
		first_change_sent = true;
		funnel("first_change", { signed_in: is_signed_in(), account: has_account() });
	}
	maybe_nudge();
}

/** The balloon, if it's time: enough drawn, enough time, nobody signed in, no dialog in the way, never shown before. */
function maybe_nudge() {
	if ($nudge || !$publish || !$publish.is(":visible")) { return; }
	if (is_signed_in() || has_account() || !unpublished() || guest_info()) { return; }
	if (!Array.isArray(undos) || undos.length < NUDGE_CHANGES) { return; }
	let delay = NUDGE_DELAY_MS;
	try {
		if (localStorage.getItem(NUDGE_SEEN_KEY) === "1") { return; }
		const override = localStorage.getItem(NUDGE_DELAY_KEY);
		if (override !== null && Number.isFinite(Number(override))) { delay = Number(override); }
	} catch (_error) { /* no storage: a nudge every visit would be nagging; none */ return; }
	if (Date.now() - opened_at < delay) { return; }
	if (document.querySelector(".dialog-window, .welcome-window")) { return; }
	show_nudge();
}

function show_nudge() {
	if (!$publish) { return; }
	try { localStorage.setItem(NUDGE_SEEN_KEY, "1"); } catch (_error) { /* then it may show again another day */ }
	$nudge = $(E("div")).addClass("publish-nudge").attr({ role: "status" }).appendTo(document.body);
	$(E("div")).addClass("publish-nudge-text").text(localize("Like it? Publish it. Pick a name, and it's live on the web.")).appendTo($nudge);
	const $row = $(E("div")).addClass("publish-nudge-row").appendTo($nudge);
	$(E("button")).attr({ type: "button" }).addClass("publish-nudge-go").text(localize("Publish")).on("click", () => {
		funnel("nudge_clicked");
		dismiss_nudge();
		publish_current_page("nudge");
	})
		.appendTo($row);
	$(E("button")).attr({ type: "button" }).addClass("publish-nudge-later").text(localize("Later")).on("click", () => { dismiss_nudge(); })
		.appendTo($row);
	position_nudge();
	funnel("nudge_shown", { changes: Array.isArray(undos) ? undos.length : 0 });
	const timer = window.setTimeout(dismiss_nudge, NUDGE_TIMEOUT_MS);
	$nudge.on("remove", () => { clearTimeout(timer); });
	$G.on("resize.publish-nudge", position_nudge);
	$G.on("keydown.publish-nudge", (e) => { if (e.key === "Escape") { dismiss_nudge(); } });
}

function position_nudge() {
	if (!$nudge || !$publish) { return; }
	const rect = $publish[0].getBoundingClientRect();
	const width = $nudge.outerWidth() || 240;
	$nudge.css({ top: `${rect.bottom + 6}px`, left: `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px` });
}

function dismiss_nudge() {
	if (!$nudge) { return; }
	$nudge.remove();
	$nudge = null;
	$G.off(".publish-nudge");
}

/**
 * Adds the button to the page bar (site-button.js init_page_label) and keeps it current.
 * @param {JQuery} $bar
 */
function init_publish_button($bar) {
	opened_at = Date.now();
	$publish = /** @type {JQuery<HTMLButtonElement>} */ ($(E("button")).attr({ type: "button" }).addClass("page-publish").text(localize("Publish")).appendTo($bar));
	$publish.on("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // (a text being edited keeps its caret)
	$publish.on("click", () => { dismiss_nudge(); publish_current_page("button"); });
	$G.on("site-page-opened site-page-restored site-settings-changed", () => { opened_at = Date.now(); first_change_sent = false; refresh(); });
	$G.on("history-update session-update", refresh);
	refresh();

	$("<style>").text(`
		.page-publish {
			flex: none;
			margin-left: auto;
			height: 16px;
			padding: 0 10px;
			font: bold 11px/14px Arial, Helvetica, sans-serif;
			min-width: 0;
			white-space: nowrap;
		}
		.page-publish.page-publish-first {
			color: var(--HotTrackingColor, #000080);
		}
		.page-publish.page-publish-dirty::before {
			content: "\\2022 ";
		}
		.publish-nudge {
			position: fixed;
			z-index: 1000;
			max-width: min(260px, calc(100vw - 16px));
			padding: 6px 8px;
			background: #ffffe1;
			color: #000;
			border: 1px solid #000;
			box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.35);
			font: 11px/1.4 Arial, Helvetica, sans-serif;
		}
		.publish-nudge::before {
			content: "";
			position: absolute;
			top: -7px;
			right: 14px;
			border: 6px solid transparent;
			border-top: 0;
			border-bottom-color: #000;
		}
		.publish-nudge::after {
			content: "";
			position: absolute;
			top: -6px;
			right: 14px;
			border: 6px solid transparent;
			border-top: 0;
			border-bottom-color: #ffffe1;
		}
		.publish-nudge-row {
			margin-top: 6px;
			display: flex;
			gap: 4px;
			justify-content: flex-end;
		}
		.publish-nudge-row button {
			font: 11px Arial, Helvetica, sans-serif;
			min-width: 0;
			padding: 1px 8px;
		}
		.publish-nudge-go {
			font-weight: bold;
		}
	`).appendTo(document.head);
}

export { init_publish_button };
