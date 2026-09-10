// @ts-check
// eslint-disable-next-line no-unused-vars
/* global file_format:writable, file_name:writable, saved:writable, system_file_handle:writable */
/* global localize, new_local_session */
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
import { DEFAULT_SITES_URL, default_editor_url } from "./site-constants.js";
import { get_site_editor_url, get_site_files_base, is_signed_in, load_settings, save_settings, show_publish_dialog } from "./site-publish.js";

/** @type {string | null} learned from /api/whoami */
let sites_url = null;

/** The public URL of a page (or file) of the signed-in site. */
function public_url(path = "index.html") {
	const { site } = load_settings();
	return `${(sites_url || DEFAULT_SITES_URL).replace(/\/+$/, "")}/~${site}/${path === "index.html" ? "" : path}`;
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
		const error = new Error(response.status === 401 ? "The edit secret was rejected." : message);
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
		const info = await (await api("/api/whoami")).json();
		sites_url = info.sites_url || sites_url;
		refresh_x_element_kinds();
		return true;
	} catch (_error) {
		return false;
	}
}

/**
 * File > Sign In to My Site…
 * @returns {Promise<boolean>} signed in
 */
function show_sign_in_dialog() {
	return new Promise((resolve) => {
		const settings = load_settings();
		let done = false;
		const $w = $DialogWindow(localize("Sign In to My Site"));
		$w.addClass("my-site-sign-in squish");
		$(E("p")).text(localize("Your site lives at …/~name/. Enter the name and the edit secret.")).appendTo($w.$main);
		/** @param {string} label @param {string} value @param {object} attrs */
		const field = (label, value, attrs) => {
			const $row = $(E("label")).addClass("my-site-row").text(`${label} `).appendTo($w.$main);
			return $(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", ...attrs }).val(value).appendTo($row);
		};
		const $site = field(localize("Site name:"), settings.site, { placeholder: "e.g. jack", autocapitalize: "off", name: "site-name" });
		const $secret = field(localize("Edit secret:"), settings.secret, { type: "password", autocomplete: "new-password", name: "edit-secret" });
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
				$status.text("The edit secret is needed to save to the site.");
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
				$status.text(`Couldn't sign in at ${editor_url}: the secret was rejected or the editor is unreachable.`);
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
				$(E("li")).addClass("my-site-empty").text(localize("Nothing here yet. New Page… makes your first page; Save to My Site puts this picture up.")).appendTo($list);
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
		const $name = $(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", placeholder: "about.html" }).val("about.html").appendTo($label);
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

export { check_sign_in, ensure_signed_in, list_files, open_live_page, open_page_from_site, public_url, save_page_to_site, show_my_site_dialog, show_sign_in_dialog, sign_out, upload_asset };
