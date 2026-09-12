// @ts-check
// <x-toc>: a table of contents — the page's sections (blocks.js sections carry an id), each linked by its #anchor,
// named by its heading (or first words). Rendered from the page itself at serve time.
import { escape_html } from "./index.js";
import { find_sections, text_of } from "../sections.js";

export default {
	tag: "x-toc",
	attrs: ["title"],
	editor: {
		label: "Table of Contents",
		description: "Lists the page's sections, each a link to it, on the published page.",
		fallback: "<b>Contents</b><br><i>(the page's sections are listed here on the published page)</i>",
	},
	render({ attrs, context }) {
		const items = [];
		for (const section of find_sections(context.page_html || "")) {
			if (!section.id) { continue; }
			const heading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(section.html);
			const text = text_of(heading ? heading[1] : section.html, 80);
			items.push(`<li class="toc-item"><a href="#${escape_html(section.id)}">${escape_html(text || section.id)}</a></li>`);
		}
		const heading = attrs.title ? `<b class="toc-title">${escape_html(attrs.title)}</b>` : "";
		return heading + (items.length ? `<ul class="toc">${items.join("")}</ul>` : "<p class=\"toc-empty\"><i>No sections on this page yet.</i></p>");
	},
};
