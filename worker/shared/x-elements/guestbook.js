// @ts-check
// <x-guestbook>: the classic guestbook. Visitors sign it with a name and a message (plain text, a POST form the
// sites Worker handles at /~name/x/guestbook, or /x/guestbook for the root site); entries live in the site's Durable
// Object, newest first.
import { ROOT_SITE, site_base, site_home } from "../names.js";
import { escape_html } from "./index.js";

/**
 * A same-site path to return to after signing: starts at the site's home, can't leave it (or, for the root site, wander
 * into someone's /~name/), and can't be an absolute or protocol-relative URL.
 * @param {unknown} value @param {string} site
 */
function safe_back(value, site) {
	const home = site_home(site);
	const back = String(value || "");
	const ok = back.startsWith(home) && !back.includes("//") && !back.includes("..") && !(site === ROOT_SITE && back.startsWith("/~"));
	return ok ? back : home;
}

const MAX_NAME = 40;
const MAX_MESSAGE = 500;

export default {
	tag: "x-guestbook",
	attrs: ["title", "max"],
	editor: {
		label: "Guestbook",
		description: "Visitors can sign it; entries are kept by your site.",
		fallback: "<b>Sign my guestbook!</b> <i>(the form appears on the published page)</i>",
	},
	async render({ attrs, context }) {
		const max = Math.min(200, Math.max(1, parseInt(attrs.max || "50", 10) || 50));
		const entries = await context.state.get_guestbook_entries(max);
		const title = attrs.title ?? "Sign my guestbook!";
		const back = new URL(context.request.url).pathname;
		const list = entries.length === 0 ?
			"<p><i>Nobody has signed yet. Be the first!</i></p>" :
			entries.map((entry) => `<p><b>${escape_html(entry.name)}</b> <small>wrote on ${escape_html(new Date(entry.created).toISOString().slice(0, 10))}:</small><br>${escape_html(entry.message).replace(/\n/g, "<br>")}</p>`).join("<hr size=\"1\">");
		return `<a name="guestbook"></a><b>${escape_html(title)}</b>
<form method="post" action="${escape_html(site_base(context.site))}/x/guestbook" style="margin:4px 0">
<input type="hidden" name="back" value="${escape_html(back)}">
<input type="text" name="website" value="" style="display:none" tabindex="-1" autocomplete="off">
Name: <input type="text" name="name" maxlength="${MAX_NAME}" size="20" required><br>
<textarea name="message" rows="3" cols="40" maxlength="${MAX_MESSAGE}" required></textarea><br>
<input type="submit" value="Sign!">
</form>
<div style="max-height:220px;overflow:auto;text-align:left">${list}</div>`;
	},
	/**
	 * POST /~name/x/guestbook (or /x/guestbook for root): adds an entry (rate-limited per visitor), then goes back to the page.
	 * @param {{ form: FormData, context: import("./index.js").XElementContext }} input
	 */
	async action({ form, context }) {
		if (String(form.get("website") || "")) {
			return { status: 303, location: safe_back(form.get("back"), context.site) }; // honeypot: pretend it worked
		}
		const name = String(form.get("name") || "").trim().slice(0, MAX_NAME);
		const message = String(form.get("message") || "").trim().slice(0, MAX_MESSAGE);
		if (!name || !message) {
			return { status: 400, error: "A name and a message are needed to sign the guestbook." };
		}
		const ip = context.request.headers.get("CF-Connecting-IP") || "unknown";
		const ok = await context.state.add_guestbook_entry({ name, message, ip_hash: await hash(ip) });
		if (!ok) {
			return { status: 429, error: "You're signing too fast. Try again in a minute." };
		}
		return { status: 303, location: `${safe_back(form.get("back"), context.site)}#guestbook` };
	},
};

/** @param {string} text */
async function hash(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
