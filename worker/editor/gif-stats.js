// GifStats: one Durable Object (name "global") counting which GifCities GIFs get used, per site and overall, so
// "top GIFs" (for a person, and for everyone) can be shown later. SQLite table `uses(gif, site, count, last_used)`;
// the site '' row is the global tally. Written by POST /api/gifs/used, read by GET /api/gifs/top (index.js).
import { DurableObject } from "cloudflare:workers";

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
	}
	/**
	 * @param {string} gif - GifCities id
	 * @param {string} site - "" for nobody in particular
	 */
	record(gif, site) {
		const now = Date.now();
		const sql = this.ctx.storage.sql;
		for (const scope of site ? [site, ""] : [""]) {
			sql.exec("INSERT INTO uses (gif, site, count, last_used) VALUES (?, ?, 1, ?) ON CONFLICT(gif, site) DO UPDATE SET count = count + 1, last_used = excluded.last_used", gif, scope, now);
		}
	}
	/**
	 * @param {string} site - "" for everyone
	 * @param {number} limit
	 * @returns {{ gif: string, count: number, last_used: number }[]}
	 */
	top(site, limit) {
		return this.ctx.storage.sql.exec("SELECT gif, count, last_used FROM uses WHERE site = ? ORDER BY count DESC, last_used DESC LIMIT ?", site, limit).toArray()
			.map((row) => ({ gif: String(row.gif), count: Number(row.count), last_used: Number(row.last_used) }));
	}
}
