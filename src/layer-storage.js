// @ts-check
// eslint-disable-next-line no-unused-vars
/* global current_history_node:writable, file_format:writable, file_name:writable, system_file_handle:writable */
// Autosave for the layers. JS Paint keeps a local backup of the bitmap (sessions.js: `image#<id>` in
// localStorage); stickers, text layers, and page elements live in a sidecar record, `layers#<id>`, so a
// reload brings them back too. The sidecar is in IndexedDB (sticker GIFs as Blobs): a page with a dozen
// GIFs is megabytes, which would blow localStorage's ~5 MB quota and take the bitmap's backup down with it.
// (Older sidecars in localStorage, with data URLs, are read once and moved over.)
// The sidecar is a convenience copy only — the document format is the page (collage-format.js).
import { restore_blocks, snapshot_blocks } from "./blocks.js";
import { $G } from "./helpers.js";
import { load_settings } from "./site-publish.js";
import { localStore } from "./storage.js";
import { get_sticker_source, register_sticker_source, restore_stickers, snapshot_stickers } from "./stickers.js";
import { restore_text_layers, snapshot_text_layers } from "./text-layers.js";

const DB_NAME = "jspaint-site-builder";
const STORE = "layers";

/** @type {Promise<IDBDatabase> | null} */
let db_promise = null;

/** @returns {Promise<IDBDatabase>} */
function open_db() {
	if (!db_promise) {
		db_promise = new Promise((resolve, reject) => {
			if (typeof indexedDB === "undefined") {
				reject(new Error("IndexedDB is unavailable"));
				return;
			}
			const request = indexedDB.open(DB_NAME, 1);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE)) {
					request.result.createObjectStore(STORE);
				}
			};
			request.onsuccess = () => { resolve(request.result); };
			request.onerror = () => { reject(request.error || new Error("Couldn't open IndexedDB")); };
			request.onblocked = () => { reject(new Error("IndexedDB is blocked")); };
		});
		db_promise.catch(() => { db_promise = null; });
	}
	return db_promise;
}

/**
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} operate
 * @returns {Promise<any>}
 */
async function with_store(mode, operate) {
	const db = await open_db();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE, mode);
		const request = operate(transaction.objectStore(STORE));
		request.onsuccess = () => { resolve(request.result); };
		request.onerror = () => { reject(request.error || new Error("IndexedDB request failed")); };
		transaction.onabort = () => { reject(transaction.error || new Error("IndexedDB transaction aborted")); };
	});
}

/** @param {string} session_id */
const sidecar_key = (session_id) => `layers#${session_id}`;

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

/**
 * Saves the current layers alongside the session's bitmap (or removes the sidecar when there are none).
 * @param {string} session_id
 * @param {(error?: Error) => void} [callback]
 */
async function save_layers_sidecar(session_id, callback = () => {}) {
	const stickers = snapshot_stickers();
	const text_layers = snapshot_text_layers();
	const blocks = snapshot_blocks();
	const key = sidecar_key(session_id);
	// Which page of which site this document is (so a reload can rejoin its live room and Save goes back there).
	const site_page = system_file_handle && typeof system_file_handle === "object" && typeof system_file_handle.site_page === "string" ? { site: load_settings().site, page: system_file_handle.site_page } : null;
	if (stickers.length === 0 && text_layers.length === 0 && blocks.length === 0 && !site_page) {
		remove_layers_sidecar(session_id);
		callback();
		return;
	}
	const sticker_records = [];
	for (const snapshot of stickers) {
		const source = get_sticker_source(snapshot.source_id);
		if (!source) { continue; }
		sticker_records.push({ ...snapshot, blob: source.blob });
	}
	try {
		await with_store("readwrite", (store) => store.put({ version: 3, saved: Date.now(), stickers: sticker_records, text_layers, blocks, site_page }, key));
		try {
			localStorage.removeItem(key); // an old data-URL sidecar, if any, is superseded
		} catch (_error) { /* ignore */ }
		callback();
	} catch (error) {
		// No IndexedDB (or it failed): fall back to localStorage with data URLs, as before.
		window.console?.warn("Layer autosave: IndexedDB failed, using localStorage:", error);
		try {
			const records = [];
			for (const record of sticker_records) {
				records.push({ ...record, blob: undefined, data_url: await blob_to_data_url(record.blob) });
			}
			localStore.set(key, JSON.stringify({ version: 2, stickers: records, text_layers, blocks, site_page }), (ls_error) => callback(ls_error));
		} catch (ls_error) {
			callback(ls_error);
		}
	}
}

/**
 * Restores layers saved by save_layers_sidecar, as part of the loaded state (not a history step).
 * @param {string} session_id
 * @returns {Promise<void>}
 */
async function restore_layers_sidecar(session_id) {
	const key = sidecar_key(session_id);
	/** @type {{ stickers?: any[], text_layers?: TextLayerSnapshot[], blocks?: BlockSnapshot[], site_page?: { site: string, page: string } | null } | null} */
	let data = null;
	try {
		data = await with_store("readonly", (store) => store.get(key));
	} catch (_error) { /* no IndexedDB */ }
	let from_local_storage = false;
	if (!data) {
		try {
			const json = localStorage.getItem(key);
			if (json) {
				data = JSON.parse(JSON.parse(json)); // localStore JSON-encodes the string it's given
				from_local_storage = true;
			}
		} catch (_error) {
			try {
				data = JSON.parse(localStorage.getItem(key) || "null");
				from_local_storage = !!data;
			} catch (_error2) { /* nothing usable */ }
		}
	}
	if (!data) { return; }
	try {
		/** @type {StickerSnapshot[]} */
		const sticker_snapshots = [];
		for (const record of data.stickers || []) {
			const blob = record.blob instanceof Blob ? record.blob : await (await fetch(record.data_url)).blob();
			const source = await register_sticker_source(blob);
			const snapshot = { ...record, source_id: source.id };
			delete snapshot.blob;
			delete snapshot.data_url;
			sticker_snapshots.push(snapshot);
		}
		restore_blocks(data.blocks || []);
		restore_stickers(sticker_snapshots);
		restore_text_layers(data.text_layers || []);
		current_history_node.blocks = snapshot_blocks();
		current_history_node.stickers = snapshot_stickers();
		current_history_node.text_layers = snapshot_text_layers();
		if (data.site_page && data.site_page.page && data.site_page.site === load_settings().site) {
			system_file_handle = { site_page: data.site_page.page };
			file_name = data.site_page.page;
			file_format = "text/html";
			$G.triggerHandler("site-page-restored", [{ page: data.site_page.page }]);
		}
		if (from_local_storage) {
			save_layers_sidecar(session_id); // move it to IndexedDB
		}
	} catch (error) {
		window.console?.warn("Couldn't restore layers from local storage:", error);
	}
}

/** @param {string} session_id */
function remove_layers_sidecar(session_id) {
	const key = sidecar_key(session_id);
	try {
		localStorage.removeItem(key);
	} catch (_error) { /* ignore */ }
	with_store("readwrite", (store) => store.delete(key)).catch(() => {});
}

export { remove_layers_sidecar, restore_layers_sidecar, save_layers_sidecar };
