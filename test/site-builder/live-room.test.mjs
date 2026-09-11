// The live room's WebSocket protocol (worker/editor/page-room.js), driven from Node with plain WebSockets:
// auth, seed + snapshot, ops relayed and merged, bitmap patches replayed to joiners, presence, replace.
// Needs the editor Worker running locally (in worker/: `npm run dev:editor`, secret in editor/.dev.vars):
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SECRET=dev-secret-123
import { assert } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !secret) {
	console.log("live-room: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `room-${Date.now().toString(36)}`;
const ws_base = editor.replace(/^http/, "ws");
const room_url = (page = "index.html", token = secret) => `${ws_base}/api/sites/${site}/rooms/${page}?token=${encodeURIComponent(token)}`;

/** A client that queues messages so tests can await the next one of a type. */
function connect(url) {
	const ws = new WebSocket(url);
	const queue = [];
	const waiters = [];
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		const index = waiters.findIndex((w) => w.type === message.type);
		if (index !== -1) { waiters.splice(index, 1)[0].resolve(message); } else { queue.push(message); }
	});
	const closed = new Promise((resolve) => ws.addEventListener("close", (event) => resolve(event)));
	return {
		ws,
		closed,
		/** resolves true when open, false if the connection was refused */
		opened: new Promise((resolve) => { ws.addEventListener("open", () => resolve(true)); ws.addEventListener("error", () => resolve(false)); }),
		send: (message) => ws.send(JSON.stringify(message)),
		/** @param {string} type */
		next(type, timeout = 10000) {
			const index = queue.findIndex((m) => m.type === type);
			if (index !== -1) { return Promise.resolve(queue.splice(index, 1)[0]); }
			return new Promise((resolve, reject) => {
				const waiter = { type, resolve };
				waiters.push(waiter);
				setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`timed out waiting for "${type}" (queued: ${queue.map((m) => m.type).join(",") || "none"})`)); }, timeout);
			});
		},
		has: (type) => queue.some((m) => m.type === type),
	};
}
const tiny_png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBCAgAo3EW2OJixQoAAAAASUVORK5CYII="; // 2×2

// Wrong token → refused before reaching the room
const anon = connect(room_url("index.html", "wrong"));
assert.equal(await anon.opened, false, "connection with a wrong secret is refused");
// Not a page → refused
assert.equal((await fetch(`${editor}/api/sites/${site}/rooms/notes.txt?token=${secret}`)).status, 400);
assert.equal((await fetch(`${editor}/api/sites/${site}/rooms/index.html?token=${secret}`)).status, 426, "needs a WebSocket upgrade");

// A joins an empty room and seeds it
const a = connect(room_url());
assert.equal(await a.opened, true, "connected with the secret");
a.send({ type: "hello", client_id: "aaa", name: "Alice", color: "#e6194b" });
let snapshot = await a.next("snapshot");
assert.equal(snapshot.version, 0);
assert.deepEqual(snapshot.clients, []);
assert.equal(snapshot.you.name, "Alice");
a.send({ type: "seed", width: 800, height: 600, page_properties: { bgcolor: "#ffffd9", column_left: 300, column_top: 40, column_width: 480, column_bogus: "x" }, layers: { blocks: [{ id: "b1", kind: "heading", tag: "h1", attrs: {}, html: "hi", x: 10, y: 10, width: 200, height: 40 }], stickers: [], text_layers: [] } });
assert.equal((await a.next("seeded")).version, 1);
a.send({ type: "bitmap", x: 0, y: 0, width: 2, height: 2, png: tiny_png, reset: true });
assert.equal((await a.next("ack")).version, 2);

// B joins: gets the seeded document, the patch, and sees Alice; Alice sees Bob join
const b = connect(room_url());
await b.opened;
b.send({ type: "hello", client_id: "bbb", name: "Bob", color: "#3cb44b" });
snapshot = await b.next("snapshot");
assert.equal(snapshot.version, 2);
assert.equal(snapshot.doc.width, 800);
assert.deepEqual(snapshot.doc.page_properties, { bgcolor: "#ffffd9", column_left: 300, column_top: 40, column_width: 480 }, "the sections column is kept (unknown keys are not)");
assert.equal(snapshot.doc.layers.blocks[0].html, "hi");
assert.equal(snapshot.patches.length, 1);
assert.equal(snapshot.patches[0].png, tiny_png);
assert.equal(snapshot.patches[0].reset, true);
assert.deepEqual(snapshot.clients.map((c) => c.name), ["Alice"]);
assert.equal((await a.next("join")).client.name, "Bob");

// Moving the column alone is a change: acked, stored, and told to the others
a.send({ type: "props", page_properties: { bgcolor: "#ffffd9", column_left: 120, column_top: 40, column_width: 480 }, client_op_id: "move-column" });
assert.equal((await a.next("ack")).client_op_id, "move-column");
assert.equal((await b.next("props")).page_properties.column_left, 120);

// Ops relay and merge: A moves the heading and adds a marquee; B sees both; a third joiner gets the merged doc
a.send({ type: "ops",
	ops: [
		{ kind: "blocks", op: "set", item: { id: "b1", kind: "heading", tag: "h1", attrs: {}, html: "hi", x: 50, y: 60, width: 200, height: 40 } },
		{ kind: "blocks", op: "set", item: { id: "b2", kind: "marquee", tag: "marquee", attrs: { scrollamount: "4" }, html: "~*~", x: 10, y: 100, width: 300, height: 24 } },
		{ kind: "blocks", op: "order", ids: ["b2", "b1"] },
	] });
const relayed = await b.next("ops");
assert.equal(relayed.client_id, "aaa");
assert.equal(relayed.ops.length, 3);
assert.equal(relayed.version, 4);
assert.equal((await a.next("ack")).version, 4);
// B removes the marquee; A sees it
b.send({ type: "ops", ops: [{ kind: "blocks", op: "remove", id: "b2" }] });
assert.deepEqual((await a.next("ops")).ops, [{ kind: "blocks", op: "remove", id: "b2" }]);
// B paints a patch; A gets it
b.send({ type: "bitmap", x: 4, y: 6, width: 2, height: 2, png: tiny_png });
const patch = await a.next("bitmap");
assert.equal(patch.x, 4);
assert.equal(patch.client_id, "bbb");
// Presence relays without touching the version
b.send({ type: "presence", cursor: { x: 1, y: 2 }, tool: "Pencil", editing: "b1" });
const presence = await a.next("presence");
assert.deepEqual(presence.cursor, { x: 1, y: 2 });
assert.equal(presence.editing, "b1");
a.send({ type: "ping" });
assert.equal((await a.next("pong")).version, 6);

// A third client sees the merged state: heading moved to 50,60, marquee gone, two patches in order
const c = connect(room_url());
await c.opened;
c.send({ type: "hello", client_id: "ccc", name: "Cid", color: "#0082c8" });
snapshot = await c.next("snapshot");
assert.equal(snapshot.version, 6);
assert.deepEqual(snapshot.doc.layers.blocks.map((block) => `${block.id}@${block.x},${block.y}`), ["b1@50,60"]);
assert.deepEqual(snapshot.patches.map((p) => `${p.x},${p.y}`), ["0,0", "4,6"]);
assert.deepEqual(snapshot.clients.map((client) => client.name).sort(), ["Alice", "Bob"]);

// Replace: C declares its copy the document; A and B are told to re-fetch; the patch log restarts
c.send({ type: "replace", width: 640, height: 480, page_properties: {}, layers: { blocks: [], stickers: [], text_layers: [] } });
assert.equal((await c.next("seeded")).version, 7);
assert.equal((await a.next("replaced")).client_id, "ccc");
await b.next("replaced");
c.send({ type: "bitmap", x: 0, y: 0, width: 2, height: 2, png: tiny_png, reset: true });
await c.next("ack");
a.send({ type: "hello", client_id: "aaa", name: "Alice", color: "#e6194b" });
snapshot = await a.next("snapshot");
assert.equal(snapshot.doc.width, 640);
assert.deepEqual(snapshot.doc.layers.blocks, []);
assert.equal(snapshot.patches.length, 1);

// Share keys: the owner mints one for a page; a guest joins that room with it, and only that room
const invite = await (await fetch(`${editor}/api/sites/${site}/rooms/index.html/invite`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ days: 7 }) })).json();
assert.match(invite.key, /^\d+\.[A-Za-z0-9_-]{16}$/, JSON.stringify(invite));
assert.equal((await fetch(`${editor}/api/sites/${site}/rooms/index.html/invite`, { method: "POST" })).status, 401, "minting needs the secret");
const guest = connect(`${ws_base}/api/sites/${site}/rooms/index.html?invite=${invite.key}`);
assert.equal(await guest.opened, true, "a guest joins with the key");
guest.send({ type: "hello", client_id: "ggg", name: "Guest", color: "#f58231" });
snapshot = await guest.next("snapshot");
assert.equal(snapshot.doc.width, 640);
const other_room = connect(`${ws_base}/api/sites/${site}/rooms/about.html?invite=${invite.key}`);
assert.equal(await other_room.opened, false, "the key is for one page");
const tampered = connect(`${ws_base}/api/sites/${site}/rooms/index.html?invite=${invite.key.replace(/.$/, (c) => c === "A" ? "B" : "A")}`);
assert.equal(await tampered.opened, false, "a tampered key is refused");
// …and may save that page (and media), nothing else
const guest_headers = { Authorization: `Invite ${invite.key}`, "X-Invite-Page": "index.html" };
assert.equal((await fetch(`${editor}/api/sites/${site}/files`, { headers: guest_headers })).status, 200, "guests can list");
assert.equal((await fetch(`${editor}/api/sites/${site}/files/index.html`, { method: "PUT", headers: { ...guest_headers, "Content-Type": "text/html" }, body: "<html><body><center><div class=\"collage\"></div></center></body></html>" })).status, 200, "guests save their page");
assert.equal((await fetch(`${editor}/api/sites/${site}/files/other.html`, { method: "PUT", headers: { ...guest_headers, "Content-Type": "text/html" }, body: "<html><body></body></html>" })).status, 403, "…but not another page");
assert.equal((await fetch(`${editor}/api/sites/${site}/files/index.html`, { method: "DELETE", headers: guest_headers })).status, 403, "…and can't delete");
assert.equal((await fetch(`${editor}/api/sites/${site}/files/index.html`, { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } })).status, 200);
guest.ws.close();
assert.equal((await a.next("leave")).client_id, "ggg");

// Leaving is announced; bad messages get errors, not disconnects
b.ws.close(1000, "bye");
assert.equal((await a.next("leave")).client_id, "bbb");
a.send({ type: "ops", ops: [{ kind: "nonsense", op: "set", item: { id: "x" } }] });
a.send({ type: "wat" });
assert.equal((await a.next("error")).message, "Unknown message type wat");
assert.equal(a.ws.readyState, WebSocket.OPEN);

a.ws.close();
c.ws.close();
console.log("live-room: ok");
