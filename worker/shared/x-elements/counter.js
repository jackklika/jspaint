// @ts-check
// <x-counter>: the classic visitor counter. Increments once per page view (per page), stored in the site's Durable Object.
import { escape_html } from "./index.js";

export default {
	tag: "x-counter",
	attrs: ["label", "digits"],
	editor: {
		label: "Visitor counter",
		description: "Counts visits to this page, odometer style.",
		fallback: "You are visitor number <b>?????</b>",
	},
	async render({ attrs, context }) {
		const digits = Math.min(10, Math.max(1, parseInt(attrs.digits || "6", 10) || 6));
		const label = attrs.label ?? "You are visitor number ";
		// A served page is rendered once and cached (sites/index.js): the count goes into a slot the Worker fills per view
		if (context.count_slot) { return `${escape_html(label)}<span data-x-counter="${digits}">${odometer("?".repeat(digits), digits)}</span>`; }
		// Otherwise a visit counts; the editor's preview just reads
		const count = context.preview ? await context.state.get_hits(context.page) : await context.state.hit(context.page);
		return `${escape_html(label)}${odometer(count, digits)}`;
	},
};

/**
 * The odometer: green-on-black cells, one per digit.
 * @param {number | string} count @param {number} digits
 */
function odometer(count, digits) {
	return String(count).padStart(digits, "0").split("").map((d) =>
		`<span style="display:inline-block;background:#000;color:#0f0;font:bold 16px 'Courier New',monospace;padding:1px 3px;margin:0 1px;border:1px solid #888">${d}</span>`,
	).join("");
}

export { odometer };
