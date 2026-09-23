// @ts-check
// The publish funnel, as PostHog events (Jack, 2026-09-23: "Add events to measure the funnel so I can view this on
// posthog"). One event per step, so a PostHog funnel insight can be built from them in order:
//
//   starter_opened     a newcomer's starter page (my-site.js open_starter_page)
//   first_change       their first stroke or element on an unpublished page (publish-button.js)
//   publish_clicked    Publish, from wherever: { source: "button" | "menu" | "ctrl_s" | "globe" | "share" | "nudge" | "resume", signed_in, fresh }
//   sign_in_started    the Google button ({ via: "google", resume })
//   sign_in_returned   back from Google ({ resume })
//   signed_in          the Sign In dialog finished ({ via: "google" | "password" })
//   site_named         a new site's name went through ({ claimed })
//   published          a page went up ({ first, page, assets_uploaded, assets_reused })
//   nudge_shown / nudge_clicked   the one-time "Like it? Publish it" balloon
//
// Everything goes through app-analytics.js (the PostHog snippet the editor Worker injects); without it — a dev server,
// plain jspaint — nothing happens and nothing breaks.
import { track_app_event } from "./app-analytics.js";

/**
 * @param {"starter_opened" | "first_change" | "publish_clicked" | "sign_in_started" | "sign_in_returned" | "signed_in" | "site_named" | "published" | "nudge_shown" | "nudge_clicked"} step
 * @param {Record<string, string | number | boolean | null>} [props]
 */
function funnel(step, props = {}) {
	try {
		track_app_event(step, props);
	} catch (_error) {
		// (no PostHog here: `posthog` isn't even a defined global on a dev server)
	}
}

export { funnel };
