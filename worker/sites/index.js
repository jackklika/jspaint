// @ts-check
// jspaint-sites: serves user sites at /~name/<path> from the `sites/<name>/<path>` keys of the R2 bucket.
// Pages (.html) are sanitized again and have their <x-*> elements rendered server-side; everything else
// streams through with a fixed content type. Strict CSP on every response: pages can't run scripts.
// POST /~name/x/<element> runs an <x-*> element's action (the guestbook form), also in this sandbox.
import { DurableObject } from "cloudflare:workers";
import { content_type_for, extension_of, is_html_path, valid_path, valid_site_name } from "../shared/names.js";
import { sanitize_html } from "../shared/sanitize.js";
import { render_x_elements, x_elements } from "../shared/x-elements/index.js";

const PAGE_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Cache-Control": "no-cache",
};

const GUESTBOOK_MIN_INTERVAL_MS = 30 * 1000; // per visitor
const GUESTBOOK_MAX_PER_DAY = 20; // per visitor
const GUESTBOOK_MAX_ENTRIES = 2000; // per site

/** Per-site state for <x-*> elements: visitor counters and guestbook entries. */
export class SiteState extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(() => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (page TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0)");
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, message TEXT NOT NULL, ip_hash TEXT NOT NULL, created INTEGER NOT NULL)");
			return Promise.resolve();
		});
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
 * POST /~name/x/<element>: the element's registry `action` (guestbook signing). Form posts only, same origin.
 * @param {Request} request
 * @param {URL} url
 * @param {{ SITES: R2Bucket, SITE_STATE: DurableObjectNamespace }} env
 */
async function handle_action(request, url, env) {
	const match = /^\/~([^/]+)\/x\/([a-z0-9-]+)$/.exec(url.pathname);
	if (!match || !valid_site_name(match[1])) {
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
		context: { site: match[1], page: "", page_uploaded: null, state: env.SITE_STATE.getByName(match[1]), request },
	});
	if (result.location) {
		return new Response(null, { status: result.status || 303, headers: { ...PAGE_HEADERS, Location: result.location } });
	}
	return html_response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Oops</title></head><body style="font-family:'Comic Sans MS',cursive;text-align:center;padding-top:60px"><p>${result.error || "Something went wrong."}</p><p><a href="javascript:history.back()">Go back</a></p></body></html>`.replace('<a href="javascript:history.back()">Go back</a>', `<a href="/~${match[1]}/">Go back</a>`), result.status || 400);
}

export default {
	/**
	 * @param {Request} request
	 * @param {{ SITES: R2Bucket, SITE_STATE: DurableObjectNamespace, EDITOR_URL?: string }} env
	 */
	async fetch(request, env) {
		const url = new URL(request.url);
		if (request.method === "POST") {
			return handle_action(request, url, env);
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405, headers: PAGE_HEADERS });
		}
		if (url.pathname === "/") {
			return html_response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>jspaint sites</title></head>
<body bgcolor="#ffffd9" style="font-family:'Comic Sans MS',cursive;text-align:center;padding-top:60px">
<h1>~ jspaint sites ~</h1><p>Personal pages live at <code>/~name/</code>.</p>
${env.EDITOR_URL ? `<p><a href="${env.EDITOR_URL}">Make one</a></p>` : ""}
</body></html>`);
		}
		const match = /^\/~([^/]+)(?:\/(.*))?$/.exec(url.pathname);
		if (!match) {
			return not_found();
		}
		const name = match[1];
		let path = match[2] || "";
		if (path === "" || path.endsWith("/")) {
			path += "index.html";
		}
		try {
			path = decodeURIComponent(path);
		} catch (_error) {
			return not_found();
		}
		if (!valid_site_name(name) || !valid_path(path)) {
			return not_found();
		}
		if (match[2] === undefined) {
			return Response.redirect(`${url.origin}/~${name}/`, 301); // canonical trailing slash
		}
		const object = await env.SITES.get(`sites/${name}/${path}`);
		if (!object) {
			return not_found(`There's no <b>/~${name}/${path}</b> here.`);
		}
		if (is_html_path(path)) {
			const sanitized = await sanitize_html(await object.text());
			const rendered = await render_x_elements(sanitized, {
				site: name,
				page: path,
				page_uploaded: object.uploaded,
				state: env.SITE_STATE.getByName(name),
				request,
			});
			return html_response(rendered);
		}
		const headers = new Headers(PAGE_HEADERS);
		headers.set("Content-Type", content_type_for(path));
		headers.set("Content-Length", String(object.size));
		headers.set("ETag", object.httpEtag);
		// Hashed asset names (gifs/<hash>.gif) never change; other files may.
		headers.set("Cache-Control", /^gifs\/[0-9a-f]{20,}\./.test(path) ? "public, max-age=31536000, immutable" : "public, max-age=300");
		void extension_of;
		return new Response(request.method === "HEAD" ? null : object.body, { headers });
	},
};
