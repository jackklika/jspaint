// @ts-check
// jspaint-sites: serves user sites from the `sites/<name>/<path>` keys of the R2 bucket — /~name/<path> for a site,
// and the "root" site at the domain root itself (coolpaint.world/<path> → sites/root/<path>). Pages (.html) are
// sanitized again and have their <x-*> elements rendered server-side; everything else streams through with a
// fixed content type. Strict CSP on every response: pages can't run scripts. /about serves about.html (clean
// addresses); a folder's bare address redirects to its slash; a site's 404.html, when it has one, is its not-found page.
// POST /~name/x/<element> (or /x/<element> for root) runs an <x-*> element's action (the guestbook form), also here.
// POST /~name/x/preview {page, tag, attrs, page_html?} renders one <x-*> element as the page would show it right now
// (the editor puts that on the canvas: the real count, the folder's pages) — a look, not a visit; CORS open.
// Served pages are cached (Cache API) under the site's *generation*, a counter in its Durable Object that every
// publish, delete (the editor POSTs /~name/x/published), and guestbook signing bumps: a view is one trip to that
// object (the visit recorded, the generation and the page's hit count back), then the cached page with the count
// filled into the counter's slot — no R2 read, no sanitize, no rendering. A miss renders and stores.
// Moderation (the editor's admin, MALICIOUS_ACTOR_PLAN.md phase 2): a marker the editor writes, `.moderation.json`
// under the site, re-read at every bump — a disabled site answers 451, a hidden page 404, a site in its first day is
// noindex. Every page ends with a "report this page" link; /~name/x/report is the form, forwarded to the editor.
import { DurableObject } from "cloudflare:workers";
import { ROOT_SITE, content_type_for, extension_of, is_html_path, site_base, site_home, valid_path, valid_site_name } from "../shared/names.js";
import { capture_exception } from "../shared/exceptions.js";
import { find_sections, text_of } from "../shared/sections.js";
import { sanitize_html } from "../shared/sanitize.js";
import { escape_html, render_x_element, render_x_elements, x_elements } from "../shared/x-elements/index.js";
import { odometer } from "../shared/x-elements/counter.js";
import { ShortCache, client_ip, limited, report_limited, too_many } from "../shared/limits.js";

const PAGE_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	// no-transform: Cloudflare then leaves the HTML alone — no Web Analytics beacon or other injected script on pages.
	"Cache-Control": "no-cache, no-transform",
};

const VIEWING_WINDOW_MS = 5 * 60 * 1000; // "viewing now": loaded a page this recently
const VIEWS_KEPT_MS = 24 * 60 * 60 * 1000;
const GUESTBOOK_MIN_INTERVAL_MS = 30 * 1000; // per visitor
const GUESTBOOK_MAX_PER_DAY = 20; // per visitor

/** @param {string} text */
async function sha256_hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const GUESTBOOK_MAX_ENTRIES = 2000; // per site
const PAGE_CACHE_S = 60 * 60; // a rendered page's life in the cache if no change ever bumps the generation (a missed ping)
const VIEW_FLUSH_MS = 15 * 1000; // views and counter hits are tallied in memory and written this often
const CRAWLER_UA = /bot|crawl|spider|slurp|facebookexternalhit|linkpreview|headless/i; // a page load by one of these isn't a visit
const MODERATION_FILE = ".moderation.json"; // the editor's marker (worker/editor/moderation.js); never a valid path, so never served
const NOINDEX_MS = 24 * 60 * 60 * 1000; // a site's first day: noindex
const MAX_REPORT_CHARS = 500;
/** @typedef {{ disabled?: boolean, hidden?: string[], reason?: string, created?: number }} Moderation */
/** A site's viewer stats, kept 5 s: the editor's globe asks, and each fresh answer counts every view row of the day. @type {ShortCache<any>} */
const stats_cache = new ShortCache(5_000);

/** Per-site state for <x-*> elements: visitor counters and guestbook entries. */
export class SiteState extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(() => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (page TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0)");
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, message TEXT NOT NULL, ip_hash TEXT NOT NULL, created INTEGER NOT NULL)");
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS views (ip_hash TEXT NOT NULL, page TEXT NOT NULL, at INTEGER NOT NULL)");
			this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS views_at ON views (at)");
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
			return Promise.resolve();
		});
		/** @type {number | undefined} */
		this.generation_cache = undefined;
		/** @type {Map<string, number>} `ip_hash|page` → when: views not yet written (one per visitor per page per flush) */
		this.pending_views = new Map();
		/** @type {Map<string, number>} page → counter hits not yet written */
		this.pending_hits = new Map();
		this.flush_at = 0;
		/** @type {Moderation | undefined} the site's marker as last read (undefined: not looked at yet) */
		this.moderation_cache = undefined;
	}
	/** The site's moderation marker, as of the last bump (read once from storage, from the bucket the first time ever). */
	moderation() {
		if (this.moderation_cache !== undefined) { return Promise.resolve(this.moderation_cache); }
		const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'moderation'").toArray()[0];
		if (row) {
			try { this.moderation_cache = /** @type {Moderation} */ (JSON.parse(String(row.value))); } catch (_error) { this.moderation_cache = {}; }
			return Promise.resolve(this.moderation_cache);
		}
		return this.refresh_moderation();
	}
	/** Re-reads the marker from the bucket (the editor just wrote it, or something was published). */
	async refresh_moderation() {
		/** @type {Moderation} */
		let moderation = {};
		try {
			const object = await /** @type {any} */ (this.env).SITES.get(`sites/${this.ctx.id.name}/${MODERATION_FILE}`);
			if (object) {
				const raw = JSON.parse(await object.text());
				moderation = { ...(raw.disabled === true ? { disabled: true } : {}), ...(Array.isArray(raw.hidden) ? { hidden: raw.hidden.filter((/** @type {unknown} */ p) => typeof p === "string") } : {}), ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}), ...(typeof raw.created === "number" ? { created: raw.created } : {}) };
			}
		} catch (_error) { /* an unreadable marker is no marker */ }
		this.moderation_cache = moderation;
		// (meta.value is INTEGER-typed but SQLite stores what it's given; the marker is small)
		this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('moderation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(moderation));
		return moderation;
	}
	/** Views and hits are written together, VIEW_FLUSH_MS after the first one pending (an alarm), not per page load. */
	async schedule_flush() {
		if (this.flush_at) { return; }
		this.flush_at = Date.now() + VIEW_FLUSH_MS;
		await this.ctx.storage.setAlarm(this.flush_at);
	}
	flush() {
		const sql = this.ctx.storage.sql;
		for (const [key, at] of this.pending_views) {
			const [ip_hash, page] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
			sql.exec("INSERT INTO views (ip_hash, page, at) VALUES (?, ?, ?)", ip_hash, page, at);
		}
		for (const [page, hits] of this.pending_hits) {
			sql.exec("INSERT INTO counters (page, hits) VALUES (?, ?) ON CONFLICT(page) DO UPDATE SET hits = hits + excluded.hits", page, hits);
		}
		if (this.pending_views.size && Math.random() < 0.05) { sql.exec("DELETE FROM views WHERE at < ?", Date.now() - VIEWS_KEPT_MS); }
		this.pending_views.clear();
		this.pending_hits.clear();
		this.flush_at = 0;
	}
	alarm() {
		this.flush();
	}
	/**
	 * The site's generation: the key its served pages are cached under. Bumped by every publish and delete (the editor
	 * pings /x/published) and every guestbook signing, so a cached page is never stale — a new generation is a new key.
	 */
	generation() {
		if (this.generation_cache === undefined) {
			const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'generation'").toArray()[0];
			this.generation_cache = row ? Number(row.value) : 1;
		}
		return this.generation_cache;
	}
	async bump() {
		const next = this.generation() + 1;
		this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", next);
		this.generation_cache = next;
		await this.refresh_moderation(); // (a publish, a delete, or the editor's admin wrote the marker)
		return next;
	}
	/**
	 * One trip per page view: records the visit (when `ip_hash` is given — a GET of a page) and returns what serving
	 * needs — the generation (the cache key) and the page's hit count (for its counter, if it has one; the Worker
	 * adds the visit with `hit()` after answering).
	 * @param {string} ip_hash - "" for a look that isn't a visit (HEAD, a 404)
	 * @param {string} page
	 */
	async view(ip_hash, page) {
		if (ip_hash) { await this.record_view(ip_hash, page); }
		return { generation: this.generation(), hits: this.get_hits(page), moderation: await this.moderation() };
	}
	/**
	 * Someone opened a page (the editor's globe shows "N viewing"). Pages carry no scripts, so a page load is the
	 * only signal there is: "viewing now" means "loaded a page in the last few minutes". Kept for a day.
	 * @param {string} ip_hash @param {string} page
	 */
	async record_view(ip_hash, page) {
		const key = `${ip_hash}|${page}`;
		if (!this.pending_views.has(key)) { this.pending_views.set(key, Date.now()); } // (a reload loop is one row per flush)
		await this.schedule_flush();
	}
	/** @returns {{ viewing: number, today: number, views_today: number }} distinct visitors in the last VIEWING_WINDOW_MS / day, and page loads today (the unwritten ones included) */
	viewers() {
		const now = Date.now();
		const since = (/** @type {number} */ ms) => new Set(this.ctx.storage.sql.exec("SELECT DISTINCT ip_hash FROM views WHERE at > ?", now - ms).toArray().map((row) => String(row.ip_hash)));
		const recent = since(VIEWING_WINDOW_MS);
		const today = since(VIEWS_KEPT_MS);
		const loads = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM views WHERE at > ?", now - VIEWS_KEPT_MS).one().n) + this.pending_views.size;
		for (const key of this.pending_views.keys()) {
			const ip_hash = key.slice(0, key.indexOf("|"));
			recent.add(ip_hash);
			today.add(ip_hash);
		}
		return { viewing: recent.size, today: today.size, views_today: loads };
	}
	/**
	 * Newest first.
	 * @param {number} limit
	 * @returns {{ id: number, name: string, message: string, created: number }[]}
	 */
	get_guestbook_entries(limit) {
		return this.ctx.storage.sql.exec("SELECT id, name, message, created FROM guestbook ORDER BY id DESC LIMIT ?", limit).toArray();
	}
	/**
	 * Adds an entry unless this visitor is posting too often. Returns whether it was added.
	 * @param {{ name: string, message: string, ip_hash: string }} entry
	 */
	add_guestbook_entry({ name, message, ip_hash }) {
		const now = Date.now();
		const recent = this.ctx.storage.sql.exec("SELECT MAX(created) AS last, COUNT(*) AS today FROM guestbook WHERE ip_hash = ? AND created > ?", ip_hash, now - 24 * 60 * 60 * 1000).one();
		if ((recent.last && now - recent.last < GUESTBOOK_MIN_INTERVAL_MS) || recent.today >= GUESTBOOK_MAX_PER_DAY) {
			return false;
		}
		this.ctx.storage.sql.exec("INSERT INTO guestbook (name, message, ip_hash, created) VALUES (?, ?, ?, ?)", name, message, ip_hash, now);
		this.ctx.storage.sql.exec("DELETE FROM guestbook WHERE id NOT IN (SELECT id FROM guestbook ORDER BY id DESC LIMIT ?)", GUESTBOOK_MAX_ENTRIES);
		void this.bump(); // (the pages showing the guestbook are remade)
		return true;
	}
	/**
	 * Counts one visit to a page and returns the new total.
	 * @param {string} page
	 * @returns {number}
	 */
	async hit(page) {
		this.pending_hits.set(page, (this.pending_hits.get(page) || 0) + 1);
		await this.schedule_flush();
		return this.get_hits(page);
	}
	/** @param {string} page @returns {number} the page's hits, the unwritten ones included */
	get_hits(page) {
		const row = this.ctx.storage.sql.exec("SELECT hits FROM counters WHERE page = ?", page).toArray()[0];
		return (row ? Number(row.hits) : 0) + (this.pending_hits.get(page) || 0);
	}
}

/**
 * Every HTML response goes through here: served pages, 404s, the landing page, form-action errors.
 * No analytics ever: published pages carry no scripts and no trackers (docs/DESIGN.md §9 — the
 * editor origin, coolpaint.world, is where product analytics lives).
 * @param {string} body
 * @param {number} status
 */
function html_response(body, status = 200) {
	return new Response(body, { status, headers: { ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

/** @param {string} message */
function not_found(message = "Not Found") {
	return html_response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>404</title></head>
<body bgcolor="#000000" text="#00ff00" style="font-family:'Courier New',monospace;text-align:center;padding-top:80px">
<h1>404</h1><p>${message}</p><p><marquee>~*~ this page is under construction ~*~</marquee></p>
</body></html>`, 404);
}

/**
 * POST /~name/x/<element> (or /x/<element> for the root site): the element's registry `action` (guestbook signing). Form posts only, same origin.
 * @param {Request} request
 * @param {URL} url
 * @param {{ SITES: R2Bucket, SITE_STATE: DurableObjectNamespace }} env
 */
async function handle_action(request, url, env) {
	const match = /^(?:\/~([^/]+))?\/x\/([a-z0-9-]+)$/.exec(url.pathname);
	const site = match ? (match[1] ?? ROOT_SITE) : "";
	if (!match || !valid_site_name(site)) {
		return not_found();
	}
	const definition = x_elements.get(`x-${match[2]}`);
	if (!definition || !definition.action) {
		return not_found();
	}
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) {
		return html_response("<p>Forms only work from the page itself.</p>", 403);
	}
	if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)/.test(request.headers.get("Content-Type") || "")) {
		return html_response("<p>Bad request.</p>", 400);
	}
	let form;
	try {
		form = await request.formData();
	} catch (_error) {
		return html_response("<p>Bad request.</p>", 400);
	}
	const state = env.SITE_STATE.getByName(site);
	if ((await state.moderation())?.disabled) { return unavailable(); }
	const result = await definition.action({
		form,
		context: { site, page: "", page_uploaded: null, state, request, files: site_files(env.SITES, site), page_html: "" },
	});
	if (result.location) {
		return new Response(null, { status: result.status || 303, headers: { ...PAGE_HEADERS, Location: result.location } });
	}
	return html_response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Oops</title></head><body style="font-family:'Comic Sans MS',cursive;text-align:center;padding-top:60px"><p>${result.error || "Something went wrong."}</p><p><a href="javascript:history.back()">Go back</a></p></body></html>`.replace('<a href="javascript:history.back()">Go back</a>', `<a href="${site_home(site)}">Go back</a>`), result.status || 400);
}

/**
 * POST /~name/x/preview (or /x/preview for the root site): one <x-*> element rendered as the page would show it now,
 * for the editor's canvas. JSON in, JSON out ({ html }); the body is sent as text/plain so no preflight is needed.
 * Nothing counts as a visit (`preview` in the context). Public data only, like the pages themselves.
 * @param {Request} request
 * @param {{ SITES: R2Bucket, SITE_STATE: DurableObjectNamespace }} env
 * @param {string} site
 */
async function handle_preview(request, env, site) {
	// From the editor (or this host), not from any page on the web: rendering costs, and folder previews list the bucket
	const origin = request.headers.get("Origin") || "";
	const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": origin || "*" };
	const reply = (/** @type {any} */ data, status = 200) => new Response(JSON.stringify(data), { status, headers });
	if (origin && !preview_origin_allowed(origin, new URL(request.url), env)) { return reply({ error: "Previews are for the editor" }, 403); }
	let body;
	try {
		body = JSON.parse((await request.text()).slice(0, 600 * 1024));
	} catch (_error) {
		return reply({ error: "Bad JSON" }, 400);
	}
	const page = String(body.page || "");
	const tag = String(body.tag || "").toLowerCase();
	if (!valid_path(page) || !is_html_path(page)) { return reply({ error: "Bad page" }, 400); }
	if (!x_elements.has(tag)) { return reply({ error: "Not an element" }, 404); }
	const object = await env.SITES.head(`sites/${site}/${page}`);
	const html = await render_x_element(tag, body.attrs && typeof body.attrs === "object" ? body.attrs : {}, {
		site,
		page,
		page_uploaded: object ? object.uploaded : null,
		state: env.SITE_STATE.getByName(site),
		request,
		files: site_files(env.SITES, site),
		page_html: typeof body.page_html === "string" ? body.page_html.slice(0, 512 * 1024) : "",
		preview: true,
	});
	return reply({ html });
}

/** The admin took the site down: one plain page, never cached. */
function unavailable() {
	return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Unavailable</title></head>
<body bgcolor="#000000" text="#00ff00" style="font-family:'Courier New',monospace;text-align:center;padding-top:80px">
<h1>451</h1><p>This site is unavailable.</p>
</body></html>`, { status: 451, headers: { ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * Every served page ends with a small "report this page" link (MALICIOUS_ACTOR_PLAN.md phase 2), before </body>.
 * @param {string} html @param {string} site @param {string} page
 */
function with_report_link(html, site, page) {
	const link = `<p class="cpw-report" style="text-align:right;font:10px/1.4 Verdana,Arial,sans-serif;margin:32px 8px 8px;opacity:.55"><a href="${escape_html(`${site_base(site)}/x/report?page=${encodeURIComponent(page)}`)}" style="color:inherit" rel="nofollow">report this page</a></p>`;
	const at = html.search(/<\/body\s*>/i);
	return at === -1 ? html + link : html.slice(0, at) + link + html.slice(at);
}

/**
 * GET /~name/x/report?page=… shows the form; POST takes it, and forwards the report to the editor Worker (POST
 * /api/reports, which keeps three a day per visitor and shows them to the admin). Plain pages, in the 404's style.
 * @param {Request} request @param {URL} url @param {{ SITE_STATE: DurableObjectNamespace, EDITOR_URL?: string }} env @param {ExecutionContext} ctx @param {string} site
 */
async function handle_report(request, url, env, ctx, site) {
	const page_of = (/** @type {string} */ value) => (valid_path(value) && is_html_path(value) ? value : "index.html");
	const shell = (/** @type {string} */ title, /** @type {string} */ body, status = 200) => new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape_html(title)}</title></head>
<body bgcolor="#000000" text="#00ff00" style="font-family:'Courier New',monospace;text-align:center;padding:60px 16px">
${body}
</body></html>`, { status, headers: { ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
	if (request.method === "GET") {
		const page = page_of(url.searchParams.get("page") || "");
		return shell("Report this page", `<h1>Report this page</h1>
<p>${escape_html(`${site_base(site)}/${page === "index.html" ? "" : page}`)}</p>
<form method="post" action="${escape_html(`${site_base(site)}/x/report`)}" style="display:inline-block;text-align:left;max-width:480px">
<input type="hidden" name="page" value="${escape_html(page)}">
<p><label>What's wrong with it?<br><textarea name="reason" rows="5" cols="48" maxlength="${MAX_REPORT_CHARS}" required style="width:100%;background:#000;color:#0f0;border:1px solid #0f0;font:inherit"></textarea></label></p>
<p style="display:none"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
<p><button type="submit" style="background:#000;color:#0f0;border:1px solid #0f0;font:inherit;padding:4px 12px">Send report</button> <a href="${escape_html(site_home(site))}" style="color:#0f0">never mind</a></p>
</form>`);
	}
	if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)/.test(request.headers.get("Content-Type") || "")) { return shell("Report", "<p>Bad request.</p>", 400); }
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) { return shell("Report", "<p>Forms only work from the page itself.</p>", 403); }
	let form;
	try {
		form = await request.formData();
	} catch (_error) {
		return shell("Report", "<p>Bad request.</p>", 400);
	}
	const page = page_of(String(form.get("page") || ""));
	const reason = String(form.get("reason") || "").trim().slice(0, MAX_REPORT_CHARS);
	if (String(form.get("website") || "")) { return shell("Thanks", "<h1>Thanks</h1><p>Your report was sent.</p>"); } // (the honeypot: pretend)
	if (reason.length < 3) { return shell("Report", "<p>Say a little about what's wrong.</p>", 400); }
	const ip_hash = await sha256_hex(`view|${request.headers.get("CF-Connecting-IP") || "unknown"}`);
	let outcome = "sent";
	if (env.EDITOR_URL) {
		try {
			const response = await fetch(`${env.EDITOR_URL}/api/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ site, page, reason, ip_hash }), signal: AbortSignal.timeout(5000) });
			outcome = response.ok ? "sent" : response.status === 429 ? "enough" : "failed";
		} catch (_error) {
			outcome = "failed";
		}
	}
	void ctx;
	if (outcome === "enough") { return shell("Report", `<h1>Thanks</h1><p>You've reported enough for today.</p><p><a href="${escape_html(site_home(site))}" style="color:#0f0">back</a></p>`, 429); }
	if (outcome === "failed") { return shell("Report", `<p>Something went wrong on our side. Please try again in a little while.</p>`, 503); }
	return shell("Thanks", `<h1>Thanks</h1><p>Your report was sent. Someone will look at it.</p><p><a href="${escape_html(site_home(site))}" style="color:#0f0">back</a></p>`);
}

/**
 * Whose previews we render: the editor's, this host's own, and — when the editor is a localhost one (dev, tests) —
 * any localhost port's. A request without an Origin (not a browser) is allowed; it can't be a page's script.
 * @param {string} origin @param {URL} url @param {{ EDITOR_URL?: string, SITES_URL?: string }} env
 */
function preview_origin_allowed(origin, url, env) {
	const editor = env.EDITOR_URL ? new URL(env.EDITOR_URL).origin : "";
	const sites = env.SITES_URL ? new URL(env.SITES_URL).origin : "";
	if (origin === url.origin || origin === editor || origin === sites) { return true; }
	return /^http:\/\/localhost(:\d+)?$/.test(editor) && /^http:\/\/localhost(:\d+)?$/.test(origin);
}

/** A same-origin redirect. Relative Location on purpose: Response.redirect() rejects relative URLs, and under `wrangler dev` the request's origin is the configured custom domain. @param {string} location @param {number} [status] */
function path_redirect(location, status = 301) {
	return new Response(null, { status, headers: { ...PAGE_HEADERS, Location: location } });
}

/**
 * Old hostnames (the *.workers.dev fallback, www., and the former sites. subdomain) send visitors to the domain;
 * pages are addressed by path, so nothing else changes. Allow-listed so a misconfigured var can't loop.
 * @param {URL} url
 * @param {string | undefined} sites_url
 */
function legacy_host_redirect(url, sites_url) {
	if (!sites_url) { return null; }
	const canonical = new URL(sites_url);
	if (url.host === canonical.host) { return null; }
	const legacy = url.hostname.endsWith(".workers.dev") || url.hostname === `www.${canonical.hostname}` || url.hostname === `sites.${canonical.hostname}`;
	return legacy ? Response.redirect(`${canonical.origin}${url.pathname}${url.search}`, 301) : null;
}

/** What the domain shows before the root site has a page. @param {string | undefined} editor_url */
function landing_page(editor_url) {
	return html_response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>coolpaint.world</title></head>
<body bgcolor="#ffffd9" style="font-family:'Comic Sans MS',cursive;text-align:center;padding-top:60px">
<h1>~ coolpaint.world ~</h1><p>Web pages painted in Paint. Personal pages live at <code>/~name/</code>.</p>
${editor_url ? `<p><a href="${editor_url}">Make one</a></p>` : ""}
</body></html>`);
}

/**
 * What <x-*> renderers may read of a site: its pages in a folder (direct children, .html only) and a page's title.
 * @param {R2Bucket} bucket
 * @param {string} site
 */
function site_files(bucket, site) {
	const prefix = `sites/${site}/`;
	return {
		/** @param {string} folder */
		async list_pages(folder) {
			const base = `${prefix}${folder}/`;
			/** @type {{ path: string, uploaded: number }[]} */
			const pages = [];
			let cursor;
			do {
				const listing = await bucket.list({ prefix: base, cursor });
				for (const object of listing.objects) {
					const rest = object.key.slice(base.length);
					if (!rest.includes("/") && /\.html?$/i.test(rest)) { pages.push({ path: object.key.slice(prefix.length), uploaded: object.uploaded.getTime() }); }
				}
				cursor = listing.truncated ? listing.cursor : undefined;
			} while (cursor);
			return pages;
		},
		/** @param {string} path */
		async page_title(path) {
			const object = await bucket.get(`${prefix}${path}`);
			if (!object) { return null; }
			const match = /<title>([^<]*)<\/title>/i.exec(await object.text());
			return match ? match[1].trim() : null;
		},
		/** The first words of a page (its first section, else its text), for feeds. @param {string} path */
		async page_summary(path) {
			const object = await bucket.get(`${prefix}${path}`);
			if (!object) { return ""; }
			const html = await object.text();
			const [section] = find_sections(html);
			const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
			return text_of(section ? section.html : body ? body[1] : "", 300);
		},
		/** site.json — the site's settings (folders marked as posts, titles). @returns {Promise<any>} */
		async settings() {
			const object = await bucket.get(`${prefix}site.json`);
			if (!object) { return {}; }
			try {
				const settings = JSON.parse(await object.text());
				return settings && typeof settings === "object" ? settings : {};
			} catch (_error) {
				return {};
			}
		},
		/** Whether the site has a file. @param {string} path */
		async has(path) {
			return !!await bucket.head(`${prefix}${path}`);
		},
	};
}

/** @param {string} text */
function escape_xml(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[c]));
}

/**
 * /~name/<folder>/feed.xml: an RSS feed of a folder site.json marks as posts (newest first).
 * @param {ReturnType<typeof site_files>} files
 * @param {string} site
 * @param {string} folder
 * @param {URL} url
 */
async function rss_feed(files, site, folder, url) {
	const settings = await files.settings();
	const config = settings.folders && settings.folders[folder];
	if (!config || config.kind !== "posts") { return not_found(`There's no feed for <b>${site_base(site)}/${folder}/</b> — it isn't a posts folder.`); }
	const pages = (await files.list_pages(folder)).filter((page) => !/(^|\/)index\.html?$/i.test(page.path)).sort((a, b) => b.uploaded - a.uploaded).slice(0, 50);
	const items = [];
	for (const page of pages) {
		const link = `${url.origin}${site_base(site)}/${page.path}`;
		const title = (await files.page_title(page.path)) || page.path.slice(page.path.lastIndexOf("/") + 1).replace(/\.html?$/i, "");
		items.push(`<item><title>${escape_xml(title)}</title><link>${escape_xml(link)}</link><guid>${escape_xml(link)}</guid><pubDate>${new Date(page.uploaded).toUTCString()}</pubDate><description>${escape_xml(await files.page_summary(page.path))}</description></item>`);
	}
	const channel_title = config.title || `~${site} — ${folder}`;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${escape_xml(channel_title)}</title><link>${escape_xml(`${url.origin}${site_home(site)}`)}</link><description>${escape_xml(config.description || `Pages in ${folder}/ at ${url.host}`)}</description>${items.join("")}</channel></rss>\n`;
	return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff" } });
}

/**
 * A site's stylesheet (site.css, edited in Paint's My Site) applies to all its pages: linked into <head> at serve time.
 * @param {string} html
 * @param {string} href
 */
function with_stylesheet(html, href) {
	return new HTMLRewriter().on("head", {
		element(element) { element.append(`<link rel="stylesheet" href="${href.replace(/"/g, "%22")}">`, { html: true }); },
	}).transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
}

export default {
	/**
	 * @param {Request} request
	 * @param {{ SITES: R2Bucket, SITE_STATE: DurableObjectNamespace, EDITOR_URL?: string, SITES_URL?: string }} env
	 */
	async fetch(request, env, ctx) {
		try {
			return await this.serve(request, env, ctx);
		} catch (error) {
			console.error(error);
			const message = /** @type {any} */ (error)?.message || String(error);
			const quota = /Durable Objects free tier/i.test(message);
			// The server's own failures are $exception events too (PostHog Error tracking), when the sites Worker has a key
			capture_exception(/** @type {any} */ (env), ctx, error, { worker: "jspaint-sites", route: new URL(request.url).pathname, method: request.method, status: quota ? 503 : 500, ...(quota ? { code: "storage-quota" } : {}) });
			// A plain page for visitors; what actually happened is in Error tracking and the logs
			return html_response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Back soon</title></head><body bgcolor="#000000" text="#00ff00" style="font-family:'Courier New',monospace;text-align:center;padding-top:80px"><h1>Back soon</h1><p>This page is taking a little break. Please try again in a little while.</p><p><marquee>~*~ be right back ~*~</marquee></p></body></html>`, quota ? 503 : 500);
		}
	},
	/**
	 * @param {Request} request
	 * @param {{ SITES: R2Bucket, SITE_STATE: DurableObjectNamespace, EDITOR_URL?: string, SITES_URL?: string }} env
	 * @param {ExecutionContext} ctx
	 */
	async serve(request, env, ctx) {
		const url = new URL(request.url);
		const legacy = legacy_host_redirect(url, env.SITES_URL);
		if (legacy) { return legacy; }
		// Share links used to live on this hostname (/?join=…): they belong to the editor now.
		if (url.pathname === "/" && url.searchParams.has("join") && env.EDITOR_URL) {
			return Response.redirect(`${new URL(env.EDITOR_URL).origin}/${url.search}`, 302);
		}
		// The editor says a site changed (a page written or deleted, its settings, its stylesheet): its cached pages are done for
		const published = /^(?:\/~([^/]+))?\/x\/published$/.exec(url.pathname);
		if (published && request.method === "POST") {
			const site = published[1] ?? ROOT_SITE;
			if (!valid_site_name(site)) { return not_found(); }
			// (anyone may ping — this Worker keeps no secrets — but a site's pages are remade at most a few times per 10 s)
			if (await limited(env.LIMIT_PUBLISHED, `published:${site}`)) { report_limited(env, ctx, { kind: "published", worker: "jspaint-sites" }); return too_many(10); }
			await env.SITE_STATE.getByName(site).bump();
			return new Response(null, { status: 204, headers: PAGE_HEADERS });
		}
		const preview = /^(?:\/~([^/]+))?\/x\/preview$/.exec(url.pathname);
		if (preview && request.method === "POST") {
			const site = preview[1] ?? ROOT_SITE;
			if (!valid_site_name(site)) { return not_found(); }
			if (await limited(env.LIMIT_IP_10S, `preview:${client_ip(request)}`)) { report_limited(env, ctx, { kind: "preview", worker: "jspaint-sites" }); return too_many(10, { "Access-Control-Allow-Origin": request.headers.get("Origin") || "*" }); }
			return handle_preview(request, env, site);
		}
		const report = /^(?:\/~([^/]+))?\/x\/report$/.exec(url.pathname);
		if (report && (request.method === "GET" || request.method === "POST")) {
			const site = report[1] ?? ROOT_SITE;
			return valid_site_name(site) ? handle_report(request, url, env, ctx, site) : not_found();
		}
		if (request.method === "POST") {
			return handle_action(request, url, env);
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405, headers: PAGE_HEADERS });
		}
		// Which site, which file: /~name/<path> is a site; anything else is the root site at the domain itself.
		let site, rest;
		const tilde = /^\/~([^/]+)(?:\/(.*))?$/.exec(url.pathname);
		if (tilde) {
			site = tilde[1];
			rest = tilde[2];
			if (!valid_site_name(site)) { return not_found(); }
			if (site === ROOT_SITE) { return path_redirect(`/${rest ?? ""}${url.search}`); } // the root site lives at /
			if (rest === undefined) { return path_redirect(`/~${site}/`); } // canonical trailing slash
		} else {
			site = ROOT_SITE;
			rest = url.pathname.slice(1);
		}
		let path = rest;
		if (path === "" || path.endsWith("/")) {
			path += "index.html";
		}
		try {
			path = decodeURIComponent(path);
		} catch (_error) {
			return not_found();
		}
		const feed = /^([^/][^\n]*?)\/feed\.xml$/.exec(path);
		if (feed && valid_path(`${feed[1]}/index.html`)) {
			return rss_feed(site_files(env.SITES, site), site, feed[1], url);
		}
		if (path === "x/stats.json") {
			// Who's looking (the editor's globe shows it): public; one fresh answer per site per 5 s, whoever asks
			const stats_headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
			const cached = stats_cache.get(site);
			if (cached) { return new Response(cached, { headers: { ...stats_headers, "X-Cache": "hit" } }); }
			if (await limited(env.LIMIT_IP_10S, `stats:${client_ip(request)}`)) { report_limited(env, ctx, { kind: "stats", worker: "jspaint-sites" }); return too_many(10, { "Access-Control-Allow-Origin": "*" }); }
			const stats = await env.SITE_STATE.getByName(site).viewers();
			return new Response(stats_cache.set(site, JSON.stringify({ site, ...stats })), { headers: { ...stats_headers, "X-Cache": "miss" } });
		}
		// Clean addresses: /about is about.html, and /blog (a folder) is blog/ — the address with the slash
		const clean = !/\.[A-Za-z0-9]+$/.test(path) && valid_path(`${path}.html`) ? path : "";
		if (clean) { path = `${clean}.html`; }
		if (!valid_path(path) || path.startsWith("versions/")) {
			return not_found(); // (versions/: earlier saves, only reachable through the editor)
		}
		const state = env.SITE_STATE.getByName(site);
		const cache = caches.default;
		/** Rendered pages live in the cache under the site's generation, by page (every address of a page shares one copy). @param {string} page @param {number} generation @param {number} status */
		const cache_key = (page, generation, status) => new Request(`${url.origin}/~${site}/${page}?__page_cache=${generation}&status=${status}`, { method: "GET" });
		/**
		 * One trip to the site's object: a GET of a page is a visit (the visitor by a hash of their address; the count is
		 * all that's kept for long); back come the generation and the page's hit count.
		 * @param {string} page @param {boolean} visit
		 * @returns {Promise<{ generation: number, hits: number }>}
		 */
		const look = async (page, visit) => state.view(visit && !CRAWLER_UA.test(request.headers.get("User-Agent") || "") ? await sha256_hex(`view|${client_ip(request)}`) : "", page);
		/**
		 * The cached page, answered: the counter's slot gets the count (this visit included, and counted after the answer),
		 * the visitor's headers go on, HEAD gets no body.
		 * @param {Response} cached @param {string} page @param {number} status @param {{ generation: number, hits: number }} seen @param {boolean} from_cache
		 */
		const answer = (cached, page, status, seen, from_cache) => {
			const has_counter = cached.headers.get("X-Counter") === "1";
			const counting = request.method === "GET" && status === 200 && has_counter;
			if (counting) { ctx.waitUntil(Promise.resolve(state.hit(page)).catch(() => { /* a miss is fine */ })); }
			const shown = seen.hits + (counting ? 1 : 0);
			const headers = new Headers({ ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", "X-Cache": from_cache ? "hit" : "miss" });
			if (seen.moderation?.created && Date.now() - seen.moderation.created < NOINDEX_MS) { headers.set("X-Robots-Tag", "noindex"); } // (a site's first day)
			if (request.method === "HEAD") { return new Response(null, { status, headers }); }
			const filled = new HTMLRewriter().on("span[data-x-counter]", {
				element(element) { element.setInnerContent(odometer(shown, Number(element.getAttribute("data-x-counter")) || 6), { html: true }); },
			}).transform(cached);
			return new Response(filled.body, { status, headers });
		};
		/**
		 * A page, rendered and cached: sanitized again, its <x-*> elements filled in (the counter as a slot), the site's
		 * stylesheet linked; the next view of it under this generation is a cache hit.
		 * @param {R2ObjectBody} object @param {string} page - the page's path (what the counter counts, what relative addresses are from)
		 * @param {number} [status] @param {{ generation: number, hits: number } | null} [seen] - from `look`, when it already ran for this page
		 */
		const serve_page = async (object, page, status = 200, seen = null) => {
			seen ??= await look(page, request.method === "GET" && status === 200);
			const key = cache_key(page, seen.generation, status);
			const cached = await cache.match(key);
			if (cached) { return answer(cached, page, status, seen, true); }
			const files = site_files(env.SITES, site);
			// (links to our own hosts aren't outbound; under a localhost editor — dev, tests — any localhost port is ours too)
			const own_hosts = [url.host, ...(env.SITES_URL ? [new URL(env.SITES_URL).host] : []), ...(env.EDITOR_URL ? [new URL(env.EDITOR_URL).host] : []), ...(/^http:\/\/localhost/.test(env.EDITOR_URL || "") ? [/^localhost(:\d+)?$/] : [])];
			const sanitized = await sanitize_html(await object.text(), { own_hosts });
			let rendered = await render_x_elements(sanitized, { site, page, page_uploaded: object.uploaded, state, request, files, page_html: sanitized, count_slot: true });
			if (await files.has("site.css")) { rendered = await with_stylesheet(rendered, `${site_base(site)}/site.css`); }
			rendered = with_report_link(rendered, site, page);
			const fresh = new Response(rendered, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${PAGE_CACHE_S}`, "X-Counter": /data-x-counter=/.test(rendered) ? "1" : "0" } });
			ctx.waitUntil(cache.put(key, fresh.clone()).catch(() => { /* then the next view renders again */ }));
			return answer(fresh, page, status, seen, false);
		};
		// A page seen before under this generation is answered from the cache before R2 is asked at all
		let seen = null;
		let hidden = false;
		if (is_html_path(path)) {
			seen = await look(path, request.method === "GET");
			if (seen.moderation?.disabled) { return unavailable(); } // (the admin took the site down)
			hidden = !!seen.moderation?.hidden?.includes(path); // (…or this page: it's a 404 like any missing one)
			if (!hidden) {
				const cached = await cache.match(cache_key(path, seen.generation, 200));
				if (cached) { return answer(cached, path, 200, seen, true); }
			}
		}
		const object = hidden ? null : await env.SITES.get(`sites/${site}/${path}`);
		if (!object && !hidden && clean && await env.SITES.head(`sites/${site}/${clean}/index.html`)) {
			return path_redirect(`${url.pathname}/${url.search}`); // (relative addresses inside the folder's index then resolve right)
		}
		if (!object) {
			if (site === ROOT_SITE && path === "index.html") { return landing_page(env.EDITOR_URL); }
			// The site's own 404 page, when it has one (404.html, made in Paint like any page), else ours
			const custom = await env.SITES.get(`sites/${site}/404.html`);
			if (custom) { return serve_page(custom, "404.html", 404); }
			return not_found(`There's no <b>${site_base(site)}/${path}</b> here.`);
		}
		if (is_html_path(path)) {
			return serve_page(object, path, 200, seen);
		}
		const headers = new Headers(PAGE_HEADERS);
		headers.set("Content-Type", content_type_for(path));
		headers.set("Content-Length", String(object.size));
		headers.set("ETag", object.httpEtag);
		// Hashed asset names (gifs/<hash>.gif) never change; a page's bitmap (collages/<page>.png) changes with every
		// save (pages reference it with a ?v=<hash> query, so revalidating is cheap); other files may change.
		headers.set("Cache-Control", /^gifs\/[0-9a-f]{20,}\./.test(path) ? "public, max-age=31536000, immutable" : /^collages\//.test(path) ? "no-cache" : "public, max-age=300");
		void extension_of;
		return new Response(request.method === "HEAD" ? null : object.body, { headers });
	},
};
