// The Workers' error reports: a $exception event shaped the way PostHog's Error tracking groups them ($exception_list
// with type, value, and the stack as raw frames), sent with the Worker's key; nothing sent without a key; a repeat of
// the same failure within a minute is not sent again (an outage is one signal, not a flood). Plain Node, no browser.
import { assert } from "./helpers.mjs";
import { capture_exception, exception_event, frames_of } from "../../worker/shared/exceptions.js";

// Frames from a V8 stack
const stack = `Error: Exceeded allowed rows read in Durable Objects free tier.
    at PageRoom.record (worker/editor/page-room.js:181:27)
    at PageRoom.handle_message (worker/editor/page-room.js:470:30)
    at async Object.fetch (worker/editor/index.js:790:12)`;
const frames = frames_of(stack);
assert.equal(frames.length, 3);
assert.deepEqual(frames[0], { platform: "node:javascript", filename: "worker/editor/page-room.js", function: "PageRoom.record", lineno: 181, colno: 27, in_app: true });
assert.equal(frames[2].function, "async Object.fetch");

// The event
const error = new Error("Exceeded allowed rows read in Durable Objects free tier.");
const event = exception_event(error, { worker: "jspaint-editor", route: "/api/whoami", status: 503, code: "storage-quota" });
assert.equal(event.event, "$exception");
assert.equal(event.properties.distinct_id, "jspaint-editor");
assert.equal(event.properties.$exception_list.length, 1);
assert.equal(event.properties.$exception_list[0].type, "Error");
assert.equal(event.properties.$exception_list[0].value, error.message);
assert.equal(event.properties.$exception_list[0].stacktrace.type, "raw");
assert.ok(event.properties.$exception_list[0].stacktrace.frames.length > 0, "the stack rides along as frames");
assert.equal(event.properties.code, "storage-quota");
assert.equal(event.properties.error_kind, "server");

// Sending: the key, the batch, and the repeat guard
const sent = [];
const real_fetch = globalThis.fetch;
globalThis.fetch = (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return Promise.resolve(new Response("{\"status\":1}", { status: 200 })); };
try {
	assert.equal(await capture_exception({}, null, error, { route: "/x" }), 0, "no key: nothing sent");
	assert.equal(sent.length, 0);
	const waited = [];
	const ctx = { waitUntil: (p) => { waited.push(p); } };
	assert.equal(await capture_exception({ POSTHOG_API_KEY: "phc_test" }, ctx, error, { worker: "jspaint-editor", route: "/x" }), 200);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].url, "https://us.i.posthog.com/e/");
	assert.equal(sent[0].body.api_key, "phc_test");
	assert.equal(sent[0].body.batch[0].event, "$exception");
	assert.equal(waited.length, 1, "the request outlives the response (waitUntil)");
	assert.equal(await capture_exception({ POSTHOG_API_KEY: "phc_test" }, ctx, error, { worker: "jspaint-editor", route: "/x" }), 0, "the same failure again within a minute: not sent");
	assert.equal(sent.length, 1);
	assert.equal(await capture_exception({ POSTHOG_API_KEY: "phc_test" }, ctx, new Error("Something else"), { route: "/x" }), 200, "a different failure is sent");
	assert.equal(await capture_exception({ POSTHOG_API_KEY: "phc_test" }, ctx, error, { route: "/x", test: true }), 200, "a test event is never throttled");
	globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
	assert.equal(await capture_exception({ POSTHOG_API_KEY: "phc_test" }, ctx, new Error("Unreachable"), { route: "/y" }), 0, "PostHog unreachable: 0, no throw");
} finally {
	globalThis.fetch = real_fetch;
}
console.log("exceptions: ok");
