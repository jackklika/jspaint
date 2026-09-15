// Internal app errors flow to PostHog via captureException (error-handling-enhanced.js →
// track_app_error): every "Internal application error" dialog — uncaught error or unhandled
// rejection — is captured once, with the error kind. captureException is what Error tracking
// needs (a plain capture("$exception") ingests but never appears in the Errors tab).
// Stubbed posthog; no network or Workers needed.
import { assert, open_paint } from "./helpers.mjs";

const { page, browser } = await open_paint({
	init: () => {
		window.__events = [];
		window.posthog = {
			capture: (name, props) => { window.__events.push(["capture", name, props]); },
			captureException: (error, props) => { window.__events.push(["captureException", error, props]); },
		};
	},
});

// Drive the app's real global handlers directly (deterministic — no event-timing assumptions).
await page.evaluate(() => {
	// source "" keeps the handler on the pass-the-Error-through branch (real errors' stacks contain
	// their source file; the string-formatting branch is for stackless errors like syntax errors).
	window.onerror("e2e test error", "", 1, 1, new Error("e2e test error"));
});
await page.waitForTimeout(200);
const first = await page.evaluate(() => {
	const [method, error, props] = window.__events[0] || [];
	return { method, props, is_error: error instanceof Error, message: error?.message };
});
assert.equal(first.method, "captureException", "an uncaught error goes through captureException");
assert.deepEqual(first.props, { error_kind: "uncaught" });
assert.ok(first.is_error && first.message === "e2e test error", "the error object is passed through");

await page.evaluate(() => {
	window.onunhandledrejection({ reason: new Error("e2e test rejection") });
});
await page.waitForTimeout(200);
const rejection = await page.evaluate(() => {
	const found = window.__events.filter(([method, _error, props]) => method === "captureException" && props?.error_kind === "rejection");
	return { count: found.length, message: found[0]?.[1]?.message };
});
assert.equal(rejection.count, 1, "an unhandled rejection goes through captureException");
assert.equal(rejection.message, "e2e test rejection");

// A non-Error reason (rejections can reject with anything) passes through as-is for the SDK to wrap.
await page.evaluate(() => {
	window.onunhandledrejection({ reason: "just a string" });
});
await page.waitForTimeout(200);
const string_rejection = await page.evaluate(() => {
	const found = window.__events.filter(([method, _error, props]) => method === "captureException" && props?.error_kind === "rejection");
	return { count: found.length, reason: found[1]?.[1] };
});
assert.equal(string_rejection.count, 2);
assert.equal(string_rejection.reason, "just a string");

// The fallback: an older library without captureException still gets a plain $exception capture.
await page.evaluate(() => {
	delete window.posthog.captureException;
	window.__events = [];
	window.onunhandledrejection({ reason: new Error("fallback path") });
});
await page.waitForTimeout(200);
const fallback_events = await page.evaluate(() => window.__events);
assert.deepEqual(fallback_events, [["capture", "$exception", { $exception: "Error: fallback path", error_kind: "rejection" }]], "no captureException → plain $exception capture (no Errors tab, but the event exists)");

// Not `close()`: this test deliberately triggers the app's error dialogs, which console.error —
// expected here, so skip the no-page-errors assertion and just close the browser.
await browser.close();
console.log("app-errors: ok");
