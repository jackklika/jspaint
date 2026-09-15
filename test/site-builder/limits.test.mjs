// worker/shared/limits.js, on its own (no Workers): a missing or failing binding never limits; a binding's answer is
// followed; the 429 is one plain sentence with a code and Retry-After; the short cache forgets after its ttl; the
// PostHog report is sampled and throttled and never runs without a key.
import { assert } from "./helpers.mjs";
import { SLOW_DOWN_TEXT, ShortCache, client_ip, limited, report_limited, too_many } from "../../worker/shared/limits.js";

// A binding that allows `limit` calls per key, like Cloudflare's
const binding = (limit) => {
	const counts = new Map();
	return { limit({ key }) { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return Promise.resolve({ success: n <= limit }); } };
};

assert.equal(await limited(undefined, "a"), false, "no binding: unlimited");
assert.equal(await limited({ limit() { return Promise.reject(new Error("down")); } }, "a"), false, "a failing binding: unlimited");
const three = binding(3);
assert.deepEqual([await limited(three, "k"), await limited(three, "k"), await limited(three, "k"), await limited(three, "k")], [false, false, false, true], "the fourth is over");
assert.equal(await limited(three, "other"), false, "another key has its own count");

const request = (headers) => new Request("https://example.test/", { headers });
assert.equal(client_ip(request({ "CF-Connecting-IP": "10.1.2.3" })), "10.1.2.3");
assert.equal(client_ip(request({})), "unknown");

const response = too_many(30, { "Access-Control-Allow-Origin": "*" });
assert.equal(response.status, 429);
assert.equal(response.headers.get("Retry-After"), "30");
assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
assert.deepEqual(await response.json(), { error: SLOW_DOWN_TEXT, code: "rate-limited", retry_after: 30 });
assert.equal(too_many().headers.get("Retry-After"), "10");

const cache = new ShortCache(50, 2);
assert.equal(cache.get("x"), undefined);
assert.equal(cache.set("x", 1), 1);
assert.equal(cache.get("x"), 1);
cache.set("y", 2);
cache.set("z", 3); // over the size: it starts over rather than grow
assert.equal(cache.get("x"), undefined);
assert.equal(cache.get("z"), 3);
await new Promise((resolve) => setTimeout(resolve, 70));
assert.equal(cache.get("z"), undefined, "forgotten after the ttl");

// Reporting: nothing without a key; with one, a sampled fetch through waitUntil
const calls = [];
const real_fetch = globalThis.fetch;
globalThis.fetch = (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Promise.resolve(new Response("ok")); };
const real_random = Math.random;
try {
	report_limited({}, { waitUntil() { assert.fail("no key, no report"); } }, { kind: "x", worker: "w" });
	Math.random = () => 0.5; // above the 1-in-10 sample
	report_limited({ POSTHOG_API_KEY: "phc_test" }, null, { kind: "x", worker: "w" });
	assert.equal(calls.length, 0, "sampled out");
	Math.random = () => 0.01;
	let waited = 0;
	report_limited({ POSTHOG_API_KEY: "phc_test" }, { waitUntil(p) { waited++; return p; } }, { kind: "x", worker: "w", route: "/r" });
	report_limited({ POSTHOG_API_KEY: "phc_test" }, { waitUntil(p) { waited++; return p; } }, { kind: "x", worker: "w" });
	assert.equal(calls.length, 1, "the second within a minute is dropped");
	assert.equal(waited, 1);
	assert.equal(calls[0].body.batch[0].event, "rate_limited");
	assert.deepEqual(calls[0].body.batch[0].properties, { distinct_id: "server", kind: "x", worker: "w", route: "/r" });
} finally {
	globalThis.fetch = real_fetch;
	Math.random = real_random;
}
console.log("limits: ok");
