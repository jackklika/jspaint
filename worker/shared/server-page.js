// @ts-check
// The server's own pages — a 404, a takedown, a report form, an outage — in one web-1.0 style: the error page IIS
// answered with in 2000 (Jack, 2026-09-15: "there should be no black-and-green thing. it should all be web 1.0").
// A white page in the browser's own serif, "HTTP Error 404" as the heading, "404 Not Found" under it, and plain
// paragraphs. Both Workers use it; each adds its own headers.

/** Reasons the way a server of the time named them. @type {Record<number, string>} */
const REASONS = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 451: "Unavailable For Legal Reasons", 500: "Internal Server Error", 503: "Service Unavailable" };

/** @param {string} text */
function escape_html(text) {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

/**
 * The page's HTML.
 * @param {object} options
 * @param {string} options.title - the window's title
 * @param {string} options.heading - the big serif heading ("HTTP Error 404")
 * @param {string} [options.subheading] - the bold line under it ("404 Not Found")
 * @param {string} options.body - the paragraphs, as HTML (already escaped where it came from a visitor)
 */
function server_page_html({ title, heading, subheading = "", body }) {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape_html(title)}</title></head>
<body bgcolor="#ffffff" text="#000000" link="#0000ee" vlink="#551a8b" style="font-family:'Times New Roman',Times,serif;margin:8px">
<h1>${escape_html(heading)}</h1>
${subheading ? `<h2>${escape_html(subheading)}</h2>\n` : ""}${body}
</body></html>`;
}

/**
 * An error page for a status: "HTTP Error 404" / "404 Not Found" and the paragraphs.
 * @param {number} status @param {string} body - paragraphs as HTML
 * @param {string} [title]
 */
function error_page_html(status, body, title = `Error ${status}`) {
	const reason = REASONS[status] || "Error";
	return server_page_html({ title, heading: `HTTP Error ${status}`, subheading: `${status} ${reason}`, body });
}

export { error_page_html, escape_html as escape_page_html, server_page_html };
