// @ts-check
// Link previews. Messaging apps show a card for a link from the page's <meta property="og:…"> tags, so a share link
// (/?join=<site>/<page>/<key>) is answered by the editor Worker with tags pointing at previews/<page>.png on the
// site: a 1200×630 card of the page as it is right now. Paint renders and uploads that card when a link is made,
// when the page is saved, and every so often while people draw (share.js), so the preview keeps up with the picture.
// The same still, small, is the page's thumbnail (thumbs/<page>.png): what My Site › Pages and the admin's page show,
// so a tile looks like the page — its elements and GIFs too, not just the paint underneath (Jack, 2026-09-15).
import { render_collage_frame } from "./gif-export.js";
import { make_canvas } from "./helpers.js";
import { get_page_properties } from "./page-properties.js";

const PREVIEW_WIDTH = 1200;
const PREVIEW_HEIGHT = 630;
const THUMB_WIDTH = 320;

/** The site path of a page's preview card. @param {string} page */
function preview_path(page) {
	return `previews/${page.replace(/\.html?$/i, "") || "index"}.png`;
}

/** The site path of a page's thumbnail. @param {string} page */
function thumb_path(page) {
	return `thumbs/${page.replace(/\.html?$/i, "") || "index"}.png`;
}

/**
 * Renders the card: the page scaled to the card's width and top-aligned (a tall page is cropped at the bottom),
 * on the page's background color. Pixel art stays crisp.
 * @param {HTMLCanvasElement} [frame] - the page's still, when the caller already has one (render_collage_frame)
 * @returns {Promise<Blob>} PNG
 */
async function render_share_preview(frame) {
	frame ??= await render_collage_frame();
	const card = make_canvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
	const ctx = card.ctx;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
	const bgcolor = get_page_properties().bgcolor;
	if (bgcolor) {
		ctx.fillStyle = bgcolor; // an invalid color is ignored by the canvas, leaving white
		ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
	}
	const scale = PREVIEW_WIDTH / Math.max(1, frame.width);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(frame, 0, 0, frame.width * scale, frame.height * scale);
	return to_png(card);
}

/**
 * Renders the thumbnail: the whole page, THUMB_WIDTH wide, on its background color, smoothed (it's a fifth the size,
 * so text stays readable as shapes rather than breaking into stray pixels).
 * @param {HTMLCanvasElement} [frame]
 * @returns {Promise<Blob>} PNG
 */
async function render_page_thumbnail(frame) {
	frame ??= await render_collage_frame();
	const scale = THUMB_WIDTH / Math.max(1, frame.width);
	const thumb = make_canvas(THUMB_WIDTH, Math.max(1, Math.round(frame.height * scale)));
	const ctx = thumb.ctx;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, thumb.width, thumb.height);
	const bgcolor = get_page_properties().bgcolor;
	if (bgcolor) {
		ctx.fillStyle = bgcolor;
		ctx.fillRect(0, 0, thumb.width, thumb.height);
	}
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(frame, 0, 0, thumb.width, thumb.height);
	return to_png(thumb);
}

/** @param {HTMLCanvasElement} canvas @returns {Promise<Blob>} */
function to_png(canvas) {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't render the picture"))), "image/png");
	});
}

export { PREVIEW_HEIGHT, PREVIEW_WIDTH, THUMB_WIDTH, preview_path, render_collage_frame, render_page_thumbnail, render_share_preview, thumb_path };
