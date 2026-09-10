// @ts-check
// Sanitizes user pages on save (editor Worker) and again at serve time (sites Worker, defense in depth).
// Pages are the HTML dialect (docs/DESIGN.md §3): no scripts, no frames, no event handlers, no javascript: URLs.
// Custom <x-*> elements may only carry the attributes their registry entry declares (plus class/style/id/title/data-*).
import { x_elements } from "./x-elements/index.js";

const BLOCKED_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "form", "input", "button", "textarea", "select", "meta", "link", "noscript"]);
const ALLOWED_META = new Set(["charset", "viewport", "generator", "description", "author"]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "background", "usemap", "poster", "data", "xlink:href"]);
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data:text\/html|data:application)/i;
/** Attributes any element may carry, including <x-*> ones: how the page positions and labels it, not inputs to the renderer. */
const LAYOUT_ATTRIBUTES = /^(?:class|style|id|title|data-[a-z0-9-]+)$/;

/**
 * @param {string} html
 * @returns {Promise<string>}
 */
function sanitize_html(html) {
	const rewriter = new HTMLRewriter().on("*", {
		element(element) {
			const tag = element.tagName.toLowerCase();
			if (tag === "meta") {
				// Keep harmless <meta charset>/<meta name=viewport>; drop http-equiv and the rest.
				const name = (element.getAttribute("name") || "").toLowerCase();
				if (!(element.hasAttribute("charset") || ALLOWED_META.has(name))) {
					element.remove();
				}
				return;
			}
			if (tag === "link") {
				// Only same-site stylesheets and icons survive.
				const rel = (element.getAttribute("rel") || "").toLowerCase();
				const href = element.getAttribute("href") || "";
				if (!/^(stylesheet|icon|shortcut icon)$/.test(rel) || /^[a-z]+:|^\/\//i.test(href)) {
					element.remove();
				}
				return;
			}
			if (BLOCKED_TAGS.has(tag)) {
				element.remove();
				return;
			}
			const definition = tag.startsWith("x-") ? x_elements.get(tag) : null;
			for (const [name, value] of [...element.attributes]) {
				const lower = name.toLowerCase();
				if (lower.startsWith("on") || lower === "srcdoc" || lower === "formaction") {
					element.removeAttribute(name);
				} else if (URL_ATTRIBUTES.has(lower) && DANGEROUS_URL.test(value)) {
					element.removeAttribute(name);
				} else if (definition && !definition.attrs.includes(lower) && !LAYOUT_ATTRIBUTES.test(lower)) {
					element.removeAttribute(name);
				}
			}
			if (tag.startsWith("x-") && !definition) {
				// Unknown custom element: keep it (browsers treat it as an inert unknown element), attributes and all
				// were already filtered above for URL/handler risks.
			}
		},
		comments(comment) {
			// Conditional comments are an old IE script vector; plain comments are fine but not needed.
			if (/<!?\[|script/i.test(comment.text)) {
				comment.remove();
			}
		},
	});
	return rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
}

export { sanitize_html };
