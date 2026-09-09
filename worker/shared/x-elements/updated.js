// @ts-check
// <x-updated>: "Last updated …" from the page file's own modification time. No state needed.
import { escape_html } from "./index.js";

export default {
	tag: "x-updated",
	attrs: ["label", "format"],
	editor: {
		label: "Last updated",
		description: "Shows when this page was last saved.",
		fallback: "Last updated: <i>sometime in the 90s</i>",
	},
	render({ attrs, context }) {
		const date = context.page_uploaded || new Date();
		const format = attrs.format === "long" ? "long" : "short";
		const text = format === "long" ?
			date.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) :
			date.toISOString().slice(0, 10);
		return `${escape_html(attrs.label ?? "Last updated: ")}<i>${escape_html(text)}</i>`;
	},
};
