// @ts-check
// jspaint-sites: serves user sites from the `sites/<name>/<path>` keys of the R2 bucket — /~name/<path> for a site,
// and the "root" site at the domain root itself (coolpaint.world/<path> → sites/root/<path>). Pages (.html) are
// sanitized again and have their <x-*> elements rendered server-side; everything else streams through with a
// fixed content type. Strict CSP on every response: pages can't run scripts. /about serves about.html (clean
// addresses); a folder's bare address redirects to its slash; a site's 404.html, when it has one, is its not-found page.
// POST /~name/x/<element> (or /x/<element> for root) runs an <x-*> element's action (the guestbook form), also here.
// POST /~name/x/preview {page, tag, attrs, page_html?} renders one <x-*> element as the page would show it right now
// (the editor puts that on the canvas: the real count, the folder's pages) — a look, not a visit; CORS open.
import { DurableObject } from "cloudflare:workers";
import { ROOT_SITE, content_type_for, extension_of, is_html_path, site_base, site_home, valid_path, valid_site_name } from "../shared/names.js";
import { capture_exception } from "../shared/exceptions.js";
import { find_sections, text_of } from "../shared/sections.js";
import { sanitize_html } from "../shared/sanitize.js";
import { render_x_element, render_x_elements, x_elements } from "../shared/x-elements/index.js";

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

/** Per-site state for <x-*> elements: visitor counters and guestbook entries. */
export class SiteState extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(() => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (page TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0)");
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, message TEXT NOT NULL, ip_hash TEXT NOT NULL, created INTEGER NOT NULL)");
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS views (ip_hash TEXT NOT NULL, page TEXT NOT NULL, at INTEGER NOT NULL)");
			this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS views_at ON views (at)");
			return Promise.resolve();
		});
	}
	/**
	 * Someone opened a page (the editor's globe shows "N viewing"). Pages carry no scripts, so a page load is the
	 * only signal there is: "viewing now" means "loaded a page in the last few minutes". Kept for a day.
	 * @param {string} ip_hash @param {string} page
	 */
	record_view(ip_hash, page) {
		const now = Date.now();
		this.ctx.storage.sql.exec("INSERT INTO views (ip_hash, page, at) VALUES (?, ?, ?)", ip_hash, page, now);
		if (Math.random() < 0.05) { this.ctx.storage.sql.exec("DELETE FROM views WHERE at < ?", now - VIEWS_KEPT_MS); }
	}
	/** @returns {{ viewing: number, today: number, views_today: number }} distinct visitors in the last VIEWING_WINDOW_MS / day, and page loads today */
	viewers() {
		const now = Date.now();
		const recent = this.ctx.storage.sql.exec("SELECT COUNT(DISTINCT ip_hash) AS n FROM views WHERE at > ?", now - VIEWING_WINDOW_MS).one();
		const today = this.ctx.storage.sql.exec("SELECT COUNT(DISTINCT ip_hash) AS n, COUNT(*) AS loads FROM views WHERE at > ?", now - VIEWS_KEPT_MS).one();
		return { viewing: Number(recent.n), today: Number(today.n), views_today: Number(today.loads) };
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
		return true;
	}
	/**
	 * Counts one visit to a page and returns the new total.
	 * @param {string} page
	 * @returns {number}
	 */
	hit(page) {
		this.ctx.storage.sql.exec("INSERT INTO counters (page, hits) VALUES (?, 1) ON CONFLICT(page) DO UPDATE SET hits = hits + 1", page);
		return this.ctx.storage.sql.exec("SELECT hits FROM counters WHERE page = ?", page).one().hits;
	}
	/** @param {string} page */
	get_hits(page) {
		const row = this.ctx.storage.sql.exec("SELECT hits FROM counters WHERE page = ?", page).toArray()[0];
		return row ? row.hits : 0;
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
	const result = await definition.action({
		form,
		context: { site, page: "", page_uploaded: null, state: env.SITE_STATE.getByName(site), request, files: site_files(env.SITES, site), page_html: "" },
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
	const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
	const reply = (/** @type {any} */ data, status = 200) => new Response(JSON.stringify(data), { status, headers });
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
		const preview = /^(?:\/~([^/]+))?\/x\/preview$/.exec(url.pathname);
		if (preview && request.method === "POST") {
			const site = preview[1] ?? ROOT_SITE;
			return valid_site_name(site) ? handle_preview(request, env, site) : not_found();
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
			// Who's looking (the editor's globe shows it): public, cheap, never cached
			const stats = await env.SITE_STATE.getByName(site).viewers();
			return new Response(JSON.stringify({ site, ...stats }), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
		}
		// Clean addresses: /about is about.html, and /blog (a folder) is blog/ — the address with the slash
		const clean = !/\.[A-Za-z0-9]+$/.test(path) && valid_path(`${path}.html`) ? path : "";
		if (clean) { path = `${clean}.html`; }
		if (!valid_path(path) || path.startsWith("versions/")) {
			return not_found(); // (versions/: earlier saves, only reachable through the editor)
		}
		/**
		 * A page, rendered: sanitized again, its <x-*> elements filled in, the site's stylesheet linked, the view counted.
		 * @param {R2ObjectBody} object @param {string} page - the page's path (what the counter counts, what relative addresses are from) @param {number} [status]
		 */
		const serve_page = async (object, page, status = 200) => {
			const files = site_files(env.SITES, site);
			const sanitized = await sanitize_html(await object.text());
			let rendered = await render_x_elements(sanitized, {
				site,
				page,
				page_uploaded: object.uploaded,
				state: env.SITE_STATE.getByName(site),
				request,
				files,
				page_html: sanitized,
			});
			if (await files.has("site.css")) { rendered = await with_stylesheet(rendered, `${site_base(site)}/site.css`); }
			if (request.method === "GET" && status === 200) {
				// A page load is a view (the visitor by a hash of their address; the count is all that's kept for long)
				const ip = request.headers.get("CF-Connecting-IP") || "unknown";
				ctx.waitUntil(sha256_hex(`view|${ip}`).then((ip_hash) => env.SITE_STATE.getByName(site).record_view(ip_hash, page)).catch(() => { /* a miss is fine */ }));
			}
			return html_response(rendered, status);
		};
		const object = await env.SITES.get(`sites/${site}/${path}`);
		if (!object && clean && await env.SITES.head(`sites/${site}/${clean}/index.html`)) {
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
			return serve_page(object, path);
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
