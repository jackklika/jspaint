// @ts-check
// jspaint-sites: serves user sites at /~name/<path> from the `sites/<name>/<path>` keys of the R2 bucket.
// Pages (.html) are sanitized again and have their <x-*> elements rendered server-side; everything else
// streams through with a fixed content type. Strict CSP on every response: pages can't run scripts.
import { DurableObject } from "cloudflare:workers";
import { content_type_for, extension_of, is_html_path, valid_path, valid_site_name } from "../shared/names.js";
import { sanitize_html } from "../shared/sanitize.js";
import { render_x_elements } from "../shared/x-elements/index.js";

const PAGE_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Cache-Control": "no-cache",
};

/** Per-site state for <x-*> elements: visitor counters now, guestbook entries later. */
export class SiteState extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(() => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (page TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0)");
			return Promise.resolve();
		});
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

export default {
	/**
	 * @param {Request} request
	 * @param {{ SITES: R2Bucket, SITE_STATE: DurableObjectNamespace, EDITOR_URL?: string }} env
	 */
	async fetch(request, env) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405, headers: PAGE_HEADERS });
		}
		const url = new URL(request.url);
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
