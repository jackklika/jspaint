// @ts-check
// eslint-disable-next-line no-unused-vars
/* global saved:writable */
/* global $canvas, $canvas_area, $status_area, localize, magnification, main_canvas, main_ctx, root_history_node, selected_tool, system_file_handle, transparency */
// Live sync: while you edit a page of your site, Paint is connected to that page's room — a Durable Object on
// the editor Worker (worker/editor/page-room.js) that holds the live draft and relays changes to everyone
// editing the same page. Local changes are found by diffing the document after each history change: the
// bitmap's dirty rectangle goes out as a PNG patch, elements go out as per-id set/remove/order operations.
// Remote changes are applied in place — and to every node of the undo tree, so undoing your own work never
// erases someone else's. Presence (cursors, who's editing which text) is relayed but not stored. Publishing
// (Save to My Site) remains explicit; the room is the shared draft, so the page looks the same wherever you sign in.
import { get_editing_block, get_selected_block, order_blocks, remove_block_by_id, set_remote_editor_lookup, snapshot_blocks, upsert_block_from_snapshot } from "./blocks.js";
import { resize_canvas_without_saving_dimensions, update_helper_layer, update_title } from "./functions.js";
import { $G, E, make_canvas, to_canvas_coords } from "./helpers.js";
import { upload_asset } from "./my-site.js";
import { get_page_properties, set_page_properties } from "./page-properties.js";
import { get_site_editor_url, get_site_files_base, is_signed_in, load_settings } from "./site-publish.js";
import { get_selected_sticker, get_sticker_source, order_stickers, register_sticker_source, remove_sticker_by_id, snapshot_stickers, upsert_sticker_from_snapshot } from "./stickers.js";
import { get_selected_text_layer, order_text_layers, remove_text_layer_by_id, snapshot_text_layers, upsert_text_layer_from_snapshot } from "./text-layers.js";

const ENABLED_KEY = "jspaint live sync";
const NAME_KEY = "jspaint live name";
const CLIENT_ID_KEY = "jspaint live client id";
const SYNC_DELAY_MS = 60;
const PRESENCE_INTERVAL_MS = 80;
const BAND_PIXELS = 90000; // rows per full-picture band = this / width (keeps each PNG message well under 1 MiB)
const COLORS = ["#e6194b", "#3cb44b", "#0082c8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#d2f53c", "#008080", "#aa6e28", "#800000", "#808000", "#000080"];
const KINDS = /** @type {const} */ (["blocks", "stickers", "text_layers"]);

/** @typedef {typeof KINDS[number]} LayerKind */
/** @typedef {{ kind: LayerKind, op: "set", item: any } | { kind: LayerKind, op: "remove", id: string } | { kind: LayerKind, op: "order", ids: string[] }} LiveOp */
/** @typedef {{ client_id: string, name: string, color: string, cursor?: { x: number, y: number } | null, tool?: string | null, selected?: string | null, editing?: string | null, $cursor?: JQuery<HTMLElement> }} RemoteClient */

/** @type {WebSocket | null} */
let socket = null;
/** @type {{ site: string, page: string, authoritative: boolean } | null} */
let room = null;
let connected = false;
let version = 0;
let retry_count = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let retry_timer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let sync_timer = null;
let syncing = false;
let applying_remote = false;
let full_picture_in_flight = false;
/** @type {Promise<void>} remote bitmap patches apply strictly in order */
let remote_queue = Promise.resolve();
/** What the room knows of our document (wire form), to diff against. */
/** @type {{ width: number, height: number, pixels: Uint8ClampedArray | null, layers: Record<LayerKind, Map<string, string>>, order: Record<LayerKind, string>, props: string } | null} */
let last = null;
/** @type {Map<string, string>} sticker source id → site path */
const source_paths = new Map();
/** @type {Map<string, string>} site path → sticker source id */
const sources_by_path = new Map();
/** @type {Map<string, RemoteClient>} */
const remote_clients = new Map();
/** @type {{ x: number, y: number } | null} */
let my_cursor = null;
let presence_timer = 0;
let presence_dirty = false;
/** @type {JQuery<HTMLElement> | null} */
let $indicator = null;

// ---- settings ----

function is_live_sync_enabled() {
	try {
		return localStorage.getItem(ENABLED_KEY) !== "false";
	} catch (_error) {
		return true;
	}
}
/** @param {boolean} on */
function set_live_sync_enabled(on) {
	try {
		localStorage.setItem(ENABLED_KEY, String(on));
	} catch (_error) { /* ignore */ }
	if (on) {
		join_current_page();
	} else {
		leave_page_room(localize("Live sync is off."));
	}
}
function client_id() {
	try {
		let id = sessionStorage.getItem(CLIENT_ID_KEY);
		if (!id) {
			id = Math.random().toString(36).slice(2, 10);
			sessionStorage.setItem(CLIENT_ID_KEY, id);
		}
		return id;
	} catch (_error) {
		return "anon";
	}
}
function my_name() {
	try {
		return localStorage.getItem(NAME_KEY) || `Painter ${client_id().slice(0, 2).toUpperCase()}`;
	} catch (_error) {
		return "Painter";
	}
}
/** @param {string} name */
function set_my_name(name) {
	try {
		localStorage.setItem(NAME_KEY, name.trim().slice(0, 40));
	} catch (_error) { /* ignore */ }
	if (connected) { send({ type: "hello", client_id: client_id(), name: my_name(), color: my_color() }); }
}
function my_color() {
	let hash = 0;
	for (const char of client_id()) { hash = (hash * 31 + char.charCodeAt(0)) >>> 0; }
	return COLORS[hash % COLORS.length];
}

// ---- connection ----

/** Joins the room of the page the document came from (system_file_handle.site_page), if signed in. */
function join_current_page() {
	const page = system_file_handle && typeof system_file_handle === "object" ? system_file_handle.site_page : null;
	if (page) { join_page_room(page, false); }
}

/**
 * Connects to a page's room. With `authoritative`, this client's document replaces the room's (right after
 * publishing or creating the page); otherwise the room's draft wins when it has one.
 * @param {string} page
 * @param {boolean} authoritative
 */
function join_page_room(page, authoritative) {
	if (!is_live_sync_enabled() || !is_signed_in()) { return; }
	const { site, secret } = load_settings();
	if (room && room.site === site && room.page === page && socket && socket.readyState <= WebSocket.OPEN) {
		if (authoritative && connected) { replace_room_document(); }
		return;
	}
	leave_page_room();
	room = { site, page, authoritative };
	const url = new URL(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/rooms/${encodeURIComponent(page)}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("token", secret);
	set_status("connecting");
	try {
		socket = new WebSocket(url.href);
	} catch (error) {
		set_status("error", error.message);
		return;
	}
	const this_socket = socket;
	socket.onopen = () => {
		if (socket !== this_socket) { return; }
		retry_count = 0;
		send({ type: "hello", client_id: client_id(), name: my_name(), color: my_color() });
	};
	socket.onmessage = (event) => {
		if (socket !== this_socket) { return; }
		try {
			handle_message(JSON.parse(String(event.data)));
		} catch (error) {
			window.console?.warn("live sync: bad message", error);
		}
	};
	socket.onclose = (event) => {
		if (socket !== this_socket) { return; }
		connected = false;
		socket = null;
		clear_remote_clients();
		if (!room) { return; }
		if (event.code === 1008 || event.code === 4401) {
			set_status("error", localize("The room refused the edit secret."));
			return;
		}
		// Reconnect with backoff; the room sends a fresh snapshot on hello.
		retry_count++;
		const delay = Math.min(30000, 1000 * 2 ** Math.min(retry_count, 5));
		set_status("connecting", localize("Reconnecting…"));
		retry_timer = setTimeout(() => { if (room) { join_page_room(room.page, false); } }, delay);
	};
	socket.onerror = () => { /* onclose follows */ };
}

/** @param {string} [reason] */
function leave_page_room(reason) {
	if (retry_timer) { clearTimeout(retry_timer); retry_timer = null; }
	const had_room = !!room;
	room = null;
	connected = false;
	last = null;
	if (socket) {
		const closing = socket;
		socket = null;
		try { closing.close(1000, "leaving"); } catch (_error) { /* ignore */ }
	}
	clear_remote_clients();
	if (had_room) { set_status("off", reason); }
}

/** @param {any} message */
function send(message) {
	if (socket && socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(message));
		return true;
	}
	return false;
}

// ---- status indicator ----

/**
 * @param {"off" | "connecting" | "live" | "error"} state
 * @param {string} [detail]
 */
function set_status(state, detail) {
	if (!$indicator) { return; }
	$indicator.attr("data-state", state).toggle(state !== "off" || !!detail);
	const others = [...remote_clients.values()];
	const who = others.length ? ` · ${others.map((client) => client.name).join(", ")}` : "";
	const text = state === "live" ? `● ${localize("Live")}${who}` : state === "connecting" ? `○ ${detail || localize("Connecting…")}` : state === "error" ? `● ${detail || localize("Live sync failed")}` : detail || "";
	$indicator.text(text).attr("title", state === "live" ? `${localize("Live sync")}: ${room ? room.page : ""}\n${localize("You are")} ${my_name()} (${others.length} ${localize("other(s) here")}). ${localize("Click to change your name.")}` : detail || "");
	if (state === "off" && detail) {
		setTimeout(() => { if (!room && $indicator) { $indicator.hide(); } }, 4000);
	}
}

// ---- messages from the room ----

/** @param {any} message */
function handle_message(message) {
	switch (message.type) {
		case "snapshot":
			connected = true;
			version = message.version;
			remote_clients.clear();
			for (const client of message.clients || []) { remote_clients.set(client.client_id, client); }
			if (message.version === 0 || room?.authoritative) {
				// Nothing there yet (or we're the authority): the room takes our document.
				if (room) { room.authoritative = false; }
				replace_room_document(message.version === 0);
			} else {
				remote_queue = remote_queue.then(() => apply_snapshot(message)).catch((error) => { window.console?.warn("live sync: snapshot failed", error); });
			}
			set_status("live");
			break;
		case "seeded":
		case "ack":
			version = message.version;
			break;
		case "replaced":
			// Someone else declared their copy the document: fetch it.
			send({ type: "hello", client_id: client_id(), name: my_name(), color: my_color() });
			break;
		case "ops":
			version = message.version;
			remote_queue = remote_queue.then(() => apply_remote_ops(message.ops)).catch((error) => { window.console?.warn("live sync: ops failed", error); });
			break;
		case "bitmap":
			version = message.version;
			remote_queue = remote_queue.then(() => apply_remote_bitmap(message)).catch((error) => { window.console?.warn("live sync: bitmap failed", error); });
			break;
		case "props":
			version = message.version;
			remote_queue = remote_queue.then(() => apply_remote_props(message));
			break;
		case "presence":
			update_remote_client(message);
			break;
		case "join":
			remote_clients.set(message.client.client_id, { ...remote_clients.get(message.client.client_id), ...message.client });
			set_status("live");
			send_presence(true);
			break;
		case "leave":
			remove_remote_client(message.client_id);
			set_status("live");
			break;
		case "request_snapshot":
			send_full_picture();
			break;
		case "error":
			window.console?.warn("live sync:", message.message);
			set_status("live", message.message);
			break;
		default:
			break;
	}
}

// ---- applying remote changes ----

/**
 * Replaces the document with the room's draft (on joining a room that has one).
 * @param {{ doc: { width: number, height: number, page_properties: Record<string, string>, layers: Record<LayerKind, any[]> }, patches: any[] }} message
 */
async function apply_snapshot({ doc, patches }) {
	applying_remote = true;
	try {
		if (doc.width && doc.height && (main_canvas.width !== doc.width || main_canvas.height !== doc.height)) {
			main_canvas.width = doc.width;
			main_canvas.height = doc.height;
			main_ctx.disable_image_smoothing();
			if (!transparency) {
				main_ctx.fillStyle = "#ffffff";
				main_ctx.fillRect(0, 0, main_canvas.width, main_canvas.height);
			}
		}
		for (const patch of patches || []) {
			await draw_patch(patch, false);
		}
		set_page_properties(doc.page_properties || {}, false);
		const stickers = [];
		for (const item of doc.layers.stickers || []) {
			const snapshot = await sticker_from_wire(item);
			if (snapshot) { stickers.push(snapshot); }
		}
		// Rebuild the layers in place (the joiner's own layers are superseded by the room's).
		for (const id of current_ids("blocks")) { if (!doc.layers.blocks.some((item) => item.id === id)) { remove_block_by_id(id); } }
		for (const id of current_ids("stickers")) { if (!stickers.some((item) => item.id === id)) { remove_sticker_by_id(id); } }
		for (const id of current_ids("text_layers")) { if (!doc.layers.text_layers.some((item) => item.id === id)) { remove_text_layer_by_id(id); } }
		for (const item of doc.layers.blocks || []) { upsert_block_from_snapshot(item); }
		for (const item of stickers) { upsert_sticker_from_snapshot(item); }
		for (const item of doc.layers.text_layers || []) { upsert_text_layer_from_snapshot(item); }
		order_blocks((doc.layers.blocks || []).map((item) => item.id));
		order_stickers(stickers.map((item) => item.id));
		order_text_layers((doc.layers.text_layers || []).map((item) => item.id));
		// This is the loaded state: history restarts from it.
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		for (const node of all_history_nodes()) {
			node.image_data = image_data;
			node.blocks = snapshot_blocks();
			node.stickers = snapshot_stickers();
			node.text_layers = snapshot_text_layers();
		}
		remember_current_as_sent();
		$canvas_area.trigger("resize");
		update_helper_layer();
		$G.triggerHandler("history-update");
		$G.triggerHandler("session-update");
	} finally {
		applying_remote = false;
	}
	reapply_remote_locks();
}

/** How each kind of layer applies a remote operation to the live document (blocks.js, stickers.js, text-layers.js). */
const LIVE_LAYER_OPS = {
	blocks: { upsert: upsert_block_from_snapshot, remove: remove_block_by_id, order: order_blocks },
	stickers: { upsert: upsert_sticker_from_snapshot, remove: remove_sticker_by_id, order: order_stickers },
	text_layers: { upsert: upsert_text_layer_from_snapshot, remove: remove_text_layer_by_id, order: order_text_layers },
};

/** @param {LayerKind} kind */
function current_ids(kind) {
	return (kind === "blocks" ? snapshot_blocks() : kind === "stickers" ? snapshot_stickers() : snapshot_text_layers()).map((item) => item.id);
}

/** Every node of the undo tree, root first. */
function all_history_nodes() {
	/** @type {HistoryNode[]} */
	const nodes = [];
	const stack = [root_history_node];
	while (stack.length) {
		const node = stack.pop();
		nodes.push(node);
		stack.push(...node.futures);
	}
	return nodes;
}

/**
 * @param {LiveOp[]} ops
 */
async function apply_remote_ops(ops) {
	applying_remote = true;
	try {
		for (const op of ops) {
			if (!KINDS.includes(op.kind)) { continue; }
			/** @type {any} */
			let item = op.op === "set" ? op.item : null;
			if (op.op === "set" && op.kind === "stickers") {
				item = await sticker_from_wire(item);
				if (!item) { continue; }
			}
			// The live layer…
			const live = LIVE_LAYER_OPS[op.kind];
			if (op.op === "set") {
				live.upsert(item);
			} else if (op.op === "remove") {
				live.remove(op.id);
			} else if (op.op === "order") {
				live.order(op.ids);
			}
			// …and every history node, so undo here doesn't undo them there.
			for (const node of all_history_nodes()) {
				/** @type {any[] | null} */
				const list = /** @type {any} */ (node)[op.kind];
				if (!Array.isArray(list)) { continue; }
				if (op.op === "set") {
					const index = list.findIndex((existing) => existing.id === item.id);
					if (index === -1) {
						list.push(item);
					} else {
						list[index] = item;
					}
				} else if (op.op === "remove") {
					/** @type {any} */ (node)[op.kind] = list.filter((existing) => existing.id !== op.id);
				} else if (op.op === "order") {
					/** @type {Map<string, any>} */
					const by_id = new Map();
					for (const existing of list) { by_id.set(existing.id, existing); }
					const ordered = op.ids.map((id) => by_id.get(id)).filter(Boolean);
					for (const existing of list) {
						if (!ordered.includes(existing)) { ordered.push(existing); }
					}
					/** @type {any} */ (node)[op.kind] = ordered;
				}
			}
			// What the room now knows matches what we have.
			if (last) {
				if (op.op === "set") { last.layers[op.kind].set(op.item.id, JSON.stringify(op.item)); }
				if (op.op === "remove") { last.layers[op.kind].delete(op.id); }
				last.order[op.kind] = current_ids(op.kind).join(",");
			}
		}
		$G.triggerHandler("history-update");
		$G.triggerHandler("session-update");
		saved = false;
		update_title();
	} finally {
		applying_remote = false;
	}
	reapply_remote_locks();
}

/**
 * @param {{ x: number, y: number, width: number, height: number, png: string, reset?: boolean }} patch
 * @param {boolean} [notify=true]
 */
async function draw_patch(patch, notify = true) {
	const img = new Image();
	await new Promise((resolve, reject) => {
		img.onload = resolve;
		img.onerror = () => reject(new Error("Couldn't decode a bitmap patch"));
		img.src = `data:image/png;base64,${patch.png}`;
	});
	const { x, y } = patch;
	const width = Math.min(img.naturalWidth, main_canvas.width - x);
	const height = Math.min(img.naturalHeight, main_canvas.height - y);
	if (width <= 0 || height <= 0) { return; }
	main_ctx.save();
	main_ctx.globalCompositeOperation = "copy";
	main_ctx.beginPath();
	main_ctx.rect(x, y, width, height);
	main_ctx.clip();
	main_ctx.drawImage(img, x, y);
	main_ctx.restore();
	if (!notify) { return; }
	// Rebase every history node's picture: the patch is the truth for that rectangle now.
	const patch_data = main_ctx.getImageData(x, y, width, height).data;
	for (const node of all_history_nodes()) {
		const data = node.image_data;
		if (!data || data.width !== main_canvas.width || data.height !== main_canvas.height) { continue; }
		for (let row = 0; row < height; row++) {
			data.data.set(patch_data.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * data.width + x) * 4);
		}
	}
	if (last && last.pixels && last.width === main_canvas.width && last.height === main_canvas.height) {
		for (let row = 0; row < height; row++) {
			last.pixels.set(patch_data.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * last.width + x) * 4);
		}
	}
}

/** @param {{ x: number, y: number, width: number, height: number, png: string, reset?: boolean }} message */
async function apply_remote_bitmap(message) {
	applying_remote = true;
	try {
		await draw_patch(message, true);
		update_helper_layer();
		$G.triggerHandler("session-update");
		saved = false;
		update_title();
	} finally {
		applying_remote = false;
	}
}

/** @param {{ width?: number, height?: number, page_properties?: Record<string, string> }} message */
function apply_remote_props(message) {
	applying_remote = true;
	try {
		if (message.page_properties) {
			set_page_properties(message.page_properties, false);
			if (last) { last.props = JSON.stringify(get_page_properties()); }
		}
		if (message.width && message.height && (message.width !== main_canvas.width || message.height !== main_canvas.height)) {
			resize_canvas_without_saving_dimensions(message.width, message.height, { name: localize("Resize Canvas") });
			if (last) {
				last.width = main_canvas.width;
				last.height = main_canvas.height;
				last.pixels = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data.slice();
			}
		}
	} finally {
		applying_remote = false;
	}
}

// ---- stickers on the wire: site paths instead of local source ids ----

/**
 * @param {StickerSnapshot} snapshot
 * @returns {Promise<any | null>} the snapshot with `src` (uploading the GIF to the site first if needed)
 */
async function sticker_to_wire(snapshot) {
	let path = source_paths.get(snapshot.source_id);
	if (!path) {
		const source = get_sticker_source(snapshot.source_id);
		if (!source) { return null; }
		const ext = { "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[source.blob.type] || "png";
		path = await upload_asset(new File([source.blob], `sticker.${ext}`, { type: source.blob.type || "image/png" }));
		source_paths.set(snapshot.source_id, path);
		sources_by_path.set(path, snapshot.source_id);
	}
	const wire = { ...snapshot, src: path };
	delete wire.source_id;
	return wire;
}

/**
 * @param {any} item - a sticker with `src`
 * @returns {Promise<StickerSnapshot | null>}
 */
async function sticker_from_wire(item) {
	if (!item || typeof item.src !== "string" || !/^gifs\/[A-Za-z0-9._-]+$/.test(item.src)) { return null; }
	let source_id = sources_by_path.get(item.src);
	if (!source_id) {
		const response = await fetch(`${get_site_files_base()}${item.src}`);
		if (!response.ok) { return null; }
		const source = await register_sticker_source(await response.blob());
		source_id = source.id;
		sources_by_path.set(item.src, source_id);
		source_paths.set(source_id, item.src);
	}
	const snapshot = { ...item, source_id };
	delete snapshot.src;
	return snapshot;
}

// ---- sending local changes ----

/** Records the current document as what the room has (after a snapshot, seed, or replace). */
function remember_current_as_sent() {
	last = {
		width: main_canvas.width,
		height: main_canvas.height,
		pixels: main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data.slice(),
		layers: { blocks: new Map(), stickers: new Map(), text_layers: new Map() },
		order: { blocks: "", stickers: "", text_layers: "" },
		props: JSON.stringify(get_page_properties()),
	};
	for (const item of snapshot_blocks()) { last.layers.blocks.set(item.id, JSON.stringify(item)); }
	for (const item of snapshot_text_layers()) { last.layers.text_layers.set(item.id, JSON.stringify(item)); }
	for (const item of snapshot_stickers()) {
		const path = source_paths.get(item.source_id);
		if (path) {
			const wire = { ...item, src: path };
			delete wire.source_id;
			last.layers.stickers.set(item.id, JSON.stringify(wire));
		}
	}
	for (const kind of KINDS) { last.order[kind] = current_ids(kind).join(","); }
}

/**
 * Makes this client's document the room's (empty room, or right after publishing).
 * @param {boolean} [seed=false] - the room is empty: `seed` instead of `replace`
 */
async function replace_room_document(seed = false) {
	const layers = { blocks: snapshot_blocks(), stickers: /** @type {any[]} */ ([]), text_layers: snapshot_text_layers() };
	for (const snapshot of snapshot_stickers()) {
		try {
			const wire = await sticker_to_wire(snapshot);
			if (wire) { layers.stickers.push(wire); }
		} catch (error) {
			window.console?.warn("live sync: couldn't upload a sticker", error);
		}
	}
	send({ type: seed ? "seed" : "replace", width: main_canvas.width, height: main_canvas.height, page_properties: get_page_properties(), layers });
	remember_current_as_sent();
	await send_full_picture();
}

function schedule_sync() {
	if (!connected || applying_remote) { return; }
	if (sync_timer) { clearTimeout(sync_timer); }
	sync_timer = setTimeout(() => { sync_local_changes(); }, SYNC_DELAY_MS);
}

/** Diffs the document against what the room has and sends the difference. */
async function sync_local_changes() {
	if (!connected || !last || syncing || applying_remote) {
		if (connected && last && syncing) { schedule_sync(); }
		return;
	}
	syncing = true;
	try {
		// Size and page properties
		if (main_canvas.width !== last.width || main_canvas.height !== last.height) {
			last.width = main_canvas.width;
			last.height = main_canvas.height;
			send({ type: "props", width: main_canvas.width, height: main_canvas.height });
			await send_full_picture();
		} else if (last.pixels) {
			const rect = dirty_rect(last.pixels, main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data, main_canvas.width, main_canvas.height);
			if (rect) {
				await send_region(rect.x, rect.y, rect.width, rect.height, false);
			}
		}
		const props = JSON.stringify(get_page_properties());
		if (props !== last.props) {
			last.props = props;
			send({ type: "props", page_properties: get_page_properties() });
		}
		// Layers
		/** @type {LiveOp[]} */
		const ops = [];
		for (const kind of KINDS) {
			/** @type {Map<string, string>} */
			const current = new Map();
			if (kind === "stickers") {
				for (const snapshot of snapshot_stickers()) {
					try {
						const wire = await sticker_to_wire(snapshot);
						if (wire) { current.set(snapshot.id, JSON.stringify(wire)); }
					} catch (error) {
						window.console?.warn("live sync: couldn't upload a sticker", error);
					}
				}
			} else {
				for (const item of (kind === "blocks" ? snapshot_blocks() : snapshot_text_layers())) { current.set(item.id, JSON.stringify(item)); }
			}
			const known = last.layers[kind];
			for (const [id, json] of current) {
				if (known.get(id) !== json) {
					ops.push({ kind, op: "set", item: JSON.parse(json) });
					known.set(id, json);
				}
			}
			for (const id of [...known.keys()]) {
				if (!current.has(id)) {
					ops.push({ kind, op: "remove", id });
					known.delete(id);
				}
			}
			const order = [...current.keys()].join(",");
			if (order !== last.order[kind]) {
				ops.push({ kind, op: "order", ids: [...current.keys()] });
				last.order[kind] = order;
			}
		}
		if (ops.length) { send({ type: "ops", ops }); }
	} finally {
		syncing = false;
	}
}

/**
 * The bounding box of the pixels that differ, or null.
 * @param {Uint8ClampedArray} before
 * @param {Uint8ClampedArray} after
 * @param {number} width
 * @param {number} height
 */
function dirty_rect(before, after, width, height) {
	if (before.length !== after.length) { return { x: 0, y: 0, width, height }; }
	const a = new Uint32Array(before.buffer, before.byteOffset, before.length / 4);
	const b = new Uint32Array(after.buffer, after.byteOffset, after.length / 4);
	let min_x = width, min_y = height, max_x = -1, max_y = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (a[row + x] !== b[row + x]) {
				if (x < min_x) { min_x = x; }
				if (x > max_x) { max_x = x; }
				if (y < min_y) { min_y = y; }
				max_y = y;
			}
		}
	}
	if (max_x === -1) { return null; }
	return { x: min_x, y: min_y, width: max_x - min_x + 1, height: max_y - min_y + 1 };
}

/**
 * @param {number} x @param {number} y @param {number} width @param {number} height
 * @param {boolean} reset - first band of a full picture
 */
async function send_region(x, y, width, height, reset) {
	const image_data = main_ctx.getImageData(x, y, width, height);
	const canvas = make_canvas(width, height);
	canvas.ctx.putImageData(image_data, 0, 0);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) { return; }
	const png = await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => { resolve(String(reader.result).split(",")[1]); };
		reader.onerror = () => { reject(reader.error); };
		reader.readAsDataURL(blob);
	});
	if (last && last.pixels && last.width === main_canvas.width && last.height === main_canvas.height) {
		for (let row = 0; row < height; row++) {
			last.pixels.set(image_data.data.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * last.width + x) * 4);
		}
	}
	send({ type: "bitmap", x, y, width, height, png, reset });
}

/** Sends the whole picture as horizontal bands (the first with `reset`), replacing the room's patch log. */
async function send_full_picture() {
	if (full_picture_in_flight || !connected) { return; }
	full_picture_in_flight = true;
	try {
		const width = main_canvas.width;
		const rows = Math.max(8, Math.min(main_canvas.height, Math.floor(BAND_PIXELS / Math.max(1, width))));
		for (let y = 0; y < main_canvas.height; y += rows) {
			await send_region(0, y, width, Math.min(rows, main_canvas.height - y), y === 0);
		}
	} finally {
		full_picture_in_flight = false;
	}
}

// ---- presence ----

/** @param {boolean} [now=false] */
function send_presence(now = false) {
	if (!connected) { return; }
	presence_dirty = true;
	if (presence_timer && !now) { return; }
	const flush = () => {
		presence_timer = 0;
		if (!presence_dirty || !connected) { return; }
		presence_dirty = false;
		send({
			type: "presence",
			cursor: my_cursor,
			tool: selected_tool?.name || null,
			selected: get_selected_block()?.id || get_selected_sticker()?.id || get_selected_text_layer()?.id || null,
			editing: get_editing_block()?.id || null,
		});
	};
	if (now) {
		flush();
	} else {
		presence_timer = window.setTimeout(flush, PRESENCE_INTERVAL_MS);
	}
}

/** @param {any} message */
function update_remote_client(message) {
	/** @type {RemoteClient} */
	const client = remote_clients.get(message.client_id) || { client_id: message.client_id, name: "Someone", color: "#000080" };
	client.cursor = message.cursor;
	client.tool = message.tool;
	client.selected = message.selected;
	client.editing = message.editing;
	remote_clients.set(message.client_id, client);
	render_remote_cursor(client);
	reapply_remote_locks();
}

/** @param {RemoteClient} client */
function render_remote_cursor(client) {
	if (!client.cursor) {
		client.$cursor?.remove();
		client.$cursor = undefined;
		return;
	}
	if (!client.$cursor) {
		client.$cursor = $(E("div")).addClass("live-cursor").css({ "--live-color": client.color }).appendTo($canvas_area);
		$(E("span")).addClass("live-cursor-arrow").appendTo(client.$cursor);
		$(E("span")).addClass("live-cursor-name").appendTo(client.$cursor);
	}
	client.$cursor.find(".live-cursor-name").text(client.tool ? `${client.name} · ${client.tool}` : client.name);
	position_remote_cursor(client);
}

/** @param {RemoteClient} client */
function position_remote_cursor(client) {
	if (!client.$cursor || !client.cursor) { return; }
	const offset_left = parseFloat($canvas_area.css("padding-left"));
	const offset_top = parseFloat($canvas_area.css("padding-top"));
	client.$cursor.css({ left: magnification * client.cursor.x + offset_left, top: magnification * client.cursor.y + offset_top });
}

/** @param {string} id */
function remove_remote_client(id) {
	const client = remote_clients.get(id);
	client?.$cursor?.remove();
	remote_clients.delete(id);
	reapply_remote_locks();
}

function clear_remote_clients() {
	for (const id of [...remote_clients.keys()]) { remove_remote_client(id); }
}

function reapply_remote_locks() {
	set_remote_editor_lookup((block_id) => {
		for (const client of remote_clients.values()) {
			if (client.editing === block_id) { return client.name; }
		}
		return null;
	});
}

// ---- wiring ----

/** Call once the canvas area and status bar exist (app.js). */
function init_live_session() {
	/** @type {any} */ (window).live_sync_state = live_sync_state; // for tests and debugging, like api_for_cypress_tests
	$indicator = $(E("div")).addClass("status-field inset-shallow live-indicator").attr({ role: "status" }).hide().appendTo($status_area);
	$indicator.on("click", () => {
		if (!room) { return; }
		// eslint-disable-next-line no-alert -- a tiny dev-friendly prompt; a proper dialog can come with accounts
		const name = prompt(localize("Your name, as other editors see it:"), my_name());
		if (name !== null) { set_my_name(name); set_status("live"); }
	});

	$G.on("history-update", () => {
		if (room && (!system_file_handle || typeof system_file_handle !== "object" || system_file_handle.site_page !== room.page)) {
			leave_page_room(); // the document changed to something else (New, Open…)
			return;
		}
		schedule_sync();
	});
	$G.on("layers-changed block-editing-changed", () => { send_presence(); reapply_remote_locks(); });
	$G.on("site-page-opened", (_event, detail) => { join_page_room(detail.page, !!detail.authoritative); });
	$G.on("site-page-restored", (_event, detail) => { join_page_room(detail.page, false); });
	$G.on("resize theme-load", () => { for (const client of remote_clients.values()) { position_remote_cursor(client); } });
	$canvas.on("pointermove", (e) => {
		my_cursor = to_canvas_coords(e);
		send_presence();
	});
	$canvas.on("pointerleave", () => {
		my_cursor = null;
		send_presence();
	});
	window.addEventListener("beforeunload", () => { socket?.close(1000, "unload"); });
	$G.on("status-message", (_event, text) => { $status_area.find(".status-text").text(text); });

	$("<style>").text(`
		.live-indicator {
			flex: 0 1 auto;
			max-width: 40%;
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
			cursor: default;
		}
		.live-indicator[data-state="live"] { color: #007a00; }
		.live-indicator[data-state="connecting"] { color: #666; }
		.live-indicator[data-state="error"] { color: #a00000; }
		.live-cursor {
			position: absolute;
			z-index: 6;
			pointer-events: none;
			transform: translate(-1px, -1px);
		}
		.live-cursor-arrow {
			display: block;
			width: 0;
			height: 0;
			border-left: 6px solid var(--live-color);
			border-right: 6px solid transparent;
			border-bottom: 12px solid transparent;
			border-top: 6px solid var(--live-color);
		}
		.live-cursor-name {
			position: absolute;
			left: 10px;
			top: 10px;
			font: 10px sans-serif;
			line-height: 13px;
			padding: 0 4px;
			background: var(--live-color);
			color: #fff;
			white-space: nowrap;
			border-radius: 2px;
		}
	`).appendTo(document.head);
}

/** @returns {{ connected: boolean, room: { site: string, page: string } | null, version: number, others: string[] }} for tests and the menu */
function live_sync_state() {
	return { connected, room: room ? { site: room.site, page: room.page } : null, version, others: [...remote_clients.values()].map((client) => client.name) };
}

export { init_live_session, is_live_sync_enabled, join_page_room, leave_page_room, live_sync_state, set_live_sync_enabled, set_my_name };
