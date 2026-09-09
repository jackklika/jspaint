// @ts-check
// jspaint-editor: serves the Paint app (static assets) and the API Paint uses to publish to a site.
//
//   GET    /api/whoami                              checks the edit secret; returns URLs
//   GET    /api/sites/:name/files                   list a site's files
//   GET    /api/sites/:name/files/<path>            read a file (HEAD to check existence)
//   PUT    /api/sites/:name/files/<path>            write a file (HTML is sanitized; images/audio are sniffed)
//   DELETE /api/sites/:name/files/<path>
//   GET    /api/x-elements                          the <x-*> registry's editor metadata (no auth)
//   GET    /api/gifcities/search?q=&offset=&page_size=   GifCities search scraped to JSON (no auth, cached)
//   GET    /api/gifcities/gif/:id                   relay a GifCities GIF with CORS (no auth, cached)
//
// Auth: `Authorization: Bearer <SITE_EDIT_SECRET>` on /api/whoami, listing, and writes. Reads of site files are public.
// Accounts come later; today one secret edits every site (docs/PLAN.md phase 5).
import { content_type_for, is_html_path, sniff_type, valid_path, valid_site_name } from "../shared/names.js";
import { sanitize_html } from "../shared/sanitize.js";
import { x_elements } from "../shared/x-elements/index.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*", // bearer auth, no cookies, so a permissive origin is fine
	"Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Expose-Headers": "ETag, Content-Length",
};

/**
 * @param {any} data
 * @param {number} [status]
 */
function json(data, status = 200) {
	return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}

/**
 * Constant-time comparison of the bearer token with the secret.
 * @param {Request} request
 * @param {string | undefined} secret
 */
function authorized(request, secret) {
	if (!secret) { return false; }
	const header = request.headers.get("Authorization") || "";
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (token.length !== secret.length) { return false; }
	let diff = 0;
	for (let i = 0; i < token.length; i++) {
		diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {{ SITES: R2Bucket, SITES_URL: string }} env
 */
async function handle_site_files(request, url, env) {
	const match = /^\/api\/sites\/([^/]+)\/files(?:\/(.+))?$/.exec(url.pathname);
	if (!match) { return json({ error: "Not found" }, 404); }
	const name = match[1];
	if (!valid_site_name(name)) { return json({ error: "Site names are 1–32 lowercase letters, digits, or hyphens" }, 400); }
	const prefix = `sites/${name}/`;
	const public_url = (/** @type {string} */ path) => `${env.SITES_URL}/~${name}/${path === "index.html" ? "" : path}`;

	if (match[2] === undefined) {
		if (request.method !== "GET") { return json({ error: "Method not allowed" }, 405); }
		const files = [];
		let cursor;
		do {
			const listing = await env.SITES.list({ prefix, cursor });
			for (const object of listing.objects) {
				const path = object.key.slice(prefix.length);
				files.push({ path, size: object.size, uploaded: object.uploaded, url: public_url(path) });
			}
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
		return json({ site: name, files, url: public_url("index.html") });
	}

	let path;
	try {
		path = decodeURIComponent(match[2]);
	} catch (_error) {
		return json({ error: "Bad path" }, 400);
	}
	if (!valid_path(path)) { return json({ error: "Paths use letters, digits, dots, dashes and underscores, and one of the allowed extensions (html, css, txt, png, gif, jpg, webp, ico, mp3, mid, wav, ogg)" }, 400); }
	const key = prefix + path;

	if (request.method === "GET" || request.method === "HEAD") {
		const object = await env.SITES.get(key);
		if (!object) { return json({ error: "Not found" }, 404); }
		const headers = new Headers(CORS_HEADERS);
		headers.set("Content-Type", content_type_for(path));
		headers.set("Content-Length", String(object.size));
		headers.set("ETag", object.httpEtag);
		return new Response(request.method === "HEAD" ? null : object.body, { headers });
	}
	if (request.method === "DELETE") {
		await env.SITES.delete(key);
		return json({ ok: true, deleted: path });
	}
	if (request.method === "PUT") {
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.length > MAX_FILE_BYTES) { return json({ error: `Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB` }, 413); }
		/** @type {ArrayBuffer | string} */
		let body = bytes.buffer;
		const content_type = content_type_for(path);
		if (is_html_path(path)) {
			const text = new TextDecoder().decode(bytes);
			if (!/<html[\s>]/i.test(text) || !/<body[\s>]/i.test(text)) {
				return json({ error: "Pages must be complete HTML documents (<html> … <body> …)" }, 400);
			}
			body = await sanitize_html(text);
		} else if (!/^text\//.test(content_type)) {
			const sniffed = sniff_type(bytes.slice(0, 12));
			if (!sniffed || sniffed !== content_type) {
				return json({ error: `The file doesn't look like ${content_type}` }, 400);
			}
		}
		const object = await env.SITES.put(key, body, { httpMetadata: { contentType: content_type } });
		return json({ ok: true, path, size: object.size, etag: object.httpEtag, url: public_url(path) });
	}
	return json({ error: "Method not allowed" }, 405);
}

// --- GifCities proxy (same contract as agent-server's, see src/gif-picker.js) ---
const GIFCITIES_HEADERS = { "User-Agent": "jspaint-site-builder (https://github.com/jackklika/jspaint)" };

/**
 * @param {string} query
 * @param {number} offset
 * @param {number} page_size
 */
async function gifcities_search(query, offset, page_size) {
	const upstream = await fetch(`https://gifcities.org/search?q=${encodeURIComponent(query)}&offset=${offset}&page_size=${page_size}`, {
		headers: GIFCITIES_HEADERS,
		cf: { cacheTtl: 3600, cacheEverything: true },
	});
	if (!upstream.ok) { throw new Error(`GifCities search failed: HTTP ${upstream.status}`); }
	const html = await upstream.text();
	const results = [];
	const pattern = /<img[^>]*?width="(\d+)"[^>]*?height="(\d+)"[^>]*?src="https:\/\/blob\.gifcities\.org\/gifcities\/([A-Z0-9]+)\.gif"/g;
	let match;
	while ((match = pattern.exec(html))) {
		results.push({ id: match[3], width: Number(match[1]), height: Number(match[2]), url: `/api/gifcities/gif/${match[3]}`, source: `https://gifcities.org/detail/${match[3]}` });
	}
	return { query, offset, page_size, results, next_offset: results.length >= page_size ? offset + page_size : null };
}

export default {
	/**
	 * @param {Request} request
	 * @param {{ ASSETS: Fetcher, SITES: R2Bucket, SITES_URL: string, SITE_EDIT_SECRET?: string }} env
	 */
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}
		try {
			if (url.pathname === "/api/gifcities/search") {
				const page_size = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size")) || 40));
				const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
				const data = await gifcities_search((url.searchParams.get("q") || "").trim().slice(0, 100), offset, page_size);
				return new Response(JSON.stringify(data), { headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
			}
			const gif_match = /^\/api\/gifcities\/gif\/([A-Z0-9]{20,40})$/.exec(url.pathname);
			if (gif_match) {
				const upstream = await fetch(`https://blob.gifcities.org/gifcities/${gif_match[1]}.gif`, { headers: GIFCITIES_HEADERS, cf: { cacheTtl: 86400, cacheEverything: true } });
				if (!upstream.ok) { return json({ error: `GifCities returned HTTP ${upstream.status}` }, 502); }
				return new Response(upstream.body, { headers: { ...CORS_HEADERS, "Content-Type": "image/gif", "Cache-Control": "public, max-age=86400" } });
			}
			if (url.pathname === "/api/x-elements") {
				return json([...x_elements.values()].map((definition) => ({ tag: definition.tag, attrs: definition.attrs, editor: definition.editor })));
			}
			// Reading site files needs no secret: they're public on the sites Worker anyway. Writing does.
			if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/sites\/[^/]+\/files\/./.test(url.pathname)) {
				return handle_site_files(request, url, env);
			}
			if (!authorized(request, env.SITE_EDIT_SECRET)) {
				return json({ error: "Unauthorized: send Authorization: Bearer <edit secret>" }, 401);
			}
			if (url.pathname === "/api/whoami") {
				return json({ ok: true, sites_url: env.SITES_URL, editor_url: url.origin });
			}
			if (url.pathname.startsWith("/api/sites/")) {
				return handle_site_files(request, url, env);
			}
			return json({ error: "Not found" }, 404);
		} catch (error) {
			console.error(error);
			return json({ error: error.message || String(error) }, 500);
		}
	},
};
