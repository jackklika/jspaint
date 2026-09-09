// @ts-check
/* global localize, file_name, main_canvas, system_file_handle, systemHooks */
// Animated GIF export of a collage: the bitmap plus every sticker, with the stickers actually animating.
//
// Each sticker's GIF is decoded to frames (ImageDecoder, where the browser has it), the stickers' loops are
// laid on one timeline (least common multiple of their loop lengths, capped), and a frame is emitted whenever
// any sticker changes frame. Frames are composited on a canvas and encoded with gif.js (lib/gif.js).
import { $DialogWindow } from "./$ToolWindow.js";
import { sanity_check_blob, show_error_message } from "./functions.js";
import { E, make_canvas } from "./helpers.js";
import { GIF_EXPORT_MAX_DURATION_MS, GIF_EXPORT_MAX_FRAMES } from "./site-constants.js";
import { get_sticker_source, get_stickers } from "./stickers.js";

/**
 * @typedef {object} DecodedFrame
 * @property {HTMLCanvasElement} canvas
 * @property {number} duration - ms, already normalized the way browsers display GIFs
 */
/**
 * @typedef {object} DecodedGif
 * @property {DecodedFrame[]} frames
 * @property {number} loop_ms - total duration of one loop (0 for a single frame)
 */

/** Browsers show GIF frames with a delay under 20 ms at 100 ms; ImageDecoder reports the raw (often 0) value. */
const MIN_FRAME_MS = 20;
const DEFAULT_FRAME_MS = 100;
const MAX_FRAMES_PER_STICKER = 300;

/** @type {Map<string, Promise<DecodedGif>>} keyed by sticker source id */
const decode_cache = new Map();

/**
 * @param {Blob} blob
 * @returns {Promise<DecodedGif>}
 */
async function decode_gif(blob) {
	const ImageDecoderClass = /** @type {any} */ (window).ImageDecoder;
	if (!ImageDecoderClass) {
		// No WebCodecs: fall back to the first frame (static).
		const img = new Image();
		const url = URL.createObjectURL(blob);
		try {
			await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
			return { frames: [{ canvas: make_canvas(img), duration: 0 }], loop_ms: 0 };
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	const decoder = new ImageDecoderClass({ data: await blob.arrayBuffer(), type: "image/gif" });
	await decoder.tracks.ready;
	await decoder.completed;
	const frame_count = Math.min(decoder.tracks.selectedTrack.frameCount, MAX_FRAMES_PER_STICKER);
	/** @type {DecodedFrame[]} */
	const frames = [];
	for (let i = 0; i < frame_count; i++) {
		const { image } = await decoder.decode({ frameIndex: i });
		const canvas = make_canvas(image.displayWidth, image.displayHeight);
		canvas.ctx.drawImage(image, 0, 0);
		let duration = (image.duration || 0) / 1000;
		if (duration < MIN_FRAME_MS) { duration = DEFAULT_FRAME_MS; }
		image.close();
		frames.push({ canvas, duration: Math.round(duration) });
	}
	decoder.close();
	if (frames.length <= 1) {
		return { frames, loop_ms: 0 };
	}
	return { frames, loop_ms: frames.reduce((sum, frame) => sum + frame.duration, 0) };
}

/** @param {string} source_id */
function decode_sticker_source(source_id) {
	if (!decode_cache.has(source_id)) {
		const source = get_sticker_source(source_id);
		decode_cache.set(source_id, source ? decode_gif(source.blob) : Promise.reject(new Error("Missing sticker source")));
	}
	return decode_cache.get(source_id);
}

/** @param {number} a @param {number} b */
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
/** @param {number} a @param {number} b */
const lcm = (a, b) => (a && b ? (a * b) / gcd(a, b) : a || b);

/**
 * Times (ms) at which any sticker changes frame, within one common loop of all stickers.
 * @param {DecodedGif[]} gifs
 * @returns {{ times: number[], total_ms: number }}
 */
function build_timeline(gifs) {
	const loops = gifs.map((gif) => gif.loop_ms).filter((loop) => loop > 0);
	if (loops.length === 0) {
		return { times: [0], total_ms: 0 };
	}
	let total_ms = loops.reduce(lcm, 0);
	if (total_ms > GIF_EXPORT_MAX_DURATION_MS) {
		total_ms = GIF_EXPORT_MAX_DURATION_MS; // loops that don't divide evenly will jump at the wrap; acceptable
	}
	const times = new Set([0]);
	for (const gif of gifs) {
		if (!gif.loop_ms) { continue; }
		for (let base = 0; base < total_ms; base += gif.loop_ms) {
			let t = base;
			for (const frame of gif.frames) {
				if (t < total_ms) { times.add(t); }
				t += frame.duration;
			}
		}
	}
	let sorted = [...times].sort((a, b) => a - b);
	if (sorted.length > GIF_EXPORT_MAX_FRAMES) {
		// Too many distinct change points: sample on a fixed tick instead.
		const tick = Math.ceil(total_ms / GIF_EXPORT_MAX_FRAMES);
		sorted = [];
		for (let t = 0; t < total_ms; t += tick) { sorted.push(t); }
	}
	return { times: sorted, total_ms };
}

/**
 * @param {DecodedGif} gif
 * @param {number} t - ms
 */
function frame_at(gif, t) {
	if (!gif.loop_ms) {
		return gif.frames[0];
	}
	let remaining = t % gif.loop_ms;
	for (const frame of gif.frames) {
		if (remaining < frame.duration) { return frame; }
		remaining -= frame.duration;
	}
	return gif.frames[gif.frames.length - 1];
}

/**
 * Draws the bitmap and every sticker as of time t.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} t
 * @param {Map<string, DecodedGif>} decoded - by sticker source id
 */
function composite_frame(ctx, t, decoded) {
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	ctx.drawImage(main_canvas, 0, 0);
	for (const sticker of get_stickers()) {
		const gif = decoded.get(sticker.source_id);
		if (!gif || !gif.frames.length) { continue; }
		const frame = frame_at(gif, t);
		ctx.save();
		ctx.translate(sticker.x + sticker.width / 2, sticker.y + sticker.height / 2);
		ctx.scale(sticker.flip_x ? -1 : 1, sticker.flip_y ? -1 : 1);
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(frame.canvas, -sticker.width / 2, -sticker.height / 2, sticker.width, sticker.height);
		ctx.restore();
	}
}

/**
 * Renders the collage to an animated GIF blob.
 * @param {(progress: number) => void} [on_progress]
 * @param {{ aborted?: boolean }} [abort_signal]
 * @returns {Promise<Blob>}
 */
async function render_collage_gif(on_progress = () => {}, abort_signal = {}) {
	const width = main_canvas.width;
	const height = main_canvas.height;
	/** @type {Map<string, DecodedGif>} */
	const decoded = new Map();
	for (const sticker of get_stickers()) {
		if (!decoded.has(sticker.source_id)) {
			decoded.set(sticker.source_id, await decode_sticker_source(sticker.source_id));
		}
	}
	const { times, total_ms } = build_timeline([...decoded.values()]);
	const frame_canvas = make_canvas(width, height);
	return new Promise((resolve, reject) => {
		const gif = new GIF({
			workerScript: "lib/gif.js/gif.worker.js",
			width,
			height,
			repeat: 0, // loop forever
		});
		const abort_watch = setInterval(() => {
			if (abort_signal.aborted) {
				clearInterval(abort_watch);
				gif.abort();
				reject(new Error("Canceled"));
			}
		}, 200);
		gif.on("progress", on_progress);
		gif.on("finished", (/** @type {Blob} */ blob) => {
			clearInterval(abort_watch);
			resolve(blob);
		});
		gif.on("abort", () => { clearInterval(abort_watch); });
		for (let i = 0; i < times.length; i++) {
			composite_frame(frame_canvas.ctx, times[i], decoded);
			const next = i + 1 < times.length ? times[i + 1] : total_ms;
			const delay = total_ms ? Math.max(MIN_FRAME_MS, next - times[i]) : DEFAULT_FRAME_MS;
			gif.addFrame(frame_canvas, { delay, copy: true });
		}
		gif.render();
	});
}

/** File > Save as Animated GIF: renders with a progress window, then previews and offers to save. */
function export_collage_gif() {
	const $win = $DialogWindow();
	$win.title("Rendering Animated GIF");
	const $output = $win.$main;
	const $progress = $(E("progress")).appendTo($output).addClass("inset-deep");
	const $progress_percent = $(E("span")).appendTo($output).css({ width: "2.3em", display: "inline-block", textAlign: "center" });
	$win.$main.css({ padding: 5 });
	const abort_signal = { aborted: false };
	const $cancel = $win.$Button(localize("Cancel"), () => { $win.close(); }).focus();
	$win.on("close", () => { abort_signal.aborted = true; });
	$win.center();

	const width = main_canvas.width;
	const height = main_canvas.height;
	render_collage_gif((progress) => {
		$progress.val(progress);
		$progress_percent.text(`${~~(progress * 100)}%`);
	}, abort_signal).then((blob) => {
		abort_signal.aborted = false;
		$win.off("close");
		$win.title("Animated GIF");
		const blob_url = URL.createObjectURL(blob);
		$output.empty().append(
			$(E("div")).addClass("inset-deep").append(
				$(E("img")).attr({ src: blob_url, width, height }).css({ display: "block" }),
			).css({ overflow: "auto", maxHeight: "70vh", maxWidth: "70vw" }),
		);
		$win.on("close", () => { URL.revokeObjectURL(blob_url); });
		$win.$Button(localize("Save"), () => {
			$win.close();
			sanity_check_blob(blob, () => {
				const suggested_file_name = `${file_name.replace(/\.(bmp|dib|a?png|gif|jpe?g|jpe|jfif|tiff?|webp|raw|html?)$/i, "")}.gif`;
				systemHooks.showSaveFileDialog({
					dialogTitle: localize("Save As"),
					getBlob: () => Promise.resolve(blob),
					defaultFileName: suggested_file_name,
					defaultPath: typeof system_file_handle === "string" ? `${system_file_handle.replace(/[/\\][^/\\]*$/, "")}/${suggested_file_name}` : null,
					defaultFileFormatID: "image/gif",
					formats: [{
						formatID: "image/gif",
						mimeType: "image/gif",
						name: localize("Animated GIF (*.gif)").replace(/\s+\([^(]+$/, ""),
						nameWithExtensions: localize("Animated GIF (*.gif)"),
						extensions: ["gif"],
					}],
				});
			});
		}).focus();
		$cancel.appendTo($win.$buttons);
		$win.center();
	}, (error) => {
		$win.close();
		if (error.message !== "Canceled") {
			show_error_message("Failed to render the animated GIF.", error);
		}
	});
}

export { build_timeline, decode_gif, export_collage_gif, render_collage_gif };
