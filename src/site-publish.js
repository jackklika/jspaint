// @ts-check
// eslint-disable-next-line no-unused-vars
/* global file_format:writable, file_name:writable, saved:writable, system_file_handle:writable */
/* global localize */
// File > Save to My Site…: publishes the page (bitmap + elements + stickers + text) on the hosted site
// builder (worker/editor). Assets are uploaded content-addressed (gifs/<hash>.gif, collages/<page>.png),
// then the page itself, through the editor Worker's API with the site's password (or the master key). The page appears at
// <sites>/~<name>/. Sign-in and the file browser live in my-site.js; the settings are shared from here.
import { $DialogWindow } from "./$ToolWindow.js";
import { HTML_FORMAT_ID, serialize_collage_html } from "./collage-format.js";
import { show_error_message, update_title } from "./functions.js";
import { $G, E } from "./helpers.js";
import { default_editor_url } from "./site-constants.js";
import { preview_path, render_share_preview } from "./share-preview.js";

const SETTINGS_KEY = "jspaint site publish settings";
const LEGACY_EDITOR_URLS = new Set(["https://coolpaint.world", "https://www.coolpaint.world"]);

/** @typedef {{ editor_url: string, site: string, page: string, secret: string, remember_secret: boolean, invite?: { key: string, page: string } }} PublishSettings */

/** @returns {PublishSettings} */
function load_settings() {
	/** @type {Partial<PublishSettings>} */
	let stored = {};
	try {
		stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
	} catch (_error) { /* ignore */ }
	// The editor used to be the apex; a browser that remembered that URL would now be talking to the pages sandbox.
	const stored_editor = (stored.editor_url || "").replace(/\/+$/, "");
	return {
		editor_url: stored_editor && !LEGACY_EDITOR_URLS.has(stored_editor) ? stored_editor : default_editor_url(),
		site: stored.site || "",
		page: stored.page || "index.html",
		secret: stored.secret || "",
		remember_secret: stored.remember_secret !== false,
	};
}

/** @param {PublishSettings} settings */
function save_settings(settings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, secret: settings.remember_secret ? settings.secret : "" }));
	} catch (_error) { /* ignore */ }
	$G.triggerHandler("site-settings-changed"); // e.g. the toolbox globe's tooltip
}

/** The editor Worker URL, for other modules (the GIF picker uses its proxy). */
function get_site_editor_url() {
	return load_settings().editor_url.replace(/\/+$/, "");
}

/** The site this document belongs to: a guest's (from a share link) or the signed-in one. */
function current_site() {
	const guest = system_file_handle && typeof system_file_handle === "object" ? system_file_handle.guest : null;
	return guest && guest.site ? guest.site : load_settings().site;
}

/** Where the current site's files can be read (public reads on the editor API), with a trailing slash; "" if no site. */
function get_site_files_base() {
	const site = current_site();
	return site ? `${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/files/` : "";
}

/** Whether a site name and secret are on file (my-site.js validates them against the server). */
function is_signed_in() {
	const { site, secret } = load_settings();
	return !!(site && secret);
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>} hex SHA-1 of the bytes
 */
async function hash_blob(blob) {
	const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {string} type */
const extension_for_type = (type) => ({ "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[type] || "png";

/**
 * Uploads the collage and its assets. Resolves with the page's public URL.
 * @param {PublishSettings} settings
 * @param {(line: string) => void} log
 */
async function publish_collage(settings, log) {
	const base = settings.editor_url.replace(/\/+$/, "");
	// A guest (share link) saves with their key, scoped to their page; the owner with the site's password (or the master key).
	const headers = settings.invite ? { Authorization: `Invite ${settings.invite.key}`, "X-Invite-Page": settings.invite.page } : { Authorization: `Bearer ${settings.secret}` };
	const api = `${base}/api/sites/${encodeURIComponent(settings.site)}/files`;
	const page_base = settings.page.replace(/\.html?$/i, "") || "index";

	/** @param {string} path @param {Blob | string} body @param {string} type */
	const upload = async (path, body, type) => {
		const response = await fetch(`${api}/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": type }, body });
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(data.error || `Upload of ${path} failed (HTTP ${response.status})`);
		}
		return data;
	};

	// Check the secret first so a typo fails fast, before any uploads; the listing tells us which
	// hashed assets are already there (one request, and no 404 noise in the console).
	const listing = await fetch(api, { headers });
	if (listing.status === 401 || listing.status === 403) {
		throw new Error(settings.invite ? "This share link has expired or doesn't cover this page." : "The password was rejected.");
	}
	if (!listing.ok) {
		throw new Error(`Couldn't reach the editor at ${base} (HTTP ${listing.status}).`);
	}
	const existing = new Set((await listing.json()).files.map((/** @type {{ path: string }} */ file) => file.path));

	let uploaded = 0, reused = 0;
	const html = await serialize_collage_html({
		title: page_base,
		asset_url: async (blob, kind) => {
			const hash = await hash_blob(blob);
			const path = kind === "bitmap" ?
				`collages/${page_base}.png` :
				`gifs/${hash}.${extension_for_type(blob.type)}`;
			if (kind === "sticker" && existing.has(path)) {
				reused++;
				return path;
			}
			await upload(path, blob, blob.type || "application/octet-stream");
			uploaded++;
			log(`Uploaded ${path} (${Math.max(1, Math.round(blob.size / 1024))} KB)`);
			// The bitmap keeps one path per page but changes with every save: a content hash in the URL beats browser caches.
			return kind === "bitmap" ? `${path}?v=${hash.slice(0, 12)}` : path;
		},
	});
	const result = await upload(`${page_base}.html`, html, "text/html");
	log(`Saved ${page_base}.html — ${uploaded} asset${uploaded === 1 ? "" : "s"} uploaded, ${reused} reused.`);
	// The link preview card (share links unfurl with it in messaging apps) shows the page as just saved.
	try {
		await upload(preview_path(`${page_base}.html`), await render_share_preview(), "image/png");
	} catch (error) {
		log(`(No link preview: ${error.message})`);
	}
	// The document now lives on the site: Ctrl+S saves it back there (functions.js file_save).
	system_file_handle = { site_page: `${page_base}.html`, ...(settings.invite ? { guest: { site: settings.site, key: settings.invite.key } } : {}) };
	file_name = `${page_base}.html`;
	file_format = HTML_FORMAT_ID;
	saved = true;
	update_title();
	$G.triggerHandler("site-page-opened", [{ page: `${page_base}.html`, authoritative: true }]); // live-session.js: the room takes this copy
	return result.url;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.auto] - start saving right away (Ctrl+S on a page that came from the site)
 * @param {string} [options.page] - page file to save as
 * @returns {Promise<boolean>} whether the page was saved
 */
function show_publish_dialog({ auto = false, page } = {}) {
	const settings = load_settings();
	if (page) { settings.page = page; } else if (system_file_handle && typeof system_file_handle === "object" && system_file_handle.site_page) { settings.page = system_file_handle.site_page; }
	const guest = system_file_handle && typeof system_file_handle === "object" && system_file_handle.guest ? system_file_handle.guest : null;
	if (guest) {
		settings.site = guest.site;
		settings.invite = { key: guest.key, page: settings.page };
	}
	const $w = $DialogWindow(localize("Save to My Site"));
	$w.addClass("site-publish-window squish");
	const $main = $w.$main;
	/** @type {(saved: boolean) => void} */
	let resolve_result = () => {};
	/** @type {Promise<boolean>} */
	const result_promise = new Promise((resolve) => { resolve_result = resolve; });
	$w.on("close", () => { resolve_result(false); });

	/** @param {string} label @param {string} key @param {object} [attrs] */
	const field = (label, key, attrs = {}) => {
		const $row = $(E("div")).addClass("site-publish-row").appendTo($main);
		const $label = $(E("label")).text(label).appendTo($row);
		const $input = $(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", ...attrs }).val(settings[key]).appendTo($label);
		return $input;
	};
	const $site = field(localize("Site name (~name): "), "site", { placeholder: "e.g. jack", autocapitalize: "off", name: "site-name" });
	const $page = field(localize("Page file: "), "page", { placeholder: "index.html", name: "page-file" });
	const $secret = field(localize("Password: "), "secret", { type: "password", autocomplete: "current-password", name: "password" });
	const $remember_row = $(E("div")).addClass("site-publish-row").appendTo($main);
	const $remember = $(E("input")).attr({ type: "checkbox", id: "site-publish-remember" }).prop("checked", settings.remember_secret).appendTo($remember_row);
	$(E("label")).attr({ for: "site-publish-remember" }).text(` ${localize("Remember the password on this computer")}`).appendTo($remember_row);
	const $editor_url = field(localize("Editor URL: "), "editor_url");
	if (guest) {
		// Guests save with their share link's key, to the page it covers: nothing to fill in.
		for (const $input of [$site, $page, $secret, $editor_url]) { $input.prop("disabled", true); }
		$secret.closest(".site-publish-row").hide();
		$remember_row.hide();
		$(E("div")).addClass("site-publish-row").text(localize("You're editing this page with a share link; Save publishes it for everyone.")).appendTo($main);
	}
	const $log = $(E("div")).addClass("site-publish-log inset-deep").appendTo($main);
	const log = (/** @type {string} */ line) => {
		$(E("div")).text(line).appendTo($log);
		$log[0].scrollTop = $log[0].scrollHeight;
	};

	const $save = $w.$Button(localize("Save"), async () => {
		const current = {
			editor_url: String($editor_url.val()).trim() || default_editor_url(),
			site: String($site.val()).trim().toLowerCase(),
			page: String($page.val()).trim() || "index.html",
			secret: String($secret.val()),
			remember_secret: $remember.prop("checked"),
		};
		if (!current.site) {
			log("Enter a site name — it becomes your address: …/~name/");
			$site.focus();
			return;
		}
		if (/^https?:|\//.test(current.site)) {
			log("The site name is just the name (like \"jack\"), not a URL.");
			$site.focus();
			return;
		}
		if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(current.site)) {
			log("Site names are 1–32 lowercase letters, digits, or hyphens.");
			$site.focus();
			return;
		}
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html?$/.test(current.page)) {
			log("Page files are like index.html or about.html.");
			$page.focus();
			return;
		}
		if (!current.secret && !guest) {
			log("The password is needed to save.");
			$secret.focus();
			return;
		}
		if (guest) {
			current.site = guest.site;
			current.invite = { key: guest.key, page: current.page };
		} else {
			save_settings(current);
		}
		$save.prop("disabled", true);
		$log.empty();
		log("Saving…");
		try {
			const url = await publish_collage(current, log);
			log("Done!");
			$(E("div")).append($(E("a")).attr({ href: url, target: "_blank", rel: "noopener" }).text(url)).appendTo($log);
			resolve_result(true);
			$w.$Button(localize("Open Page"), () => { window.open(url, "_blank", "noopener"); }).focus();
		} catch (error) {
			log(String(error.message || error));
			show_error_message("Couldn't save to the site.", error);
		} finally {
			$save.prop("disabled", false);
		}
	}, { type: "submit" });
	$w.$Button(localize("Cancel"), () => { $w.close(); });
	$w.$content.css({ width: "min(460px, 90vw)" });
	$w.center();
	($site.val() ? $secret : $site).focus();
	if (auto && settings.site && (settings.secret || guest)) {
		$save.trigger("click");
	}
	return result_promise;
}

$("<style>").text(`
	.site-publish-row {
		margin-bottom: 6px;
	}
	.site-publish-row label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.site-publish-row input[type="text"], .site-publish-row input[type="password"] {
		flex: 1;
		min-width: 0;
	}
	.site-publish-log {
		height: 110px;
		overflow: auto;
		padding: 4px;
		background: #fff;
		color: #222;
		font-family: monospace;
		font-size: 12px;
		white-space: pre-wrap;
		word-break: break-all;
	}
`).appendTo(document.head);

export { current_site, get_site_editor_url, get_site_files_base, is_signed_in, load_settings, publish_collage, save_settings, show_publish_dialog };
