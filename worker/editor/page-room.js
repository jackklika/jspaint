// @ts-check
// PageRoom: one Durable Object per page of a site ("jack/index.html"), the live draft everyone editing that page
// shares. Editors connect over a WebSocket (editor Worker: GET /api/sites/:name/rooms/:page?token=…); the room
// is the single writer: it applies each change to its copy of the document, stamps it with a version, stores
// it (SQLite), and broadcasts it to everyone else. Joiners get a snapshot. Presence (cursors, who's editing what)
// is relayed but not stored. Publishing to the public page stays a client action (Save to My Site); this is the draft.
//
// Document = { width, height, page_properties, layers: { blocks, stickers, text_layers } } + the bitmap as an
// ordered list of PNG patches (a full picture is sent as horizontal bands with `reset` on the first).
// Stickers reference site files (gifs/<hash>.gif); clients upload before they send.
//
// Messages (JSON):
//   client → room:  hello {client_id, name, color} · seed / replace {width, height, page_properties, layers}
//                   ops {ops: [{kind, op: "set"|"remove"|"order", item?|id?|ids?}], client_op_id}
//                   bitmap {x, y, width, height, png (base64), reset?} · props {width?, height?, page_properties?}
//                   presence {cursor, tool, selected, editing} · stroke {id, phase, tool, button, x, y, points, state} · ping
//   room → client:  snapshot {version, doc, patches, clients, you} · seeded / ack {version} · replaced · ops {version, client_id, ops}
//                   bitmap {version, client_id, x, y, width, height, png, reset} · props {version, client_id, …}
//                   presence {client_id, …} · join {client} · leave {client_id} · request_snapshot · error {message} · pong
import { DurableObject } from "cloudflare:workers";

const KINDS = new Set(["blocks", "stickers", "text_layers"]);
const MAX_PATCHES = 60; // then ask a client for a fresh full picture
const MAX_PATCH_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 900 * 1024; // Workers cap WebSocket messages at 1 MiB
const MAX_CLIENTS = 16;

/** @param {string} base64 */
function base64_bytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
	return bytes;
}
/** @param {Uint8Array | ArrayBuffer} bytes */
function bytes_base64(bytes) {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (let i = 0; i < view.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, /** @type {number[]} */ (/** @type {unknown} */ (view.subarray(i, i + 0x8000))));
	}
	return btoa(binary);
}

export class PageRoom extends DurableObject {
	/**
	 * @param {DurableObjectState} ctx
	 * @param {any} env
	 */
	constructor(ctx, env) {
		super(ctx, env);
		/** @type {{ version: number, width: number, height: number, page_properties: Record<string, string>, layers: { blocks: any[], stickers: any[], text_layers: any[] } }} */
		this.doc = { version: 0, width: 0, height: 0, page_properties: {}, layers: { blocks: [], stickers: [], text_layers: [] } };
		this.ctx.blockConcurrencyWhile(() => {
			const sql = this.ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			sql.exec("CREATE TABLE IF NOT EXISTS patches (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, x INTEGER, y INTEGER, width INTEGER, height INTEGER, reset INTEGER NOT NULL DEFAULT 0, png BLOB NOT NULL)");
			const row = sql.exec("SELECT value FROM state WHERE key = 'doc'").toArray()[0];
			if (row) {
				this.doc = JSON.parse(String(row.value));
			}
			return Promise.resolve();
		});
	}
	// ---- storage ----
	save_doc() {
		this.ctx.storage.sql.exec("INSERT INTO state (key, value) VALUES ('doc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(this.doc));
	}
	/** @returns {{ version: number, x: number, y: number, width: number, height: number, reset: boolean, png: string }[]} */
	load_patches() {
		return this.ctx.storage.sql.exec("SELECT version, x, y, width, height, reset, png FROM patches ORDER BY id").toArray().map((row) => ({
			version: Number(row.version), x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height), reset: !!row.reset, png: bytes_base64(/** @type {ArrayBuffer} */ (row.png)),
		}));
	}
	patch_stats() {
		const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(png)), 0) AS bytes FROM patches").one();
		return { count: Number(row.n), bytes: Number(row.bytes) };
	}
	// ---- connections ----
/** @param {Request} request */
	fetch(request) {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected a WebSocket", { status: 426 });
		}
		if (this.ctx.getWebSockets().length >= MAX_CLIENTS) {
			return new Response("The room is full", { status: 503 });
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ client_id: null, name: "", color: "" });
		return new Response(null, { status: 101, webSocket: client });
	}
/** @returns {{ client_id: string, name: string, color: string }[]} */
	clients() {
		return this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()).filter((info) => info && info.client_id);
	}
	/**
	 * @param {any} message
	 * @param {WebSocket} [except]
	 */
	broadcast(message, except) {
		const text = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except) { continue; }
			try {
				ws.send(text);
			} catch (_error) { /* closing */ }
		}
	}
	/** @param {WebSocket} ws @param {any} message */
	send(ws, message) {
		try {
			ws.send(JSON.stringify(message));
		} catch (_error) { /* closing */ }
	}
/**
	 * @param {WebSocket} ws
	 * @param {string | ArrayBuffer} raw
	 */
	webSocketMessage(ws, raw) {
		if (typeof raw !== "string") { return; }
		if (raw.length > MAX_MESSAGE_BYTES * 1.4) {
			this.send(ws, { type: "error", message: "Message too large" });
			return;
		}
		let message;
		try {
			message = JSON.parse(raw);
		} catch (_error) {
			this.send(ws, { type: "error", message: "Bad JSON" });
			return;
		}
		const info = ws.deserializeAttachment() || {};
		if (message.type === "hello") {
			const client_id = String(message.client_id || "").slice(0, 40) || crypto.randomUUID();
			const next = { client_id, name: String(message.name || "Someone").slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(message.color || "") ? message.color : "#000080" };
			ws.serializeAttachment(next);
			this.send(ws, {
				type: "snapshot",
				version: this.doc.version,
				doc: { width: this.doc.width, height: this.doc.height, page_properties: this.doc.page_properties, layers: this.doc.layers },
				patches: this.load_patches(),
				clients: this.clients().filter((client) => client.client_id !== client_id),
				you: next,
			});
			this.broadcast({ type: "join", client: next }, ws);
			return;
		}
		if (!info.client_id) {
			this.send(ws, { type: "error", message: "Say hello first" });
			return;
		}
		switch (message.type) {
			case "ping":
				this.send(ws, { type: "pong", version: this.doc.version });
				break;
			case "presence":
				this.broadcast({ type: "presence", client_id: info.client_id, cursor: message.cursor ?? null, tool: message.tool ?? null, selected: message.selected ?? null, editing: message.editing ?? null }, ws);
				break;
			case "stroke":
				// A stroke in progress (start / move / end / cancel): relayed, never stored — the finished stroke
				// arrives as a bitmap patch. Receivers replay it with their own copy of the painter's tool.
				if (!/^(start|move|end|cancel)$/.test(message.phase || "") || typeof message.id !== "string" || message.id.length > 40) { return; }
				if (Array.isArray(message.points) && message.points.length > 64) { message.points = message.points.slice(-64); }
				this.broadcast({ type: "stroke", client_id: info.client_id, id: message.id, phase: message.phase, tool: message.tool, button: message.button, x: message.x, y: message.y, points: message.points, state: message.state }, ws);
				break;
			case "seed":
			case "replace":
				// `seed`: the first client in an empty room brings the document. `replace`: a client that just
				// published (or created) the page declares its copy the document; everyone else re-fetches.
				if (message.type === "seed" && this.doc.version !== 0) {
					this.send(ws, { type: "error", message: "The room already has a document" });
					return;
				}
				this.apply_props(message);
				if (message.layers) {
					for (const kind of KINDS) {
						this.doc.layers[kind] = Array.isArray(message.layers[kind]) ? message.layers[kind].slice(0, 500) : [];
					}
				}
				this.doc.version++;
				this.ctx.storage.sql.exec("DELETE FROM patches"); // the full picture follows as bands
				this.save_doc();
				this.send(ws, { type: "seeded", version: this.doc.version });
				if (message.type === "replace") {
					this.broadcast({ type: "replaced", version: this.doc.version, client_id: info.client_id }, ws);
				}
				break;
			case "props":
				if (!this.apply_props(message)) { return; }
				this.doc.version++;
				this.save_doc();
				this.broadcast({ type: "props", version: this.doc.version, client_id: info.client_id, width: this.doc.width, height: this.doc.height, page_properties: this.doc.page_properties }, ws);
				this.send(ws, { type: "ack", version: this.doc.version, client_op_id: message.client_op_id ?? null });
				break;
			case "ops": {
				const ops = Array.isArray(message.ops) ? message.ops.filter((op) => this.apply_op(op)) : [];
				if (ops.length === 0) { return; }
				this.doc.version++;
				this.save_doc();
				this.broadcast({ type: "ops", version: this.doc.version, client_id: info.client_id, ops }, ws);
				this.send(ws, { type: "ack", version: this.doc.version, client_op_id: message.client_op_id ?? null });
				break;
			}
			case "bitmap": {
				const { x, y, width, height } = message;
				if (![x, y, width, height].every((n) => Number.isInteger(n) && n >= 0) || width === 0 || height === 0 || typeof message.png !== "string" || !message.png) {
					this.send(ws, { type: "error", message: "Bad bitmap patch" });
					return;
				}
				const png = base64_bytes(message.png);
				if (png.length > MAX_MESSAGE_BYTES) {
					this.send(ws, { type: "error", message: "Patch too large" });
					return;
				}
				this.doc.version++;
				if (message.reset) {
					this.ctx.storage.sql.exec("DELETE FROM patches");
				}
				this.ctx.storage.sql.exec("INSERT INTO patches (version, x, y, width, height, reset, png) VALUES (?, ?, ?, ?, ?, ?, ?)", this.doc.version, x, y, width, height, message.reset ? 1 : 0, png);
				this.save_doc();
				this.broadcast({ type: "bitmap", version: this.doc.version, client_id: info.client_id, x, y, width, height, png: message.png, reset: !!message.reset }, ws);
				this.send(ws, { type: "ack", version: this.doc.version, client_op_id: message.client_op_id ?? null });
				const stats = this.patch_stats();
				if (stats.count > MAX_PATCHES || stats.bytes > MAX_PATCH_BYTES) {
					// Too much to replay for a newcomer: the last painter sends a fresh full picture (bands with reset).
					this.send(ws, { type: "request_snapshot" });
				}
				break;
			}
			default:
				this.send(ws, { type: "error", message: `Unknown message type ${message.type}` });
		}
	}
/** @param {any} message */
	apply_props(message) {
		let changed = false;
		if (Number.isInteger(message.width) && Number.isInteger(message.height) && message.width > 0 && message.height > 0 && message.width <= 8000 && message.height <= 8000) {
			if (this.doc.width !== message.width || this.doc.height !== message.height) {
				this.doc.width = message.width;
				this.doc.height = message.height;
				changed = true;
			}
		}
		if (message.page_properties && typeof message.page_properties === "object") {
			/** @type {Record<string, string>} */
			const props = {};
			for (const key of ["bgcolor", "text_color", "background"]) {
				if (typeof message.page_properties[key] === "string") { props[key] = message.page_properties[key].slice(0, 500); }
			}
			if (JSON.stringify(props) !== JSON.stringify(this.doc.page_properties)) {
				this.doc.page_properties = props;
				changed = true;
			}
		}
		return changed;
	}
/**
	 * Applies one layer operation to the document. Elements are matched by id; the last writer wins.
	 * @param {any} op
	 * @returns {boolean} whether it was valid
	 */
	apply_op(op) {
		if (!op || !KINDS.has(op.kind)) { return false; }
		const list = this.doc.layers[op.kind];
		if (op.op === "set" && op.item && typeof op.item.id === "string") {
			if (JSON.stringify(op.item).length > 200 * 1024) { return false; }
			const index = list.findIndex((item) => item.id === op.item.id);
			if (index === -1) {
				if (list.length >= 500) { return false; }
				list.push(op.item);
			} else {
				list[index] = op.item;
			}
			return true;
		}
		if (op.op === "remove" && typeof op.id === "string") {
			const index = list.findIndex((item) => item.id === op.id);
			if (index !== -1) { list.splice(index, 1); }
			return true;
		}
		if (op.op === "order" && Array.isArray(op.ids)) {
			const by_id = new Map(list.map((item) => [item.id, item]));
			const ordered = op.ids.map((id) => by_id.get(id)).filter(Boolean);
			for (const item of list) {
				if (!ordered.includes(item)) { ordered.push(item); } // anything the sender didn't know about stays on top
			}
			this.doc.layers[op.kind] = ordered;
			return true;
		}
		return false;
	}
/** @param {WebSocket} ws */
	webSocketClose(ws) {
		const info = ws.deserializeAttachment();
		if (info && info.client_id) {
			this.broadcast({ type: "leave", client_id: info.client_id }, ws);
		}
	}
	/** @param {WebSocket} ws */
	webSocketError(ws) {
		this.webSocketClose(ws);
	}
}
