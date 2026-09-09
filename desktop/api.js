// @ts-check
// The desktop's client for the editor Worker API (worker/editor/index.js): sign-in state, site files, assets, x-elements.
// The editor origin is the page's own origin when served by the Worker; overridable for local Paint dev servers.

const SETTINGS_KEY = "site-builder desktop settings";

/** @typedef {{ editor_url: string, site: string, secret: string }} DesktopSettings */

/** @returns {DesktopSettings} */
export function load_settings() {
	/** @type {Partial<DesktopSettings>} */
	let stored = {};
	try {
		stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
	} catch (_error) { /* ignore */ }
	const default_editor = /^https?:\/\/localhost:(1999|11822|4097)/.test(location.origin) ? "http://localhost:8787" : location.origin;
	return { editor_url: (stored.editor_url || default_editor).replace(/\/+$/, ""), site: stored.site || "", secret: stored.secret || "" };
}

/** @param {DesktopSettings} settings */
export function save_settings(settings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch (_error) { /* ignore */ }
}

/** @type {{ sites_url: string } | null} learned from /api/whoami */
let server_info = null;

/** The public URL of a site file, on the sites Worker. */
export function public_url(path = "") {
	const { site } = load_settings();
	const base = server_info?.sites_url || "https://jspaint-sites.jklika2.workers.dev";
	return `${base}/~${site}/${path === "index.html" ? "" : path}`;
}

/** @param {string} path @param {RequestInit} [init] */
async function request(path, init = {}) {
	const { editor_url, secret } = load_settings();
	const headers = new Headers(init.headers || {});
	if (secret) { headers.set("Authorization", `Bearer ${secret}`); }
	const response = await fetch(`${editor_url}${path}`, { ...init, headers });
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			message = (await response.json()).error || message;
		} catch (_error) { /* not JSON */ }
		const error = new Error(message);
		/** @type {any} */ (error).status = response.status;
		throw error;
	}
	return response;
}

/** Validates the secret; caches the sites URL. */
export async function whoami() {
	server_info = await (await request("/api/whoami")).json();
	return server_info;
}

/** Registry metadata for <x-*> elements (public). */
export async function list_x_elements() {
	return (await request("/api/x-elements")).json();
}

/** @returns {Promise<{ site: string, files: { path: string, size: number, uploaded: string, url: string }[] }>} */
export async function list_files() {
	const { site } = load_settings();
	return (await request(`/api/sites/${encodeURIComponent(site)}/files`)).json();
}

/** @param {string} path */
export function read_file(path) {
	const { site } = load_settings();
	return request(`/api/sites/${encodeURIComponent(site)}/files/${path}`);
}

/**
 * @param {string} path
 * @param {Blob | string} body
 * @param {string} type
 */
export async function write_file(path, body, type) {
	const { site } = load_settings();
	return (await request(`/api/sites/${encodeURIComponent(site)}/files/${path}`, { method: "PUT", headers: { "Content-Type": type }, body })).json();
}

/** @param {string} path */
export async function delete_file(path) {
	const { site } = load_settings();
	return (await request(`/api/sites/${encodeURIComponent(site)}/files/${path}`, { method: "DELETE" })).json();
}

/** @param {Blob} blob */
export async function hash_blob(blob) {
	const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const EXTENSIONS = { "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/mpeg": "mp3", "audio/midi": "mid", "audio/wav": "wav", "audio/ogg": "ogg" };

/**
 * Uploads a media blob content-addressed under gifs/ (images) or midi/ (audio); returns the site-relative path.
 * @param {Blob} blob
 * @param {Set<string>} [existing] - paths already on the site, to skip uploads
 */
export async function upload_asset(blob, existing) {
	const ext = EXTENSIONS[blob.type] || "png";
	const folder = /^audio\//.test(blob.type) ? "midi" : "gifs";
	const path = `${folder}/${await hash_blob(blob)}.${ext}`;
	if (!existing?.has(path)) {
		await write_file(path, blob, blob.type);
		existing?.add(path);
	}
	return path;
}

/** GifCities search through the editor's proxy. */
export async function gifcities_search(query, offset = 0, page_size = 40) {
	const { editor_url } = load_settings();
	const response = await fetch(`${editor_url}/api/gifcities/search?q=${encodeURIComponent(query)}&offset=${offset}&page_size=${page_size}`);
	if (!response.ok) { throw new Error(`Search failed (HTTP ${response.status})`); }
	const data = await response.json();
	for (const result of data.results) { result.url = `${editor_url}${result.url}`; }
	return data;
}
