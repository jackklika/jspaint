// @ts-check
/* global current_history_node:writable */
// Autosave for the layers. JS Paint keeps a local backup of the bitmap (sessions.js: `image#<id>`);
// stickers and text layers live in a sidecar entry, `layers#<id>`, so a reload brings them back too.
// The sidecar is a convenience copy only — the document format is the collage web page (collage-format.js).
import { localStore } from "./storage.js";
import { get_sticker_source, register_sticker_source, restore_stickers, snapshot_stickers } from "./stickers.js";
import { restore_text_layers, snapshot_text_layers } from "./text-layers.js";

/** @type {Map<string, Promise<string>>} data URLs by sticker source id, so autosaves don't re-encode GIFs */
const data_url_cache = new Map();

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blob_to_data_url(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => { resolve(/** @type {string} */(reader.result)); };
		reader.onerror = () => { reject(reader.error); };
		reader.readAsDataURL(blob);
	});
}

/** @param {string} session_id */
const sidecar_key = (session_id) => `layers#${session_id}`;

/**
 * Saves the current layers alongside the session's bitmap (or removes the sidecar when there are none).
 * @param {string} session_id
 * @param {(error?: Error) => void} [callback]
 */
async function save_layers_sidecar(session_id, callback = () => {}) {
	const stickers = snapshot_stickers();
	const text_layers = snapshot_text_layers();
	if (stickers.length === 0 && text_layers.length === 0) {
		try {
			localStorage.removeItem(sidecar_key(session_id));
		} catch (_error) { /* ignore */ }
		callback();
		return;
	}
	try {
		const sticker_records = [];
		for (const snapshot of stickers) {
			const source = get_sticker_source(snapshot.source_id);
			if (!source) { continue; }
			if (!data_url_cache.has(source.id)) {
				data_url_cache.set(source.id, blob_to_data_url(source.blob));
			}
			sticker_records.push({ ...snapshot, data_url: await data_url_cache.get(source.id) });
		}
		const json = JSON.stringify({ version: 1, stickers: sticker_records, text_layers });
		localStore.set(sidecar_key(session_id), json, (error) => callback(error));
	} catch (error) {
		callback(error);
	}
}

/**
 * Restores layers saved by save_layers_sidecar, as part of the loaded state (not as a history step).
 * @param {string} session_id
 * @returns {Promise<void>}
 */
function restore_layers_sidecar(session_id) {
	return new Promise((resolve) => {
		localStore.get(sidecar_key(session_id), async (error, json) => {
			if (error || !json) {
				resolve();
				return;
			}
			try {
				const data = JSON.parse(json);
				/** @type {StickerSnapshot[]} */
				const sticker_snapshots = [];
				for (const record of data.stickers || []) {
					const blob = await (await fetch(record.data_url)).blob();
					const source = await register_sticker_source(blob);
					data_url_cache.set(source.id, Promise.resolve(record.data_url));
					const snapshot = { ...record, source_id: source.id };
					delete snapshot.data_url;
					sticker_snapshots.push(snapshot);
				}
				restore_stickers(sticker_snapshots);
				restore_text_layers(data.text_layers || []);
				current_history_node.stickers = snapshot_stickers();
				current_history_node.text_layers = snapshot_text_layers();
			} catch (error) {
				window.console?.warn("Couldn't restore layers from local storage:", error);
			}
			resolve();
		});
	});
}

/** @param {string} session_id */
function remove_layers_sidecar(session_id) {
	try {
		localStorage.removeItem(sidecar_key(session_id));
	} catch (_error) { /* ignore */ }
}

export { remove_layers_sidecar, restore_layers_sidecar, save_layers_sidecar };
