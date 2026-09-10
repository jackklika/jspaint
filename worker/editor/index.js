// @ts-check
// jspaint-editor: serves the Paint app (static assets) and the API Paint uses to publish to a site.
//
//   GET    /api/whoami[?site=name]                  checks the bearer (master key, or that site's password); returns role + URLs
//   POST   /api/sites/:name/password                master key only: gives the site a new random password → { site, password, rotated }
//   DELETE /api/sites/:name/password                master key only: removes the site's password
//   GET    /api/sites/:name/files                   list a site's files
//   GET    /api/sites/:name/files/<path>            read a file (HEAD to check existence; ?optional → 204 instead of 404)
//   PUT    /api/sites/:name/files/<path>            write a file (HTML is sanitized; images/audio are sniffed)
//   DELETE /api/sites/:name/files/<path>
//   (site.json: the site's settings — { "folders": { "posts": { "kind": "posts", "title": "…" } } }; site.css: its stylesheet)
//   GET    /api/x-elements                          the <x-*> registry's editor metadata (no auth)
//   GET    /api/gifcities/search?q=&offset=&page_size=   GifCities search scraped to JSON (no auth, cached)
//   GET    /api/gifcities/gif/:id                   relay a GifCities GIF with CORS (no auth, cached)
//   GET    /api/sites/:name/rooms/:page?token=…      WebSocket: the page's live room (PageRoom Durable Object, page-room.js)
//   POST   /api/sites/:name/rooms/:page/invite       make a share key for that page (owner only) → { key, expires }
//   …?invite=<key> / Authorization: Invite <key>    a guest: may join that page's room and save that page (and its previews/ card, gifs/, midi/)
//   POST   /api/gifs/used {gif, site?}                 remember a GifCities GIF was used (GifStats DO); GET /api/gifs/top?site=&limit= lists the most used
//   GET    /?join=<site>/<page>/<key>                a share link: Paint with link-preview tags for that page (share_landing)
//   GET    /~name[/page]  and  /page (root site)     → 302 /?site=name[&page=…]: Paint opens that page (site_entry_redirect; ".html" optional)
//
// Auth: `Authorization: Bearer <token>` on whoami, listing, writes, invites, and rooms (?token= on the WebSocket).
// The token is either the master key (SITE_EDIT_SECRET: every site, plus minting passwords) or one site's password
// (random, minted by the master, stored only as a keyed hash in the Accounts Durable Object — accounts.js). role_of()
// says which. Reads of site files are public. Open sign-up / Google OAuth come later (docs/PLAN.md phase 5).
import { inject_analytics } from "../shared/analytics.js";
import { ROOT_SITE, content_type_for, is_html_path, site_base, sniff_type, valid_path, valid_site_name } from "../shared/names.js";
import { sanitize_html } from "../shared/sanitize.js";
import { x_elements } from "../shared/x-elements/index.js";
export { Accounts } from "./accounts.js";
export { GifStats } from "./gif-stats.js";
export { PageRoom } from "./page-room.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*", // bearer auth, no cookies, so a permissive origin is fine
	"Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type, X-Invite-Page",
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
 * Constant-time string comparison (length first — a mismatch there leaks nothing useful).
 * @param {string} a @param {string} b
 */
function same_string(a, b) {
	if (a.length !== b.length) { return false; }
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/** The bearer a request carries: the Authorization header, or ?token= on a WebSocket upgrade (browsers can't set headers there; TLS covers it). @param {Request} request */
function bearer_of(request) {
	const header = request.headers.get("Authorization") || "";
	if (header.startsWith("Bearer ")) { return header.slice(7).trim(); }
	return request.headers.get("Upgrade") === "websocket" ? new URL(request.url).searchParams.get("token") || "" : "";
}

// --- site passwords ---
// Minted by the master key: 16 symbols from a 32-symbol alphabet (no l/o/0/1 lookalikes), shown as xxxx-xxxx-xxxx-xxxx —
// 80 random bits, so a fast keyed hash is plenty: HMAC-SHA256(SITE_EDIT_SECRET, "site-password:<site>:<password>").
// Typed passwords are compared after lowercasing and dropping everything but letters and digits (dashes, spaces,
// phone autocapitalization). The master key itself is never normalized.

const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // cspell:disable-line
/** @type {Map<string, CryptoKey>} the master key imported for HMAC, by secret */
const hmac_keys = new Map();
/** @type {Map<string, { hash: string | null, until: number }>} site → stored password hash (or none), briefly cached */
const site_hashes = new Map();
const SITE_HASH_TTL_MS = 60000;
const SITE_HASH_CACHE_MAX = 500;

/** @param {string} secret */
async function hmac_key(secret) {
	let key = hmac_keys.get(secret);
	if (!key) {
		key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		hmac_keys.set(secret, key);
	}
	return key;
}

/** @param {string} secret @param {string} message @returns {Promise<ArrayBuffer>} */
async function hmac(secret, message) {
	return crypto.subtle.sign("HMAC", await hmac_key(secret), new TextEncoder().encode(message));
}

/** @param {string} text */
function normalize_password(text) {
	return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function generate_password() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const symbols = [...bytes].map((byte) => PASSWORD_ALPHABET[byte & 31]).join("");
	return symbols.replace(/(.{4})(?=.)/g, "$1-");
}

/** @param {string} secret @param {string} site @param {string} password */
async function password_hash(secret, site, password) {
	const mac = new Uint8Array(await hmac(secret, `site-password:${site}:${normalize_password(password)}`));
	return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The site's stored password hash (null if it has none), via a short cache so a publish's many uploads don't each
 * cross to the Accounts DO. `fresh` skips the cache (a just-minted password, or a stale entry).
 * @param {{ ACCOUNTS: DurableObjectNamespace }} env
 * @param {string} site
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<string | null>}
 */
async function site_hash(env, site, { fresh = false } = {}) {
	const cached = site_hashes.get(site);
	if (cached && !fresh && cached.until > Date.now()) { return cached.hash; }
	const hash = await /** @type {any} */ (env.ACCOUNTS.getByName("global")).get_hash(site);
	if (site_hashes.size >= SITE_HASH_CACHE_MAX) { site_hashes.delete(site_hashes.keys().next().value); }
	site_hashes.set(site, { hash, until: Date.now() + SITE_HASH_TTL_MS });
	return hash;
}

/**
 * Who the request's bearer is: "master" (the edit secret: every site), "site" (this site's own password), or null.
 * Async: every caller must `await` it — a Promise would be truthy.
 * @param {Request} request
 * @param {{ ACCOUNTS: DurableObjectNamespace, SITE_EDIT_SECRET?: string }} env
 * @param {string} [site] - the site the request is about (no site: only the master can pass)
 * @returns {Promise<"master" | "site" | null>}
 */
async function role_of(request, env, site = "") {
	const secret = env.SITE_EDIT_SECRET;
	if (!secret) { return null; }
	const token = bearer_of(request);
	if (!token) { return null; }
	if (same_string(token, secret)) { return "master"; }
	if (!site || !valid_site_name(site)) { return null; }
	const given = await password_hash(secret, site, token);
	let stored = await site_hash(env, site);
	if (stored && same_string(given, stored)) { return "site"; }
	stored = await site_hash(env, site, { fresh: true });
	return stored && same_string(given, stored) ? "site" : null;
}

// --- share keys: a guest's pass to one page ---
// key = "<expiry day>.<hmac>" where hmac = HMAC-SHA256(SITE_EDIT_SECRET, "site|page|day") truncated to 12 bytes,
// base64url. Stateless: anyone with the key may join the page's room and save that page until the day is over.

/** @param {ArrayBuffer | Uint8Array} bytes */
function base64url(bytes) {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return btoa(String.fromCharCode(...view)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} secret
 * @param {string} site
 * @param {string} page
 * @param {number} expiry_day - days since the epoch
 */
async function invite_signature(secret, site, page, expiry_day) {
	const mac = await hmac(secret, `${site}|${page}|${expiry_day}`);
	return base64url(mac.slice(0, 12));
}

/**
 * @param {string} secret
 * @param {string} site
 * @param {string} page
 * @param {number} days - how long the key lasts
 */
async function make_invite(secret, site, page, days) {
	const expiry_day = Math.floor(Date.now() / 86400000) + Math.max(1, Math.min(3650, Math.round(days)));
	return { key: `${expiry_day}.${await invite_signature(secret, site, page, expiry_day)}`, expires: new Date(expiry_day * 86400000).toISOString() };
}

/**
 * @param {string | null | undefined} key
 * @param {string | undefined} secret
 * @param {string} site
 * @param {string} page
 */
async function invite_valid(key, secret, site, page) {
	if (!key || !secret) { return false; }
	const match = /^(\d{4,7})\.([A-Za-z0-9_-]{16})$/.exec(key);
	if (!match) { return false; }
	const expiry_day = Number(match[1]);
	if (expiry_day * 86400000 < Date.now()) { return false; }
	return same_string(await invite_signature(secret, site, page, expiry_day), match[2]);
}

/** The invite key a request carries (Authorization: Invite <key>, or ?invite= on a WebSocket upgrade). @param {Request} request */
function invite_key_of(request) {
	const header = request.headers.get("Authorization") || "";
	if (header.startsWith("Invite ")) { return header.slice(7).trim(); }
	return new URL(request.url).searchParams.get("invite") || "";
}

/**
 * Which paths a guest with a key for `page` may write: the page itself, its bitmap, and hashed media.
 * @param {string} page
 * @param {string} path
 */
function invite_may_write(page, path) {
	const base = page.replace(/\.html?$/i, "");
	return path === page || path === `collages/${base}.png` || path === `previews/${base}.png` || /^(gifs|midi)\/[A-Za-z0-9._-]+$/.test(path);
}

const SHARE_JOIN = /^([a-z0-9-]+)\/(.+)\/(\d+\.[A-Za-z0-9_-]+)$/;
const SHARE_DESCRIPTION = "Someone's painting a web page live. Tap to join and draw with them — no sign-in.";

/** @param {string} text */
function escape_html(text) {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** @param {string} text - the inside of a <title> */
function decode_entities(text) {
	return text.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_m, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" })[name]);
}

/**
 * An HTML asset response with the PostHog bootstrap injected when POSTHOG_API_KEY is set (editor-only;
 * published pages on the sites Worker never carry trackers — docs/DESIGN.md §9).
 * @param {Response} asset
 * @param {{ POSTHOG_API_KEY?: string, POSTHOG_HOST?: string }} env
 * @param {{ site?: string, page?: string }} [ctx] what the page is about, as event properties
 */
async function with_analytics(asset, env, ctx = {}) {
	const injected = inject_analytics(await asset.text(), env, ctx);
	if (!injected) { return asset; }
	const headers = new Headers(asset.headers);
	headers.set("Cache-Control", "no-cache"); // the bootstrap is injected per-request; also keeps deploys fresh
	return new Response(injected.html, { status: asset.status, headers });
}

/**
 * A share link, /?join=<site>/<page>/<key>: Paint itself, with link-preview (Open Graph / Twitter card) tags for that
 * page — its preview card if one has been uploaded (previews/<page>.png), else its saved bitmap, else the app icon.
 * Messaging apps fetch this without running scripts, so the tags have to be in the HTML.
 * @param {Request} request
 * @param {URL} url
 * @param {{ ASSETS: Fetcher, SITES: R2Bucket, POSTHOG_API_KEY?: string, POSTHOG_HOST?: string }} env
 */
async function share_landing(request, url, env) {
	const asset = await env.ASSETS.fetch(new Request(new URL("/", url).href, request));
	const match = SHARE_JOIN.exec(url.searchParams.get("join") || "");
	if (!match || !valid_site_name(match[1])) { return asset; }
	let page;
	try {
		page = decodeURIComponent(match[2]);
	} catch (_error) {
		return asset;
	}
	if (!valid_path(page) || !is_html_path(page)) { return asset; }
	const site = match[1];
	const base = page.replace(/\.html?$/i, "");
	const prefix = `sites/${site}/`;
	const [preview, bitmap, html] = await Promise.all([
		env.SITES.head(`${prefix}previews/${base}.png`),
		env.SITES.head(`${prefix}collages/${base}.png`),
		env.SITES.get(`${prefix}${page}`),
	]);
	const image_object = preview || bitmap;
	const image_path = preview ? `previews/${base}.png` : bitmap ? `collages/${base}.png` : null;
	const image = image_path ?
		`${url.origin}/api/sites/${site}/files/${image_path}?v=${(image_object?.httpEtag || "").replace(/\W/g, "").slice(0, 12)}` :
		`${url.origin}/images/icons/512x512.png`;
	const size = preview ? [1200, 630] : bitmap ? null : [512, 512];
	let title = base;
	if (html) {
		const found = /<title>([^<]*)<\/title>/i.exec(await html.text());
		if (found && found[1].trim()) { title = decode_entities(found[1].trim()); }
	}
	const tags = [
		["name", "description", SHARE_DESCRIPTION],
		["property", "og:type", "website"],
		["property", "og:site_name", url.host],
		["property", "og:title", `${title} · ~${site}`],
		["property", "og:description", SHARE_DESCRIPTION],
		["property", "og:url", url.href],
		["property", "og:image", image],
		...(size ? [["property", "og:image:width", String(size[0])], ["property", "og:image:height", String(size[1])]] : []),
		["name", "twitter:card", preview || bitmap ? "summary_large_image" : "summary"],
		["name", "twitter:title", `${title} · ~${site}`],
		["name", "twitter:description", SHARE_DESCRIPTION],
		["name", "twitter:image", image],
	];
	const markup = tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escape_html(value)}">`).join("\n\t");
	const rewritten = await new HTMLRewriter()
		.on('meta[property^="og:"], meta[name^="twitter:"], meta[name="description"]', { element(element) { element.remove(); } })
		.on("head", { element(element) { element.append(`\n\t${markup}\n`, { html: true }); } })
		.transform(asset)
		.text();
	const headers = new Headers(asset.headers);
	headers.set("Cache-Control", "no-cache"); // the preview changes as people draw
	headers.delete("ETag");
	const injected = inject_analytics(rewritten, env, { site, page });
	return new Response(injected ? injected.html : rewritten, { status: asset.status, headers });
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {{ SITES: R2Bucket, SITES_URL: string, SITE_EDIT_SECRET?: string }} env
 * @param {{ page: string } | null} [invite] - the request is a guest's, allowed only within their page
 */
async function handle_site_files(request, url, env, invite = null) {
	const match = /^\/api\/sites\/([^/]+)\/files(?:\/(.+))?$/.exec(url.pathname);
	if (!match) { return json({ error: "Not found" }, 404); }
	const name = match[1];
	if (!valid_site_name(name)) { return json({ error: "Site names are 1–32 lowercase letters, digits, or hyphens" }, 400); }
	const prefix = `sites/${name}/`;
	const public_url = (/** @type {string} */ path) => `${env.SITES_URL}${site_base(name)}/${path === "index.html" ? "" : path}`;

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
		// ?optional: a probe that may well miss — answer 204 instead of 404 so the browser console stays quiet.
		if (!object) { return url.searchParams.has("optional") ? new Response(null, { status: 204, headers: CORS_HEADERS }) : json({ error: "Not found" }, 404); }
		const headers = new Headers(CORS_HEADERS);
		headers.set("Content-Type", content_type_for(path));
		headers.set("Content-Length", String(object.size));
		headers.set("ETag", object.httpEtag);
		headers.set("Cache-Control", "no-cache"); // Paint re-opens pages from here right after saving them
		return new Response(request.method === "HEAD" ? null : object.body, { headers });
	}
	if (invite && (request.method === "DELETE" || !invite_may_write(invite.page, path))) {
		return json({ error: "This share key only allows saving its own page (and adding GIFs or music)." }, 403);
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
		if (/\.json$/i.test(path)) {
			// site.json: the site's settings (folders marked as posts, titles…) — one small, well-formed object.
			if (path !== "site.json") { return json({ error: "The only JSON file a site has is site.json (its settings)" }, 400); }
			if (bytes.length > 64 * 1024) { return json({ error: "site.json is limited to 64 KB" }, 413); }
			let settings;
			try {
				settings = JSON.parse(new TextDecoder().decode(bytes));
			} catch (_error) {
				return json({ error: "site.json must be valid JSON" }, 400);
			}
			if (!settings || typeof settings !== "object" || Array.isArray(settings)) { return json({ error: "site.json must be an object" }, 400); }
			body = JSON.stringify(settings, null, "\t");
		} else if (is_html_path(path)) {
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

// --- GifCities proxy (see src/gif-picker.js) ---
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

/**
 * Page loads on the old `*.workers.dev` hostname (or `www.`) are sent to the domain; the API keeps answering
 * everywhere so browsers that remembered the old editor URL still save. Local dev hosts are never redirected.
 * @param {URL} url
 * @param {string | undefined} canonical_url - e.g. "https://coolpaint.world"
 * @returns {Response | null}
 */
export function canonical_redirect(url, canonical_url) {
	if (!canonical_url) { return null; }
	const canonical = new URL(canonical_url);
	if (url.host === canonical.host) { return null; }
	if (!url.hostname.endsWith(".workers.dev") && url.hostname !== `www.${canonical.hostname}`) { return null; }
	return Response.redirect(`${canonical.origin}${url.pathname}${url.search}`, 301);
}

const SITE_ENTRY = /^\/~([^/]+)(?:\/(.*))?$/;
// Paint's own files, served as they are; everything else on the editor host is a page address.
const APP_DIRECTORIES = /^\/(src|lib|images|styles|help|audio|localization)\//;
const APP_FILES = new Set(["/", "/index.html", "/favicon.ico", "/manifest.webmanifest", "/browserconfig.xml"]);
/**
 * Page addresses on the editor host mirror the sites host, and open that page in Paint (src/my-site.js: the page
 * itself when you're signed in as the site, a copy otherwise): edit.<domain>/~name[/page] → ?site=name[&page=…],
 * and edit.<domain>/about (or /about.html, /blog/post) → the root site's page. ".html" is optional. A path under
 * a site that isn't a page (a GIF, a typo) just opens the site. Returns null for Paint's own files.
 * @param {URL} url
 * @returns {Response | null}
 */
export function site_entry_redirect(url) {
	if (APP_FILES.has(url.pathname) || APP_DIRECTORIES.test(url.pathname)) { return null; }
	let site, rest;
	const tilde = SITE_ENTRY.exec(url.pathname);
	if (tilde) {
		site = tilde[1];
		if (!valid_site_name(site)) { return new Response("Not found", { status: 404 }); }
		rest = tilde[2] || "";
	} else {
		site = ROOT_SITE;
		rest = url.pathname.slice(1);
	}
	let page = rest;
	if (page && !page.endsWith("/") && !/\.[A-Za-z0-9]+$/.test(page)) { page += ".html"; } // /about → about.html
	if (page.endsWith("/")) { page += "index.html"; }
	try {
		page = decodeURIComponent(page);
	} catch (_error) {
		page = "";
	}
	if (page && !(valid_path(page) && is_html_path(page))) {
		if (!tilde) { return null; } // not a page on the root site (e.g. /foo.png): let the assets answer (404 if there's none)
		page = "";
	}
	const params = new URLSearchParams({ site });
	if (page) { params.set("page", page); }
	return new Response(null, { status: 302, headers: { Location: `/?${params}`, "Cache-Control": "no-store" } });
}

export default {
	/**
	 * @param {Request} request
	 * @param {{ ASSETS: Fetcher, SITES: R2Bucket, PAGE_ROOM: DurableObjectNamespace, GIF_STATS: DurableObjectNamespace, ACCOUNTS: DurableObjectNamespace, EDITOR_URL?: string, SITES_URL: string, SITE_EDIT_SECRET?: string, POSTHOG_API_KEY?: string, POSTHOG_HOST?: string }} env
	 */
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) {
			const canonical = canonical_redirect(url, env.EDITOR_URL);
			if (canonical) { return canonical; }
			const entry = site_entry_redirect(url);
			if (entry) { return entry; }
			if (url.pathname === "/" && url.searchParams.has("join")) {
				return share_landing(request, url, env);
			}
			// The app shell gets the PostHog bootstrap (editor-only analytics; docs/DESIGN.md §9).
			if (request.method === "GET" && env.POSTHOG_API_KEY && (url.pathname === "/" || url.pathname === "/index.html")) {
				const asset = await env.ASSETS.fetch(request);
				if ((asset.headers.get("Content-Type") || "").includes("text/html")) {
					return with_analytics(asset, env);
				}
				return asset;
			}
			return env.ASSETS.fetch(request);
		}
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}
		try {
			const room_match = /^\/api\/sites\/([^/]+)\/rooms\/(.+?)(\/invite)?$/.exec(url.pathname);
			if (room_match) {
				// The live room: one Durable Object per page, WebSocket only; the master key, the site's password, or a share key gets you in.
				const name = room_match[1];
				let page;
				try {
					page = decodeURIComponent(room_match[2]);
				} catch (_error) {
					return json({ error: "Bad page" }, 400);
				}
				if (!valid_site_name(name) || !valid_path(page) || !is_html_path(page)) { return json({ error: "Rooms are per page: /api/sites/<name>/rooms/<page>.html" }, 400); }
				if (room_match[3]) {
					// POST …/rooms/<page>/invite: the owner makes a share key for this page.
					if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
					if (!await role_of(request, env, name)) { return json({ error: "Unauthorized: send Authorization: Bearer <password>" }, 401); }
					const body = await request.json().catch(() => ({}));
					return json({ site: name, page, ...(await make_invite(env.SITE_EDIT_SECRET, name, page, Number(body.days) || 30)) });
				}
				if (request.headers.get("Upgrade") !== "websocket") { return json({ error: "The room is a WebSocket endpoint" }, 426); }
				const owner = await role_of(request, env, name);
				if (!owner && !await invite_valid(invite_key_of(request), env.SITE_EDIT_SECRET, name, page)) { return json({ error: "Unauthorized: add ?token=<password> or ?invite=<share key>" }, 401); }
				return env.PAGE_ROOM.getByName(`${name}/${page}`).fetch(request);
			}
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
			// GIF usage: which GifCities GIFs people use (GifStats Durable Object), for "top GIFs" per site and overall.
			if (url.pathname === "/api/gifs/used" && request.method === "POST") {
				const body = await request.json().catch(() => ({}));
				const gif = String(body.gif || "");
				const site = String(body.site || "");
				if (!/^[A-Z0-9]{20,40}$/.test(gif)) { return json({ error: "gif must be a GifCities id" }, 400); }
				if (site && !valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
				await env.GIF_STATS.getByName("global").record(gif, site);
				return json({ ok: true });
			}
			if (url.pathname === "/api/gifs/top") {
				const site = url.searchParams.get("site") || "";
				if (site && !valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
				const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 50));
				return json({ site, top: await env.GIF_STATS.getByName("global").top(site, limit) });
			}
			if (url.pathname === "/api/x-elements") {
				return json([...x_elements.values()].map((definition) => ({ tag: definition.tag, attrs: definition.attrs, editor: definition.editor })));
			}
			// Reading site files needs no secret: they're public on the sites Worker anyway. Writing does.
			if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/sites\/[^/]+\/files\/./.test(url.pathname)) {
				return handle_site_files(request, url, env);
			}
			if (url.pathname === "/api/whoami") {
				// Paint's sign-in check: the master (any site) or the site's password (needs ?site=).
				const site = url.searchParams.get("site") || "";
				if (site && !valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
				const role = await role_of(request, env, site);
				if (!role) { return json({ error: "Unauthorized: the password was rejected" }, 401); }
				return json({ ok: true, role, site: site || null, sites_url: env.SITES_URL, editor_url: url.origin });
			}
			const password_match = /^\/api\/sites\/([^/]+)\/password$/.exec(url.pathname);
			if (password_match) {
				// The master key gives a site a fresh random password (or takes it away). The password is returned exactly once.
				const name = password_match[1];
				if (!valid_site_name(name)) { return json({ error: "Bad site name" }, 400); }
				const role = await role_of(request, env, name);
				if (!role) { return json({ error: "Unauthorized: send Authorization: Bearer <master key>" }, 401); }
				if (role !== "master") { return json({ error: "Only the master key can set a site's password" }, 403); }
				const accounts = /** @type {any} */ (env.ACCOUNTS.getByName("global"));
				if (request.method === "POST") {
					const password = generate_password();
					const { rotated } = await accounts.set_hash(name, await password_hash(/** @type {string} */ (env.SITE_EDIT_SECRET), name, password));
					site_hashes.delete(name);
					return json({ site: name, password, rotated });
				}
				if (request.method === "DELETE") {
					const removed = await accounts.remove(name);
					site_hashes.delete(name);
					return json({ ok: true, site: name, removed });
				}
				return json({ error: "Method not allowed" }, 405);
			}
			const files_match = /^\/api\/sites\/([^/]+)\/files(?:\/|$)/.exec(url.pathname);
			if (files_match) {
				const name = files_match[1];
				if (!valid_site_name(name)) { return json({ error: "Site names are 1–32 lowercase letters, digits, or hyphens" }, 400); }
				if (await role_of(request, env, name)) {
					return handle_site_files(request, url, env);
				}
				// A guest with a share key may list the site and save their page (handle_site_files scopes the writes).
				const guest_page = request.headers.get("X-Invite-Page") || "";
				if (valid_path(guest_page) && is_html_path(guest_page) && await invite_valid(invite_key_of(request), env.SITE_EDIT_SECRET, name, guest_page)) {
					return handle_site_files(request, url, env, { page: guest_page });
				}
				return json({ error: "Unauthorized: send Authorization: Bearer <password>" }, 401);
			}
			return json({ error: "Not found" }, 404);
		} catch (error) {
			console.error(error);
			return json({ error: error.message || String(error) }, 500);
		}
	},
};
