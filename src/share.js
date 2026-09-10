// @ts-check
// eslint-disable-next-line no-unused-vars
/* global file_format:writable, file_name:writable, system_file_handle:writable */
/* global localize */
// Share a page: File › Share Page… (and the Share button at the bottom right) shows a link and a QR code that
// lets anyone join this page's live room right away — no sign-in. The link carries a share key (worker/editor:
// HMAC of site + page + expiry), good for that one page only. Opening such a link puts Paint in guest mode:
// `system_file_handle = { site_page, guest: { site, key } }`; the live session connects with the key, and Save
// publishes the page with it. Guests can pass the same link on; only the owner can mint new ones.
import { $DialogWindow } from "./$ToolWindow.js";
import { HTML_FORMAT_ID } from "./collage-format.js";
import { update_title } from "./functions.js";
import { $G, E } from "./helpers.js";
import { qr_modules, render_qr_canvas } from "./qr.js";
import { preview_path, render_share_preview } from "./share-preview.js";
import { current_site, get_site_editor_url, is_signed_in, load_settings, show_publish_dialog } from "./site-publish.js";

const JOIN_KEY = "jspaint join"; // sessionStorage: the share link this tab opened with (survives the app's own reloads)
// <site>/<page>/<key>; the page may itself contain slashes (encoded in links, decoded by URLSearchParams).
const JOIN_VALUE = /^([a-z0-9-]+)\/(.+)\/(\d+\.[A-Za-z0-9_-]+)$/;
const PREVIEW_MIN_INTERVAL_MS = 45000;

/** @param {string | null} value - "<site>/<page>/<key>" */
function parse_join(value) {
	const match = value && JOIN_VALUE.exec(value);
	if (!match) { return null; }
	try {
		return { site: match[1], page: decodeURIComponent(match[2]), key: match[3] };
	} catch (_error) {
		return null;
	}
}

// A share link is /?join=<site>/<page>/<key> (in the query so the editor Worker sees it and can answer with a link
// preview); older links used #join:…. Take either before sessions.js rewrites the URL to its own #local:… session id.
(() => {
	const from_query = parse_join(new URLSearchParams(location.search).get("join"));
	const from_hash = location.hash.startsWith("#join:") ? parse_join(location.hash.slice("#join:".length)) : null;
	const join = from_query || from_hash;
	if (join) {
		try {
			sessionStorage.setItem(JOIN_KEY, JSON.stringify(join));
		} catch (_error) { /* ignore */ }
		history.replaceState(null, "", location.pathname);
	}
})();

/** @returns {{ site: string, key: string } | null} the guest pass this document is being edited with */
function guest_info() {
	return system_file_handle && typeof system_file_handle === "object" && system_file_handle.guest ? system_file_handle.guest : null;
}

/** The page this document is (owner or guest), or null. */
function current_site_page() {
	return system_file_handle && typeof system_file_handle === "object" && typeof system_file_handle.site_page === "string" ? system_file_handle.site_page : null;
}

/**
 * @param {string} site @param {string} page @param {string} key
 */
function share_url(site, page, key) {
	return `${location.origin}${location.pathname}?join=${site}/${encodeURIComponent(page)}/${key}`;
}

/**
 * Renders the page's preview card and puts it on the site (previews/<page>.png), so the link unfurls with the
 * picture as it is now. Owner or guest; guests' keys allow this path.
 * @param {string} site @param {string} page
 */
async function upload_share_preview(site, page) {
	const guest = guest_info();
	const headers = guest ?
		{ Authorization: `Invite ${guest.key}`, "X-Invite-Page": page } :
		{ Authorization: `Bearer ${load_settings().secret}` };
	const blob = await render_share_preview();
	const response = await fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files/${preview_path(page)}`, {
		method: "PUT",
		headers: { ...headers, "Content-Type": "image/png" },
		body: blob,
	});
	if (!response.ok) {
		throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
	}
}

// Once a page has been shared from this tab (or was joined from a link), keep its preview card roughly current:
// after changes settle, at most every PREVIEW_MIN_INTERVAL_MS.
let keep_preview_fresh = false;
let preview_timer = 0;
let last_preview_at = 0;
function schedule_preview_refresh() {
	if (!keep_preview_fresh) { return; }
	const page = current_site_page();
	const site = current_site();
	if (!page || !site || (!guest_info() && !is_signed_in())) { return; }
	clearTimeout(preview_timer);
	const wait = Math.max(5000, PREVIEW_MIN_INTERVAL_MS - (Date.now() - last_preview_at));
	preview_timer = window.setTimeout(() => {
		last_preview_at = Date.now();
		upload_share_preview(site, page).catch(() => { /* best effort */ });
	}, wait);
}

/**
 * Asks the editor Worker for a share key (owner only).
 * @param {string} page
 * @param {number} days
 */
async function make_share_key(page, days) {
	const { site, secret } = load_settings();
	const response = await fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/rooms/${encodeURIComponent(page)}/invite`, {
		method: "POST",
		headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
		body: JSON.stringify({ days }),
	});
	if (!response.ok) {
		throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
	}
	return /** @type {Promise<{ key: string, expires: string }>} */ (response.json());
}

/** Joins as a guest, from a share link this tab was opened with (called once the app is up). */
function join_from_share_link() {
	/** @type {{ site: string, page: string, key: string } | null} */
	let join = null;
	try {
		join = JSON.parse(sessionStorage.getItem(JOIN_KEY) || "null");
	} catch (_error) { /* ignore */ }
	if (!join || !join.site || !join.page || !join.key) { return; }
	system_file_handle = { site_page: join.page, guest: { site: join.site, key: join.key } };
	file_name = join.page;
	file_format = HTML_FORMAT_ID;
	update_title();
	keep_preview_fresh = true;
	$G.triggerHandler("site-page-opened", [{ page: join.page, authoritative: false }]);
}

/** File › Share Page… */
function show_share_dialog() {
	const page = current_site_page();
	const $w = $DialogWindow(localize("Share Page"));
	$w.addClass("share-window squish");
	const $main = $w.$main;
	if (!page || (!guest_info() && !is_signed_in())) {
		$(E("p")).text(localize("Sharing works on a page of your site. Save this picture to My Site first, then share it — or sign in and open a page.")).appendTo($main);
		$w.$Button(localize("Save to My Site…"), () => { $w.close(); show_publish_dialog(); }, { type: "submit" });
		$w.$Button(localize("Close"), () => { $w.close(); });
		$w.center();
		return;
	}
	const guest = guest_info();
	const site = current_site();
	keep_preview_fresh = true;
	$(E("p")).addClass("share-blurb").text(localize("Anyone with this link can draw on %1 with you, live, right away — no sign-in. It works for this page only.", page)).appendTo($main);
	const $link_row = $(E("div")).addClass("share-link-row").appendTo($main);
	const $link = /** @type {JQuery<HTMLInputElement>} */ ($(E("input")).attr({ type: "text", readonly: "readonly", spellcheck: "false", "aria-label": localize("Share link") }).appendTo($link_row));
	const $copy = $(E("button")).attr({ type: "button" }).text(localize("Copy")).appendTo($link_row);
	const $qr = $(E("div")).addClass("share-qr inset-deep").appendTo($main);
	const $status = $(E("div")).addClass("share-status").appendTo($main);
	const $options = $(E("div")).addClass("share-options").appendTo($main);
	/** @type {JQuery<HTMLSelectElement> | null} */
	let $days = null;
	if (!guest) {
		const $label = $(E("label")).text(`${localize("Link works for:")} `).appendTo($options);
		$days = /** @type {JQuery<HTMLSelectElement>} */ ($(E("select")).appendTo($label));
		for (const [value, text] of [["1", localize("1 day")], ["7", localize("1 week")], ["30", localize("1 month")], ["365", localize("1 year")]]) {
			$(E("option")).val(value).text(text).appendTo($days);
		}
		$days.val("30");
	}

	const show_link = (/** @type {string} */ url, /** @type {string} */ note) => {
		$link.val(url);
		$qr.empty();
		try {
			$qr.append(render_qr_canvas(qr_modules(url), 4));
		} catch (error) {
			$qr.text(`${localize("(no QR code:")} ${error.message})`);
		}
		$status.text(note);
	};
	// The link's preview card (what messaging apps show) is the page as it is now.
	const update_preview = () => {
		last_preview_at = Date.now();
		upload_share_preview(site, page).then(() => {
			if ($w.closed) { return; }
			$status.text(`${$status.text()} ${localize("Link preview updated.")}`.trim());
		}).catch(() => { /* the link still works; the preview falls back to the saved picture */ });
	};
	const refresh = async () => {
		if (guest) {
			show_link(share_url(guest.site, page, guest.key), localize("You joined with this link. Pass it on to bring someone else in."));
			update_preview();
			return;
		}
		$status.text(localize("Making a link…"));
		try {
			const days = Number($days?.val()) || 30;
			const { key, expires } = await make_share_key(page, days);
			show_link(share_url(site, page, key), localize("Works until %1. Making a new link doesn't cancel old ones.", new Date(expires).toLocaleDateString()));
			update_preview();
		} catch (error) {
			$status.text(`${localize("Couldn't make a link:")} ${error.message}`);
		}
	};
	$copy.on("click", async () => {
		const url = String($link.val());
		try {
			await navigator.clipboard.writeText(url);
			$status.text(localize("Copied!"));
		} catch (_error) {
			$link.trigger("focus");
			/** @type {HTMLInputElement} */ ($link[0]).select();
			$status.text(localize("Select the link and copy it."));
		}
	});
	$days?.on("change", () => { refresh(); });
	$link.on("focus", () => { /** @type {HTMLInputElement} */ ($link[0]).select(); });

	if (!guest) { $w.$Button(localize("New Link"), () => { refresh(); }); }
	$w.$Button(localize("Close"), () => { $w.close(); });
	$w.$content.css({ width: "min(440px, 92vw)" });
	$w.center();
	refresh();
}

/** Call once the app is up (app.js): joins from a share link if there is one, and keeps shared pages' previews fresh. */
function init_share() {
	$G.on("history-update", schedule_preview_refresh);
	window.addEventListener("load", () => { setTimeout(join_from_share_link, 400); });

	$("<style>").text(`
		.share-blurb {
			margin: 0 0 8px;
		}
		.share-link-row {
			display: flex;
			gap: 4px;
			margin-bottom: 8px;
		}
		.share-link-row input {
			flex: 1;
			min-width: 0;
			font: 12px monospace;
		}
		.share-qr {
			display: flex;
			justify-content: center;
			padding: 6px;
			background: #fff;
			min-height: 120px;
		}
		.share-qr canvas {
			image-rendering: pixelated;
			max-width: 100%;
		}
		.share-status {
			margin-top: 6px;
			min-height: 1.2em;
			font-size: 12px;
		}
		.share-options {
			margin-top: 6px;
			font-size: 12px;
		}
	`).appendTo(document.head);
}

export { current_site_page, guest_info, init_share, show_share_dialog };
