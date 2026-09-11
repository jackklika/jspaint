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
import { escape_html, refresh_x_element_kinds } from "./block-kinds.js";
import { HTML_FORMAT_ID, is_collage_html, open_collage_from_file } from "./collage-format.js";
import { are_you_sure, reset_canvas_and_history, reset_file, reset_selected_colors, set_magnification, show_error_message, update_title } from "./functions.js";
import { $G, E } from "./helpers.js";
import { DEFAULT_SITES_URL, ROOT_SITE, default_editor_url, is_hosted_editor, site_public_url } from "./site-constants.js";
import { get_site_editor_url, get_site_files_base, is_signed_in, load_settings, save_settings, show_publish_dialog } from "./site-publish.js";

/** @type {string | null} learned from /api/whoami */
let sites_url = null;
/** @type {"master" | "site" | null} what the saved password is, learned from /api/whoami */
let role = null;
/** @type {number | null} when the site got its password (ms), from /api/whoami; null when unknown */
let site_created = null;

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
		// Nobody in particular, on the hosted editor: the domain's own front page, as a copy to play with (saving it
		// means signing in). A dev server or a plain jspaint starts blank.
		if (is_hosted_editor()) { await open_page_copy(ROOT_SITE, "index.html"); }
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
	const opened = await open_collage_from_file(new File([text], path, { type: HTML_FORMAT_ID }), { base_url: base + page_folder(path), site_page: path });
	if (opened) {
		saved = true; // nothing of yours in it yet
		if (site !== load_settings().site) {
			system_file_handle = { site_page: path, copy_of: site };
		}
		update_title();
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
		site_created = typeof info.created === "number" ? info.created : null;
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
	const opened = await open_collage_from_file(new File([text], path, { type: HTML_FORMAT_ID }), { base_url: get_site_files_base() + page_folder(path), site_page: path });
	if (opened) {
		saved = true; // it is what's on the site (restoring the layers after the bitmap had marked it changed)
		update_title();
		$G.triggerHandler("site-page-opened", [{ page: path, authoritative: false }]); // live-session.js joins the page's room
	}
	return opened;
}

// ---- site settings (site.json): folders marked as posts, titles ----

/** @returns {Promise<any>} the site's settings object ({} when there's none) */
async function site_settings() {
	const { site } = load_settings();
	try {
		const response = await fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files/site.json?optional`);
		if (response.status !== 200) { return {}; }
		const settings = await response.json();
		return settings && typeof settings === "object" ? settings : {};
	} catch (_error) {
		return {};
	}
}

/**
 * Merges into site.json (folders merge per folder).
 * @param {{ folders?: Record<string, any>, [key: string]: any }} patch
 */
async function save_site_settings(patch) {
	const settings = await site_settings();
	const merged = { ...settings, ...patch, folders: { ...(settings.folders || {}), ...(patch.folders || {}) } };
	await write_file("site.json", JSON.stringify(merged, null, "\t"), "application/json");
	return merged;
}

/** The folder part of a page path, with its slash: "posts/x.html" → "posts/", "index.html" → "". @param {string} path */
function page_folder(path) {
	return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

/** A short lowercase file name from a title: "My trip to Ohio!" → "my-trip-to-ohio". @param {string} title */
function slug_for(title) {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "post";
}

/**
 * Starts a new post: a page in the posts folder (marked as such in site.json, so the folder view and the feed pick
 * it up) with a title section, the date, and a section to write in. Saved to the site on Ctrl+S.
 * @param {string} folder - like posts
 * @param {string} title
 */
async function new_site_post(folder, title) {
	const path = `${folder}/${slug_for(title)}.html`;
	await save_site_settings({ folders: { [folder]: { kind: "posts", ...((await site_settings()).folders?.[folder] || {}) } } }).catch(() => { /* the post still works; the feed needs the mark */ });
	are_you_sure(() => {
		$(window).triggerHandler("session-update");
		new_local_session();
		reset_file();
		reset_selected_colors();
		reset_canvas_and_history();
		set_magnification(1);
		file_name = path;
		file_format = HTML_FORMAT_ID;
		system_file_handle = { site_page: path, fresh: true }; // fresh: saving asks before replacing a page of that name
		add_block("section", { x: 0, y: 0 }, { html: `<h1>${escape_html(title)}</h1><p><small>Posted <x-updated label="">today</x-updated></small></p>`, edit: false });
		add_block("section", { x: 0, y: 0 }, { html: "Write your post here." });
		saved = false;
		update_title();
		$G.triggerHandler("site-page-opened", [{ page: path, authoritative: true }]);
	});
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
		system_file_handle = { site_page: path, fresh: true }; // fresh: saving asks before replacing a page of that name
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
/** @type {((tab: string) => void) | null} the open folder's tab switcher */
let switch_folder_tab = null;

/**
 * File > My Site…: your site in three tabs — Site (its name and address, when it was made, what's on it), Pages (every
 * page as a thumbnail, and + for a new one), Files (everything on the site: GeoCities File Manager energy).
 * @param {{ tab?: "site" | "pages" | "files" }} [options]
 */
async function show_my_site_dialog({ tab = "site" } = {}) {
	if ($folder) {
		$folder.bringToFront();
		if (switch_folder_tab) { switch_folder_tab(tab); }
		return;
	}
	if (!await ensure_signed_in()) { return; }
	const $w = $folder = $DialogWindow(localize("My Site"));
	$w.addClass("my-site-window squish");
	const $tabs = $(E("div")).addClass("my-site-tabs").attr({ role: "tablist" }).appendTo($w.$main);
	const $panels = $(E("div")).addClass("my-site-panels").appendTo($w.$main);
	/** @type {Record<string, { $tab: JQuery, $panel: JQuery }>} */
	const tabs = {};
	/** @param {string} id */
	const show_tab = (id) => {
		if (!tabs[id]) { return; }
		for (const [key, entry] of Object.entries(tabs)) {
			entry.$tab.toggleClass("selected", key === id).attr({ "aria-selected": String(key === id), tabindex: key === id ? "0" : "-1" });
			entry.$panel.toggle(key === id);
		}
	};
	/** A tab and its panel (a Windows 98 property sheet). @param {string} id @param {string} label */
	const add_tab = (id, label) => {
		const $tab = $(E("div")).addClass("my-site-tab").attr({ role: "tab", tabindex: "-1", "aria-selected": "false", "data-tab": id }).text(label).appendTo($tabs);
		const $panel = $(E("div")).addClass("my-site-panel").attr({ role: "tabpanel", "data-tab": id }).hide().appendTo($panels);
		$tab.on("click", () => { show_tab(id); });
		$tab.on("keydown", (e) => {
			if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") { return; }
			const ids = Object.keys(tabs);
			const next = ids[(ids.indexOf(id) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
			show_tab(next);
			tabs[next].$tab.trigger("focus");
			e.preventDefault();
		});
		tabs[id] = { $tab, $panel };
		return $panel;
	};
	switch_folder_tab = show_tab;
	const $site_panel = add_tab("site", localize("Site"));
	const $pages_panel = add_tab("pages", localize("Pages"));
	const $files_panel = add_tab("files", localize("Files"));
	const $summary = $(E("div")).addClass("my-site-summary").appendTo($site_panel);
	const $site_tools = $(E("div")).addClass("my-site-toolbar my-site-site-tools").appendTo($site_panel);
	const $tiles = $(E("div")).addClass("my-site-pages inset-deep").attr({ role: "listbox", "aria-label": localize("Pages") }).appendTo($pages_panel);
	const $page_tools = $(E("div")).addClass("my-site-toolbar my-site-page-tools").appendTo($pages_panel);
	const $toolbar = $(E("div")).addClass("my-site-toolbar").appendTo($files_panel);
	const $list = $(E("ul")).addClass("my-site-files inset-deep").attr({ role: "listbox" }).appendTo($files_panel);
	const $status = $(E("div")).addClass("my-site-status").appendTo($w.$main);
	const $file_input = $(E("input")).attr({ type: "file", multiple: "multiple", accept: "image/gif,image/png,image/jpeg,image/webp,audio/mpeg,audio/midi,audio/wav,audio/ogg,.mid,.midi" }).hide().appendTo($w.$main);
	/** @typedef {{ path: string, size: number, uploaded: string }} SiteFile */
	/** @type {SiteFile | null} */
	let selected = null;
	/** @type {SiteFile[] | null} what the site holds, once listed (null until then) */
	let listed_files = null;
	const is_page = (/** @type {string} */ path) => /\.html?$/i.test(path);
	const is_index = (/** @type {string} */ path) => /^index\.html?$/i.test(path);
	const kb = (/** @type {number} */ bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

	/** @param {JQuery} $bar @param {string} label @param {() => void} action */
	const button = ($bar, label, action) => $(E("button")).attr({ type: "button" }).text(label).on("click", action).appendTo($bar);
	/** @param {{ path: string } | null} file */
	const open_selected = async (file = selected) => {
		if (!file) { return; }
		if (await open_page_from_site(file.path)) {
			$w.close();
		}
	};
	const view_selected = () => { if (selected) { window.open(public_url(selected.path), "_blank", "noopener"); } };
	const delete_selected = () => {
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
	};
	const versions_of_selected = () => { show_versions_dialog(selected && is_page(selected.path) ? selected.path : (system_file_handle && typeof system_file_handle === "object" && system_file_handle.site_page) || "index.html"); };

	// Files: the whole toolbar
	const $open = button($toolbar, localize("Open"), () => { open_selected(); });
	const $view = button($toolbar, localize("View"), view_selected);
	button($toolbar, localize("New Page…"), () => { show_new_page_dialog(); });
	button($toolbar, localize("New Post…"), () => { show_new_post_dialog(); });
	button($toolbar, localize("Upload…"), () => { $file_input.trigger("click"); });
	const $delete = button($toolbar, localize("Delete"), delete_selected);
	button($toolbar, localize("Folder…"), () => { show_folder_dialog(selected && selected.path.includes("/") ? selected.path.slice(0, selected.path.lastIndexOf("/")) : "posts"); });
	button($toolbar, localize("Versions…"), versions_of_selected);
	button($toolbar, localize("Refresh"), () => { refresh(); });
	// Pages: what you do with a page (+ in the grid makes one)
	const $open_page = button($page_tools, localize("Open"), () => { open_selected(); });
	const $view_page = button($page_tools, localize("View"), view_selected);
	button($page_tools, localize("New Post…"), () => { show_new_post_dialog(); });
	const $versions_page = button($page_tools, localize("Versions…"), versions_of_selected);
	const $delete_page = button($page_tools, localize("Delete"), delete_selected);
	// Site: the site as a whole
	button($site_tools, localize("View Site"), () => { window.open(public_url(""), "_blank", "noopener"); });
	button($site_tools, localize("Site Style…"), () => { show_site_css_dialog(); });
	button($site_tools, localize("Sign Out"), () => { sign_out(); $w.close(); });

	const update_buttons = () => {
		const page_selected = !!selected && is_page(selected.path);
		$open.add($open_page).add($versions_page).prop("disabled", !page_selected);
		$view.add($view_page).add($delete).add($delete_page).prop("disabled", !selected);
	};
	/** The same selection in both views. @param {SiteFile | null} file */
	const select_file = (file) => {
		selected = file;
		$list.find(".my-site-row").add($tiles.find(".my-site-tile")).each((_i, el) => { $(el).toggleClass("selected", !!file && el.dataset.path === file.path); });
		update_buttons();
	};

	/** Site: name, address, dates, what's on it. @param {SiteFile[]} files */
	const render_summary = async (files) => {
		const { site } = load_settings();
		const stamps = files.map((file) => Date.parse(file.uploaded)).filter(Number.isFinite);
		const first_upload = stamps.length ? Math.min(...stamps) : null;
		const created = site_created || first_upload;
		const updated = stamps.length ? Math.max(...stamps) : null;
		const pages = files.filter((file) => is_page(file.path));
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		const settings = await site_settings();
		const posts_folders = Object.entries(settings.folders || {}).filter(([, config]) => config && config.kind === "posts").map(([name]) => name);
		$summary.empty();
		const $head = $(E("div")).addClass("my-site-summary-head").appendTo($summary);
		$(E("span")).addClass("site-globe site-globe-static").appendTo($head);
		const $titles = $(E("div")).appendTo($head);
		$(E("div")).addClass("my-site-summary-name").text(site === ROOT_SITE ? new URL(public_url("")).host : `~${site}`).appendTo($titles);
		$(E("a")).addClass("my-site-summary-address").attr({ href: public_url(""), target: "_blank", rel: "noopener" }).text(public_url("")).appendTo($titles);
		const $facts = $(E("table")).addClass("my-site-facts").appendTo($summary);
		/** @param {string} label @param {string} value */
		const fact = (label, value) => {
			const $tr = $(E("tr")).appendTo($facts);
			$(E("th")).text(label).appendTo($tr);
			$(E("td")).text(value).appendTo($tr);
		};
		fact(localize("Created:"), created ? new Date(created).toLocaleDateString(undefined, { dateStyle: "long" }) : localize("not yet — nothing's been put up"));
		fact(localize("Updated:"), updated ? new Date(updated).toLocaleString() : "—");
		fact(localize("Pages:"), pages.length ? `${pages.length}${pages.some((file) => is_index(file.path)) ? "" : ` — ${localize("no front page (index.html) yet")}`}` : localize("none yet"));
		fact(localize("Files:"), `${files.length} (${kb(bytes)})`);
		if (posts_folders.length) { fact(localize("Posts:"), posts_folders.map((folder) => `${folder}/ (RSS: ${folder}/feed.xml)`).join(", ")); }
		fact(localize("Signed in:"), role === "master" ? localize("with the master key") : localize("with this site's password"));
		$(E("p")).addClass("my-site-note").text(site === ROOT_SITE ? localize("The front page of the domain: its pages live at the root address, other sites at ~name.") : localize("Pages shows your pages as thumbnails; Files, everything on the site.")).appendTo($summary);
	};

	/** Pages: thumbnails, like a folder of pictures, with + at the end. @param {SiteFile[]} files */
	const render_pages = (files) => {
		$tiles.empty();
		const by_path = new Map(files.map((file) => [file.path, file]));
		const pages = files.filter((file) => is_page(file.path)).sort((a, b) => (is_index(a.path) ? -1 : is_index(b.path) ? 1 : a.path.localeCompare(b.path)));
		if (pages.length === 0) {
			$(E("div")).addClass("my-site-empty my-site-pages-empty").text(localize("No pages yet. + makes your front page (index.html).")).appendTo($tiles);
		}
		for (const file of pages) {
			const bitmap = by_path.get(`collages/${file.path.replace(/\.html?$/i, "")}.png`);
			const $tile = $(E("div")).addClass("my-site-tile").attr({ role: "option", tabindex: "0", "data-path": file.path, title: `${file.path} · ${kb(file.size)} · ${new Date(file.uploaded).toLocaleString()}` }).appendTo($tiles);
			const $thumb = $(E("div")).addClass("my-site-thumb").appendTo($tile);
			if (bitmap) {
				$(E("img")).attr({ src: `${public_url(bitmap.path)}?v=${Date.parse(bitmap.uploaded) || 0}`, alt: "", draggable: "false" }).appendTo($thumb); // (the site's copy; ?v= so a new save shows)
			} else {
				$thumb.addClass("my-site-thumb-blank").text("📄");
			}
			$(E("span")).addClass("my-site-tile-name").text(is_index(file.path) ? `${file.path} ★` : file.path).appendTo($tile);
			$tile.on("click focus", () => { select_file(file); });
			$tile.on("dblclick", () => { open_selected(file); });
			$tile.on("keydown", (e) => { if (e.key === "Enter") { open_selected(file); } });
		}
		const $new = $(E("div")).addClass("my-site-tile my-site-new").attr({ role: "button", tabindex: "0", title: localize("New Page…") }).appendTo($tiles);
		$(E("div")).addClass("my-site-thumb my-site-thumb-blank").text("+").appendTo($new);
		$(E("span")).addClass("my-site-tile-name").text(localize("New Page")).appendTo($new);
		$new.on("click", () => { show_new_page_dialog(); });
		$new.on("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show_new_page_dialog(); } });
	};

	/** Files: every file, one per line. @param {SiteFile[]} files */
	const render_files = (files) => {
		$list.empty();
		if (files.length === 0) {
			$(E("li")).addClass("my-site-empty").text(localize("Nothing here yet. New Page… makes your front page (index.html); Save to My Site puts this picture up as it.")).appendTo($list);
		}
		for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
			const $row = $(E("li")).addClass("my-site-row").attr({ role: "option", tabindex: "0", "data-path": file.path }).appendTo($list);
			$(E("span")).addClass("my-site-icon").text(is_page(file.path) ? "📄" : /\.(gif|png|jpe?g|webp)$/i.test(file.path) ? "🖼" : /\.(mp3|mid|midi|wav|ogg)$/i.test(file.path) ? "♫" : "📎").appendTo($row);
			$(E("span")).addClass("my-site-name").text(file.path).appendTo($row);
			$(E("span")).addClass("my-site-meta").text(`${kb(file.size)} · ${new Date(file.uploaded).toLocaleDateString()}`).appendTo($row);
			$row.on("click focus", () => { select_file(file); });
			$row.on("dblclick", () => {
				if (is_page(file.path)) { open_selected(file); } else { window.open(public_url(file.path), "_blank", "noopener"); }
			});
			$row.on("keydown", (e) => { if (e.key === "Enter") { $row.trigger("dblclick"); } });
		}
	};

	const refresh = async () => {
		const { site } = load_settings();
		$w.title(`${localize("My Site")} — ${site === ROOT_SITE ? new URL(public_url("")).host : `~${site}`}`);
		$status.text(localize("Loading…"));
		$list.empty();
		$tiles.empty();
		select_file(null);
		try {
			const all_files = (await list_files()).files;
			const files = all_files.filter((/** @type {{ path: string }} */ file) => !file.path.startsWith("versions/")); // old copies live under Versions…
			listed_files = files;
			render_pages(files);
			render_files(files);
			const $link = $(E("a")).attr({ href: public_url(""), target: "_blank", rel: "noopener" }).text(public_url(""));
			$status.empty().append(document.createTextNode(`${files.length} file${files.length === 1 ? "" : "s"} · `), $link);
			await render_summary(files);
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
		// The first page of a site is its front page — but only once we know the site has none (the listing is async;
		// suggesting index.html for a site that has one would overwrite the front page on save).
		const has_index = !listed_files || listed_files.some((file) => /^index\.html?$/i.test(file.path));
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

	const show_new_post_dialog = () => {
		const $d = $DialogWindow(localize("New Post"));
		$d.addClass("new-post-window");
		const $title_label = $(E("label")).addClass("my-site-row").text(`${localize("Title:")} `).appendTo($d.$main);
		const $title = $(E("input")).attr({ type: "text", spellcheck: "true", placeholder: localize("What's it about?"), name: "post-title" }).appendTo($title_label);
		const $folder_label = $(E("label")).addClass("my-site-row").text(`${localize("Folder:")} `).appendTo($d.$main);
		const $folder_name = $(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", name: "post-folder" }).val("posts").appendTo($folder_label);
		$(E("p")).addClass("my-site-note").text(localize("A post is a page in that folder, which becomes a posts folder: a Folder View element lists them, and there's an RSS feed. Save (Ctrl+S) puts it on the site.")).appendTo($d.$main);
		$d.$Button(localize("OK"), () => {
			const title = String($title.val()).trim();
			const folder = String($folder_name.val()).trim().replace(/^\/+|\/+$/g, "");
			if (!title) { $title.focus(); return; }
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(folder)) { $folder_name.focus(); return; }
			$d.close();
			$w.close();
			new_site_post(folder, title);
		}, { type: "submit" });
		$d.$Button(localize("Cancel"), () => { $d.close(); });
		$d.$content.css({ width: "min(520px, 92vw)" });
		$d.center();
		$title.focus();
	};

	/** @param {string} folder */
	const show_folder_dialog = async (folder) => {
		const settings = await site_settings();
		const config = (settings.folders && settings.folders[folder]) || {};
		const $d = $DialogWindow(localize("Folder"));
		$d.addClass("folder-window");
		const $name_label = $(E("label")).addClass("my-site-row").text(`${localize("Folder:")} `).appendTo($d.$main);
		const $name = $(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", name: "folder-name" }).val(folder).appendTo($name_label);
		const $kind_label = $(E("label")).addClass("my-site-row").text(`${localize("Kind:")} `).appendTo($d.$main);
		const $kind = $(E("select")).attr({ name: "folder-kind" }).append($(E("option")).val("").text(localize("Plain folder")), $(E("option")).val("posts").text(localize("Posts: newest first, with an RSS feed"))).val(config.kind || "").appendTo($kind_label);
		const $title_label = $(E("label")).addClass("my-site-row").text(`${localize("Title:")} `).appendTo($d.$main);
		const $title = $(E("input")).attr({ type: "text", name: "folder-title", placeholder: localize("(for the feed)") }).val(config.title || "").appendTo($title_label);
		$(E("p")).addClass("my-site-note").text(localize("Saved in site.json. A posts folder's feed is at folder/feed.xml; a Folder View element on any page lists its pages.")).appendTo($d.$main);
		$d.$Button(localize("OK"), async () => {
			const name = String($name.val()).trim().replace(/^\/+|\/+$/g, "");
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { $name.focus(); return; }
			$d.close();
			try {
				await save_site_settings({ folders: { [name]: { ...config, kind: String($kind.val()) || undefined, title: String($title.val()).trim() || undefined } } });
				$status.text(localize("Saved site.json."));
				refresh();
			} catch (error) {
				$status.text(`Couldn't save site.json: ${error.message}`);
			}
		}, { type: "submit" });
		$d.$Button(localize("Cancel"), () => { $d.close(); });
		$d.$content.css({ width: "min(520px, 92vw)" });
		$d.center();
	};

	/** Earlier saves of a page, kept by the site (the editor Worker archives a page when it's overwritten); Restore brings one back. @param {string} path */
	const show_versions_dialog = async (path) => {
		const { site } = load_settings();
		const $d = $DialogWindow(localize("Versions"));
		$d.addClass("versions-window squish");
		$(E("p")).addClass("my-site-note").text(localize("Earlier saves of %1, newest first. Restore puts one back on the site (the current one is kept as a version too).", path)).appendTo($d.$main);
		const $list = $(E("ul")).addClass("my-site-files inset-deep versions-list").attr({ role: "listbox" }).appendTo($d.$main);
		const $note = $(E("div")).addClass("my-site-status").text(localize("Loading…")).appendTo($d.$main);
		try {
			const versions = await (await api(`/api/sites/${encodeURIComponent(site)}/versions?page=${encodeURIComponent(path)}`)).json();
			$note.text(versions.versions.length ? "" : localize("No earlier saves of this page yet — they're kept from now on, each time it's saved over."));
			for (const version of versions.versions) {
				const $row = $(E("li")).addClass("my-site-row").appendTo($list);
				$(E("span")).addClass("my-site-name").text(new Date(version.uploaded).toLocaleString()).appendTo($row);
				$(E("span")).addClass("my-site-meta").text(`${Math.max(1, Math.round(version.size / 1024))} KB`).appendTo($row);
				$(E("button")).attr({ type: "button" }).text(localize("Restore")).appendTo($row).on("click", async () => {
					$note.text(localize("Restoring…"));
					try {
						await api(`/api/sites/${encodeURIComponent(site)}/versions/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: path, version: version.version }) });
						$note.text(localize("Restored. It's on the site now."));
						refresh();
						if (system_file_handle && typeof system_file_handle === "object" && system_file_handle.site_page === path) {
							open_page_from_site(path); // the picture in Paint is the restored one too
						}
					} catch (error) {
						$note.text(`Couldn't restore: ${error.message}`);
					}
				});
			}
		} catch (error) {
			$note.text(`Couldn't list versions: ${error.message}`);
		}
		$d.$Button(localize("Close"), () => { $d.close(); });
		$d.$content.css({ width: "min(520px, 92vw)" });
		$d.center();
	};

	const show_site_css_dialog = async () => {
		const { site } = load_settings();
		let css = "";
		try {
			const response = await fetch(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files/site.css?optional`);
			if (response.status === 200) { css = await response.text(); }
		} catch (_error) { /* start empty */ }
		const $d = $DialogWindow(localize("Site Style"));
		$d.addClass("site-css-window");
		$(E("p")).addClass("my-site-note").text(localize("CSS for every page of your site (site.css). Folder views are <ul class=\"folder\">, sections <div class=\"section\">, the contents list <ul class=\"toc\">.")).appendTo($d.$main);
		const $css = $(E("textarea")).attr({ rows: "14", spellcheck: "false", name: "site-css", placeholder: "body { background: #ffffd9; }\n.folder { list-style: square; }" }).css({ width: "100%", boxSizing: "border-box", font: "12px monospace" }).val(css).appendTo($d.$main);
		$d.$Button(localize("Save"), async () => {
			$d.close();
			try {
				await write_file("site.css", String($css.val()), "text/css");
				$status.text(localize("Saved site.css."));
				refresh();
			} catch (error) {
				$status.text(`Couldn't save site.css: ${error.message}`);
			}
		}, { type: "submit" });
		$d.$Button(localize("Cancel"), () => { $d.close(); });
		$d.$content.css({ width: "min(560px, 94vw)" });
		$d.center();
		$css.focus();
	};

	$w.$Button(localize("Close"), () => { $w.close(); });
	$w.on("close", () => { $folder = null; switch_folder_tab = null; });
	$w.$content.css({ width: "min(560px, 94vw)" });
	show_tab(tab);
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
		max-width: 380px; /* wraps; the dialog's button column must still fit beside it */
		white-space: normal;
	}
	/* Tabs: a Windows 98 property sheet */
	.my-site-tabs {
		display: flex;
		align-items: flex-end;
		padding: 0 2px;
		position: relative;
		z-index: 1;
	}
	.my-site-tab {
		padding: 3px 10px 2px;
		margin-right: -1px;
		background: var(--ButtonFace, #c0c0c0);
		color: var(--ButtonText, #000);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) transparent var(--ButtonHilight, #fff);
		box-shadow: inset -1px 0 var(--ButtonShadow, #808080);
		border-radius: 3px 3px 0 0;
		cursor: default;
		user-select: none;
		white-space: nowrap;
	}
	.my-site-tab.selected {
		padding: 4px 12px 4px;
		margin: -2px 0 -1px -2px;
		position: relative;
		z-index: 2;
	}
	.my-site-tab:focus-visible {
		outline: 1px dotted currentColor;
		outline-offset: -4px;
	}
	.my-site-panels {
		background: var(--ButtonFace, #c0c0c0);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) var(--ButtonDkShadow, #000) var(--ButtonHilight, #fff);
		box-shadow: inset -1px -1px var(--ButtonShadow, #808080);
		padding: 8px;
	}
	.my-site-panel > .my-site-toolbar:last-child {
		margin: 6px 0 0;
	}
	/* Site */
	.my-site-summary-head {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-bottom: 8px;
	}
	.my-site-summary-name {
		font-size: 16px;
		font-weight: bold;
	}
	.my-site-summary-address {
		font-size: 12px;
		word-break: break-all;
	}
	.my-site-facts {
		border-collapse: collapse;
		font-size: 12px;
		margin-bottom: 6px;
	}
	.my-site-facts th {
		text-align: right;
		font-weight: normal;
		opacity: 0.8;
		padding: 1px 8px 1px 0;
		white-space: nowrap;
		vertical-align: top;
	}
	.my-site-facts td {
		padding: 1px 0;
	}
	/* Pages: large icons */
	.my-site-pages {
		display: grid;
		grid-template-columns: repeat(auto-fill, 104px);
		justify-content: start;
		align-content: start;
		gap: 4px;
		height: 240px;
		overflow: auto;
		padding: 6px;
		background: var(--Window, #fff);
		color: var(--WindowText, #222);
	}
	.my-site-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		padding: 4px 2px;
		cursor: default;
		user-select: none;
	}
	.my-site-thumb {
		width: 90px;
		height: 68px;
		padding: 2px;
		box-sizing: border-box;
		background: var(--ButtonFace, #c0c0c0);
		border: 1px solid;
		border-color: var(--ButtonHilight, #fff) var(--ButtonDkShadow, #000) var(--ButtonDkShadow, #000) var(--ButtonHilight, #fff);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.my-site-thumb img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: #fff;
		border: 1px solid #000;
		box-sizing: border-box;
		image-rendering: auto;
	}
	.my-site-thumb-blank {
		font-size: 32px;
		line-height: 1;
	}
	.my-site-new .my-site-thumb {
		border-style: dashed;
		border-color: var(--ButtonShadow, #808080);
		background: transparent;
		font-size: 36px;
	}
	.my-site-tile-name {
		max-width: 100px;
		padding: 0 2px;
		font-size: 11px;
		text-align: center;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.my-site-tile.selected .my-site-tile-name {
		background: var(--Hilight, #000080);
		color: var(--HilightText, #fff);
	}
	.my-site-tile:focus-visible {
		outline: none;
	}
	.my-site-tile:focus-visible .my-site-tile-name {
		outline: 1px dotted currentColor;
	}
	.my-site-pages-empty {
		grid-column: 1 / -1;
	}
`).appendTo(document.head);

export { check_sign_in, current_role, open_site_from_url, ensure_signed_in, list_files, open_live_page, open_page_from_site, public_url, save_page_to_site, show_my_site_dialog, show_sign_in_dialog, sign_out, upload_asset };
