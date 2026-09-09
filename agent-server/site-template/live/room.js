// Managed by the jspaint fork: agent-server/site-template/live/room.js — edit it there, not in the site repo.
//
// jspaint-live: a tiny Worker with one Durable Object per room that fans the latest canvas out to viewers.
//
//   GET    /rooms/:id/data   the latest canvas as a PNG data URI (JS Paint's RESTSession format), 404 if none
//   PUT    /rooms/:id/data   store a new canvas (requires `Authorization: Bearer <LIVE_SECRET>`)
//   DELETE /rooms/:id/data   clear the room (same auth)
//   GET    /rooms/:id/ws     WebSocket; receives {"type":"update","version":n} whenever the canvas changes
//
// Viewers (the site's display page) connect to /ws and fetch /data on each update, so messages stay tiny
// regardless of image size. It's a separate Worker from the site because Workers with Durable Objects
// don't get preview URLs, and the site relies on its preview alias.
/* global WebSocketPair, WebSocketRequestResponsePair */

import { DurableObject } from "cloudflare:workers";

const MAX_DATA_BYTES = 1.9 * 1024 * 1024; // SQLite-backed storage caps values at 2 MB

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Expose-Headers": "ETag",
};

/**
 * @param {string} body
 * @param {number} status
 * @param {Record<string, string>} [headers]
 */
function text(body, status = 200, headers = {}) {
	return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

export class Room extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		// Keepalive that doesn't wake a hibernating object.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname.endsWith("/ws")) {
			if (request.headers.get("Upgrade") !== "websocket") {
				return text("Expected a WebSocket upgrade", 426);
			}
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server); // hibernation-friendly accept
			return new Response(null, { status: 101, webSocket: client });
		}

		if (request.method === "GET") {
			const data = await this.ctx.storage.get("data");
			if (!data) {
				return text("", 404);
			}
			const version = (await this.ctx.storage.get("version")) || 0;
			return text(data, 200, { ETag: `"${version}"`, "Cache-Control": "no-store" });
		}

		if (request.method === "PUT") {
			const data = await request.text();
			if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.trim())) {
				return text("Body must be a PNG data URI", 400);
			}
			if (data.length > MAX_DATA_BYTES) {
				return text(`Image too large for the room (${data.length} bytes > ${MAX_DATA_BYTES})`, 413);
			}
			const version = ((await this.ctx.storage.get("version")) || 0) + 1;
			await this.ctx.storage.put({ data: data.trim(), version });
			const clients = this.broadcast({ type: "update", version });
			return Response.json({ ok: true, version, clients });
		}

		if (request.method === "DELETE") {
			await this.ctx.storage.deleteAll();
			const clients = this.broadcast({ type: "update", version: 0 });
			return Response.json({ ok: true, clients });
		}

		return text("Method not allowed", 405);
	}
	/**
	 * @param {object} message
	 * @returns {number} how many viewers got it
	 */
	broadcast(message) {
		const payload = JSON.stringify(message);
		let count = 0;
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
				count++;
			} catch (_error) {
				// closed underneath us; the close handler will clean up
			}
		}
		return count;
	}
	webSocketMessage(_ws, _message) {
		// Viewers only listen. (Application-level "ping" is answered automatically.)
	}
	webSocketClose(ws, code, reason) {
		ws.close(code, reason);
	}
	webSocketError(_ws, error) {
		console.error("WebSocket error:", error);
	}
}

export default {
	/**
	 * @param {Request} request
	 * @param {{ ROOM: DurableObjectNamespace, LIVE_SECRET?: string }} env
	 */
	async fetch(request, env) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}
		const match = /^\/rooms\/([A-Za-z0-9_-]{1,64})\/(data|ws)$/.exec(new URL(request.url).pathname);
		if (!match) {
			return text("jspaint-live: GET|PUT|DELETE /rooms/:id/data, GET /rooms/:id/ws", 404, CORS_HEADERS);
		}
		const [, room_id, kind] = match;

		if (kind === "data" && request.method !== "GET") {
			// Writes come only from the agent server, which holds the shared secret.
			const expected = env.LIVE_SECRET ? `Bearer ${env.LIVE_SECRET}` : null;
			if (!expected || request.headers.get("Authorization") !== expected) {
				return text("Unauthorized", 401, CORS_HEADERS);
			}
		}

		const response = await env.ROOM.getByName(room_id).fetch(request);
		if (response.status === 101) {
			return response; // WebSocket handshake; don't touch it
		}
		const headers = new Headers(response.headers);
		for (const [name, value] of Object.entries(CORS_HEADERS)) {
			headers.set(name, value);
		}
		return new Response(response.body, { status: response.status, headers });
	},
};
