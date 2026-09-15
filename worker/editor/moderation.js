// @ts-check
// Moderation state per site — a marker object in the bucket, `sites/<name>/.moderation.json`, that only the editor
// Worker writes (the admin, MALICIOUS_ACTOR_PLAN.md phase 2) and both Workers read: `disabled` (the site answers
// 451 and can't be published to), `hidden` (pages that answer 404), `created` (when the site was claimed: its first
// day is `noindex`), `reason`, `by`, `updated`. The name starts with a dot, which names.js never accepts as a path, so
// no one serves, lists, or writes it through the file routes. The sites Worker re-reads it whenever the site's
// generation bumps (a publish, a delete, or this Worker's ping right after writing it), so a change lands at once.
import { ShortCache } from "../shared/limits.js";

const MODERATION_FILE = ".moderation.json";

/**
 * @typedef {{ disabled?: boolean, hidden?: string[], reason?: string, created?: number, updated?: number, by?: string }} Moderation
 */

/** Markers read lately, per isolate (a public file read asks; 30 s of staleness is fine for a takedown). @type {ShortCache<Moderation>} */
const moderation_cache = new ShortCache(30_000, 2000);

/** The site's marker, or an empty one. @param {{ SITES: R2Bucket }} env @param {string} site @returns {Promise<Moderation>} */
async function read_moderation(env, site) {
	const cached = moderation_cache.get(site);
	if (cached) { return cached; }
	const object = await env.SITES.get(`sites/${site}/${MODERATION_FILE}`);
	let moderation = {};
	if (object) {
		try {
			moderation = normalize(JSON.parse(await object.text()));
		} catch (_error) {
			moderation = {};
		}
	}
	return moderation_cache.set(site, moderation);
}

/** Only the fields we know, in their shapes. @param {any} raw @returns {Moderation} */
function normalize(raw) {
	if (!raw || typeof raw !== "object") { return {}; }
	/** @type {Moderation} */
	const moderation = {};
	if (raw.disabled === true) { moderation.disabled = true; }
	if (Array.isArray(raw.hidden)) { moderation.hidden = raw.hidden.filter((page) => typeof page === "string").slice(0, 500); }
	if (typeof raw.reason === "string" && raw.reason) { moderation.reason = raw.reason.slice(0, 500); }
	for (const key of /** @type {const} */ (["created", "updated"])) {
		if (typeof raw[key] === "number" && Number.isFinite(raw[key])) { moderation[key] = raw[key]; }
	}
	if (typeof raw.by === "string" && raw.by) { moderation.by = raw.by.slice(0, 200); }
	return moderation;
}

/**
 * Changes a site's marker and tells the sites Worker. `hide`/`unhide` adjust the hidden pages; `created` is set
 * only if the marker has none (a claim); `disabled`/`reason` replace. Returns the marker as written.
 * @param {{ SITES: R2Bucket, SITES_URL?: string }} env @param {ExecutionContext | null} ctx @param {string} site
 * @param {{ disabled?: boolean, hide?: string[], unhide?: string[], reason?: string | null, created?: number }} patch
 * @param {string} [by] - who (the admin's email, or "system")
 */
async function write_moderation(env, ctx, site, patch, by = "system") {
	moderation_cache.entries.delete(site);
	const current = await read_moderation(env, site);
	/** @type {Moderation} */
	const next = { ...current };
	if (typeof patch.disabled === "boolean") { if (patch.disabled) { next.disabled = true; } else { delete next.disabled; } }
	if (patch.hide || patch.unhide) {
		const hidden = new Set(current.hidden || []);
		for (const page of patch.hide || []) { hidden.add(page); }
		for (const page of patch.unhide || []) { hidden.delete(page); }
		if (hidden.size) { next.hidden = [...hidden].slice(0, 500); } else { delete next.hidden; }
	}
	if (patch.reason !== undefined) { if (patch.reason) { next.reason = String(patch.reason).slice(0, 500); } else { delete next.reason; } }
	if (typeof patch.created === "number" && !current.created) { next.created = patch.created; }
	next.updated = Date.now();
	next.by = by;
	const empty = !next.disabled && !next.hidden && !next.reason && !next.created;
	if (empty) {
		await env.SITES.delete(`sites/${site}/${MODERATION_FILE}`);
	} else {
		await env.SITES.put(`sites/${site}/${MODERATION_FILE}`, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
	}
	moderation_cache.set(site, empty ? {} : next);
	await notify_published(env, ctx, site, "index.html");
	return empty ? {} : next;
}

/** A page is one the marker hides. @param {Moderation} moderation @param {string} page */
function page_hidden(moderation, page) {
	return !!moderation.hidden && moderation.hidden.includes(page);
}

/**
 * Tells the sites Worker a site changed, so the served pages it cached are remade and the marker re-read: POST
 * /~site/x/published bumps the site's generation (sites/index.js). Media under hashed or per-save names (gifs/,
 * midi/, collages/, previews/, versions/) doesn't change what a page renders to. Awaited, so the page is fresh by
 * the time the save is reported done; a failure only leaves the cache to age out (an hour).
 * @param {{ SITES_URL?: string }} env @param {ExecutionContext | null} ctx @param {string} site @param {string} path
 */
async function notify_published(env, ctx, site, path) {
	if (!env.SITES_URL || /^(gifs|midi|collages|previews|versions)\//.test(path)) { return; }
	try {
		await fetch(`${env.SITES_URL}/~${site}/x/published`, { method: "POST", signal: AbortSignal.timeout(3000) });
	} catch (error) {
		console.warn(`published ping for ${site} failed:`, error);
		void ctx;
	}
}

export { MODERATION_FILE, notify_published, page_hidden, read_moderation, write_moderation };
