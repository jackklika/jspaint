// @ts-check
// The <x-*> element registry — the site builder's plugin system (docs/DESIGN.md §3.5).
// Each entry declares its tag, the attributes it accepts, how the sites Worker renders it at serve time,
// and what the editor shows for it. Fallback content lives inside the tag in the page file and is what a
// browser shows when the page is served raw (an exported zip, another host).
import counter from "./counter.js";
import folder from "./folder.js";
import toc from "./toc.js";
import guestbook from "./guestbook.js";
import music from "./music.js";
import updated from "./updated.js";

/**
 * @typedef {object} XElementContext
 * @property {string} site - the ~name
 * @property {string} page - path within the site, e.g. "index.html"
 * @property {Date | null} page_uploaded - when the page file was last written
 * @property {any} state - the site's Durable Object stub (SiteState)
 * @property {Request} request
 * @property {{ list_pages: (folder: string) => Promise<{ path: string, uploaded: number }[]>, page_title: (path: string) => Promise<string | null>, page_summary: (path: string) => Promise<string>, settings: () => Promise<any>, has: (path: string) => Promise<boolean> }} files - read-only look at the site's pages and settings
 * @property {string} page_html - the page being rendered (sanitized), for elements that read the page itself (<x-toc>)
 * @property {boolean} [preview] - a look from the editor, not a visit: nothing counts (the counter reads instead of hitting)
 */

/**
 * @typedef {object} XElementDefinition
 * @property {string} tag
 * @property {string[]} attrs - allowed attribute names
 * @property {{ label: string, description: string, fallback: string }} editor - how the editor presents it, and the default fallback content
 * @property {(input: { attrs: Record<string, string>, context: XElementContext }) => Promise<string> | string} render - inner HTML (must be dialect-safe)
 * @property {(input: { form: FormData, context: XElementContext }) => Promise<XElementActionResult> | XElementActionResult} [action] - handles POST /~name/x/<name>
 */
/**
 * @typedef {{ status: number, location?: string, error?: string }} XElementActionResult - a redirect (303 + location) or an error page
 */

/** @type {Map<string, XElementDefinition>} */
const x_elements = new Map([counter, updated, guestbook, music, folder, toc].map((definition) => [definition.tag, definition]));

/**
 * Renders every registered <x-*> element in a page. The tag stays (so the page re-imports), its content is replaced.
 * If rendering fails, the fallback content is left alone.
 * @param {string} html
 * @param {XElementContext} context
 * @returns {Promise<string>}
 */
function render_x_elements(html, context) {
	let rewriter = new HTMLRewriter();
	for (const definition of x_elements.values()) {
		rewriter = rewriter.on(definition.tag, {
			async element(element) {
				/** @type {Record<string, string>} */
				const attrs = {};
				for (const [name, value] of [...element.attributes]) {
					if (definition.attrs.includes(name.toLowerCase())) {
						attrs[name.toLowerCase()] = value;
					}
				}
				try {
					element.setInnerContent(await definition.render({ attrs, context }), { html: true });
				} catch (error) {
					console.error(`<${definition.tag}> failed to render:`, error);
				}
			},
		});
	}
	return rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
}

/**
 * Renders one element for the editor's preview: what the page would show for it right now (the live count, the
 * folder's pages, the sections…), so what's on the canvas is what visitors see. Unknown attributes are dropped.
 * @param {string} tag
 * @param {Record<string, unknown>} attrs
 * @param {XElementContext} context
 * @returns {Promise<string | null>} inner HTML, or null for a tag that isn't an element
 */
// eslint-disable-next-line require-await -- render() may be sync; the caller awaits either way
async function render_x_element(tag, attrs, context) {
	const definition = x_elements.get(tag);
	if (!definition) { return null; }
	/** @type {Record<string, string>} */
	const allowed = {};
	for (const [name, value] of Object.entries(attrs || {})) {
		if (definition.attrs.includes(name.toLowerCase()) && typeof value === "string") { allowed[name.toLowerCase()] = value.slice(0, 2000); }
	}
	return definition.render({ attrs: allowed, context: { ...context, preview: true } });
}

/** @param {string} text */
function escape_html(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

export { escape_html, render_x_element, render_x_elements, x_elements };
