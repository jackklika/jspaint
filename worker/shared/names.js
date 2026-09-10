// @ts-check
// Validation shared by both Workers: site names (~jack), file paths inside a site, and content types.

/** A site name is a tilde name: lowercase letters, digits, hyphens; 1–32 chars; no leading/trailing hyphen. */
const SITE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A path inside a site: segments of safe characters, no dot-segments, ≤ 200 chars. */
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const CONTENT_TYPES = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	png: "image/png",
	gif: "image/gif",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	ico: "image/x-icon",
	mp3: "audio/mpeg",
	mid: "audio/midi",
	midi: "audio/midi",
	wav: "audio/wav",
	ogg: "audio/ogg",
	json: "application/json; charset=utf-8", // only site.json (the site's settings); the editor Worker refuses other .json files
};

/** Files a site may contain, by extension. Anything else is refused at upload. */
const ALLOWED_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));

/** @param {string} name */
function valid_site_name(name) {
	return SITE_NAME.test(name);
}

/** @param {string} path - without a leading slash */
function valid_path(path) {
	if (!path || path.length > 200) { return false; }
	const segments = path.split("/");
	return segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..") && ALLOWED_EXTENSIONS.has(extension_of(path));
}

/** @param {string} path */
function extension_of(path) {
	const match = /\.([A-Za-z0-9]+)$/.exec(path);
	return match ? match[1].toLowerCase() : "";
}

/** @param {string} path */
function content_type_for(path) {
	return CONTENT_TYPES[extension_of(path)] || "application/octet-stream";
}

/** @param {string} path */
function is_html_path(path) {
	return /^html?$/.test(extension_of(path));
}

/**
 * MIME type by magic number, for validating uploads.
 * @param {Uint8Array} head
 */
function sniff_type(head) {
	if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) { return "image/gif"; }
	if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E) { return "image/png"; }
	if (head[0] === 0xFF && head[1] === 0xD8) { return "image/jpeg"; }
	if (head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42) { return "image/webp"; }
	if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) { return "image/x-icon"; }
	if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { return "audio/mpeg"; } // ID3
	if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) { return "audio/mpeg"; } // MPEG frame sync
	if (head[0] === 0x4D && head[1] === 0x54 && head[2] === 0x68 && head[3] === 0x64) { return "audio/midi"; }
	if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) { return "audio/wav"; }
	if (head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) { return "audio/ogg"; }
	return null;
}

/** The site served at the domain root (coolpaint.world/): its files are sites/root/…, and it has no /~root/ prefix. */
const ROOT_SITE = "root";

/** URL path prefix of a site's pages on the sites origin: "" for the root site, "/~name" otherwise. @param {string} site */
function site_base(site) {
	return site === ROOT_SITE ? "" : `/~${site}`;
}

/** A site's home path: "/" for the root site, "/~name/" otherwise. @param {string} site */
function site_home(site) {
	return `${site_base(site)}/`;
}

export { ALLOWED_EXTENSIONS, ROOT_SITE, content_type_for, extension_of, is_html_path, site_base, site_home, sniff_type, valid_path, valid_site_name };
