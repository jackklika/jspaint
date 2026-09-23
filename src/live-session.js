// @ts-check
// eslint-disable-next-line no-unused-vars
/* global saved:writable, pointer:writable, pointer_previous:writable, pointer_start:writable, pointer_active:writable, pointer_over_canvas:writable, button:writable, reverse:writable, shift:writable, ctrl:writable, stroke_size:writable, brush_size:writable, brush_shape:writable, eraser_size:writable, airbrush_size:writable, pencil_size:writable, stroke_color:writable, fill_color:writable, selected_colors:writable, tool_transparent_mode:writable */
/* global $canvas, $canvas_area, $status_area, current_history_node, localize, magnification, main_canvas, main_ctx, root_history_node, selected_tool, system_file_handle, transparency, update_fill_and_stroke_colors_and_lineWidth */
// Live sync: while you edit a page of your site, Paint is connected to that page's room — a Durable Object on
// the editor Worker (worker/editor/page-room.js) that holds the live draft and relays changes to everyone
// editing the same page. Local changes are found by diffing the document after each history change: the
// bitmap's dirty rectangle goes out as a PNG patch, elements go out as per-id set/remove/order operations.
// Remote changes are applied in place — and to every node of the undo tree, so undoing your own work never
// erases someone else's. Presence (cursors, who's editing which text) is relayed but not stored. Publishing
// (Publish) remains explicit; the room is the shared draft, so the page looks the same wherever you sign in.
// The room keeps every change as a version (who, what, when — the label sent with each change is the undoable's
// name); page-history.js shows that tree and can take everyone back to any version (`restore`).
import { get_editing_block, get_selected_block, order_blocks, remove_block_by_id, set_remote_editor_lookup, snapshot_blocks, upsert_block_from_snapshot } from "./blocks.js";
import { get_tool_by_id, resize_canvas_without_saving_dimensions, update_helper_layer, update_title } from "./functions.js";
import { $G, E, get_icon_for_tool, make_canvas, to_canvas_coords } from "./helpers.js";
import { upload_asset } from "./my-site.js";
import { get_page_properties, set_page_properties } from "./page-properties.js";
import { get_site_editor_url, get_site_files_base, is_signed_in, load_settings } from "./site-publish.js";
import { get_selected_sticker, get_sticker_source, order_stickers, register_sticker_source, remove_sticker_by_id, snapshot_stickers, upsert_sticker_from_snapshot } from "./stickers.js";
import { get_selected_text_layer, order_text_layers, remove_text_layer_by_id, snapshot_text_layers, upsert_text_layer_from_snapshot } from "./text-layers.js";
import { create_tools } from "./tools.js";

const ENABLED_KEY = "jspaint live sync";
const NAME_KEY = "jspaint live name";
const CLIENT_ID_KEY = "jspaint live client id";
const SYNC_DELAY_MS = 60;
const PRESENCE_INTERVAL_MS = 100; // (every incoming message costs the room 1/20 of a request; nothing is sent when alone)
const BAND_PIXELS = 90000; // rows per full-picture band = this / width (keeps each PNG message well under 1 MiB)
const COLORS = ["#e6194b", "#3cb44b", "#0082c8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#d2f53c", "#008080", "#aa6e28", "#800000", "#808000", "#000080"];
const KINDS = /** @type {const} */ (["blocks", "stickers", "text_layers"]);

/** @typedef {typeof KINDS[number]} LayerKind */
/** @typedef {{ kind: LayerKind, op: "set", item: any } | { kind: LayerKind, op: "remove", id: string } | { kind: LayerKind, op: "order", ids: string[] }} LiveOp */
/** @typedef {{ client_id: string, name: string, color: string, cursor?: { x: number, y: number } | null, tool?: string | null, tool_id?: string | null, selected?: string | null, editing?: string | null, $cursor?: JQuery<HTMLElement> }} RemoteClient */

/** @type {WebSocket | null} */
let socket = null;
/** @type {{ site: string, page: string, authoritative: boolean, guest: boolean, reason: string } | null} */
let room = null;
/** The undo-tree node the room last heard about: the next change is labeled by what happened since. @type {HistoryNode | null} */
let last_synced_node = null;
let connected = false;
let version = 0;
let retry_count = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let retry_timer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let sync_timer = null;
/** Until when the room asked us to slow down (ms): cursors and stroke pieces wait, the next sync is put off. */
let slow_until = 0;
let slow_warned_at = 0;
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
 * @param {string} [reason] - why the document is authoritative ("published", "new"): the history entry's label
 */
function join_page_room(page, authoritative, reason = "") {
	if (!is_live_sync_enabled()) { return; }
	// A guest (share link) joins with their key; the owner with the edit secret.
	const guest = system_file_handle && typeof system_file_handle === "object" && system_file_handle.guest ? system_file_handle.guest : null;
	if (!guest && !is_signed_in()) { return; }
	const site = guest ? guest.site : load_settings().site;
	if (room && room.site === site && room.page === page && socket && socket.readyState <= WebSocket.OPEN) {
		if (authoritative && connected && !guest) { replace_room_document(false, replace_label(reason)); }
		return;
	}
	leave_page_room();
	room = { site, page, authoritative: authoritative && !guest, guest: !!guest, reason };
	const url = new URL(`${get_site_editor_url()}/api/sites/${encodeURIComponent(site)}/rooms/${encodeURIComponent(page)}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	if (guest) {
		url.searchParams.set("invite", guest.key);
	} else if (load_settings().secret) {
		url.searchParams.set("token", load_settings().secret);
	} // (an account's session rides in the cookie: the room is on the editor's own origin)
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
			set_status("error", room.guest ? localize("This share link has expired.") : localize("The room refused the password."));
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
			// The room may have given us a fresh id (ours was another live connection's): it's ours from here on
			if (message.you?.client_id && message.you.client_id !== client_id()) { try { sessionStorage.setItem(CLIENT_ID_KEY, message.you.client_id); } catch (_error) { /* then strokes carry the old one */ } }
			remote_clients.clear();
			for (const client of message.clients || []) { remote_clients.set(client.client_id, client); }
			if ((message.version === 0 && !room?.guest) || room?.authoritative) {
				// Nothing there yet (or we're the authority): the room takes our document. Guests never seed.
				const reason = room ? room.reason : "";
				if (room) { room.authoritative = false; room.reason = ""; }
				replace_room_document(message.version === 0, replace_label(reason));
			} else if (message.version === 0) {
				set_status("live", localize("This page has nothing in it yet."));
				remember_current_as_sent();
			} else {
				remote_queue = remote_queue.then(() => apply_snapshot(message)).catch((error) => { window.console?.warn("live sync: snapshot failed", error); });
			}
			set_status("live");
			last_synced_node = current_history_node;
			$G.triggerHandler("live-version");
			break;
		case "seeded":
		case "ack":
			version = message.version;
			$G.triggerHandler("live-version");
			break;
		case "history":
		case "state":
			// For the Page History window (page-history.js)
			$G.triggerHandler(`live-${message.type}`, [message]);
			break;
		case "restored":
			// Someone (maybe us) took the page back to an older version: the room's document is that now — fetch it.
			version = message.version;
			send({ type: "hello", client_id: client_id(), name: my_name(), color: my_color() });
			if (message.client_id !== client_id()) {
				$G.triggerHandler("status-message", [localize("%1 went back in the page's history.", message.name || localize("Someone"))]);
			}
			$G.triggerHandler("live-version");
			break;
		case "replaced":
			if (message.client_id === client_id()) { break; } // our own, from a previous socket of this tab
			// Someone else declared their copy the document: fetch it.
			send({ type: "hello", client_id: client_id(), name: my_name(), color: my_color() });
			break;
		case "ops":
			version = message.version;
			$G.triggerHandler("live-version");
			if (message.client_id === client_id()) { break; } // a late echo of our own change (e.g. after re-opening the page): already here
			remote_queue = remote_queue.then(() => apply_remote_ops(message.ops)).catch((error) => { window.console?.warn("live sync: ops failed", error); });
			break;
		case "bitmap":
			version = message.version;
			$G.triggerHandler("live-version");
			if (message.client_id === client_id()) { break; }
			remote_queue = remote_queue.then(() => apply_remote_bitmap(message)).then(() => { finish_remote_stroke(message.client_id); }).catch((error) => { window.console?.warn("live sync: bitmap failed", error); });
			break;
		case "stroke":
			if (message.client_id === client_id()) { break; }
			apply_remote_stroke(message);
			break;
		case "props":
			version = message.version;
			$G.triggerHandler("live-version");
			remote_queue = remote_queue.then(() => apply_remote_props(message));
			break;
		case "presence":
			if (message.client_id === client_id()) { break; }
			update_remote_client(message);
			break;
		case "join":
			if (message.client.client_id === client_id()) { break; } // our own previous socket, seen from the new one
			remote_clients.set(message.client.client_id, { ...remote_clients.get(message.client.client_id), ...message.client });
			set_status("live");
			send_presence(true);
			break;
		case "leave":
			remove_remote_client(message.client_id);
			remove_remote_painter(message.client_id);
			set_status("live");
			break;
		case "request_snapshot":
			send_full_picture();
			break;
		case "error":
			window.console?.warn("live sync:", message.message);
			set_status("live", message.message);
			break;
		case "slow-down":
			// The room's brake: we're sending faster than it takes (a burst, a bug, or the page's busy day). Cursors and
			// stroke pieces wait it out; the next sync is put off; nothing is dropped here.
			slow_until = Date.now() + Math.min(60_000, Math.max(250, Number(message.retry_in_ms) || 1000));
			if (Date.now() - slow_warned_at > 30_000) {
				slow_warned_at = Date.now();
				set_status("live", message.code === "daily-budget" ? localize("This page has been very busy today: syncing slowly.") : localize("Syncing a little slower…"));
			}
			if (sync_timer) { schedule_sync(); }
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
		path = source.path; // a picture from the site (the Pictures window) is already there
		if (!path) {
			const ext = { "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[source.blob.type] || "png";
			path = await upload_asset(new File([source.blob], `sticker.${ext}`, { type: source.blob.type || "image/png" }));
			source.path = path;
		}
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
		const source = await register_sticker_source(await response.blob(), { path: item.src });
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

/** What the history calls a replaced draft. @param {string} reason */
function replace_label(reason) {
	return reason === "published" ? localize("Saved to My Site") : reason === "new" ? localize("New page") : localize("Opened");
}

/**
 * What to call the change about to be sent: the undoable that made it (its history node's name), or "Undo …".
 * @returns {string}
 */
function change_label() {
	const node = current_history_node;
	let label = node.name || "";
	if (last_synced_node && node !== last_synced_node) {
		for (let ancestor = last_synced_node.parent; ancestor; ancestor = ancestor.parent) {
			if (ancestor === node) { label = `${localize("Undo")} ${last_synced_node.name || ""}`.trim(); break; }
		}
	}
	last_synced_node = node;
	return label.slice(0, 60);
}

/**
 * Makes this client's document the room's (empty room, or right after publishing).
 * @param {boolean} [seed=false] - the room is empty: `seed` instead of `replace`
 * @param {string} [label] - what the history calls it
 */
async function replace_room_document(seed = false, label = "") {
	const layers = { blocks: snapshot_blocks(), stickers: /** @type {any[]} */ ([]), text_layers: snapshot_text_layers() };
	for (const snapshot of snapshot_stickers()) {
		try {
			const wire = await sticker_to_wire(snapshot);
			if (wire) { layers.stickers.push(wire); }
		} catch (error) {
			window.console?.warn("live sync: couldn't upload a sticker", error);
		}
	}
	send({ type: seed ? "seed" : "replace", width: main_canvas.width, height: main_canvas.height, page_properties: get_page_properties(), layers, label: label || (seed ? localize("First draft") : localize("Opened")) });
	remember_current_as_sent();
	last_synced_node = current_history_node;
	await send_full_picture();
}

function schedule_sync() {
	if (!connected || applying_remote) { return; }
	if (sync_timer) { clearTimeout(sync_timer); }
	sync_timer = setTimeout(() => { sync_local_changes(); }, Math.max(SYNC_DELAY_MS, slow_until - Date.now()));
}

/** Diffs the document against what the room has and sends the difference. */
async function sync_local_changes() {
	if (!connected || !last || syncing || applying_remote) {
		if (connected && last && syncing) { schedule_sync(); }
		return;
	}
	syncing = true;
	try {
		const label = change_label();
		// Size and page properties
		if (main_canvas.width !== last.width || main_canvas.height !== last.height) {
			// A new size: the remembered pixels must be the new size too, or the bands below overflow them (RangeError)
			last.width = main_canvas.width;
			last.height = main_canvas.height;
			last.pixels = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data.slice();
			send({ type: "props", width: main_canvas.width, height: main_canvas.height, label });
			await send_full_picture();
		} else if (last.pixels) {
			const rect = dirty_rect(last.pixels, main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data, main_canvas.width, main_canvas.height);
			if (rect) {
				await send_region(rect.x, rect.y, rect.width, rect.height, false, label);
			}
		}
		const props = JSON.stringify(get_page_properties());
		if (props !== last.props) {
			last.props = props;
			send({ type: "props", page_properties: get_page_properties(), label });
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
		if (ops.length) { send({ type: "ops", ops, label }); }
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
 * @param {string} label - what the history calls it
 * @param {boolean} [part] - a band of a full picture: no history entry of its own (folded into what came before)
 */
async function send_region(x, y, width, height, reset, label, part = false) {
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
	send({ type: "bitmap", x, y, width, height, png, reset, label, part });
}

/**
 * Sends the whole picture as horizontal bands (the first with `reset`), replacing the room's patch log. The bands
 * are parts of whatever came before them in the history (a seed, a replace, a resize, or the room's own request
 * for a fresh picture): they get no entry of their own.
 */
async function send_full_picture() {
	if (full_picture_in_flight || !connected) { return; }
	full_picture_in_flight = true;
	try {
		const width = main_canvas.width;
		const rows = Math.max(8, Math.min(main_canvas.height, Math.floor(BAND_PIXELS / Math.max(1, width))));
		for (let y = 0; y < main_canvas.height; y += rows) {
			await send_region(0, y, width, Math.min(rows, main_canvas.height - y), y === 0, "", true);
		}
	} finally {
		full_picture_in_flight = false;
	}
}

/**
 * Sends what hasn't been sent yet, now — before the document becomes another page (my-site.js): a stroke made a
 * moment ago would otherwise be lost to the room's older draft when this page is opened again.
 */
async function flush_live_sync() {
	if (sync_timer) { clearTimeout(sync_timer); sync_timer = null; }
	if (!connected || !last) { return; }
	// eslint-disable-next-line no-unmodified-loop-condition -- sync_local_changes clears `syncing` when its round is done
	for (let tries = 0; tries < 50 && syncing; tries++) { await new Promise((resolve) => { setTimeout(resolve, 20); }); } // (a round in progress finishes first)
	if (sync_timer) { clearTimeout(sync_timer); sync_timer = null; }
	await sync_local_changes();
}

// ---- the page's history (page-history.js) ----

/** Asks the room for every version; the answer arrives as a `live-history` event. */
function request_history() {
	return send({ type: "history" });
}
/** Asks for a version as it was (document and bitmap patches); the answer arrives as a `live-state` event. @param {number} id */
function checkout_version(id) {
	return send({ type: "checkout", id });
}
/** Takes the page — for everyone — back to a version; the next change branches from it. @param {number} id */
function restore_version(id) {
	return send({ type: "restore", id });
}

// ---- presence ----

/** @param {boolean} [now=false] */
function send_presence(now = false) {
	// Alone in the room, there's nobody to show a cursor to: send nothing. When someone joins, the "join" handler
	// calls send_presence(true) so they see us at once. (The room only relays presence; it never stores it.)
	if (!connected || remote_clients.size === 0 || Date.now() < slow_until) { return; }
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
			tool_id: selected_tool?.id || null,
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
	client.tool_id = message.tool_id || null;
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
		// The pointer: a right triangle whose corner is exactly where they point; their tool's icon hangs below-left of
		// it, with their name under that.
		client.$cursor = $(E("div")).addClass("live-cursor").css({ "--live-color": client.color }).appendTo($canvas_area);
		$(E("span")).addClass("live-cursor-pointer").html('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M11.5 0.5H0.5L11.5 11.5Z"/></svg>').appendTo(client.$cursor);
		$(E("span")).addClass("live-cursor-tool").appendTo(client.$cursor);
		$(E("span")).addClass("live-cursor-name").appendTo(client.$cursor);
	}
	const $tool = client.$cursor.find(".live-cursor-tool");
	const tool = client.tool_id ? get_tool_by_id(/** @type {ToolID} */ (client.tool_id)) : null;
	if (tool && $tool.attr("data-tool") !== tool.id) {
		$tool.empty().append(get_icon_for_tool(tool)).attr({ "data-tool": tool.id, title: tool.name }).show();
	} else if (!tool) {
		$tool.empty().removeAttr("data-tool").hide();
	}
	client.$cursor.find(".live-cursor-name").text(client.name);
	client.$cursor.toggleClass("painting", !!remote_painters.get(client.client_id)?.active);
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
	for (const id of [...remote_painters.keys()]) { remove_remote_painter(id); }
}

// ---- strokes in progress: what someone is painting right now, before it lands as a patch ----
//
// Sender: while a paint tool is down, the processed pointer positions go out ~30 times a second as `stroke`
// messages (start / move / end / cancel). Receiver: each remote painter gets its own set of tool objects
// (create_tools) and its own overlay canvas; the stroke is replayed through the real tool code — pointerdown,
// paint, and the tool's own preview drawing — with the paint globals (pointer, sizes, colors…) swapped in for
// the duration of each synchronous step, so the local tools and the local stroke are never touched. Nothing
// ever hits the real canvas or the history here; when the painter's finished stroke arrives as a bitmap patch,
// the overlay clears. Tools that would change the document from pointerdown (Fill, selections, Text…) aren't replayed.

const STROKE_TOOLS = new Set(["TOOL_PENCIL", "TOOL_BRUSH", "TOOL_AIRBRUSH", "TOOL_ERASER", "TOOL_LINE", "TOOL_RECTANGLE", "TOOL_ROUNDED_RECTANGLE", "TOOL_ELLIPSE", "TOOL_CURVE"]);
const MULTI_STEP_TOOLS = new Set(["TOOL_CURVE"]); // stay previewed across clicks until the finished patch arrives
const STROKE_SEND_INTERVAL_MS = 100; // points are batched, so the remote line is identical; only the preview trails a little
const STROKE_CLEAR_AFTER_END_MS = 2500; // in case the stroke changed nothing (no patch will come)

/**
 * @typedef {object} RemotePainter
 * @property {Tool[]} tools
 * @property {Tool | null} tool
 * @property {any} state - sizes and colors the painter is using
 * @property {number} button
 * @property {{ x: number, y: number }} pointer
 * @property {{ x: number, y: number }} previous
 * @property {{ x: number, y: number }} start
 * @property {boolean} active
 * @property {PixelCanvas} overlay
 * @property {JQuery<HTMLElement>} $el
 * @property {ReturnType<typeof setTimeout> | null} clear_timer
 */
/** @type {Map<string, RemotePainter>} by client id */
const remote_painters = new Map();

/** @type {{ id: string, pending: { x: number, y: number }[], timer: number, last: { x: number, y: number } | null } | null} */
let local_stroke = null;

/** @param {string} client_id_ */
function get_remote_painter(client_id_) {
	let painter = remote_painters.get(client_id_);
	if (!painter) {
		const $el = $(E("div")).addClass("remote-stroke-layer").insertAfter($canvas);
		const overlay = make_canvas(main_canvas.width, main_canvas.height);
		$el.append(overlay);
		painter = { tools: create_tools(), tool: null, state: null, button: 0, pointer: { x: 0, y: 0 }, previous: { x: 0, y: 0 }, start: { x: 0, y: 0 }, active: false, overlay, $el, clear_timer: null };
		remote_painters.set(client_id_, painter);
		position_remote_overlay(painter);
	}
	return painter;
}

/** @param {RemotePainter} painter */
function position_remote_overlay(painter) {
	if (painter.overlay.width !== main_canvas.width || painter.overlay.height !== main_canvas.height) {
		painter.overlay.width = main_canvas.width;
		painter.overlay.height = main_canvas.height;
	}
	painter.$el.css({
		left: parseFloat($canvas_area.css("padding-left")),
		top: parseFloat($canvas_area.css("padding-top")),
		width: magnification * main_canvas.width,
		height: magnification * main_canvas.height,
	});
}

/** @param {string} client_id_ */
function remove_remote_painter(client_id_) {
	const painter = remote_painters.get(client_id_);
	if (!painter) { return; }
	if (painter.clear_timer) { clearTimeout(painter.clear_timer); }
	painter.$el.remove();
	remote_painters.delete(client_id_);
}

/**
 * Runs `fn` with the paint globals set to the remote painter's, then puts everything back. Synchronous only.
 * @param {RemotePainter} painter
 * @param {() => void} fn
 */
function with_painter_globals(painter, fn) {
	const saved_globals = { pointer, pointer_previous, pointer_start, pointer_active, pointer_over_canvas, button, reverse, shift, ctrl, stroke_size, brush_size, brush_shape, eraser_size, airbrush_size, pencil_size, stroke_color, fill_color, selected_colors, tool_transparent_mode };
	const saved_ctx = { fillStyle: main_ctx.fillStyle, strokeStyle: main_ctx.strokeStyle, lineWidth: main_ctx.lineWidth };
	const saved_status = /** @type {any} */ (window).$status_size;
	const state = painter.state || {};
	pointer = painter.pointer;
	pointer_previous = painter.previous;
	pointer_start = painter.start;
	pointer_active = true;
	pointer_over_canvas = true;
	button = painter.button;
	reverse = painter.button === 2;
	shift = false;
	ctrl = false;
	stroke_size = state.stroke_size || 1;
	brush_size = state.brush_size || 4;
	brush_shape = state.brush_shape || "circle";
	eraser_size = state.eraser_size || 8;
	airbrush_size = state.airbrush_size || 9;
	pencil_size = state.pencil_size || 1;
	selected_colors = { foreground: state.foreground || "#000000", background: state.background || "#ffffff", ternary: state.ternary || "" };
	tool_transparent_mode = !!state.tool_transparent_mode;
	/** @type {any} */ (window).$status_size = { text() {} }; // the tools report sizes to the status bar; not for someone else's stroke
	try {
		if (painter.tool) { update_fill_and_stroke_colors_and_lineWidth(painter.tool); }
		fn();
	} finally {
		({ pointer, pointer_previous, pointer_start, pointer_active, pointer_over_canvas, button, reverse, shift, ctrl, stroke_size, brush_size, brush_shape, eraser_size, airbrush_size, pencil_size, stroke_color, fill_color, selected_colors, tool_transparent_mode } = saved_globals);
		main_ctx.fillStyle = saved_ctx.fillStyle;
		main_ctx.strokeStyle = saved_ctx.strokeStyle;
		main_ctx.lineWidth = saved_ctx.lineWidth;
		/** @type {any} */ (window).$status_size = saved_status;
	}
}

/** Draws the painter's tool preview (its own mask/shape/curve so far) onto the painter's overlay. */
function render_remote_painter(painter) {
	const ctx = painter.overlay.ctx;
	ctx.clearRect(0, 0, painter.overlay.width, painter.overlay.height);
	const tool = painter.tool;
	if (!tool) { return; }
	with_painter_globals(painter, () => {
		for (const draw of [tool.drawPreviewUnderGrid, tool.drawPreviewAboveGrid]) {
			if (!draw) { continue; }
			ctx.save();
			try {
				draw.call(tool, ctx, painter.pointer.x, painter.pointer.y, false, 1, 0, 0);
			} catch (error) {
				window.console?.warn("live sync: remote preview failed", error);
			}
			ctx.restore();
		}
	});
}

/** Forgets the stroke in progress (after its patch arrived, or it was canceled). @param {RemotePainter} painter */
function reset_remote_painter(painter) {
	if (painter.clear_timer) { clearTimeout(painter.clear_timer); painter.clear_timer = null; }
	if (painter.tool) {
		with_painter_globals(painter, () => { painter.tool.cancel?.(); });
	}
	painter.active = false;
	painter.overlay.ctx.clearRect(0, 0, painter.overlay.width, painter.overlay.height);
	const client = remote_clients.get([...remote_painters].find(([, p]) => p === painter)?.[0] || "");
	if (client) { render_remote_cursor(client); }
}

/** The painter's finished stroke landed as a patch: the preview has done its job. @param {string} client_id_ */
function finish_remote_stroke(client_id_) {
	const painter = remote_painters.get(client_id_);
	if (painter && (!painter.active || !painter.tool || !MULTI_STEP_TOOLS.has(painter.tool.id))) {
		reset_remote_painter(painter);
	}
}

/** @param {any} message */
function apply_remote_stroke(message) {
	const painter = get_remote_painter(message.client_id);
	const client = remote_clients.get(message.client_id);
	position_remote_overlay(painter);
	if (message.phase === "start") {
		if (painter.tool && painter.tool.id !== message.tool) { reset_remote_painter(painter); }
		if (painter.clear_timer) { clearTimeout(painter.clear_timer); painter.clear_timer = null; }
		painter.tool = STROKE_TOOLS.has(message.tool) ? painter.tools.find((tool) => tool.id === message.tool) || null : null;
		if (!painter.tool) { return; }
		painter.state = message.state || {};
		painter.button = message.button === 2 ? 2 : 0;
		painter.start = painter.previous = painter.pointer = { x: Number(message.x) || 0, y: Number(message.y) || 0 };
		painter.active = true;
		with_painter_globals(painter, () => {
			painter.tool.pointerdown?.(main_ctx, painter.pointer.x, painter.pointer.y);
			painter.tool.paint?.(main_ctx, painter.pointer.x, painter.pointer.y);
		});
		render_remote_painter(painter);
	} else if (message.phase === "move") {
		if (!painter.tool || !painter.active) { return; }
		for (const point of message.points || []) {
			painter.previous = painter.pointer;
			painter.pointer = { x: Number(point.x) || 0, y: Number(point.y) || 0 };
			with_painter_globals(painter, () => { painter.tool.paint?.(main_ctx, painter.pointer.x, painter.pointer.y); });
		}
		render_remote_painter(painter);
	} else if (message.phase === "end") {
		painter.active = false;
		if (painter.tool && !MULTI_STEP_TOOLS.has(painter.tool.id)) {
			painter.clear_timer = setTimeout(() => { reset_remote_painter(painter); }, STROKE_CLEAR_AFTER_END_MS);
		}
	} else if (message.phase === "cancel") {
		reset_remote_painter(painter);
	}
	if (client) {
		if (message.phase === "start" || message.phase === "move") { client.cursor = { ...painter.pointer }; }
		render_remote_cursor(client);
	}
}

/**
 * The local painter: a paint tool went down on the canvas. Streams the stroke until pointerup.
 * @param {JQuery.TriggeredEvent} e
 */
function begin_local_stroke(e) {
	if (!connected || !selected_tool || !STROKE_TOOLS.has(selected_tool.id) || (e.button !== 0 && e.button !== 2)) { return; }
	// Decided once per stroke: alone, the stroke isn't relayed at all (someone joining mid-stroke sees the finished
	// patch, which is what matters); with company, every phase goes out.
	if (remote_clients.size === 0 || Date.now() < slow_until) { return; }
	const start = to_canvas_coords(e);
	const id = `${client_id()}-${Date.now().toString(36)}`;
	const color = (/** @type {string | CanvasPattern} */ c) => typeof c === "string" ? c : "#000000";
	send({
		type: "stroke",
		id,
		phase: "start",
		tool: selected_tool.id,
		button: e.button,
		x: start.x,
		y: start.y,
		state: { stroke_size, brush_size, brush_shape, eraser_size, airbrush_size, pencil_size, foreground: color(selected_colors.foreground), background: color(selected_colors.background), ternary: color(selected_colors.ternary), tool_transparent_mode },
	});
	const stroke = local_stroke = { id, pending: [], timer: 0, last: start };
	const flush = () => {
		stroke.timer = 0;
		if (Date.now() < slow_until && local_stroke === stroke) { stroke.timer = window.setTimeout(flush, slow_until - Date.now()); return; } // (the room asked for a pause)
		if (stroke.pending.length && local_stroke === stroke) {
			send({ type: "stroke", id, phase: "move", points: stroke.pending.splice(0, 64) });
			if (stroke.pending.length) { stroke.timer = window.setTimeout(flush, STROKE_SEND_INTERVAL_MS); }
		}
	};
	const on_move = () => {
		// The app's own pointermove handler ran first (it was attached earlier), so `pointer` is the processed position.
		if (local_stroke !== stroke || !pointer) { return; }
		if (stroke.last && stroke.last.x === pointer.x && stroke.last.y === pointer.y) { return; }
		stroke.last = { x: pointer.x, y: pointer.y };
		stroke.pending.push(stroke.last);
		if (!stroke.timer) { stroke.timer = window.setTimeout(flush, STROKE_SEND_INTERVAL_MS); }
	};
	// Attach after the app's handlers (they attach during this same pointerdown), so ours sees the processed pointer.
	setTimeout(() => {
		if (local_stroke !== stroke) { return; }
		$G.on("pointermove", on_move);
		$G.one("pointerup pointercancel", (_event, canceling) => {
			$G.off("pointermove", on_move);
			if (stroke.timer) { clearTimeout(stroke.timer); }
			if (stroke.pending.length) { send({ type: "stroke", id, phase: "move", points: stroke.pending.splice(0, 64) }); }
			send({ type: "stroke", id, phase: canceling ? "cancel" : "end" });
			if (local_stroke === stroke) { local_stroke = null; }
		});
	}, 0);
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
	$G.on("site-page-opened", (_event, detail) => { join_page_room(detail.page, !!detail.authoritative, detail.reason || ""); });
	$G.on("site-page-restored", (_event, detail) => { join_page_room(detail.page, false); });
	$G.on("resize theme-load", () => {
		for (const client of remote_clients.values()) { position_remote_cursor(client); }
		for (const painter of remote_painters.values()) { position_remote_overlay(painter); }
	});
	$canvas_area.on("resize", () => { for (const painter of remote_painters.values()) { position_remote_overlay(painter); } });
	$canvas.on("pointerdown", (e) => { begin_local_stroke(e); });
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
			width: 0;
			height: 0;
		}
		.live-cursor-pointer {
			position: absolute;
			left: -12px;
			top: 0;
			width: 12px;
			height: 12px;
			display: block;
		}
		.live-cursor-pointer svg {
			display: block;
		}
		.live-cursor-pointer path {
			fill: var(--live-color);
			stroke: #000;
			stroke-width: 1;
		}
		.live-cursor-tool {
			position: absolute;
			left: -34px;
			top: 8px;
			width: 24px;
			height: 24px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: #fff;
			border: 1px solid #000;
			box-shadow: 1px 1px 0 var(--live-color);
			box-sizing: border-box;
		}
		.live-cursor-tool img {
			width: 16px;
			height: 16px;
			image-rendering: pixelated;
		}
		.remote-stroke-layer {
			position: absolute;
			z-index: 2; /* over the picture, under the elements */
			pointer-events: none;
		}
		.remote-stroke-layer > canvas {
			display: block;
			width: 100%;
			height: 100%;
			image-rendering: pixelated;
		}
		.live-cursor.painting .live-cursor-pointer path {
			stroke-width: 2;
		}
		.live-cursor-name {
			position: absolute;
			left: -34px;
			top: 34px;
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

/** @returns {{ connected: boolean, room: { site: string, page: string } | null, version: number, others: string[], client_id: string, name: string }} for tests, the menu, and the Page History window */
function live_sync_state() {
	return { connected, room: room ? { site: room.site, page: room.page } : null, version, others: [...remote_clients.values()].map((client) => client.name), client_id: client_id(), name: my_name() };
}

export { checkout_version, flush_live_sync, init_live_session, is_live_sync_enabled, join_page_room, leave_page_room, live_sync_state, request_history, restore_version, set_live_sync_enabled, set_my_name };
