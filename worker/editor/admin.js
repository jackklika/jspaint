// @ts-check
// The admin's page (MALICIOUS_ACTOR_PLAN.md phase 2.5): every page on the platform, grouped by site and by account,
// in one compact view at /admin, with the levers — hide a page, hide or delete a site, lock an account, set a
// quota, resolve a report. Only an admin (ADMIN_EMAILS in wrangler.jsonc; auth.js is_admin) or the master key gets
// in; role_of says "master" for both. The data is one listing of the bucket plus the Accounts object's tables,
// kept 30 s per isolate and dropped after every action.
//
//   GET    /admin                                   the page (HTML; a non-admin sees a plain refusal)
//   GET    /api/admin/overview                      sites (owner, usage, pages, moderation), users (with their sites), reports
//   POST   /api/admin/sites/:name/moderate          { disabled?, hide?: [page], unhide?: [page], reason? } → the marker (moderation.js)
//   DELETE /api/admin/sites/:name                   every object of the site, its owner and usage rows
//   POST   /api/admin/users/:id/lock                { locked, note? } — a locked account's sessions end and it can't sign in
//   POST   /api/admin/reports/:id/resolve           { resolved }
import { ShortCache } from "../shared/limits.js";
import { is_html_path, valid_path, valid_site_name } from "../shared/names.js";
import { accounts_of, session_of } from "./auth.js";
import { MODERATION_FILE, notify_published, read_moderation, write_moderation } from "./moderation.js";

const QUOTA_BYTES = 200 * 1024 * 1024;
const QUOTA_FILES = 1000;

/** @param {any} data @param {number} [status] */
function json(data, status = 200) {
	return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

/** The whole picture, kept a little while. @type {ShortCache<any>} */
const overview_cache = new ShortCache(30_000, 1);

/**
 * Everything the page shows: one listing of the bucket grouped by site, joined with the Accounts tables.
 * @param {{ SITES: R2Bucket, ACCOUNTS: DurableObjectNamespace }} env
 */
async function overview(env) {
	const cached = overview_cache.get("all");
	if (cached) { return cached; }
	const accounts = accounts_of(env);
	const [users, owners, usages, reports] = await Promise.all([accounts.all_users(), accounts.all_owners(), accounts.all_usage(), accounts.reports(300)]);
	/** @type {Map<string, { name: string, files: number, bytes: number, updated: number, pages: { path: string, size: number, uploaded: number, hidden: boolean }[], marked: boolean }>} */
	const sites = new Map();
	let cursor;
	do {
		const listing = await env.SITES.list({ prefix: "sites/", cursor });
		for (const object of listing.objects) {
			const [, name, ...rest] = object.key.split("/");
			const path = rest.join("/");
			if (!name || !path) { continue; }
			let site = sites.get(name);
			if (!site) { site = { name, files: 0, bytes: 0, updated: 0, pages: [], marked: false }; sites.set(name, site); }
			site.files += 1;
			site.bytes += object.size;
			site.updated = Math.max(site.updated, object.uploaded.getTime());
			if (path === MODERATION_FILE) { site.marked = true; continue; }
			if (!path.startsWith("versions/") && is_html_path(path)) { site.pages.push({ path, size: object.size, uploaded: object.uploaded.getTime(), hidden: false }); }
		}
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	const users_by_id = new Map(users.map((user) => [user.id, user]));
	const owner_of = new Map(owners.map((owner) => [owner.site, owner]));
	const usage_of = new Map(usages.map((usage) => [usage.site, usage]));
	const markers = await Promise.all([...sites.values()].filter((site) => site.marked).map(async (site) => [site.name, await read_moderation(env, site.name)]));
	const moderation_of = new Map(/** @type {[string, any][]} */ (markers));
	// Sites somebody owns but never published to are sites too
	for (const owner of owners) { if (!sites.has(owner.site)) { sites.set(owner.site, { name: owner.site, files: 0, bytes: 0, updated: 0, pages: [], marked: false }); } }
	const site_rows = [...sites.values()].map((site) => {
		const owner = owner_of.get(site.name);
		const user = owner ? users_by_id.get(owner.user_id) : null;
		const moderation = moderation_of.get(site.name) || {};
		const usage = usage_of.get(site.name);
		const hidden = new Set(moderation.hidden || []);
		for (const page of site.pages) { page.hidden = hidden.has(page.path); }
		site.pages.sort((a, b) => a.path.localeCompare(b.path));
		return {
			name: site.name,
			owner: user ? { id: user.id, email: user.email, name: user.name, locked: user.locked } : owner ? { id: owner.user_id, email: "", name: "", locked: false } : null,
			claimed: owner ? owner.claimed : null,
			files: site.files,
			bytes: site.bytes,
			updated: site.updated || null,
			pages: site.pages,
			disabled: !!moderation.disabled,
			reason: moderation.reason || "",
			created: moderation.created || null,
			limit_bytes: usage?.limit_bytes ?? QUOTA_BYTES,
			limit_files: usage?.limit_files ?? QUOTA_FILES,
		};
	}).sort((a, b) => (b.updated || 0) - (a.updated || 0));
	/** @type {Map<string, string[]>} */
	const sites_of = new Map();
	for (const owner of owners) { sites_of.set(owner.user_id, [...(sites_of.get(owner.user_id) || []), owner.site]); }
	const user_rows = users.map((user) => ({ ...user, sites: (sites_of.get(user.id) || []).sort() }));
	const result = {
		generated: Date.now(),
		totals: {
			sites: site_rows.length,
			users: user_rows.length,
			pages: site_rows.reduce((sum, site) => sum + site.pages.length, 0),
			files: site_rows.reduce((sum, site) => sum + site.files, 0),
			bytes: site_rows.reduce((sum, site) => sum + site.bytes, 0),
			reports_open: reports.filter((report) => !report.resolved).length,
			disabled: site_rows.filter((site) => site.disabled).length,
			locked: user_rows.filter((user) => user.locked).length,
		},
		sites: site_rows,
		users: user_rows,
		reports,
	};
	return overview_cache.set("all", result);
}

/**
 * Deletes a site outright: every object under it (pages, media, archives, the marker), then its rows in Accounts.
 * @param {{ SITES: R2Bucket, ACCOUNTS: DurableObjectNamespace, SITES_URL?: string }} env @param {ExecutionContext | null} ctx @param {string} site
 */
async function delete_site(env, ctx, site) {
	const prefix = `sites/${site}/`;
	let deleted = 0, cursor;
	do {
		const listing = await env.SITES.list({ prefix, cursor });
		const keys = listing.objects.map((object) => object.key);
		if (keys.length) { await env.SITES.delete(keys); deleted += keys.length; }
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
	await accounts_of(env).remove_site(site);
	await notify_published(env, ctx, site, "index.html");
	return deleted;
}

/**
 * The admin routes; null when the request isn't one.
 * @param {Request} request @param {URL} url @param {any} env @param {ExecutionContext | null} ctx
 * @param {(request: Request, env: any, site?: string) => Promise<string | null>} role_of
 */
async function handle_admin(request, url, env, ctx, role_of) {
	const path = url.pathname;
	if (path !== "/admin" && !path.startsWith("/api/admin/")) { return null; }
	const role = await role_of(request, env);
	if (role !== "master") {
		if (path === "/admin") {
			const session = await session_of(request, env);
			const body = session ?
				`<p>This page is for the site's admin.</p><p><a href="/">Back to Paint</a></p>` :
				`<p>Sign in as the admin to see this page.</p><p><a href="/auth/google?next=/admin">Sign in with Google</a> · <a href="/">Back to Paint</a></p>`;
			return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Admin</title></head><body style="font-family:'Comic Sans MS',cursive;text-align:center;padding-top:60px">${body}</body></html>`, { status: session ? 403 : 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
		}
		return json({ error: "Unauthorized: the admin only" }, 401);
	}
	if (path === "/admin") {
		return new Response(ADMIN_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
	}
	if (path === "/api/admin/overview") {
		if (request.method !== "GET") { return json({ error: "Method not allowed" }, 405); }
		if (url.searchParams.has("fresh")) { overview_cache.entries.clear(); }
		return json(await overview(env));
	}
	const session = await session_of(request, env, { fresh: true });
	const by = session?.email || "master key";
	const site_match = /^\/api\/admin\/sites\/([^/]+)(\/moderate)?$/.exec(path);
	if (site_match) {
		const site = site_match[1];
		if (!valid_site_name(site)) { return json({ error: "Bad site name" }, 400); }
		if (site_match[2]) {
			if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
			const body = await request.json().catch(() => ({}));
			const pages = (/** @type {unknown} */ list) => (Array.isArray(list) ? list.filter((page) => typeof page === "string" && valid_path(page) && is_html_path(page)).slice(0, 100) : undefined);
			const patch = {
				...(typeof body.disabled === "boolean" ? { disabled: body.disabled } : {}),
				...(body.hide ? { hide: pages(body.hide) } : {}),
				...(body.unhide ? { unhide: pages(body.unhide) } : {}),
				...(body.reason !== undefined ? { reason: body.reason === null ? null : String(body.reason).slice(0, 500) } : {}),
			};
			const moderation = await write_moderation(env, ctx, site, patch, by);
			overview_cache.entries.clear();
			return json({ site, moderation });
		}
		if (request.method !== "DELETE") { return json({ error: "Method not allowed" }, 405); }
		if (site === "root") { return json({ error: "The domain's own site stays" }, 403); }
		const deleted = await delete_site(env, ctx, site);
		overview_cache.entries.clear();
		return json({ ok: true, site, deleted });
	}
	const lock_match = /^\/api\/admin\/users\/([0-9a-f]{24})\/lock$/.exec(path);
	if (lock_match) {
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const body = await request.json().catch(() => ({}));
		const accounts = accounts_of(env);
		const user = await accounts.get_user(lock_match[1]);
		if (!user) { return json({ error: "No such account" }, 404); }
		if (body.locked && session && session.id === user.id) { return json({ error: "Not yourself" }, 400); }
		await accounts.set_locked(user.id, !!body.locked, typeof body.note === "string" ? body.note.slice(0, 500) : "");
		overview_cache.entries.clear();
		return json({ ok: true, id: user.id, locked: !!body.locked });
	}
	const report_match = /^\/api\/admin\/reports\/(\d+)\/resolve$/.exec(path);
	if (report_match) {
		if (request.method !== "POST") { return json({ error: "Method not allowed" }, 405); }
		const body = await request.json().catch(() => ({}));
		await accounts_of(env).resolve_report(Number(report_match[1]), body.resolved !== false);
		overview_cache.entries.clear();
		return json({ ok: true, id: Number(report_match[1]), resolved: body.resolved !== false });
	}
	return json({ error: "Not found" }, 404);
}

// The page itself: one compact HTML file with its script inline (it fetches /api/admin/overview and acts through the
// routes above; every action confirms, and deleting a site asks for its name).
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coolpaint.world — admin</title>
<style>
	:root { color-scheme: light; }
	body { margin: 0; background: #c0c0c0; color: #000; font: 12px/1.35 Tahoma, Verdana, Arial, sans-serif; }
	header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 6px 10px; background: #000080; color: #fff; }
	header h1 { font-size: 13px; margin: 0; font-weight: bold; }
	header .totals { opacity: .9; }
	header input { font: inherit; padding: 2px 4px; min-width: 220px; }
	nav { display: flex; gap: 2px; padding: 6px 10px 0; }
	nav button { font: inherit; padding: 3px 10px; background: #c0c0c0; border: 2px solid; border-color: #fff #404040 #404040 #fff; cursor: pointer; }
	nav button[aria-selected=true] { background: #dfdfdf; border-bottom-color: #dfdfdf; }
	main { background: #dfdfdf; margin: 0 10px 10px; padding: 8px; border: 2px solid; border-color: #fff #404040 #404040 #fff; min-height: 60vh; }
	table { border-collapse: collapse; width: 100%; background: #fff; }
	th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid #ddd; vertical-align: top; white-space: nowrap; }
	th { background: #eee; position: sticky; top: 0; font-weight: bold; }
	tr.site > td { background: #f4f4ff; }
	tr.page > td:first-child { padding-left: 26px; }
	tr.hidden-row > td, tr.locked-row > td { color: #888; }
	td.grow { white-space: normal; }
	img.thumb { width: 48px; height: 36px; object-fit: cover; image-rendering: pixelated; border: 1px solid #999; background: #fff; vertical-align: middle; }
	button.act { font: inherit; font-size: 11px; padding: 0 6px; margin: 0 1px; background: #c0c0c0; border: 2px solid; border-color: #fff #404040 #404040 #fff; cursor: pointer; }
	button.act.danger { color: #800; }
	.badge { display: inline-block; font-size: 10px; padding: 0 4px; border: 1px solid; margin-left: 4px; }
	.badge.off { color: #800; border-color: #800; }
	.badge.hid { color: #555; border-color: #555; }
	.badge.new { color: #060; border-color: #060; }
	a { color: #000080; }
	.muted { color: #666; }
	.chip { display: inline-block; background: #eef; border: 1px solid #99c; padding: 0 4px; margin: 1px 2px 1px 0; cursor: pointer; }
	#status { padding: 4px 10px; min-height: 1.4em; }
	@media (max-width: 700px) { th, td { white-space: normal; } header input { min-width: 0; flex: 1; } }
</style>
</head>
<body>
<header>
	<h1>coolpaint.world — admin</h1>
	<span class="totals" id="totals">loading…</span>
	<input id="search" type="search" placeholder="filter: site, page, email, reason" autofocus>
	<button class="act" id="reload">Reload</button>
</header>
<nav role="tablist">
	<button role="tab" data-tab="sites" aria-selected="true">Sites</button>
	<button role="tab" data-tab="users" aria-selected="false">Users</button>
	<button role="tab" data-tab="reports" aria-selected="false">Reports</button>
</nav>
<main id="main"></main>
<div id="status" class="muted"></div>
<script>
(() => {
	const $ = (sel, root = document) => root.querySelector(sel);
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
	const kb = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
	const when = (ms) => ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "—";
	const sites_url = ${JSON.stringify("__SITES_URL__")};
	const live = (site, page) => (site === "root" ? "" : "/~" + site) + "/" + (page === "index.html" ? "" : page.replace(/\\.html$/, ""));
	const editor = (site, page) => "/~" + site + "/" + page;
	const thumb = (site, page) => "/api/sites/" + encodeURIComponent(site) + "/files/collages/" + encodeURIComponent(page.replace(/\\.html?$/i, "")) + ".png";
	let data = null, tab = "sites", filter = "";
	const status = (text) => { $("#status").textContent = text; };
	async function api(path, init) {
		const response = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
		const body = await response.json().catch(() => ({}));
		if (!response.ok) { throw new Error(body.error || ("HTTP " + response.status)); }
		return body;
	}
	async function load(fresh) {
		status("loading…");
		try {
			data = await api("/api/admin/overview" + (fresh ? "?fresh=1" : ""));
			const t = data.totals;
			$("#totals").textContent = t.sites + " sites · " + t.pages + " pages · " + t.users + " accounts · " + kb(t.bytes) + " in " + t.files + " files" + (t.disabled ? " · " + t.disabled + " hidden sites" : "") + (t.locked ? " · " + t.locked + " locked" : "") + (t.reports_open ? " · " + t.reports_open + " open reports" : "");
			render();
			status("as of " + when(data.generated));
		} catch (error) { status("Couldn't load: " + error.message); }
	}
	async function act(label, path, init, ask) {
		if (ask && !confirm(ask)) { return; }
		status(label + "…");
		try { await api(path, init); await load(true); status(label + ": done"); } catch (error) { status(label + " failed: " + error.message); }
	}
	const matches = (text) => !filter || text.toLowerCase().includes(filter);
	function render() {
		if (!data) { return; }
		const main = $("#main");
		if (tab === "sites") { main.innerHTML = render_sites(); }
		else if (tab === "users") { main.innerHTML = render_users(); }
		else { main.innerHTML = render_reports(); }
	}
	function render_sites() {
		const rows = [];
		for (const site of data.sites) {
			const text = [site.name, site.owner?.email, site.reason, ...site.pages.map((p) => p.path)].join(" ");
			if (!matches(text)) { continue; }
			const fresh = site.created && Date.now() - site.created < 86400000;
			rows.push('<tr class="site' + (site.disabled ? " hidden-row" : "") + '"><td><b>~' + esc(site.name) + '</b>' +
				(site.disabled ? '<span class="badge off">hidden site</span>' : "") + (fresh ? '<span class="badge new">new</span>' : "") + (site.pages.some((p) => p.hidden) ? '<span class="badge hid">' + site.pages.filter((p) => p.hidden).length + ' hidden</span>' : "") +
				'</td><td>' + (site.owner ? '<span class="chip" data-user="' + esc(site.owner.email) + '">' + esc(site.owner.email || site.owner.id) + (site.owner.locked ? " 🔒" : "") + "</span>" : '<span class="muted">master key</span>') +
				'</td><td>' + site.pages.length + ' pages</td><td>' + kb(site.bytes) + ' / ' + kb(site.limit_bytes) + ' · ' + site.files + ' files</td><td>' + when(site.updated) + '</td><td class="grow">' + esc(site.reason) + '</td><td>' +
				'<a href="' + esc(sites_url + live(site.name, "index.html")) + '" target="_blank" rel="noopener">open</a> · <a href="' + esc(editor(site.name, "index.html")) + '" target="_blank" rel="noopener">edit</a> ' +
				'<button class="act" data-act="site-hide" data-site="' + esc(site.name) + '" data-on="' + (site.disabled ? 0 : 1) + '">' + (site.disabled ? "unhide site" : "hide site") + '</button>' +
				'<button class="act" data-act="quota" data-site="' + esc(site.name) + '" data-mb="' + Math.round(site.limit_bytes / 1048576) + '">quota…</button>' +
				(site.name === "root" ? "" : '<button class="act danger" data-act="site-delete" data-site="' + esc(site.name) + '">delete site…</button>') +
				'</td></tr>');
			for (const page of site.pages) {
				rows.push('<tr class="page' + (page.hidden ? " hidden-row" : "") + '"><td><img class="thumb" loading="lazy" src="' + esc(thumb(site.name, page.path)) + '" alt="" onerror="this.style.visibility=\\'hidden\\'"> ' +
					'<a href="' + esc(sites_url + live(site.name, page.path)) + '" target="_blank" rel="noopener">' + esc(page.path) + '</a>' + (page.hidden ? '<span class="badge hid">hidden</span>' : "") +
					'</td><td></td><td></td><td>' + kb(page.size) + '</td><td>' + when(page.uploaded) + '</td><td></td><td>' +
					'<a href="' + esc(editor(site.name, page.path)) + '" target="_blank" rel="noopener">edit</a> ' +
					'<button class="act" data-act="page-hide" data-site="' + esc(site.name) + '" data-page="' + esc(page.path) + '" data-on="' + (page.hidden ? 0 : 1) + '">' + (page.hidden ? "unhide" : "hide") + '</button>' +
					'<button class="act danger" data-act="page-delete" data-site="' + esc(site.name) + '" data-page="' + esc(page.path) + '">delete</button>' +
					'</td></tr>');
			}
		}
		return '<table><thead><tr><th>site / page</th><th>owner</th><th>pages</th><th>size</th><th>updated</th><th>reason</th><th>actions</th></tr></thead><tbody>' + (rows.join("") || '<tr><td colspan="7" class="muted">nothing matches</td></tr>') + '</tbody></table>';
	}
	function render_users() {
		const rows = [];
		for (const user of data.users) {
			if (!matches([user.email, user.name, user.note, ...user.sites].join(" "))) { continue; }
			rows.push('<tr' + (user.locked ? ' class="locked-row"' : "") + '><td><b>' + esc(user.email || user.id) + '</b>' + (user.locked ? '<span class="badge off">locked</span>' : "") + '</td><td>' + esc(user.name) + '</td><td>' +
				(user.sites.map((s) => '<span class="chip" data-site="' + esc(s) + '">~' + esc(s) + '</span>').join("") || '<span class="muted">no sites</span>') +
				'</td><td>' + when(user.created) + '</td><td>' + when(user.seen) + '</td><td class="grow">' + esc(user.note) + '</td><td>' +
				'<button class="act' + (user.locked ? "" : " danger") + '" data-act="lock" data-user="' + esc(user.id) + '" data-on="' + (user.locked ? 0 : 1) + '">' + (user.locked ? "unlock" : "lock account…") + '</button>' +
				(user.sites.length ? '<button class="act" data-act="hide-all" data-user="' + esc(user.id) + '" data-sites="' + esc(user.sites.join(",")) + '">hide all sites</button>' : "") +
				'</td></tr>');
		}
		return '<table><thead><tr><th>account</th><th>name</th><th>sites</th><th>joined</th><th>seen</th><th>note</th><th>actions</th></tr></thead><tbody>' + (rows.join("") || '<tr><td colspan="7" class="muted">nothing matches</td></tr>') + '</tbody></table>';
	}
	function render_reports() {
		const rows = [];
		for (const report of data.reports) {
			if (!matches([report.site, report.page, report.reason].join(" "))) { continue; }
			rows.push('<tr' + (report.resolved ? ' class="hidden-row"' : "") + '><td>' + when(report.created) + '</td><td><a href="' + esc(sites_url + live(report.site, report.page)) + '" target="_blank" rel="noopener">~' + esc(report.site) + '/' + esc(report.page) + '</a></td><td class="grow">' + esc(report.reason) + '</td><td>' +
				'<button class="act" data-act="resolve" data-report="' + report.id + '" data-on="' + (report.resolved ? 0 : 1) + '">' + (report.resolved ? "reopen" : "resolve") + '</button>' +
				'<button class="act" data-act="page-hide" data-site="' + esc(report.site) + '" data-page="' + esc(report.page) + '" data-on="1">hide page</button>' +
				'<button class="act" data-act="site-hide" data-site="' + esc(report.site) + '" data-on="1">hide site</button>' +
				'</td></tr>');
		}
		return '<table><thead><tr><th>when</th><th>page</th><th>reason</th><th>actions</th></tr></thead><tbody>' + (rows.join("") || '<tr><td colspan="4" class="muted">no reports</td></tr>') + '</tbody></table>';
	}
	document.addEventListener("click", (event) => {
		const button = event.target.closest("button.act, .chip");
		if (!button) { return; }
		const d = button.dataset;
		if (button.classList.contains("chip")) {
			$("#search").value = d.user || d.site || "";
			filter = $("#search").value.toLowerCase();
			tab = d.user ? "users" : "sites";
			for (const t of document.querySelectorAll("nav button")) { t.setAttribute("aria-selected", String(t.dataset.tab === tab)); }
			render();
			return;
		}
		switch (d.act) {
			case "reload": return load(true);
			case "site-hide": {
				const on = d.on === "1";
				const reason = on ? prompt("Hide ~" + d.site + " (every page answers 451). Reason, for your notes:", "") : null;
				if (on && reason === null) { return; }
				return act(on ? "Hiding site" : "Unhiding site", "/api/admin/sites/" + encodeURIComponent(d.site) + "/moderate", { method: "POST", body: JSON.stringify(on ? { disabled: true, reason } : { disabled: false, reason: null }) });
			}
			case "page-hide": {
				const on = d.on === "1";
				return act(on ? "Hiding page" : "Unhiding page", "/api/admin/sites/" + encodeURIComponent(d.site) + "/moderate", { method: "POST", body: JSON.stringify(on ? { hide: [d.page] } : { unhide: [d.page] }) });
			}
			case "page-delete":
				return act("Deleting page", "/api/sites/" + encodeURIComponent(d.site) + "/files/" + d.page.split("/").map(encodeURIComponent).join("/"), { method: "DELETE" }, "Delete ~" + d.site + "/" + d.page + "? Its saved versions stay in the bucket.");
			case "site-delete": {
				const typed = prompt("Delete ~" + d.site + " and everything in it? Type the site's name to confirm:", "");
				if (typed !== d.site) { if (typed !== null) { status("Not deleted: the name didn't match."); } return; }
				return act("Deleting site", "/api/admin/sites/" + encodeURIComponent(d.site), { method: "DELETE" });
			}
			case "quota": {
				const mb = prompt("Storage for ~" + d.site + ", in MB (blank = the default 200):", d.mb);
				if (mb === null) { return; }
				return act("Setting quota", "/api/sites/" + encodeURIComponent(d.site) + "/quota", { method: "POST", body: JSON.stringify({ bytes: mb.trim() ? Math.round(Number(mb) * 1048576) : null }) });
			}
			case "lock": {
				const on = d.on === "1";
				const note = on ? prompt("Lock this account (signed out everywhere, can't sign in). Note, for your records:", "") : "";
				if (on && note === null) { return; }
				return act(on ? "Locking account" : "Unlocking account", "/api/admin/users/" + d.user + "/lock", { method: "POST", body: JSON.stringify({ locked: on, note }) });
			}
			case "hide-all": {
				const sites = d.sites.split(",").filter(Boolean);
				if (!confirm("Hide " + sites.length + " site(s): " + sites.map((s) => "~" + s).join(", ") + "?")) { return; }
				return (async () => {
					for (const site of sites) { await api("/api/admin/sites/" + encodeURIComponent(site) + "/moderate", { method: "POST", body: JSON.stringify({ disabled: true, reason: "account action" }) }).catch((error) => status("~" + site + ": " + error.message)); }
					await load(true);
				})();
			}
			case "resolve":
				return act(d.on === "1" ? "Resolving" : "Reopening", "/api/admin/reports/" + d.report + "/resolve", { method: "POST", body: JSON.stringify({ resolved: d.on === "1" }) });
			default:
				return undefined;
		}
	});
	$("#reload").dataset.act = "reload";
	$("#search").addEventListener("input", () => { filter = $("#search").value.trim().toLowerCase(); render(); });
	for (const button of document.querySelectorAll("nav button")) {
		button.addEventListener("click", () => {
			tab = button.dataset.tab;
			for (const t of document.querySelectorAll("nav button")) { t.setAttribute("aria-selected", String(t === button)); }
			render();
		});
	}
	load(false);
})();
</script>
</body>
</html>`;

export { handle_admin, overview };
