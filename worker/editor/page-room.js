// @ts-check
// PageRoom: one Durable Object per page of a site ("yourname/index.html"), the live draft everyone editing that page
// shares. Editors connect over a WebSocket (editor Worker: GET /api/sites/:name/rooms/:page?token=…); the room
// is the single writer: it applies each change to its copy of the document, stamps it with a version, stores
// it (SQLite), and broadcasts it to everyone else. Joiners get a snapshot. Presence (cursors, who's editing what)
// is relayed but not stored. Publishing to the public page stays a client action (Save to My Site); this is the draft.
//
// Document = { width, height, page_properties, layers: { blocks, stickers, text_layers } } + the bitmap as an
// ordered list of PNG patches (a full picture is sent as horizontal bands with `reset` on the first).
// Stickers reference site files (gifs/<hash>.gif); clients upload before they send.
//
// History: every change is kept as a version — who, when, what, and its parent (the version it was made on) —
// so the page's history is a tree, like Paint's own undo tree but shared: `restore {id}` moves the room's head
// to an older version (the document becomes that state, everyone re-fetches), and the next change branches
// from there; the versions after it stay, as a branch. Any version can be rebuilt: the layers from the nearest
// checkpoint (a full copy of the document, kept on seeds/replaces, on full-picture resets, and every 25th
// version) plus the ops/props after it; the bitmap from the nearest full picture (`reset`) plus the patches
// after it. History is bounded (MAX_VERSIONS / MAX_HISTORY_BYTES): the oldest versions go first, never those
// the head is built from; a version whose base is gone is listed but can't be brought back (`ok: false`).
//
// Messages (JSON):
//   client → room:  hello {client_id, name, color} · seed / replace {width, height, page_properties, layers, label?}
//                   ops {ops: [{kind, op: "set"|"remove"|"order", item?|id?|ids?}], client_op_id, label?}
//                   bitmap {x, y, width, height, png (base64), reset?, label?} · props {width?, height?, page_properties?, label?}
//                   presence {cursor, tool, tool_id, selected, editing} · stroke {id, phase, tool, button, x, y, points, state} · ping
//                   history · checkout {id} · restore {id}
//   room → client:  snapshot {version, doc, patches, clients, you} · seeded / ack {version} · replaced · ops {version, client_id, ops}
//                   bitmap {version, client_id, x, y, width, height, png, reset} · props {version, client_id, …}
//                   presence {client_id, …} · join {client} · leave {client_id} · request_snapshot · error {message} · pong
//                   history {head, versions: [{id, parent, client_id, name, color, at, kind, label, ok}]}
//                   state {id, doc, patches} (or {id, error}) · restored {version, client_id, name} (to everyone, the restorer too)
import { DurableObject } from "cloudflare:workers";

const KINDS = new Set(["blocks", "stickers", "text_layers"]);
const MAX_PATCHES = 60; // then ask a client for a fresh full picture
const MAX_PATCH_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 900 * 1024; // Workers cap WebSocket messages at 1 MiB
const MAX_CLIENTS = 16;
const MAX_VERSIONS = 500; // of history, per page
const MAX_HISTORY_BYTES = 48 * 1024 * 1024; // of bitmap patches in the history
const CHECKPOINT_EVERY = 25; // versions between full copies of the document (layers), for rebuilding old versions
const MAX_LABEL = 60;
/** What a change is called when the client doesn't say. @type {Record<string, string>} */
const KIND_LABELS = { seed: "First draft", replace: "Draft replaced", ops: "Elements changed", props: "Page changed", bitmap: "Painted" };

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

/** A stored bitmap version as a patch message. @param {any} row */
function patch_of(row) {
	return { version: Number(row.id), x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height), reset: !!row.reset, png: bytes_base64(/** @type {ArrayBuffer} */ (row.png)) };
}
/**
 * Applies one layer operation to a document. Elements are matched by id; the last writer wins.
 * @param {{ layers: Record<string, any[]> }} doc
 * @param {any} op
 * @returns {boolean} whether it was valid
 */
function apply_op_to(doc, op) {
	if (!op || !KINDS.has(op.kind)) { return false; }
	const list = doc.layers[op.kind];
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
		doc.layers[op.kind] = ordered;
		return true;
	}
	return false;
}

export class PageRoom extends DurableObject {
	/**
	 * @param {DurableObjectState} ctx
	 * @param {any} env
	 */
	constructor(ctx, env) {
		super(ctx, env);
		/**
		 * The document at the head. `version` is the last version id given out (ids only ever grow); `head` is the
		 * version this document is the state of — the newest, unless someone went back in the history.
		 * @type {{ version: number, width: number, height: number, page_properties: Record<string, string | number>, layers: { blocks: any[], stickers: any[], text_layers: any[] } }}
		 */
		this.doc = { version: 0, width: 0, height: 0, page_properties: {}, layers: { blocks: [], stickers: [], text_layers: [] } };
		this.head = 0;
		this.ctx.blockConcurrencyWhile(() => {
			const sql = this.ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			sql.exec("CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL DEFAULT 0, client_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', payload TEXT, x INTEGER, y INTEGER, width INTEGER, height INTEGER, reset INTEGER NOT NULL DEFAULT 0, png BLOB, doc TEXT)");
			sql.exec("CREATE INDEX IF NOT EXISTS versions_parent ON versions (parent)");
			const row = sql.exec("SELECT value FROM state WHERE key = 'doc'").toArray()[0];
			if (row) {
				this.doc = JSON.parse(String(row.value));
			}
			const head = sql.exec("SELECT value FROM state WHERE key = 'head'").toArray()[0];
			if (head) {
				this.head = Number(head.value) || 0;
			} else if (this.doc.version > 0) {
				this.migrate();
			}
			return Promise.resolve();
		});
	}
	// ---- storage ----
	save_doc() {
		this.ctx.storage.sql.exec("INSERT INTO state (key, value) VALUES ('doc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(this.doc));
	}
	save_head() {
		this.ctx.storage.sql.exec("INSERT INTO state (key, value) VALUES ('head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(this.head));
	}
	/** The document without its counter: what a version's checkpoint holds, and what a snapshot sends. */
	doc_state() {
		return { width: this.doc.width, height: this.doc.height, page_properties: this.doc.page_properties, layers: this.doc.layers };
	}
	/** A room from before history was kept: its document becomes the root version, its patch list the bitmap chain. */
	migrate() {
		const sql = this.ctx.storage.sql;
		const has_patches = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'patches'").toArray().length > 0;
		const patches = has_patches ? sql.exec("SELECT x, y, width, height, reset, png FROM patches ORDER BY id").toArray() : [];
		const at = Date.now();
		let id = this.doc.version + 1;
		sql.exec("INSERT INTO versions (id, parent, at, kind, label, doc) VALUES (?, 0, ?, 'replace', 'Before history was kept', ?)", id, at, JSON.stringify(this.doc_state()));
		for (const row of patches) {
			sql.exec("INSERT INTO versions (id, parent, at, kind, label, x, y, width, height, reset, png) VALUES (?, ?, ?, 'bitmap', 'Painted', ?, ?, ?, ?, ?, ?)", id + 1, id, at, row.x, row.y, row.width, row.height, row.reset ? 1 : 0, row.png);
			id++;
		}
		if (has_patches) { sql.exec("DROP TABLE patches"); }
		this.doc.version = id;
		this.head = id;
		this.save_doc();
		this.save_head();
	}
	/**
	 * Keeps a change as a version on the head (the new head), with a checkpoint of the document when it's due.
	 * @param {{ client_id?: string, name?: string, color?: string }} info - who
	 * @param {string} kind
	 * @param {any} label
	 * @param {{ payload?: any, patch?: { x: number, y: number, width: number, height: number, reset: boolean, png: Uint8Array }, part?: boolean }} [extra] - `part`: a later band of a full picture, listed with no label of its own (the viewer folds it into the first)
	 */
	record(info, kind, label, extra = {}) {
		const id = ++this.doc.version;
		const parent = this.head;
		const text = extra.part ? "" : typeof label === "string" && label.trim() ? label.trim().slice(0, MAX_LABEL) : KIND_LABELS[kind] || kind;
		const patch = extra.patch;
		const checkpoint = kind === "seed" || kind === "replace" || !!patch?.reset || id % CHECKPOINT_EVERY === 0;
		this.ctx.storage.sql.exec(
			"INSERT INTO versions (id, parent, client_id, name, color, at, kind, label, payload, x, y, width, height, reset, png, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, parent, info.client_id || "", info.name || "", info.color || "", Date.now(), kind, text, extra.payload === undefined ? null : JSON.stringify(extra.payload),
			patch ? patch.x : null, patch ? patch.y : null, patch ? patch.width : null, patch ? patch.height : null, patch?.reset ? 1 : 0, patch ? patch.png : null,
			checkpoint ? JSON.stringify(this.doc_state()) : null,
		);
		this.head = id;
		this.save_doc();
		this.save_head();
		if (id % 10 === 0) { this.prune(); }
		return id;
	}
	/**
	 * The versions a version is built from: itself and its ancestors up to (and including) the nearest one that
	 * satisfies `stop` — a checkpoint (`doc IS NOT NULL`) for the layers, a full picture (`reset`) for the bitmap.
	 * Oldest first. Stops early where an ancestor is gone (pruned): then the base is missing.
	 * @param {number} id
	 * @param {"doc" | "reset"} stop
	 * @returns {{ rows: any[], complete: boolean }}
	 */
	base_path(id, stop) {
		const rows = this.ctx.storage.sql.exec(
			`WITH RECURSIVE chain(id, parent, done, depth) AS (
				SELECT id, parent, ${stop === "doc" ? "doc IS NOT NULL" : "reset"}, 0 FROM versions WHERE id = ?
				UNION ALL
				SELECT v.id, v.parent, ${stop === "doc" ? "v.doc IS NOT NULL" : "v.reset"}, c.depth + 1 FROM versions v JOIN chain c ON v.id = c.parent WHERE NOT c.done AND c.depth < 3000
			)
			SELECT v.id, v.parent, v.kind, v.payload, v.doc, v.x, v.y, v.width, v.height, v.reset, v.png, c.done FROM chain c JOIN versions v ON v.id = c.id ORDER BY v.id`,
			id,
		).toArray();
		const oldest = rows[0];
		// Complete when the walk ended at a base — or at the very first version (nothing before it: a blank picture)
		const complete = !!oldest && (!!oldest.done || Number(oldest.parent) === 0);
		return { rows, complete };
	}
	/**
	 * The document and bitmap patches as they were at a version, or null when its base was pruned away.
	 * @param {number} id
	 */
	state_at(id) {
		const layers = this.base_path(id, "doc");
		if (!layers.rows.length || !layers.complete || layers.rows[0].doc == null) { return null; }
		const doc = JSON.parse(String(layers.rows[0].doc));
		for (const row of layers.rows.slice(1)) {
			if (row.kind === "ops" && row.payload) {
				for (const op of JSON.parse(String(row.payload))) { apply_op_to(doc, op); }
			} else if (row.kind === "props" && row.payload) {
				Object.assign(doc, JSON.parse(String(row.payload)));
			}
		}
		const bitmap = this.base_path(id, "reset");
		if (!bitmap.complete) { return null; }
		return { doc, patches: bitmap.rows.filter((row) => row.kind === "bitmap").map((row) => patch_of(row)) };
	}
	/** @returns {{ version: number, x: number, y: number, width: number, height: number, reset: boolean, png: string }[]} the head's bitmap, as patches to replay */
	load_patches() {
		if (!this.head) { return []; }
		return this.base_path(this.head, "reset").rows.filter((row) => row.kind === "bitmap").map((row) => patch_of(row));
	}
	/** How much a newcomer would have to replay for the head's bitmap. */
	patch_stats() {
		if (!this.head) { return { count: 0, bytes: 0 }; }
		const rows = this.base_path(this.head, "reset").rows.filter((row) => row.kind === "bitmap");
		return { count: rows.length, bytes: rows.reduce((sum, row) => sum + (row.png ? /** @type {ArrayBuffer} */ (row.png).byteLength : 0), 0) };
	}
	/** Every version, oldest first, with whether it can still be brought back (its bases are here). */
	history() {
		const rows = this.ctx.storage.sql.exec("SELECT id, parent, client_id, name, color, at, kind, label, reset, doc IS NOT NULL AS checkpoint FROM versions ORDER BY id").toArray();
		/** @type {Map<number, any>} */
		const by_id = new Map(rows.map((row) => [Number(row.id), row]));
		/** @type {Map<number, boolean>} */
		const ok = new Map();
		const restorable = (/** @type {number} */ id) => {
			if (ok.has(id)) { return /** @type {boolean} */ (ok.get(id)); }
			let found_doc = false, found_reset = false, result = false;
			for (let cur = id, steps = 0; steps < 3000; steps++) {
				const row = by_id.get(cur);
				if (!row) { result = cur === 0 && found_doc; break; } // the first version's parent is 0: a blank picture before it
				if (row.checkpoint) { found_doc = true; }
				if (row.reset) { found_reset = true; }
				if (found_doc && found_reset) { result = true; break; }
				cur = Number(row.parent);
			}
			ok.set(id, result);
			return result;
		};
		return {
			head: this.head,
			versions: rows.map((row) => ({
				id: Number(row.id),
				parent: Number(row.parent),
				client_id: String(row.client_id),
				name: String(row.name),
				color: String(row.color),
				at: Number(row.at),
				kind: String(row.kind),
				label: String(row.label),
				ok: restorable(Number(row.id)),
			})),
		};
	}
	/** Trims the history to its caps, oldest versions first — never the ones the head is built from. */
	prune() {
		const sql = this.ctx.storage.sql;
		const totals = sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(png)), 0) AS bytes FROM versions").one();
		let count = Number(totals.n), bytes = Number(totals.bytes);
		if (count <= MAX_VERSIONS && bytes <= MAX_HISTORY_BYTES) { return; }
		const keep = new Set([...this.base_path(this.head, "doc").rows, ...this.base_path(this.head, "reset").rows].map((row) => Number(row.id)));
		for (const row of sql.exec("SELECT id, COALESCE(LENGTH(png), 0) AS bytes FROM versions ORDER BY id").toArray()) {
			if (count <= MAX_VERSIONS * 0.9 && bytes <= MAX_HISTORY_BYTES * 0.9) { break; }
			if (keep.has(Number(row.id))) { continue; }
			sql.exec("DELETE FROM versions WHERE id = ?", row.id);
			count--;
			bytes -= Number(row.bytes);
		}
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
	/** How many are in the room right now (the editor's globe shows "N editing"). */
	client_count() {
		return this.clients().length;
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
				version: this.head,
				doc: this.doc_state(),
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
				this.send(ws, { type: "pong", version: this.head });
				break;
			case "history":
				this.send(ws, { type: "history", ...this.history() });
				break;
			case "checkout": {
				// A look at an older version (the viewer's preview): its document and bitmap, rebuilt
				const id = Number(message.id);
				const state = Number.isInteger(id) && id > 0 ? this.state_at(id) : null;
				this.send(ws, state ? { type: "state", id, doc: state.doc, patches: state.patches } : { type: "state", id, error: "That version is too old to bring back." });
				break;
			}
			case "restore": {
				// Back (or forward) to a version: it becomes the head — the document everyone has — and the next change
				// branches from it. Nothing is deleted: the versions after it stay, as a branch.
				const id = Number(message.id);
				if (!Number.isInteger(id) || id <= 0) { this.send(ws, { type: "error", message: "Bad version" }); return; }
				if (id === this.head) { this.send(ws, { type: "restored", version: id, client_id: info.client_id, name: info.name }); return; }
				const state = this.state_at(id);
				if (!state) { this.send(ws, { type: "state", id, error: "That version is too old to bring back." }); return; }
				this.doc = { version: this.doc.version, ...state.doc };
				this.head = id;
				this.save_doc();
				this.save_head();
				this.broadcast({ type: "restored", version: id, client_id: info.client_id, name: info.name });
				break;
			}
			case "presence":
				this.broadcast({ type: "presence", client_id: info.client_id, cursor: message.cursor ?? null, tool: message.tool ?? null, tool_id: message.tool_id ?? null, selected: message.selected ?? null, editing: message.editing ?? null }, ws);
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
				this.record(info, message.type, message.label); // (a checkpoint; the full picture follows as bands, the first a reset)
				this.send(ws, { type: "seeded", version: this.head });
				if (message.type === "replace") {
					this.broadcast({ type: "replaced", version: this.head, client_id: info.client_id }, ws);
				}
				break;
			case "props": {
				if (!this.apply_props(message)) { return; }
				const version = this.record(info, "props", message.label, { payload: { width: this.doc.width, height: this.doc.height, page_properties: this.doc.page_properties } });
				this.broadcast({ type: "props", version, client_id: info.client_id, width: this.doc.width, height: this.doc.height, page_properties: this.doc.page_properties }, ws);
				this.send(ws, { type: "ack", version, client_op_id: message.client_op_id ?? null });
				break;
			}
			case "ops": {
				const ops = Array.isArray(message.ops) ? message.ops.filter((op) => apply_op_to(this.doc, op)) : [];
				if (ops.length === 0) { return; }
				const version = this.record(info, "ops", message.label, { payload: ops });
				this.broadcast({ type: "ops", version, client_id: info.client_id, ops }, ws);
				this.send(ws, { type: "ack", version, client_op_id: message.client_op_id ?? null });
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
				const version = this.record(info, "bitmap", message.label, { patch: { x, y, width, height, reset: !!message.reset, png }, part: !!message.part });
				this.broadcast({ type: "bitmap", version, client_id: info.client_id, x, y, width, height, png: message.png, reset: !!message.reset }, ws);
				this.send(ws, { type: "ack", version, client_op_id: message.client_op_id ?? null });
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
			/** @type {Record<string, string | number>} */
			const props = {};
			for (const key of ["bgcolor", "text_color", "background"]) {
				if (typeof message.page_properties[key] === "string") { props[key] = message.page_properties[key].slice(0, 500); }
			}
			// The sections column (where the writing stacks): kept too, so every tab lays the sections out the same way
			for (const key of ["column_left", "column_top", "column_width"]) {
				const value = message.page_properties[key];
				if (Number.isInteger(value) && value >= 0 && value <= 20000) { props[key] = value; }
			}
			if (JSON.stringify(props) !== JSON.stringify(this.doc.page_properties)) {
				this.doc.page_properties = props;
				changed = true;
			}
		}
		return changed;
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
