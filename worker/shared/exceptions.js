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
 * A V8 stack ("    at fn (file:line:col)") as PostHog raw frames, innermost first.
 * @param {string} stack
 * @returns {{ platform: string, filename: string, function: string, lineno: number, colno: number, in_app: boolean }[]}
 */
function frames_of(stack) {
	const frames = [];
	for (const line of stack.split("\n").slice(1, 30)) {
		const m = /^\s*at\s+(?:(.*?)\s+\()?([^()]+?):(\d+):(\d+)\)?\s*$/.exec(line);
		if (!m) { continue; }
		frames.push({ platform: "node:javascript", filename: m[2], function: m[1] || "<anonymous>", lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|cloudflare:/.test(m[2]) });
	}
	return frames;
}

/**
 * The event PostHog gets for an error: the shape Error tracking groups on.
 * @param {unknown} error
 * @param {Record<string, unknown>} properties
 */
function exception_event(error, properties) {
	const err = /** @type {{ name?: string, message?: string, stack?: string }} */ (error && typeof error === "object" ? error : { message: String(error) });
	const type = String(err.name || "Error");
	const value = String(err.message || err || "Unknown error").slice(0, 2000);
	const frames = err.stack ? frames_of(String(err.stack)) : [];
	return {
		event: "$exception",
		timestamp: new Date().toISOString(),
		properties: {
			distinct_id: String(properties.worker || "worker"),
			$exception_list: [{ type, value, mechanism: { handled: true, synthetic: false }, ...(frames.length ? { stacktrace: { type: "raw", frames } } : {}) }],
			$exception_type: type,
			$exception_message: value,
			$lib: "coolpaint-worker",
			error_kind: "server",
			...properties,
		},
	};
}

/**
 * @param {{ POSTHOG_API_KEY?: string, POSTHOG_HOST?: string }} env
 * @param {{ waitUntil: (p: Promise<unknown>) => void } | null} ctx
 * @param {unknown} error
 * @param {Record<string, unknown>} [properties] - where it happened (worker, route, status, code…)
 * @returns {Promise<number>} PostHog's HTTP status — 0 when nothing was sent (no key, a repeat, or the network failed)
 */
function capture_exception(env, ctx, error, properties = {}) {
	const api_key = env && env.POSTHOG_API_KEY;
	if (!api_key) { return Promise.resolve(0); }
	const event = exception_event(error, properties);
	const key = `${event.properties.$exception_type}:${event.properties.$exception_message}:${properties.route || ""}`;
	const now = Date.now();
	if (!properties.test && (last_reported.get(key) || 0) > now - REPEAT_MS) { return Promise.resolve(0); }
	last_reported.set(key, now);
	if (last_reported.size > 200) { last_reported.delete(/** @type {string} */ (last_reported.keys().next().value)); }
	const capture = fetch("https://us.i.posthog.com/e/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key, batch: [event] }),
	}).then((response) => response.status, () => 0); // (analytics must never break a request)
	if (ctx) { ctx.waitUntil(capture); }
	return capture;
}

export { capture_exception, exception_event, frames_of };
