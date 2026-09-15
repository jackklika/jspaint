// @ts-check
// Rate limits and the answers they give (MALICIOUS_ACTOR_PLAN.md). The brake is Cloudflare's Rate Limiting binding —
// free, no storage, declared under `ratelimits` in each wrangler.jsonc, one fixed limit per binding, keyed by any
// string (an address, a site, a session). It's per Cloudflare location and eventually consistent: a brake, not a
// ledger — quotas that must be exact live in Durable Objects. A binding that's missing (a test, an older dev
// config) or failing counts as unlimited: the brake must never stop a real request.
//
// Every limit sits far above human speed (docs: ten times); what it catches is a script or a bug, and the answer is
// one plain sentence with Retry-After, never detail.

/** @typedef {{ limit: (options: { key: string }) => Promise<{ success: boolean }> }} RateLimiter */

const SLOW_DOWN_TEXT = "Slow down a little and try again.";

/**
 * Whether this key is over the binding's limit (and counts this attempt).
 * @param {RateLimiter | undefined} binding
 * @param {string} key
 */
async function limited(binding, key) {
	if (!binding) { return false; }
	try {
		const { success } = await binding.limit({ key });
		return !success;
	} catch (_error) {
		return false;
	}
}

/** The requester's address, for keying limits (Cloudflare sets it; a test may too). @param {Request} request */
function client_ip(request) {
	return request.headers.get("CF-Connecting-IP") || "unknown";
}

/**
 * The 429: a plain sentence, a code the client can recognize, and when to try again.
 * @param {number} [retry_after_s]
 * @param {Record<string, string>} [headers]
 */
function too_many(retry_after_s = 10, headers = {}) {
	return new Response(JSON.stringify({ error: SLOW_DOWN_TEXT, code: "rate-limited", retry_after: retry_after_s }), {
		status: 429,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(retry_after_s), ...headers },
	});
}

/** @type {Map<string, number>} when each kind of limit was last reported, per isolate */
const last_reported = new Map();

/**
 * A limit was hit: a `rate_limited` event for PostHog (the abuse dashboard), sampled — one in ten hits, and at most
 * one a minute per kind per isolate — so a flood doesn't become a flood of events. Never the address itself.
 * @param {{ POSTHOG_API_KEY?: string }} env
 * @param {ExecutionContext | null | undefined} ctx
 * @param {{ kind: string, worker: string, [key: string]: string | number }} properties
 * @param {{ always?: boolean }} [options] - `always`: not sampled (a rare, important event — a page past its day's budget)
 */
function report_limited(env, ctx, properties, { always = false } = {}) {
	const api_key = env.POSTHOG_API_KEY;
	if (!api_key || (!always && Math.random() >= 0.1)) { return; }
	const now = Date.now();
	if ((last_reported.get(properties.kind) || 0) > now - 60_000) { return; }
	last_reported.set(properties.kind, now);
	const capture = fetch("https://us.i.posthog.com/e/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key, batch: [{ event: "rate_limited", properties: { distinct_id: "server", ...properties }, timestamp: new Date().toISOString() }] }),
	}).catch(() => { /* the dashboard can miss one */ });
	if (ctx) { ctx.waitUntil(capture); }
}

/**
 * A small per-isolate cache for public answers that many people ask for at once (a site's presence, its viewer
 * stats): the same answer for `ttl_ms`, so a flood costs the Durable Object one trip per period, not per request.
 * @template T
 */
class ShortCache {
	/** @param {number} ttl_ms @param {number} [max_entries] */
	constructor(ttl_ms, max_entries = 500) {
		this.ttl_ms = ttl_ms;
		this.max_entries = max_entries;
		/** @type {Map<string, { at: number, value: T }>} */
		this.entries = new Map();
	}
	/** @param {string} key @returns {T | undefined} */
	get(key) {
		const entry = this.entries.get(key);
		if (!entry) { return undefined; }
		if (entry.at < Date.now() - this.ttl_ms) { this.entries.delete(key); return undefined; }
		return entry.value;
	}
	/** @param {string} key @param {T} value */
	set(key, value) {
		if (this.entries.size >= this.max_entries) { this.entries.clear(); }
		this.entries.set(key, { at: Date.now(), value });
		return value;
	}
}

export { SLOW_DOWN_TEXT, ShortCache, client_ip, limited, report_limited, too_many };
