// @ts-check
// jspaint-editor: serves the Paint app (static assets) and the API Paint uses to publish to a site.
//
//   GET    /api/sites/:name/presence                 how many are editing the site right now (its pages' live rooms; no auth)
//   POST   /api/debug/exception                     master key: sends a test $exception to PostHog, answers with PostHog's status
//   GET    /api/whoami[?site=name]                  checks the bearer (master key, or that site's password); returns role, created, URLs
//   POST   /api/sites/:name/password                master key only: gives the site a new random password → { site, password, rotated }
//   DELETE /api/sites/:name/password                master key only: removes the site's password
//   GET    /api/sites/:name/files                   list a site's files
//   GET    /api/sites/:name/files/<path>            read a file (HEAD to check existence; ?optional → 204 instead of 404)
//   PUT    /api/sites/:name/files/<path>            write a file (HTML is sanitized; images/audio are sniffed)
//   DELETE /api/sites/:name/files/<path>
//   GET    /api/sites/:name/versions?page=<path>      earlier saves of a page (kept under versions/ when a page is written over)
//   POST   /api/sites/:name/versions/restore {page, version}  put an earlier save back (the current one is archived first)
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
//   POST   /api/sites/:name/rooms/:page/invite/revoke  every share key for that page stops working (owner)
//   POST   /api/reports {site, page, reason, ip_hash}  a visitor's report (the sites Worker forwards its form; three a day per visitor)
//   GET    /admin  and  /api/admin/*                 the admin's page and its levers (admin.js; ADMIN_EMAILS, or the master key)
//
// Auth: `Authorization: Bearer <token>` on whoami, listing, writes, invites, and rooms (?token= on the WebSocket).
// The token is either the master key (SITE_EDIT_SECRET: every site, plus minting passwords) or one site's password
// (random, minted by the master, stored only as a keyed hash in the Accounts Durable Object — accounts.js). role_of()
// says which. Reads of site files are public. Open sign-up / Google OAuth come later (docs/PLAN.md phase 5).
import { inject_analytics } from "../shared/analytics.js";
import { capture_exception } from "../shared/exceptions.js";
import { ShortCache, client_ip, limited, report_limited, too_many } from "../shared/limits.js";
import { ROOT_SITE, content_type_for, is_html_path, site_base, sniff_type, valid_path, valid_site_name } from "../shared/names.js";
import { accounts_of, capture_event, editor_origin, handle_auth, session_of, with_refreshed_claims } from "./auth.js";
import { handle_admin } from "./admin.js";
import { notify_published, page_hidden, read_moderation } from "./moderation.js";
import { sanitize_html } from "../shared/sanitize.js";
import { x_elements } from "../shared/x-elements/index.js";
export { Accounts } from "./accounts.js";
export { GifStats } from "./gif-stats.js";
export { PageRoom } from "./page-room.js";

const MAX_FILE_BYTES = 24 * 1024 * 1024; // a phone photo is 3–12 MB; the page shows a smaller copy (pictures.js)
// Quotas (MALICIOUS_ACTOR_PLAN.md phase 1): what a site may hold in the bucket, archives included — exact accounting in
// the Accounts object (usage_of), kept in step by every write and recounted from a listing after. The master raises
// a site's limits (POST /api/sites/:name/quota). Guests through a share key are held to a day's worth besides.
const QUOTA_BYTES = 200 * 1024 * 1024;
const QUOTA_FILES = 1000;
const GUEST_DAILY_BYTES = 32 * 1024 * 1024;
const BITMAP_ARCHIVES_KEPT = 20; // per page, whatever the kept versions refer to
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
/** @param {any} data @param {number} [status] @param {Record<string, string>} [headers] */
function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers } });
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
	// An address that keeps offering wrong keys or passwords is refused for a minute without a look at anything
	const ip = token ? client_ip(request) : "";
	if (token && (auth_blocked.get(ip) || 0) > Date.now()) { return null; }
	if (token && same_string(token, secret)) { return "master"; }
	if (!site || !valid_site_name(site)) {
		if (token) { return bad_token(env, ip); }
		const session = await session_of(request, env);
		return session?.admin ? "master" : null; // (an admin's session is the master key — auth.js is_admin)
	}
	if (token) {
		const given = await password_hash(secret, site, token);
		let stored = await site_hash(env, site);
		if (stored && same_string(given, stored)) { return "site"; }
		stored = await site_hash(env, site, { fresh: true });
		if (stored && same_string(given, stored)) { return "site"; }
		await bad_token(env, ip);
	}
	// No (good) bearer: a signed-in account (auth.js cookies) that owns the site edits it like the site's password does.
	// The claims cookie names the sites; a site claimed since it was signed is asked about (Accounts knows).
	const session = await session_of(request, env);
	if (!session) { return null; }
	if (session.admin) { return "master"; }
	if (session.sites && session.sites.includes(site)) { return "site"; }
	return (await accounts_of(env).owner_of(site)) === session.id ? "site" : null;
}

/** @type {Map<string, number>} addresses refused until (ms), after too many bad tokens — this isolate's memory, beside the binding's count */
const auth_blocked = new Map();

/**
 * A wrong key or password: counted per address (LIMIT_AUTH); over the limit, the address is refused for a minute.
 * Always null (the role a bad token gets), so callers can `return await bad_token(...)`.
 * @param {any} env @param {string} ip
 */
async function bad_token(env, ip) {
	if (await limited(env.LIMIT_AUTH, `auth:${ip}`)) {
		auth_blocked.set(ip, Date.now() + 60_000);
		if (auth_blocked.size > 10_000) { auth_blocked.clear(); }
		report_limited(env, null, { kind: "auth", worker: "jspaint-editor" });
	}
	return null;
}

/** A site's "who's editing" answer, kept 10 s: the globe of every open editor asks, and a flood would fan out to every page room. @type {ShortCache<any>} */
const presence_cache = new ShortCache(10_000);

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
async function invite_signature(secret, site, page, expiry_day, nonce = "") {
	const mac = await hmac(secret, `${site}|${page}|${expiry_day}${nonce ? `|${nonce}` : ""}`);
	return base64url(mac.slice(0, 12));
}

/**
 * @param {string} secret
 * @param {string} site
 * @param {string} page
 * @param {number} days - how long the key lasts
 * @param {string} [nonce] - the page's room's (page-room.js nonce): revoking changes it, and every earlier key dies
 */
async function make_invite(secret, site, page, days, nonce = "") {
	const expiry_day = Math.floor(Date.now() / 86400000) + Math.max(1, Math.min(3650, Math.round(days)));
	return { key: `${expiry_day}.${await invite_signature(secret, site, page, expiry_day, nonce)}`, expires: new Date(expiry_day * 86400000).toISOString() };
}

/** Rooms' invite nonces, a minute per isolate (a guest's every request would otherwise wake the room). @type {ShortCache<string>} */
const nonce_cache = new ShortCache(60_000, 5000);
/** @param {{ PAGE_ROOM: DurableObjectNamespace }} env @param {string} site @param {string} page */
async function room_nonce(env, site, page) {
	const cached = nonce_cache.get(`${site}/${page}`);
	if (cached !== undefined) { return cached; }
	return nonce_cache.set(`${site}/${page}`, String(await /** @type {any} */ (env.PAGE_ROOM.getByName(`${site}/${page}`)).nonce()));
}

/**
 * @param {string | null | undefined} key
 * @param {string | undefined} secret
 * @param {string} site
 * @param {string} page
 * @param {string} [nonce]
 */
async function invite_valid(key, secret, site, page, nonce = "") {
	if (!key || !secret) { return false; }
	const match = /^(\d{4,7})\.([A-Za-z0-9_-]{16})$/.exec(key);
	if (!match) { return false; }
	const expiry_day = Number(match[1]);
	if (expiry_day * 86400000 < Date.now()) { return false; }
	return same_string(await invite_signature(secret, site, page, expiry_day, nonce), match[2]);
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

// --- versions: nothing is lost when a page is written over ---
// Saving over a page keeps the old copy at versions/<stamp>/<path>; a bitmap that's about to change is kept as
// versions/bitmaps/<base>.<hash12>.png (the hash the page's src=…?v= carries), so a version restores with its picture.

const VERSIONS_KEPT = 10;

/** @param {Uint8Array} bytes @returns {Promise<string>} the first 12 hex digits of SHA-1 (what Paint puts in ?v=) */
async function short_hash(bytes) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** @param {string} path */
function is_bitmap_path(path) {
	return /^collages\/.+\.png$/i.test(path);
}

/**
 * @param {R2Bucket} bucket
 * @param {string} prefix - sites/<name>/
 * @param {string} path
 * @param {string} key
 * @param {Uint8Array} incoming - what's about to be written (a bitmap is archived only if it differs)
 */
async function archive_before_overwrite(bucket, prefix, path, key, incoming) {
	if (path.startsWith("versions/")) { return; }
	const old = await bucket.get(key);
	if (!old) { return; }
	if (is_html_path(path)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		await bucket.put(`${prefix}versions/${stamp}/${path}`, await old.arrayBuffer(), { httpMetadata: { contentType: content_type_for(path) } });
		await prune_versions(bucket, prefix, path);
	} else if (is_bitmap_path(path)) {
		const bytes = new Uint8Array(await old.arrayBuffer());
		const [old_hash, new_hash] = await Promise.all([short_hash(bytes), short_hash(incoming)]);
		if (old_hash === new_hash) { return; }
		const base = path.slice("collages/".length).replace(/\.png$/i, "");
		await bucket.put(`${prefix}versions/bitmaps/${base}.${old_hash}.png`, bytes, { httpMetadata: { contentType: "image/png" } });
	}
}

/**
 * @param {R2Bucket} bucket
 * @param {string} prefix
 * @param {string} page
 * @returns {Promise<{ version: string, key: string, uploaded: number, size: number }[]>} newest first
 */
async function list_versions(bucket, prefix, page) {
	const versions = [];
	let cursor;
	do {
		const listing = await bucket.list({ prefix: `${prefix}versions/`, cursor });
		for (const object of listing.objects) {
			const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}versions/([^/]+)/${page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).exec(object.key);
			if (match && match[1] !== "bitmaps") { versions.push({ version: match[1], key: object.key, uploaded: object.uploaded.getTime(), size: object.size }); }
		}
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	return versions.sort((a, b) => b.version.localeCompare(a.version));
}

/** Keeps the newest VERSIONS_KEPT saves of a page, and the bitmaps they refer to. @param {R2Bucket} bucket @param {string} prefix @param {string} page */
async function prune_versions(bucket, prefix, page) {
	const versions = await list_versions(bucket, prefix, page);
	const old = versions.slice(VERSIONS_KEPT);
	for (const version of old) { await bucket.delete(version.key); }
	if (!old.length) { return; }
	// Bitmap copies no kept version refers to can go too
	const base = page.replace(/\.html?$/i, "");
	const referenced = new Set();
	for (const version of versions.slice(0, VERSIONS_KEPT)) {
		const html = await (await bucket.get(version.key))?.text();
		for (const match of (html || "").matchAll(/\?v=([0-9a-f]{12})/g)) { referenced.add(match[1]); }
	}
	const listing = await bucket.list({ prefix: `${prefix}versions/bitmaps/${base}.` });
	const kept = [];
	for (const object of listing.objects) {
		const hash = /\.([0-9a-f]{12})\.png$/.exec(object.key)?.[1];
		if (hash && !referenced.has(hash)) { await bucket.delete(object.key); } else { kept.push(object); }
	}
	// And never more than BITMAP_ARCHIVES_KEPT pictures per page, whatever refers to them (the newest stay)
	kept.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
	for (const object of kept.slice(BITMAP_ARCHIVES_KEPT)) { await bucket.delete(object.key); }
}

/**
 * Puts an earlier save back: its HTML over the page (archiving the current one first) and, if the version's picture
 * was kept, that picture over the page's bitmap.
 * @param {R2Bucket} bucket
 * @param {string} prefix
 * @param {string} page
 * @param {string} version
 */
async function restore_version(bucket, prefix, page, version) {
	const archived = await bucket.get(`${prefix}versions/${version}/${page}`);
	if (!archived) { return { ok: false, error: "No such version" }; }
	const html = await archived.text();
	const base = page.replace(/\.html?$/i, "");
	const hash = /collages\/[^"'?]*\?v=([0-9a-f]{12})/.exec(html)?.[1];
	let bitmap_restored = false;
	const bitmap_key = `${prefix}collages/${base}.png`;
	if (hash) {
		const kept = await bucket.get(`${prefix}versions/bitmaps/${base}.${hash}.png`);
		if (kept) {
			const kept_bytes = new Uint8Array(await kept.arrayBuffer());
			await archive_before_overwrite(bucket, prefix, `collages/${base}.png`, bitmap_key, kept_bytes); // (keeps the current picture if it differs)
			await bucket.put(bitmap_key, kept_bytes, { httpMetadata: { contentType: "image/png" } });
			bitmap_restored = true;
		} else {
			const current = await bucket.get(bitmap_key);
			if (current && await short_hash(new Uint8Array(await current.arrayBuffer())) === hash) {
				bitmap_restored = true; // the page's current picture is already the one this version had
			}
		}
	}
	await archive_before_overwrite(bucket, prefix, page, `${prefix}${page}`, new TextEncoder().encode(html));
	await bucket.put(`${prefix}${page}`, html, { httpMetadata: { contentType: content_type_for(page) } });
	return { ok: true, page, version, bitmap_restored };
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {{ SITES: R2Bucket, SITES_URL: string, SITE_EDIT_SECRET?: string }} env
 * @param {{ page: string, key: string } | null} [invite] - the request is a guest's (their share key), allowed only within their page
 */
async function handle_site_files(request, url, env, invite = null, ctx = null) {
	const accounts = accounts_of(env);
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
				if ((path.split("/").pop() || "").startsWith(".")) { continue; } // (the admin's marker — moderation.js — isn't a file of the site)
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
		// A site the admin took down, or a page the admin hid, isn't readable here either — unless you're its owner or the master
		const moderation = await read_moderation(env, name);
		if ((moderation.disabled || page_hidden(moderation, path)) && !(await role_of(request, env, name))) { return json({ error: "Not found" }, 404); }
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
		const existing = await env.SITES.head(key);
		await env.SITES.delete(key);
		if (existing) {
			const usage = await site_usage(env, name);
			await accounts.set_usage(name, usage.bytes - existing.size, usage.files - 1);
			if (ctx) { ctx.waitUntil(recount_usage(env, name)); }
		}
		await notify_published(env, ctx, name, path);
		return json({ ok: true, deleted: path });
	}
	if (request.method === "PUT") {
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.length > MAX_FILE_BYTES) { return json({ error: `Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB` }, 413); }
		// A page written is a publish: a few per 10 s per site is plenty for a person (uploads of pictures aren't counted)
		if (is_html_path(path) && await limited(env.LIMIT_PUBLISH, `publish:${name}`)) { report_limited(env, ctx, { kind: "publish", worker: "jspaint-editor" }); return too_many(10, CORS_HEADERS); }
		if (is_html_path(path) && (await read_moderation(env, name)).disabled && (await role_of(request, env)) !== "master") { return json({ error: "This site is unavailable.", code: "disabled" }, 403); }
		// The site's quota: what it holds now (archives included), less what this write replaces, plus this file
		const existing = await env.SITES.head(key);
		const usage = await site_usage(env, name);
		const limit_bytes = usage.limit_bytes ?? QUOTA_BYTES;
		const limit_files = usage.limit_files ?? QUOTA_FILES;
		const after_bytes = usage.bytes - (existing?.size || 0) + bytes.length;
		const after_files = usage.files + (existing ? 0 : 1);
		if (after_bytes > limit_bytes || after_files > limit_files) {
			return json({ error: `This site is full (${Math.round(limit_bytes / 1024 / 1024)} MB, ${limit_files} files). Delete something in My Site to make room.`, code: "quota", usage: { bytes: usage.bytes, files: usage.files, limit_bytes, limit_files } }, 413);
		}
		if (invite) {
			// A guest's share key uploads a day's worth at most (the site's quota holds it too)
			const total = await accounts.add_guest_upload(await sha256_hex_of(invite.key), Math.floor(Date.now() / 86400000), bytes.length);
			if (total > GUEST_DAILY_BYTES) { return json({ error: "This share link has uploaded all it can today.", code: "quota" }, 413); }
		}
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
			body = await sanitize_html(text, { own_hosts: [env.SITES_URL, env.EDITOR_URL].filter(Boolean).map((u) => new URL(u).host) }); // (links to our own hosts aren't outbound)
		} else if (!/^text\//.test(content_type)) {
			const sniffed = sniff_type(bytes.slice(0, 12));
			if (!sniffed || sniffed !== content_type) {
				return json({ error: `The file doesn't look like ${content_type}` }, 400);
			}
		}
		await archive_before_overwrite(env.SITES, prefix, path, key, bytes);
		const object = await env.SITES.put(key, body, { httpMetadata: { contentType: content_type } });
		await accounts.set_usage(name, after_bytes, after_files); // (the archive just made is counted by the recount)
		if (ctx) { ctx.waitUntil(recount_usage(env, name)); }
		await notify_published(env, ctx, name, path);
		return json({ ok: true, path, size: object.size, etag: object.httpEtag, url: public_url(path) });
	}
	return json({ error: "Method not allowed" }, 405);
}

/** @param {string} text */
async function sha256_hex_of(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * What a site holds, from Accounts — counted from the bucket first if it was never counted.
 * @param {any} env @param {string} site
 * @returns {Promise<{ bytes: number, files: number, limit_bytes: number | null, limit_files: number | null, updated: number }>}
 */
async function site_usage(env, site) {
	const usage = await accounts_of(env).usage_of(site);
	return usage.updated ? usage : recount_usage(env, site);
}

/**
 * Counts every object under the site (pages, media, archives) and stores the total. One listing per thousand
 * objects; runs after each write (off the response) and whenever a site has never been counted.
 * @param {any} env @param {string} site
 */
async function recount_usage(env, site) {
	const prefix = `sites/${site}/`;
	let bytes = 0, files = 0, cursor;
	do {
		const listing = await env.SITES.list({ prefix, cursor });
		for (const object of listing.objects) { bytes += object.size; files += 1; }
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	const accounts = accounts_of(env);
	await accounts.set_usage(site, bytes, files);
	const usage = await accounts.usage_of(site);
	return usage;
}

/** A site's usage as the API reports it (the defaults filled in). @param {string} site @param {{ bytes: number, files: number, limit_bytes: number | null, limit_files: number | null }} usage */
function usage_report(site, usage) {
	return { site, bytes: usage.bytes, files: usage.files, limit_bytes: usage.limit_bytes ?? QUOTA_BYTES, limit_files: usage.limit_files ?? QUOTA_FILES };
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
// edit.<domain>/new: a fresh site's first page (the starter page and the Welcome window, src/my-site.js), for anyone
const NEW_SITE_PATH = "/new";
/**
 * Page addresses on the editor host mirror the sites host, and open that page in Paint (src/my-site.js: the page
 * itself when you're signed in as the site, a copy otherwise): edit.<domain>/~name[/page] → ?site=name[&page=…],
 * and edit.<domain>/about (or /about.html, /blog/post) → the root site's page. ".html" is optional. A path under
 * a site that isn't a page (a GIF, a typo) just opens the site. edit.<domain>/new → ?new=1: a new site's first
 * page. Returns null for Paint's own files.
 * @param {URL} url
 * @returns {Response | null}
 */
export function site_entry_redirect(url) {
	if (APP_FILES.has(url.pathname) || APP_DIRECTORIES.test(url.pathname) || url.pathname === "/admin") { return null; }
	if (url.pathname === NEW_SITE_PATH || url.pathname === `${NEW_SITE_PATH}/`) {
		return new Response(null, { status: 302, headers: { Location: "/?new=1", "Cache-Control": "no-store" } });
	}
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

const editor = {
	/**
	 * @param {Request} request
	 * @param {{ ASSETS: Fetcher, SITES: R2Bucket, PAGE_ROOM: DurableObjectNamespace, GIF_STATS: DurableObjectNamespace, ACCOUNTS: DurableObjectNamespace, EDITOR_URL?: string, SITES_URL: string, SITE_EDIT_SECRET?: string, POSTHOG_API_KEY?: string, POSTHOG_HOST?: string }} env
	 * @param {ExecutionContext} ctx - waitUntil for fire-and-forget work (server-side analytics capture)
	 */
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/auth/")) {
			try {
				return await handle_auth(request, url, env, { role_of, password_hash, site_hash }, ctx);
			} catch (error) {
				console.error(error);
				return json({ error: error.message || String(error) }, 500);
			}
		}
		const admin = await handle_admin(request, url, env, ctx, role_of);
		if (admin) { return admin; }
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
			const room_match = /^\/api\/sites\/([^/]+)\/rooms\/(.+?)(\/invite(?:\/revoke)?)?$/.exec(url.pathname);
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
					// POST …/rooms/<page>/invite: the owner makes a share key for this page; …/invite/revoke ends every key made so far
					if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
					if (!await role_of(request, env, name)) { return json({ error: "Unauthorized: send Authorization: Bearer <password>" }, 401); }
					if (room_match[3] === "/invite/revoke") {
						const nonce = String(await /** @type {any} */ (env.PAGE_ROOM.getByName(`${name}/${page}`)).revoke_invites());
						nonce_cache.set(`${name}/${page}`, nonce);
						return json({ site: name, page, revoked: true });
					}
					const body = await request.json().catch(() => ({}));
					return json({ site: name, page, ...(await make_invite(env.SITE_EDIT_SECRET, name, page, Number(body.days) || 30, await room_nonce(env, name, page))) });
				}
				if (request.headers.get("Upgrade") !== "websocket") { return json({ error: "The room is a WebSocket endpoint" }, 426); }
				if (await limited(env.LIMIT_CONNECT, `connect:${client_ip(request)}`)) { report_limited(env, ctx, { kind: "connect", worker: "jspaint-editor" }); return too_many(60, CORS_HEADERS); }
				const owner = await role_of(request, env, name);
				if (!owner && !await invite_valid(invite_key_of(request), env.SITE_EDIT_SECRET, name, page, await room_nonce(env, name, page))) { return json({ error: "Unauthorized: add ?token=<password> or ?invite=<share key>" }, 401); }
				return env.PAGE_ROOM.getByName(`${name}/${page}`).fetch(request);
			}
			if (url.pathname === "/api/gifcities/search") {
				if (await limited(env.LIMIT_IP_10S, `gif-search:${client_ip(request)}`)) { report_limited(env, ctx, { kind: "gif-search", worker: "jspaint-editor" }); return too_many(10, CORS_HEADERS); }
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
			if (url.pathname === "/api/reports" && request.method === "POST") {
				// A visitor's report of a page, forwarded by the sites Worker's form (worker/sites/index.js handle_report):
				// kept for the admin (three a day per visitor — accounts.js add_report), and a `site_reported` event
				const body = await request.json().catch(() => ({}));
				const site = String(body.site || "");
				const page = String(body.page || "");
				const reason = String(body.reason || "").trim().slice(0, 500);
				const ip_hash = String(body.ip_hash || "");
				if (!valid_site_name(site) || !valid_path(page) || !is_html_path(page) || reason.length < 3 || !/^[0-9a-f]{64}$/.test(ip_hash)) { return json({ error: "site, page, reason, and ip_hash are needed" }, 400); }
				if (await limited(env.LIMIT_IP_60S, `report:${ip_hash}`)) { return too_many(60, CORS_HEADERS); }
				const result = await accounts_of(env).add_report({ site, page, reason, ip_hash });
				if (!result.ok) { return json({ error: "You've reported enough for today.", code: "rate-limited" }, 429); }
				capture_event(env, ctx, "site_reported", "visitor", { site, page });
				return json({ ok: true, id: result.id });
			}
			if (url.pathname === "/api/gifs/used" && request.method === "POST") {
				// Someone signed in, or holding a site's password or the master key: a stranger's click counts for nothing
				// (each one used to be a row written by anyone who cared to POST)
				if (await limited(env.LIMIT_IP_60S, `gifs-used:${client_ip(request)}`)) { report_limited(env, ctx, { kind: "gifs-used", worker: "jspaint-editor" }); return too_many(60, CORS_HEADERS); }
				const body = await request.json().catch(() => ({}));
				const gif = String(body.gif || "");
				const site = String(body.site || "");
				if (!/^[A-Z0-9]{20,40}$/.test(gif)) { return json({ error: "gif must be a GifCities id" }, 400); }
				if (site && !valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
				if (!(await role_of(request, env, site)) && !(await session_of(request, env))) { return json({ error: "Sign in first" }, 401); }
				await env.GIF_STATS.getByName("global").record(gif, site);
				return json({ ok: true });
			}
			if (url.pathname === "/api/gifs/top") {
				if (await limited(env.LIMIT_IP_10S, `gifs-top:${client_ip(request)}`)) { return too_many(10, CORS_HEADERS); }
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
				return handle_site_files(request, url, env, null, ctx);
			}
			if (url.pathname === "/api/debug/exception" && request.method === "POST") {
				// Support: proves the error pipeline end to end — sends a test $exception to PostHog and answers with
				// PostHog's status (master key only; docs/DEPLOY.md). Look for "Test exception from the editor Worker" in Error tracking.
				if ((await role_of(request, env)) !== "master") { return json({ error: "Unauthorized: send Authorization: Bearer <master key>" }, 401); }
				const posthog_status = await capture_exception(env, ctx, new Error(`Test exception from the editor Worker (${new Date().toISOString()})`), { worker: "jspaint-editor", route: url.pathname, method: request.method, status: 500, test: true });
				return json({ reported: posthog_status === 200, posthog_status, configured: !!env.POSTHOG_API_KEY });
			}
			if (url.pathname === "/api/whoami") {
				// Paint's sign-in check: the master (any site) or the site's password (needs ?site=).
				const site = url.searchParams.get("site") || "";
				if (site && !valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
				const role = await role_of(request, env, site);
				const session = await session_of(request, env, { fresh: true }); // (reported even beside a password: Paint then knows the account and can drop the password; fresh: it names the account, and a sign-out must show)
				if (!role && !session) { return json({ error: "Unauthorized: the password was rejected" }, 401); }
				// `created`: when the site got its password (My Site's summary); null for a site the master key alone edits
				const accounts = accounts_of(env);
				const created = site ? await accounts.get_created(site) : null;
				// A signed-in account: who, and which sites are theirs ("user" = signed in, but not this site's owner)
				const account = session ? { user: { id: session.id, email: session.email, name: session.name }, sites: await accounts.sites_of(session.id), admin: session.admin === true } : {};
				return json({ ok: true, role: role || "user", site: site || null, created, sites_url: env.SITES_URL, editor_url: url.origin, ...account });
			}
			const presence_match = /^\/api\/sites\/([^/]+)\/presence$/.exec(url.pathname);
			if (presence_match) {
				// Who's editing the site right now: the clients in its pages' live rooms (public: a count, nothing more)
				const name = presence_match[1];
				if (!valid_site_name(name)) { return json({ error: "Bad site name" }, 400); }
				// One answer per site per 10 s, whoever asks (each fresh answer lists the bucket and wakes every page's room)
				const cached = presence_cache.get(name);
				if (cached) { return json(cached, 200, { "Cache-Control": "no-store", "X-Cache": "hit" }); }
				if (await limited(env.LIMIT_IP_10S, `presence:${client_ip(request)}`)) { report_limited(env, ctx, { kind: "presence", worker: "jspaint-editor" }); return too_many(10, CORS_HEADERS); }
				const listing = await env.SITES.list({ prefix: `sites/${name}/`, limit: 200 });
				const pages = listing.objects.map((object) => object.key.slice(`sites/${name}/`.length)).filter((path) => is_html_path(path) && !path.startsWith("versions/")).slice(0, 20);
				const counts = await Promise.all(pages.map(async (page) => ({ page, editing: await /** @type {any} */ (env.PAGE_ROOM.getByName(`${name}/${page}`)).client_count() })));
				const answer = presence_cache.set(name, { site: name, editing: counts.reduce((sum, entry) => sum + entry.editing, 0), pages: counts.filter((entry) => entry.editing > 0) });
				return json(answer, 200, { "Cache-Control": "no-store", "X-Cache": "miss" });
			}
			const usage_match = /^\/api\/sites\/([^/]+)\/(usage|quota)$/.exec(url.pathname);
			if (usage_match) {
				// What the site holds against its quota (the owner, for My Site's storage line); the master sets the quota
				const name = usage_match[1];
				if (!valid_site_name(name)) { return json({ error: "Bad site name" }, 400); }
				const role = await role_of(request, env, name);
				if (!role) { return json({ error: "Unauthorized: send Authorization: Bearer <password>" }, 401); }
				if (usage_match[2] === "quota") {
					if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
					if (role !== "master") { return json({ error: "Unauthorized: send Authorization: Bearer <master key>" }, 401); }
					const body = await request.json().catch(() => ({}));
					const limit = (/** @type {unknown} */ value) => (value === null || value === undefined ? null : Math.max(0, Math.round(Number(value) || 0)) || null);
					await accounts_of(env).set_quota(name, limit(body.bytes), limit(body.files));
					return json(usage_report(name, await site_usage(env, name)));
				}
				if (request.method !== "GET") { return json({ error: "Method not allowed" }, 405); }
				return json(usage_report(name, url.searchParams.has("recount") ? await recount_usage(env, name) : await site_usage(env, name)));
			}
			const password_match = /^\/api\/sites\/([^/]+)\/password$/.exec(url.pathname);
			if (password_match) {
				// The master key gives a site a fresh random password (or takes it away). The password is returned exactly once.
				const name = password_match[1];
				if (!valid_site_name(name)) { return json({ error: "Bad site name" }, 400); }
				const role = await role_of(request, env, name);
				if (!role) { return json({ error: "Unauthorized: send Authorization: Bearer <master key>" }, 401); }
				const accounts = /** @type {any} */ (env.ACCOUNTS.getByName("global"));
				const session = bearer_of(request) ? null : await session_of(request, env);
				const owner = !!session && (await accounts.owner_of(name)) === session.id; // (the account that owns the site, not someone holding its password)
				if (role !== "master" && !owner) { return json({ error: "Only the master key or the site's owner can set a site's password" }, 403); }
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
			const versions_match = /^\/api\/sites\/([^/]+)\/versions(\/restore)?$/.exec(url.pathname);
			if (versions_match) {
				const name = versions_match[1];
				if (!valid_site_name(name)) { return json({ error: "Bad site name" }, 400); }
				if (!await role_of(request, env, name)) { return json({ error: "Unauthorized: send Authorization: Bearer <password>" }, 401); }
				const prefix = `sites/${name}/`;
				if (versions_match[2]) {
					if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
					const body = await request.json().catch(() => ({}));
					const page = String(body.page || "");
					const version = String(body.version || "");
					if (!valid_path(page) || !is_html_path(page) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z$/.test(version)) { return json({ error: "page (a .html path) and version (a stamp from the list) are needed" }, 400); }
					const result = await restore_version(env.SITES, prefix, page, version);
					if (result.ok) { await notify_published(env, ctx, name, page); } // (the served page is remade at once)
					return json(result, result.ok ? 200 : 404);
				}
				const page = url.searchParams.get("page") || "";
				if (!valid_path(page) || !is_html_path(page)) { return json({ error: "?page=<path>.html" }, 400); }
				return json({ page, versions: (await list_versions(env.SITES, prefix, page)).map(({ version, uploaded, size }) => ({ version, uploaded, size })) });
			}
			const files_match = /^\/api\/sites\/([^/]+)\/files(?:\/|$)/.exec(url.pathname);
			if (files_match) {
				const name = files_match[1];
				if (!valid_site_name(name)) { return json({ error: "Site names are 1–32 lowercase letters, digits, or hyphens" }, 400); }
				if (await role_of(request, env, name)) {
					return handle_site_files(request, url, env, null, ctx);
				}
				// A guest with a share key may list the site and save their page (handle_site_files scopes the writes).
				const guest_page = request.headers.get("X-Invite-Page") || "";
				if (valid_path(guest_page) && is_html_path(guest_page) && await invite_valid(invite_key_of(request), env.SITE_EDIT_SECRET, name, guest_page, await room_nonce(env, name, guest_page))) {
					return handle_site_files(request, url, env, { page: guest_page, key: invite_key_of(request) }, ctx);
				}
				return json({ error: "Unauthorized: send Authorization: Bearer <password>" }, 401);
			}
			return json({ error: "Not found" }, 404);
		} catch (error) {
			console.error(error);
			const message = error.message || String(error);
			const quota = /Durable Objects free tier/i.test(message);
			// The server's own failures are $exception events too (PostHog Error tracking) — the browser never sees them as errors
			capture_exception(env, ctx, error, { worker: "jspaint-editor", route: url.pathname, method: request.method, status: quota ? 503 : 500, ...(quota ? { code: "storage-quota" } : {}) });
			// Clients get a plain message and a code; the detail lives in PostHog and the Worker logs (a person editing
			// their page needn't read about Cloudflare's tiers or a stack trace). The Durable Objects quota (the Workers
			// Free plan meters rows per day; docs/DEPLOY.md) is a 503 with Retry-After so Paint knows it's temporary.
			if (quota) { return json({ error: "Something went wrong on our side. Please try again in a little while.", code: "storage-quota" }, 503, { "Retry-After": "3600" }); }
			return json({ error: "Something went wrong on our side. Please try again in a little while.", code: "server-error" }, 500);
		}
	},
};

/**
 * Paint on one localhost port talking to the Worker on another (tests, `npm run dev:*`) must send the session cookie:
 * that takes the exact origin and Allow-Credentials, which the plain "*" (fine for bearer auth) can't say. Production
 * is same-origin and never needs this.
 * @param {Request} request @param {Response} response @param {any} env
 */
function with_dev_cors(request, response, env) {
	const origin = request.headers.get("Origin") || "";
	const local_editor = /^http:\/\/localhost(:\d+)?$/.test(editor_origin(new URL(request.url), env)); // (wrangler dev reports the custom domain as the host: go by config)
	if (response.status === 101 || !/^http:\/\/localhost(:\d+)?$/.test(origin) || !local_editor) { return response; }
	if (!response.headers.has("Access-Control-Allow-Origin")) { return response; }
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Access-Control-Allow-Credentials", "true");
	headers.append("Vary", "Origin");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
	/** @param {Request} request @param {any} env @param {ExecutionContext} ctx */
	async fetch(request, env, ctx) {
		return with_dev_cors(request, await with_refreshed_claims(request, await editor.fetch(request, env, ctx)), env);
	},
};
