// The live room's brakes (page-room.js `allow`, MALICIOUS_ACTOR_PLAN.md phase 0): a burst past the bucket gets a
// `slow-down` and stays connected — cursors are dropped, the connection isn't; a flood that keeps going is closed
// with 1013 ("slow down"), and a fresh connection is welcome again. Needs the editor Worker running locally:
//   SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SECRET=…
import { assert } from "./helpers.mjs";

const editor = process.env.SITE_BUILDER_EDITOR_URL;
const secret = process.env.SITE_BUILDER_SECRET;
if (!editor || !secret) {
	console.log("room-limits: skipped (set SITE_BUILDER_EDITOR_URL, SITE_BUILDER_SECRET)");
	process.exit(0);
}
const site = `brake-${Date.now().toString(36)}`;
const url = `${editor.replace(/^http/, "ws")}/api/sites/${site}/rooms/index.html?token=${encodeURIComponent(secret)}`;

/** A client that queues messages so the test can await the next one of a type. */
function connect() {
	const ws = new WebSocket(url);
	const queue = [];
	const waiters = [];
	let count = 0;
	ws.addEventListener("message", (event) => {
		count++;
		const message = JSON.parse(String(event.data));
		const index = waiters.findIndex((w) => w.type === message.type);
		if (index !== -1) { waiters.splice(index, 1)[0].resolve(message); } else { queue.push(message); }
	});
	return {
		ws,
		received: () => count,
		closed: new Promise((resolve) => ws.addEventListener("close", (event) => resolve(event))),
		opened: new Promise((resolve) => { ws.addEventListener("open", () => resolve(true)); ws.addEventListener("error", () => resolve(false)); }),
		send: (message) => ws.send(JSON.stringify(message)),
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

// A burst over the bucket: one slow-down, the cursors past the line dropped, the connection kept
const a = connect();
assert.equal(await a.opened, true);
a.send({ type: "hello", client_id: "a", name: "A" });
await a.next("snapshot");
for (let i = 0; i < 130; i++) { a.send({ type: "presence", cursor: { x: i, y: i } }); }
const warning = await a.next("slow-down");
assert.ok(warning.retry_in_ms >= 250 && warning.retry_in_ms <= 60000, JSON.stringify(warning));
assert.equal(warning.code, undefined, "not the day's budget, a burst");
await new Promise((resolve) => setTimeout(resolve, 1100)); // (the bucket refills at 30 a second; a ping right now would be dropped like the cursors)
a.send({ type: "ping" });
assert.equal((await a.next("pong")).type, "pong", "still connected and answered");
assert.equal(a.ws.readyState, WebSocket.OPEN);

// A flood that keeps going: three strikes and the socket is closed with 1013; the room is fine afterwards
for (let i = 0; i < 600 && a.ws.readyState === WebSocket.OPEN; i++) { a.send({ type: "presence", cursor: { x: i, y: 0 } }); }
const close = await Promise.race([a.closed, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
assert.ok(close, "the flooding connection was closed");
assert.equal(close.code, 1013, `closed with 1013: ${close.code} ${close.reason}`);
assert.equal(close.reason, "slow down");

// Somebody's work is never dropped by the brake: a burst of versions past the write bucket still lands (and warns)
const b = connect();
assert.equal(await b.opened, true);
b.send({ type: "hello", client_id: "b", name: "B" });
const snapshot = await b.next("snapshot");
assert.equal(snapshot.version, 0, "an empty room");
for (let i = 0; i < 50; i++) { b.send({ type: "props", label: `change ${i}`, width: 800 + i, height: 600, page_properties: {} }); }
await b.next("slow-down");
b.send({ type: "ping" });
const pong = await b.next("pong");
assert.equal(pong.version, 50, `every version was written: ${pong.version}`);
b.ws.close(1000, "done");
await b.closed;
console.log("room-limits: ok");
