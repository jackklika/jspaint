// @ts-check
// The sections of a published page, found in its markup: every <div class="block section" id="…"> (Paint writes the
// attributes in whatever order; a section may hold nested <div>s — cards, callouts — so the end tag is matched by
// depth, not by the first </div>). Used by <x-toc> and the folder view's summaries.

/**
 * @param {string} html - a whole page, or a fragment
 * @returns {{ tag: string, id: string, attrs: string, html: string }[]} in page order; `html` is the section's inner markup
 */
function find_sections(html) {
	const sections = [];
	const start = /<(div|p|h[1-6])\b([^>]*)>/gi;
	let match;
	while ((match = start.exec(html))) {
		const [tag_text, tag, attrs] = [match[0], match[1].toLowerCase(), match[2]];
		const class_match = /\bclass="([^"]*)"/i.exec(attrs);
		if (!class_match || !/\bsection\b/.test(class_match[1]) || !/\bblock\b/.test(class_match[1])) { continue; }
		const id_match = /\bid="([^"]*)"/i.exec(attrs);
		// The matching end tag: count nested tags of the same name
		const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
		tags.lastIndex = match.index + tag_text.length;
		let depth = 1;
		let end = -1;
		let inner_end = html.length;
		let t;
		while ((t = tags.exec(html))) {
			depth += t[1] ? -1 : 1;
			if (depth === 0) { inner_end = t.index; end = t.index + t[0].length; break; }
		}
		sections.push({ tag, id: id_match ? id_match[1] : "", attrs, html: html.slice(match.index + tag_text.length, inner_end) });
		start.lastIndex = end === -1 ? html.length : end;
	}
	return sections;
}

/** Plain words of some markup, for a summary or a heading. @param {string} markup @param {number} [max] */
function text_of(markup, max = 300) {
	return markup
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

export { find_sections, text_of };
