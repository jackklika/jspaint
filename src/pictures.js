// @ts-check
/* global $status_text, localize */
// Pictures: photos and GIFs on the site. A picture put into a section's text or on the page as a sticker is kept on
// the site right away (signed in), so a reload and everyone in the live room see it; signed out, it's inlined as a
// data: URL until the page is saved. A big photo gets a page-size copy (≤1200px) and a thumbnail (≤240px): the page
// shows the copy and links to the full-size original. The Pictures window (the toolbox's Pictures tool) browses the
// site's pictures and uploads new ones.
import { $DialogWindow } from "./$ToolWindow.js";
import { escape_html } from "./block-kinds.js";
import { get_editing_block, insert_node_at_caret, is_editing_container } from "./blocks.js";
import { E } from "./helpers.js";
import { list_files, public_url, upload_asset, write_file } from "./my-site.js";
import { get_site_files_base, is_signed_in } from "./site-publish.js";
import { add_sticker_from_blob } from "./stickers.js";
import { active_gallery, insert_card, register_card_kind } from "./cards.js";

const DISPLAY_MAX = 1200; // the copy the page shows
const THUMB_MAX = 240; // the copy the Pictures window shows
/** @type {Record<string, string>} */
const IMAGE_EXT = { "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * @typedef {object} SitePicture - one picture on the site (an original, and its smaller copies if it's a big photo)
 * @property {string} path - gifs/<hash>.<ext>, the full-size original
 * @property {string | null} display_path - gifs/<hash>.w1200.<ext>, the page-size copy (null: the original is small enough)
 * @property {string | null} thumb_path - gifs/<hash>.w240.<ext>
 * @property {number} size - bytes of the original
 * @property {string} uploaded
 */

/** @param {Blob} blob */
function blob_to_data_url(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => { resolve(String(reader.result)); };
		reader.onerror = () => { reject(reader.error); };
		reader.readAsDataURL(blob);
	});
}

/** Image type from the bytes (fetched pictures often say application/octet-stream). @param {Blob} blob */
async function image_type(blob) {
	const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) { return "image/gif"; }
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { return "image/png"; }
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { return "image/jpeg"; }
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) { return "image/webp"; }
	return IMAGE_EXT[blob.type] ? blob.type : "";
}

/**
 * A smaller copy of a photo, if it's bigger than `max` on a side: JPEG, or PNG when the source is PNG (transparency).
 * GIFs are never copied (the animation would be lost).
 * @param {ImageBitmap} bitmap @param {string} type - the source's type @param {number} max
 * @returns {Promise<Blob | null>}
 */
function scaled_copy(bitmap, type, max) {
	const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
	if (scale >= 1) { return Promise.resolve(null); }
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	const copy_type = type === "image/png" ? "image/png" : "image/jpeg";
	return new Promise((resolve) => { canvas.toBlob(resolve, copy_type, 0.85); });
}

/**
 * Puts a picture on the site: the original (gifs/<hash>.<ext>), and for a big photo a page-size copy and a thumbnail.
 * @param {Blob} blob
 * @returns {Promise<SitePicture>}
 */
async function upload_picture(blob) {
	const type = await image_type(blob);
	if (!type) { throw new Error(localize("Only GIF, PNG, JPEG, and WebP pictures can go on the site.")); }
	const file = new File([blob], `picture.${IMAGE_EXT[type]}`, { type });
	const path = await upload_asset(file);
	const picture = { path, display_path: null, thumb_path: null, size: blob.size, uploaded: new Date().toISOString() };
	if (type === "image/gif") { return picture; }
	let bitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch (_error) {
		return picture; // undecodable here: the original still went up
	}
	try {
		const base = path.replace(/\.[a-z0-9]+$/i, "");
		const display = await scaled_copy(bitmap, type, DISPLAY_MAX);
		if (display) {
			picture.display_path = `${base}.w${DISPLAY_MAX}.${IMAGE_EXT[display.type]}`;
			await write_file(picture.display_path, display, display.type);
		}
		const thumb = await scaled_copy(bitmap, type, THUMB_MAX);
		if (thumb) {
			picture.thumb_path = `${base}.w${THUMB_MAX}.${IMAGE_EXT[thumb.type]}`;
			await write_file(picture.thumb_path, thumb, thumb.type);
		}
	} finally {
		bitmap.close();
	}
	return picture;
}

/**
 * The site's pictures, from its listing: originals under gifs/, with their .w1200/.w240 copies attached. Newest first.
 * @param {{ path: string, size: number, uploaded: string }[]} files
 * @returns {SitePicture[]}
 */
function site_pictures(files) {
	/** @type {Map<string, SitePicture>} */
	const by_base = new Map();
	for (const file of files) {
		const match = /^(gifs\/[A-Za-z0-9_-]+)\.(gif|png|jpe?g|webp)$/i.exec(file.path);
		if (match) { by_base.set(match[1], { path: file.path, display_path: null, thumb_path: null, size: file.size, uploaded: file.uploaded }); }
	}
	for (const file of files) {
		const match = /^(gifs\/[A-Za-z0-9_-]+)\.w(\d+)\.(png|jpg)$/i.exec(file.path);
		const picture = match && by_base.get(match[1]);
		if (!picture) { continue; }
		if (Number(match[2]) === DISPLAY_MAX) { picture.display_path = file.path; }
		if (Number(match[2]) === THUMB_MAX) { picture.thumb_path = file.path; }
	}
	return [...by_base.values()].sort((a, b) => Date.parse(b.uploaded) - Date.parse(a.uploaded));
}

/**
 * The markup for a picture in a section's text: the page-size copy, linking to the full-size original when there is
 * one. Addresses are the site's public ones, so the page works from any folder, in a copy on another site, and for
 * everyone in the live room.
 * @param {SitePicture} picture
 */
function picture_html(picture) {
	const img = `<img src="${escape_html(public_url(picture.display_path || picture.path))}" alt="">`;
	return picture.display_path ? `<a href="${escape_html(public_url(picture.path))}">${img}</a>` : img;
}

/** The picture's markup into the text at the caret, as nodes. @param {string} html */
function insert_picture_html(html) {
	const template = document.createElement("template");
	template.innerHTML = html;
	insert_node_at_caret(template.content);
}

/**
 * Puts a picture from the site on the page: into the text at the caret while a section is being written, else as a
 * sticker (a big photo's sticker shows the page-size copy and links to the full-size original).
 * @param {SitePicture} picture
 * @param {{ x?: number, y?: number }} [position]
 */
async function place_site_picture(picture, position) {
	if (is_editing_container() && !position) {
		const gallery = active_gallery();
		if (gallery) {
			// The gallery card that's selected takes it (the Pictures window stays open for the next one)
			const pictures = gallery.querySelector(".gallery-pictures") || gallery;
			pictures.insertAdjacentHTML("beforeend", `<a href="${escape_html(public_url(picture.path))}">${`<img src="${escape_html(public_url(picture.display_path || picture.path))}" alt="">`}</a>`);
			get_editing_block_for(gallery)?.record_edit();
			return;
		}
		if (picture_card_wanted) {
			picture_card_wanted = false;
			insert_card(element_from(`<figure class="card picture" data-card="picture">${picture_html(picture)}<figcaption class="card-text">${localize("A caption")}</figcaption></figure>`));
			return;
		}
		insert_picture_html(picture_html(picture));
		return;
	}
	const path = picture.display_path || picture.path;
	const blob = await (await fetch(`${get_site_files_base()}${path}`)).blob();
	await add_sticker_from_blob(blob, { ...position, path, href: picture.display_path ? public_url(picture.path) : "" });
}

/**
 * A picture arrives (the GIF picker, a file, a drop) while a section is being written: into the text at the caret.
 * Signed in, it goes on the site first (a reload and the live room can show it); otherwise it's inlined as a data:
 * URL, which the page keeps until it's saved to a site.
 * @param {Blob} blob
 */
async function insert_picture_blob(blob) {
	if (is_signed_in()) {
		$status_text.text(localize("Putting the picture on your site…"));
		try {
			const picture = await upload_picture(blob);
			insert_picture_html(picture_html(picture));
			$status_text.default();
			return;
		} catch (error) {
			$status_text.text(`${localize("Couldn't put the picture on your site:")} ${error.message}`);
		}
	}
	insert_picture_html(`<img src="${await blob_to_data_url(blob)}" alt="">`);
}

/**
 * A picture file from the user (Upload… in the Pictures window, or the file dialog): onto the page, by way of the site
 * when signed in (so a big photo gets its page-size copy).
 * @param {File} file
 * @param {{ x?: number, y?: number }} [position]
 */
async function add_picture_file(file, position) {
	if (is_signed_in()) {
		$status_text.text(localize("Putting %1 on your site…", file.name));
		try {
			const picture = await upload_picture(file);
			await place_site_picture(picture, position);
			$status_text.default();
			return;
		} catch (error) {
			$status_text.text(`${localize("Couldn't put the picture on your site:")} ${error.message}`);
		}
	}
	if (is_editing_container() && !position) {
		await insert_picture_blob(file);
	} else {
		await add_sticker_from_blob(file, position);
	}
}

/** @type {boolean} the next picture picked while writing becomes a Picture card (a caption, a width) — the "/picture" item */
let picture_card_wanted = false;
/** @param {string} html */
function element_from(html) {
	const template = document.createElement("template");
	template.innerHTML = html;
	return /** @type {HTMLElement} */ (template.content.firstElementChild);
}
/** @param {Element} el */
function get_editing_block_for(el) {
	const block = get_editing_block();
	return block && block.el.contains(el) ? block : null;
}
register_card_kind({
	id: "picture",
	label: localize("Picture"),
	group: "cards",
	keywords: ["photo", "image", "figure"],
	hint: localize("with a caption"),
	icon: '<rect x="1" y="3" width="14" height="10" fill="#fff" stroke="#000"/><path d="M2 12l3-4 2 2 2-3 4 5z" fill="#808080"/><circle cx="11" cy="6" r="1.5" fill="#000080"/>',
	action: () => { picture_card_wanted = true; show_pictures_window(); $status_text.text(localize("Pick a picture (or Upload…): it goes in with a caption.")); },
});
register_card_kind({
	id: "gallery",
	label: localize("Gallery"),
	group: "cards",
	keywords: ["photos", "grid", "album"],
	hint: localize("pick pictures"),
	icon: '<rect x="1" y="2" width="6" height="5" fill="#fff" stroke="#000"/><rect x="9" y="2" width="6" height="5" fill="#fff" stroke="#000"/><rect x="1" y="9" width="6" height="5" fill="#fff" stroke="#000"/><rect x="9" y="9" width="6" height="5" fill="#fff" stroke="#000"/><path d="M2 6l2-2 1 1 1-2 1 3z" fill="#808080"/>',
	action: () => {
		if (insert_card(element_from(`<figure class="card gallery" data-card="gallery" data-width="wide"><div class="gallery-pictures"></div><figcaption class="card-text">${localize("A few pictures")}</figcaption></figure>`))) {
			show_pictures_window();
			$status_text.text(localize("Click pictures to add them to the gallery (the gallery stays selected while you do)."));
		}
	},
});

// ---- the Pictures window ----

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $pictures = null;
/** @type {(() => void) | null} */
let refresh_pictures = null;

/** The toolbox's Pictures tool: the site's pictures as tiles (click one to put it on the page), and Upload…. */
function show_pictures_window() {
	if ($pictures) {
		$pictures.bringToFront();
		refresh_pictures?.();
		return;
	}
	const $w = $pictures = $DialogWindow(localize("Pictures"));
	$w.addClass("pictures-window squish");
	const $main = $w.$main;
	const $bar = $(E("div")).addClass("pictures-bar").appendTo($main);
	const $upload = $(E("button")).attr({ type: "button" }).text(localize("Upload…")).appendTo($bar);
	const $status = $(E("span")).addClass("pictures-status").appendTo($bar);
	const $input = $(E("input")).attr({ type: "file", multiple: "multiple", accept: "image/gif,image/png,image/jpeg,image/webp" }).hide().appendTo($main);
	const $grid = $(E("div")).addClass("pictures-grid inset-deep").attr({ role: "listbox", "aria-label": localize("Pictures") }).appendTo($main);
	$(E("p")).addClass("my-site-note pictures-note").text(localize("Click a picture to put it on the page: into the text while you're writing a section, otherwise as a sticker. A big photo is shown at page size and opens full-size when clicked.")).appendTo($main);
	$upload.on("click", () => { $input.trigger("click"); });
	$input.on("change", async () => {
		const files = [...(/** @type {HTMLInputElement} */ ($input[0]).files || [])];
		$input.val("");
		for (const file of files) {
			$status.text(localize("Putting %1 on the page…", file.name));
			try {
				await add_picture_file(file);
			} catch (error) {
				$status.text(`${localize("Couldn't add %1:", file.name)} ${error.message}`);
				return;
			}
		}
		$status.text("");
		refresh();
	});
	const refresh = async () => {
		$grid.empty();
		if (!is_signed_in()) {
			$(E("div")).addClass("my-site-empty pictures-empty").text(localize("Sign in to My Site to keep pictures on your site. Upload… still puts a picture on this page.")).appendTo($grid);
			return;
		}
		$status.text(localize("Loading…"));
		try {
			const pictures = site_pictures((await list_files()).files);
			if ($w.closed) { return; }
			$grid.empty();
			if (pictures.length === 0) {
				$(E("div")).addClass("my-site-empty pictures-empty").text(localize("No pictures on your site yet. Upload… puts one up, and GIFs from the GIF picker land here too.")).appendTo($grid);
			}
			for (const picture of pictures) {
				const $tile = $(E("button")).addClass("picture-tile").attr({ type: "button", "data-path": picture.path, title: `${picture.path.replace(/^gifs\//, "")} · ${Math.max(1, Math.round(picture.size / 1024))} KB${picture.display_path ? ` · ${localize("shown at page size, links to the full-size photo")}` : ""}` }).appendTo($grid);
				$(E("img")).attr({ src: public_url(picture.thumb_path || picture.display_path || picture.path), alt: "", loading: "lazy", draggable: "false" }).appendTo($tile);
				if (picture.display_path) { $(E("span")).addClass("picture-badge").text(localize("photo")).appendTo($tile); }
				$tile.on("click", async () => {
					try {
						await place_site_picture(picture);
					} catch (error) {
						$status.text(`${localize("Couldn't add the picture:")} ${error.message}`);
					}
				});
			}
			$status.text(pictures.length ? `${pictures.length} ${pictures.length === 1 ? localize("picture") : localize("pictures")}` : "");
		} catch (error) {
			$status.text(`${localize("Couldn't list your pictures:")} ${error.message}`);
		}
	};
	refresh_pictures = refresh;
	$w.$Button(localize("Close"), () => { $w.close(); });
	$w.on("close", () => { $pictures = null; refresh_pictures = null; });
	$w.$content.css({ width: "min(520px, 92vw)" });
	$w.center();
	refresh();
}

$("<style>").text(`
	.pictures-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}
	.pictures-status {
		font-size: 11px;
		opacity: 0.8;
	}
	.pictures-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-content: flex-start;
		height: 260px;
		overflow: auto;
		padding: 6px;
		background: var(--Window, #fff);
		color: var(--WindowText, #222);
	}
	.picture-tile {
		position: relative;
		width: 88px;
		height: 72px;
		padding: 2px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: #fff;
	}
	.picture-tile img {
		max-width: 100%;
		max-height: 100%;
		pointer-events: none;
	}
	.picture-badge {
		position: absolute;
		right: 3px;
		bottom: 3px;
		font-size: 9px;
		padding: 0 3px;
		background: var(--Hilight, #000080);
		color: var(--HilightText, #fff);
	}
	.pictures-empty {
		width: 100%;
	}
	.pictures-note {
		max-width: none;
		margin: 6px 0 0;
	}
`).appendTo(document.head);

export { add_picture_file, insert_picture_blob, picture_html, place_site_picture, show_pictures_window, site_pictures, upload_picture };
