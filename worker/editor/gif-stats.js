// GifStats: one Durable Object (name "global") counting which GifCities GIFs get used, per site and overall, so
// "top GIFs" (for a person, and for everyone) can be shown later. SQLite table `uses(gif, site, count, last_used)`;
// the site '' row is the global tally. Written by POST /api/gifs/used, read by GET /api/gifs/top (index.js).
// Uses are tallied in memory and written once a minute (an alarm), so a click costs no row write of its own and a
// flood of them costs one row per GIF per minute; a read flushes first, so it's exact.
import { DurableObject } from "cloudflare:workers";

const FLUSH_MS = 60 * 1000;

export class GifStats extends DurableObject {
	/**
	 * @param {DurableObjectState} ctx
	 * @param {any} env
	 */
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(() => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS uses (gif TEXT NOT NULL, site TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL, PRIMARY KEY (gif, site))");
			return Promise.resolve();
		});
		/** @type {Map<string, number>} `gif|site` → uses not yet written */
		this.pending = new Map();
		this.flush_at = 0;
	}
	/**
	 * @param {string} gif - GifCities id
	 * @param {string} site - "" for nobody in particular
	 */
	async record(gif, site) {
		for (const scope of site ? [site, ""] : [""]) {
			const key = `${gif}|${scope}`;
			this.pending.set(key, (this.pending.get(key) || 0) + 1);
		}
		if (!this.flush_at) {
			this.flush_at = Date.now() + FLUSH_MS;
			await this.ctx.storage.setAlarm(this.flush_at);
		}
	}
	/** Writes the tally: one row per GIF per scope, however many clicks. */
	flush() {
		const now = Date.now();
		const sql = this.ctx.storage.sql;
		for (const [key, count] of this.pending) {
			const [gif, scope] = key.split("|");
			sql.exec("INSERT INTO uses (gif, site, count, last_used) VALUES (?, ?, ?, ?) ON CONFLICT(gif, site) DO UPDATE SET count = count + excluded.count, last_used = excluded.last_used", gif, scope, count, now);
		}
		this.pending.clear();
		this.flush_at = 0;
	}
	alarm() {
		this.flush();
	}
	/**
	 * @param {string} site - "" for everyone
	 * @param {number} limit
	 * @returns {{ gif: string, count: number, last_used: number }[]}
	 */
	top(site, limit) {
		this.flush(); // (exact, even a moment after a click)
		return this.ctx.storage.sql.exec("SELECT gif, count, last_used FROM uses WHERE site = ? ORDER BY count DESC, last_used DESC LIMIT ?", site, limit).toArray()
			.map((row) => ({ gif: String(row.gif), count: Number(row.count), last_used: Number(row.last_used) }));
	}
}
