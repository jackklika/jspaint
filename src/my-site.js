// @ts-check
// eslint-disable-next-line no-unused-vars
/* global file_format:writable, file_name:writable, saved:writable, system_file_handle:writable */
/* global $status_text, localize, new_local_session */
// My Site, inside Paint: File > Sign In to My Site… (site name + edit secret), File > My Site… (the folder:
// pages and files with Open / New Page / Upload / Delete / View), and Save back to the site with Ctrl+S once
// a page came from there. Talks to the editor Worker's API (worker/editor/index.js); pages open through
// collage-format.js with the site's files as the base for relative assets.
import { $DialogWindow } from "./$ToolWindow.js";
import { add_block } from "./blocks.js";
import { refresh_x_element_kinds } from "./block-kinds.js";
import { HTML_FORMAT_ID, is_collage_html, open_collage_from_file } from "./collage-format.js";
import { are_you_sure, reset_canvas_and_history, reset_file, reset_selected_colors, set_magnification, show_error_message, update_title } from "./functions.js";
import { $G, E } from "./helpers.js";
import { DEFAULT_SITES_URL, ROOT_SITE, default_editor_url, site_public_url } from "./site-constants.js";
import { get_site_editor_url, get_site_files_base, is_signed_in, load_settings, save_settings, show_publish_dialog } from "./site-publish.js";

/** @type {string | null} learned from /api/whoami */
let sites_url = null;
/** @type {"master" | "site" | null} what the saved password is, learned from /api/whoami */
let role = null;

/** "master" (the edit secret: every site), "site" (this site's own password), or null when not checked yet. */
function current_role() {
	return role;
}

/** The public URL of a page (or file) of the signed-in site. */
function public_url(path = "index.html") {
	return site_public_url(load_settings().site, path, sites_url || DEFAULT_SITES_URL);
}

// edit.<domain>/~name[/page] redirects to /?site=name[&page=…]: remember it (before sessions.js rewrites the URL to
// its own #local:… id — same mechanism as the share link in share.js), and open_site_from_url() acts on it once the
// app is up. Other query params are kept (jspaint reads a few of its own).
const SITE_ENTRY_KEY = "jspaint open site"; // sessionStorage
// A plain visit (no #local:… session to restore, captured before sessions.js assigns one): signed in, Paint opens
// your site's front page rather than a blank picture — edit.<domain> is where you edit your site.
const FRESH_VISIT = !location.hash;
const PAGE_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.html?$/;
(() => {
	const params = new URLSearchParams(location.search);
	if (!params.has("site")) { return; }
	const site = (params.get("site") || "").toLowerCase();
	const page = params.get("page") || "";
	params.delete("site");
	params.delete("page");
	const rest = params.toString();
	history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
	if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(site)) { return; }
	try {
		sessionStorage.setItem(SITE_ENTRY_KEY, JSON.stringify({ site, page: PAGE_PATH.test(page) ? page : "" }));
	} catch (_error) { /* ignore */ }
})();

/**
 * Opens the site this tab was sent to (see above). Signed in as that site: the page (or the My Site folder).
 * Anyone else: a copy of the page to play with — published pages are public, so anyone may open one in Paint;
 * Save to My Site puts the copy on *your* site, and putting it back at its own address takes that site's password.
 * No page there at all: the Sign In dialog, prefilled (maybe it's yours and still empty). Read once — a reload
 * doesn't ask again.
 */
async function open_site_from_url() {
	/** @type {{ site: string, page: string } | null} */
	let entry = null;
	try {
		entry = JSON.parse(sessionStorage.getItem(SITE_ENTRY_KEY) || "null");
		sessionStorage.removeItem(SITE_ENTRY_KEY);
	} catch (_error) { /* ignore */ }
	if (!entry || !entry.site) {
		if (!FRESH_VISIT) { return; }
		if (is_signed_in() && await check_sign_in()) {
			// Your site's front page (not the page you last saved: edit.<domain>/about is the address for that)
			if (await page_exists(load_settings().site, "index.html")) { await open_page_from_site("index.html"); }
			return;
		}
		// Nobody in particular: the domain's own front page, as a copy to play with (saving it means signing in)
		await open_page_copy(ROOT_SITE, "index.html");
		return;
	}
	if (load_settings().site === entry.site && await check_sign_in()) {
		if (entry.page && await open_page_from_site(entry.page)) { return; }
		show_my_site_dialog();
		return;
	}
	if (await open_page_copy(entry.site, entry.page || "index.html")) { return; }
	if (!await show_sign_in_dialog({ site: entry.site }) || load_settings().site !== entry.site) { return; }
	if (entry.page && await open_page_from_site(entry.page)) { return; }
	show_my_site_dialog();
}

/**
 * Whether a site has that page, without signing in (site files are public) and without a console 404.
 * @param {string} site @param {string} path
 */
async function page_exists(site, path) {
	try {
		const response = await fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files/${path}?optional`, { method: "HEAD" });
		return response.status === 200;
	} catch (_error) {
		return false;
	}
}

/**
 * Opens someone's published page as a copy: read without signing in (site files are public), assets resolve
 * against that site, no live room. The document remembers whose it was (`copy_of`), and Ctrl+S / Save to My Site
 * publishes it to the site you're signed in to (asking you to sign in if you aren't).
 * @param {string} site
 * @param {string} path
 * @returns {Promise<boolean>} opened
 */
async function open_page_copy(site, path) {
	const base = `${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files/`;
	let response;
	try {
		response = await fetch(`${base}${path}?optional`); // 204 when there's no such page (a 404 would log a console error)
	} catch (_error) {
		return false;
	}
	if (response.status === 204 || response.status === 404) { return false; }
	if (!response.ok) {
		show_error_message(`Couldn't load ${site_public_url(site, path)} (HTTP ${response.status}).`);
		return false;
	}
	const text = await response.text();
	if (!is_collage_html(text)) {
		show_error_message(`${path} wasn't made with Paint (importing other pages comes later).`);
		return false;
	}
	const opened = await open_collage_from_file(new File([text], path, { type: HTML_FORMAT_ID }), { base_url: base, site_page: path });
	if (opened) {
		if (site !== load_settings().site) {
			system_file_handle = { site_page: path, copy_of: site };
		}
		$G.triggerHandler("site-settings-changed"); // the globe's tooltip: whose page this is
		$status_text.text(localize("Opened a copy of %1. Save to My Site puts it on your own site.", site_public_url(site, path)));
	}
	return opened;
}

/**
 * @param {string} path - API path
 * @param {RequestInit} [init]
 */
async function api(path, init = {}) {
	const { secret } = load_settings();
	const headers = new Headers(init.headers || {});
	if (secret) { headers.set("Authorization", `Bearer ${secret}`); }
	const response = await fetch(`${get_site_editor_url()}${path}`, { ...init, headers });
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			message = (await response.json()).error || message;
		} catch (_error) { /* not JSON */ }
		const error = new Error(response.status === 401 ? "The password was rejected." : message);
		/** @type {any} */ (error).status = response.status;
		throw error;
	}
	return response;
}

/** @returns {Promise<{ files: { path: string, size: number, uploaded: string, url: string }[] }>} */
async function list_files() {
	const { site } = load_settings();
	return (await api(`/api/sites/${encodeURIComponent(site)}/files`)).json();
}

/** @param {string} path */
function read_file(path) {
	const { site } = load_settings();
	return api(`/api/sites/${encodeURIComponent(site)}/files/${path}`);
}

/** @param {string} path @param {Blob | string} body @param {string} type */
async function write_file(path, body, type) {
	const { site } = load_settings();
	return (await api(`/api/sites/${encodeURIComponent(site)}/files/${path}`, { method: "PUT", headers: { "Content-Type": type }, body })).json();
}

/** @param {string} path */
async function delete_file(path) {
	const { site } = load_settings();
	return (await api(`/api/sites/${encodeURIComponent(site)}/files/${path}`, { method: "DELETE" })).json();
}

/** @param {Blob} blob */
async function hash_blob(blob) {
	const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const UPLOAD_EXTENSIONS = { "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/mpeg": "mp3", "audio/midi": "mid", "audio/wav": "wav", "audio/ogg": "ogg" };

/**
 * Uploads a media file content-addressed under gifs/ (images) or midi/ (audio); returns its site path.
 * @param {File} file
 */
async function upload_asset(file) {
	const type = file.type || (/\.(mid|midi)$/i.test(file.name) ? "audio/midi" : "");
	const ext = UPLOAD_EXTENSIONS[type];
	if (!ext) { throw new Error(`${file.name}: only GIF, PNG, JPEG, WebP, MP3, MIDI, WAV, and OGG files can be uploaded.`); }
	const path = `${/^audio\//.test(type) ? "midi" : "gifs"}/${await hash_blob(file)}.${ext}`;
	await write_file(path, file, type);
	return path;
}

// ---- sign in ----

/**
 * Checks the stored site name and secret against the server.
 * @returns {Promise<boolean>}
 */
async function check_sign_in() {
	if (!is_signed_in()) { return false; }
	try {
		const info = await (await api(`/api/whoami?site=${encodeURIComponent(load_settings().site)}`)).json();
		sites_url = info.sites_url || sites_url;
		role = info.role || null;
		refresh_x_element_kinds();
		return true;
	} catch (_error) {
		return false;
	}
}

/**
 * File > Sign In to My Site…
 * @param {{ site?: string }} [options] - `site` prefills the name (an edit.<domain>/~name link)
 * @returns {Promise<boolean>} signed in
 */
function show_sign_in_dialog({ site: prefill = "" } = {}) {
	return new Promise((resolve) => {
		const settings = load_settings();
		let done = false;
		const $w = $DialogWindow(localize("Sign In to My Site"));
		$w.addClass("my-site-sign-in squish");
		$(E("p")).text(prefill === ROOT_SITE ?
			localize("\"root\" is the front page of the domain itself. Enter its password.") :
			localize("Your site lives at …/~name/. Enter the name and its password.")).appendTo($w.$main);
		/** @param {string} label @param {string} value @param {object} attrs */
		const field = (label, value, attrs) => {
			const $row = $(E("label")).addClass("my-site-row").text(`${label} `).appendTo($w.$main);
			return $(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", ...attrs }).val(value).appendTo($row);
		};
		const $site = field(localize("Site name:"), prefill || settings.site, { placeholder: "e.g. jack", autocapitalize: "off", name: "site-name" });
		const $secret = field(localize("Password:"), settings.secret, { type: "password", autocomplete: "current-password", name: "password" });
		const $editor = field(localize("Editor URL:"), settings.editor_url, { placeholder: default_editor_url(), name: "editor-url" });
		const $status = $(E("div")).addClass("my-site-status").appendTo($w.$main);
		const $ok = $w.$Button(localize("Sign In"), async () => {
			const site = String($site.val()).trim().toLowerCase();
			const secret = String($secret.val());
			const editor_url = (String($editor.val()).trim() || default_editor_url()).replace(/\/+$/, "");
			if (!site) {
				$status.text("Enter a site name — it becomes your address: …/~name/");
				$site.focus();
				return;
			}
			if (/^https?:|\//.test(site)) {
				$status.text("The site name is just the name (like \"jack\"), not a URL.");
				$site.focus();
				return;
			}
			if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(site)) {
				$status.text("Site names are 1–32 lowercase letters, digits, or hyphens.");
				$site.focus();
				return;
			}
			if (!secret) {
				$status.text("The password is needed to save to the site.");
				$secret.focus();
				return;
			}
			$ok.prop("disabled", true);
			$status.text("Checking…");
			save_settings({ ...settings, site, secret, editor_url, remember_secret: true });
			if (await check_sign_in()) {
				done = true;
				$w.close();
				resolve(true);
			} else {
				$ok.prop("disabled", false);
				$status.text(`Couldn't sign in at ${editor_url}: the password was rejected or the editor is unreachable.`);
			}
		}, { type: "submit" });
		$w.$Button(localize("Cancel"), () => { $w.close(); });
		$w.on("close", () => { if (!done) { resolve(false); } });
		$w.$content.css({ width: "min(420px, 92vw)" });
		$w.center();
		($site.val() ? $secret : $site).focus();
	});
}

/** Signed in, asking first if needed. @returns {Promise<boolean>} */
async function ensure_signed_in() {
	if (await check_sign_in()) { return true; }
	return show_sign_in_dialog();
}

function sign_out() {
	const settings = load_settings();
	save_settings({ ...settings, secret: "", remember_secret: false });
	sites_url = null;
	if (system_file_handle && typeof system_file_handle === "object" && system_file_handle.site_page) {
		system_file_handle = null; // Ctrl+S goes back to saving a file
	}
}

// ---- pages ----

/**
 * Opens a page of the site as the document. Relative assets resolve against the site's files.
 * @param {string} path
 */
async function open_page_from_site(path) {
	let text;
	try {
		text = await (await read_file(path)).text();
	} catch (error) {
		show_error_message(`Couldn't load ${path} from the site.`, error);
		return false;
	}
	if (!is_collage_html(text)) {
		show_error_message(`${path} wasn't made with Paint (importing other pages comes later).`);
		return false;
	}
	const opened = await open_collage_from_file(new File([text], path, { type: HTML_FORMAT_ID }), { base_url: get_site_files_base(), site_page: path });
	if (opened) {
		$G.triggerHandler("site-page-opened", [{ page: path, authoritative: false }]); // live-session.js joins the page's room
	}
	return opened;
}

/**
 * Starts a new page for the site: a fresh 800px canvas with a heading, saved to the site on Ctrl+S.
 * @param {string} path - like about.html
 */
function new_site_page(path) {
	are_you_sure(() => {
		$(window).triggerHandler("session-update"); // autosave the old session
		new_local_session();
		reset_file();
		reset_selected_colors();
		reset_canvas_and_history();
		set_magnification(1);
		file_name = path;
		file_format = HTML_FORMAT_ID;
		system_file_handle = { site_page: path };
		add_block("heading", { x: 40, y: 30 }, { html: `<font face="Comic Sans MS" color="#ff1493">${path.replace(/\.html?$/i, "")}</font>` });
		saved = false;
		update_title();
		$G.triggerHandler("site-page-opened", [{ page: path, authoritative: true }]);
	});
}

/**
 * Saves the document as a page of the site (File > Save on a page that came from My Site).
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function save_page_to_site(path) {
	const guest = system_file_handle && typeof system_file_handle === "object" ? system_file_handle.guest : null;
	if (!guest && !await ensure_signed_in()) { return false; }
	return show_publish_dialog({ auto: true, page: path });
}

/** View > Live Page: the published page in a new tab. */
function open_live_page() {
	const path = system_file_handle && typeof system_file_handle === "object" && system_file_handle.site_page ? system_file_handle.site_page : load_settings().page || "index.html";
	window.open(public_url(path), "_blank", "noopener");
}

// ---- the folder ----

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $folder = null;

/** File > My Site…: the site's files, GeoCities File Manager energy. */
async function show_my_site_dialog() {
	if ($folder) {
		$folder.bringToFront();
		return;
	}
	if (!await ensure_signed_in()) { return; }
	const $w = $folder = $DialogWindow(localize("My Site"));
	$w.addClass("my-site-window squish");
	const $toolbar = $(E("div")).addClass("my-site-toolbar").appendTo($w.$main);
	const $list = $(E("ul")).addClass("my-site-files inset-deep").attr({ role: "listbox" }).appendTo($w.$main);
	const $status = $(E("div")).addClass("my-site-status").appendTo($w.$main);
	const $file_input = $(E("input")).attr({ type: "file", multiple: "multiple", accept: "image/gif,image/png,image/jpeg,image/webp,audio/mpeg,audio/midi,audio/wav,audio/ogg,.mid,.midi" }).hide().appendTo($w.$main);
	/** @type {{ path: string, size: number, uploaded: string } | null} */
	let selected = null;

	/** @param {string} label @param {() => void} action */
	const button = (label, action) => $(E("button")).attr({ type: "button" }).text(label).on("click", action).appendTo($toolbar);
	const $open = button(localize("Open"), () => { if (selected) { open_selected(); } });
	const $view = button(localize("View"), () => { if (selected) { window.open(public_url(selected.path), "_blank", "noopener"); } });
	button(localize("New Page…"), () => { show_new_page_dialog(); });
	button(localize("Upload…"), () => { $file_input.trigger("click"); });
	const $delete = button(localize("Delete"), () => {
		if (!selected) { return; }
		const path = selected.path;
		const $confirm = $DialogWindow(localize("Delete"));
		$(E("p")).text(`Delete ${path} from your site? This can't be undone.`).appendTo($confirm.$main);
		$confirm.$Button(localize("Delete"), async () => {
			$confirm.close();
			try {
				await delete_file(path);
				if (system_file_handle && typeof system_file_handle === "object" && system_file_handle.site_page === path) {
					system_file_handle = null;
				}
				refresh();
			} catch (error) {
				$status.text(`Couldn't delete: ${error.message}`);
			}
		}, { type: "submit" });
		$confirm.$Button(localize("Cancel"), () => { $confirm.close(); });
		$confirm.center();
	});
	button(localize("Refresh"), () => { refresh(); });
	button(localize("Sign Out"), () => { sign_out(); $w.close(); });

	const update_buttons = () => {
		$open.prop("disabled", !selected || !/\.html?$/i.test(selected.path));
		$view.prop("disabled", !selected);
		$delete.prop("disabled", !selected);
	};
	/** @param {{ path: string } | null} file */
	const open_selected = async (file = selected) => {
		if (!file) { return; }
		if (await open_page_from_site(file.path)) {
			$w.close();
		}
	};
	const refresh = async () => {
		const { site } = load_settings();
		$w.title(`${localize("My Site")} — ~${site}`);
		$status.text(localize("Loading…"));
		$list.empty();
		selected = null;
		update_buttons();
		try {
			const { files } = await list_files();
			if (files.length === 0) {
				$(E("li")).addClass("my-site-empty").text(localize("Nothing here yet. New Page… makes your front page (index.html); Save to My Site puts this picture up as it.")).appendTo($list);
			}
			for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
				const is_page = /\.html?$/i.test(file.path);
				const $row = $(E("li")).addClass("my-site-row").attr({ role: "option", tabindex: "0" }).appendTo($list);
				$(E("span")).addClass("my-site-icon").text(is_page ? "📄" : /\.(gif|png|jpe?g|webp)$/i.test(file.path) ? "🖼" : /\.(mp3|mid|midi|wav|ogg)$/i.test(file.path) ? "♫" : "📎").appendTo($row);
				$(E("span")).addClass("my-site-name").text(file.path).appendTo($row);
				$(E("span")).addClass("my-site-meta").text(`${Math.max(1, Math.round(file.size / 1024))} KB · ${new Date(file.uploaded).toLocaleDateString()}`).appendTo($row);
				$row.on("click focus", () => {
					$list.find(".my-site-row").removeClass("selected");
					$row.addClass("selected");
					selected = file;
					update_buttons();
				});
				$row.on("dblclick", () => {
					if (is_page) { open_selected(file); } else { window.open(public_url(file.path), "_blank", "noopener"); }
				});
				$row.on("keydown", (e) => { if (e.key === "Enter") { $row.trigger("dblclick"); } });
			}
			const $link = $(E("a")).attr({ href: public_url(""), target: "_blank", rel: "noopener" }).text(public_url(""));
			$status.empty().append(document.createTextNode(`${files.length} file${files.length === 1 ? "" : "s"} · `), $link);
		} catch (error) {
			$status.text(`Couldn't list the files: ${error.message}`);
		}
	};
	$file_input.on("change", async () => {
		const files = [...(/** @type {HTMLInputElement} */ ($file_input[0]).files || [])];
		$file_input.val("");
		for (const file of files) {
			$status.text(`Uploading ${file.name}…`);
			try {
				const path = await upload_asset(file);
				$status.text(`Uploaded ${path}`);
			} catch (error) {
				$status.text(`Couldn't upload ${file.name}: ${error.message}`);
				return;
			}
		}
		refresh();
	});
	const show_new_page_dialog = () => {
		const $d = $DialogWindow(localize("New Page"));
		const $label = $(E("label")).text(localize("Page file name: ")).appendTo($d.$main);
		// The first page of a site is its front page.
		const has_index = [...document.querySelectorAll(".my-site-window .my-site-name")].some((el) => el.textContent === "index.html");
		const suggested = has_index ? "about.html" : "index.html";
		const $name = $(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", placeholder: suggested }).val(suggested).appendTo($label);
		$(E("p")).addClass("my-site-note").text(localize("A fresh page opens in Paint; Save (Ctrl+S) puts it on the site.")).appendTo($d.$main);
		$d.$Button(localize("OK"), () => {
			const path = `${String($name.val()).trim().replace(/\.html?$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[._-]+/, "")}.html`;
			if (path === ".html") { $name.focus(); return; }
			$d.close();
			$w.close();
			new_site_page(path);
		}, { type: "submit" });
		$d.$Button(localize("Cancel"), () => { $d.close(); });
		$d.center();
		$name.focus();
		/** @type {HTMLInputElement} */ ($name[0]).setSelectionRange(0, 5);
	};

	$w.$Button(localize("Close"), () => { $w.close(); });
	$w.on("close", () => { $folder = null; });
	$w.$content.css({ width: "min(520px, 92vw)" });
	$w.center();
	refresh();
}

$("<style>").text(`
	.my-site-row-input, .my-site-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.my-site-sign-in .my-site-row {
		margin-bottom: 6px;
	}
	.my-site-sign-in .my-site-row input {
		flex: 1;
		min-width: 0;
	}
	.my-site-toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-bottom: 6px;
	}
	.my-site-files {
		list-style: none;
		margin: 0;
		padding: 2px;
		height: 240px;
		overflow: auto;
		background: #fff;
		color: #222;
	}
	.my-site-files .my-site-row {
		padding: 2px 4px;
		cursor: default;
		user-select: none;
	}
	.my-site-files .my-site-row.selected {
		background: #000080;
		color: #fff;
	}
	.my-site-icon {
		width: 18px;
		flex: none;
		text-align: center;
	}
	.my-site-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.my-site-meta {
		font-size: 11px;
		opacity: 0.8;
		white-space: nowrap;
	}
	.my-site-empty {
		padding: 8px;
		opacity: 0.7;
	}
	.my-site-status {
		margin-top: 6px;
		min-height: 1.2em;
		font-size: 12px;
		word-break: break-all;
	}
	.my-site-note {
		font-size: 11px;
		opacity: 0.8;
	}
`).appendTo(document.head);

export { check_sign_in, current_role, open_site_from_url, ensure_signed_in, list_files, open_live_page, open_page_from_site, public_url, save_page_to_site, show_my_site_dialog, show_sign_in_dialog, sign_out, upload_asset };
