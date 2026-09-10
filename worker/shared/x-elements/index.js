// @ts-check
// The <x-*> element registry — the site builder's plugin system (docs/DESIGN.md §3.5).
// Each entry declares its tag, the attributes it accepts, how the sites Worker renders it at serve time,
// and what the editor shows for it. Fallback content lives inside the tag in the page file and is what a
// browser shows when the page is served raw (an exported zip, another host).
import counter from "./counter.js";
import folder from "./folder.js";
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
 * @property {{ list_pages: (folder: string) => Promise<{ path: string, uploaded: number }[]>, page_title: (path: string) => Promise<string | null> }} files - read-only look at the site's pages
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
const x_elements = new Map([counter, updated, guestbook, music, folder].map((definition) => [definition.tag, definition]));

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

/** @param {string} text */
function escape_html(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

export { escape_html, render_x_elements, x_elements };
