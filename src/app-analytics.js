// @ts-check
/* global posthog:writable */
// App-side analytics events (gif_picker_opened, gif_search, …) and errors. The editor Worker injects
// the PostHog bootstrap into the app shell when POSTHOG_API_KEY is set (worker/shared/analytics.js);
// on dev servers or plain jspaint there is no snippet, and events are dropped on the floor.
// Internal app errors (error-handling-enhanced.js) come through here as $exception events — the app's
// error dialog is the single funnel, so the SDK's own capture_exceptions stays off (no double-counting)
// and PostHog's Errors tab groups them by message + stack.

/**
 * Best-effort capture of an app event. Never throws, never blocks.
 * @param {string} name
 * @param {Record<string, any>} [props]
 */
function track_app_event(name, props) {
	posthog?.capture(name, props);
}

/**
 * Best-effort capture of an internal application error (the "Internal application error" dialogs).
 * Uses `posthog.captureException` — Error tracking needs the metadata it attaches ($exception_list
 * & co.; a plain capture("$exception") ingests but never shows up in the Errors tab). Extra
 * properties ride along as the second argument.
 * @param {"uncaught" | "rejection"} kind - which of the app's global handlers caught it
 * @param {Error | string} error - the error object or message the handler received
 */
function track_app_error(kind, error) {
	try {
		if (posthog?.captureException) {
			posthog.captureException(error, { error_kind: kind });
		} else if (posthog) {
			// Older library without captureException: best effort, without the required metadata.
			posthog.capture("$exception", { $exception: String(error).slice(0, 2000), error_kind: kind });
		}
	} catch (_error) {
		// Never let analytics break the error handler itself.
	}
}

export { track_app_error, track_app_event };
