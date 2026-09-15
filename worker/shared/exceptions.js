// @ts-check
// Server-side errors → PostHog Error tracking. A Worker's own failures (a Durable Object over its quota, a bug in a
// route) never reach the browser's error dialog, which is where the app's $exception events come from; this sends
// them from the server as `$exception` events shaped the way Error tracking groups them ($exception_list with type
// and value). No POSTHOG_API_KEY (local dev): a no-op. The same failure is reported at most once a minute per isolate,
// so an outage is a signal, not a flood.

/** @type {Map<string, number>} */
const last_reported = new Map();
const REPEAT_MS = 60 * 1000;

/**
 * @param {{ POSTHOG_API_KEY?: string, POSTHOG_HOST?: string }} env
 * @param {{ waitUntil: (p: Promise<unknown>) => void } | null} ctx
 * @param {unknown} error
 * @param {Record<string, unknown>} [properties] - where it happened (worker, route, status, code…)
 */
function capture_exception(env, ctx, error, properties = {}) {
	const api_key = env && env.POSTHOG_API_KEY;
	if (!api_key) { return; }
	const err = /** @type {{ name?: string, message?: string, stack?: string }} */ (error && typeof error === "object" ? error : { message: String(error) });
	const type = String(err.name || "Error");
	const value = String(err.message || err || "Unknown error").slice(0, 2000);
	const key = `${type}:${value}:${properties.route || ""}`;
	const now = Date.now();
	if ((last_reported.get(key) || 0) > now - REPEAT_MS) { return; }
	last_reported.set(key, now);
	if (last_reported.size > 200) { last_reported.delete(/** @type {string} */ (last_reported.keys().next().value)); }
	const capture = fetch("https://us.i.posthog.com/e/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			api_key,
			batch: [{
				event: "$exception",
				timestamp: new Date().toISOString(),
				properties: {
					distinct_id: String(properties.worker || "worker"),
					$exception_list: [{ type, value, mechanism: { handled: true, synthetic: false }, ...(err.stack ? { stacktrace: { type: "raw", frames: [] } } : {}) }],
					$exception_type: type,
					$exception_message: value,
					$lib: "coolpaint-worker",
					error_kind: "server",
					...properties,
				},
			}],
		}),
	}).catch(() => { /* analytics must never break a request */ });
	if (ctx) { ctx.waitUntil(capture); }
}

export { capture_exception };
