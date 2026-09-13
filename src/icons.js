// @ts-check
// Pixel icons drawn as text: each row is 16 characters, "#" a black pixel, "o" a navy one, "." nothing —
// 16×16, crisp, in the Win98 palette, like the toolbox's page-tool icons (page-tools.js). Shared where the same
// glyph appears in more than one place (the Link tool and the Font toolbar's link button).

/**
 * @param {string[]} rows - 16 rows of 16 characters
 * @param {Record<string, string>} [palette] - character → fill
 * @returns {string} an SVG document
 */
function pixel_svg(rows, palette = { "#": "#000000", o: "#000080" }) {
	const rects = rows.map((row, y) => [...row].map((c, x) => palette[c] ? `<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[c]}"/>` : "").join("")).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>`;
}

/** Two links of a chain, interlocked: a link. */
const LINK_ICON_SVG = pixel_svg([
	"................",
	"................",
	"................",
	"..######........",
	".#oooooo#.......",
	".#o....o#.......",
	".#o....o#.......",
	".#oooooo######..",
	"..######oooooo#.",
	".......#o....o#.",
	".......#o....o#.",
	".......#oooooo#.",
	"........######..",
	"................",
	"................",
	"................",
]);

export { LINK_ICON_SVG, pixel_svg };
