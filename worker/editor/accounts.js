// Accounts: one Durable Object (name "global") holding each site's password — as a hash only. The editor Worker
// computes HMAC-SHA256(SITE_EDIT_SECRET, "site-password:<site>:<password>") and asks this DO for the stored hash to
// compare against (index.js role_of), so the DO never sees a secret or a password. Passwords are minted with the
// master key (POST /api/sites/:name/password) and edit that one site. Later: a Google OAuth identity per site can
// sit next to the hash here (an `owner` column) without changing the password path.
import { DurableObject } from "cloudflare:workers";

export class Accounts extends DurableObject {
	/**
	 * @param {DurableObjectState} ctx
	 * @param {any} env
	 */
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(() => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS sites (name TEXT PRIMARY KEY, hash TEXT NOT NULL, created INTEGER NOT NULL, rotated INTEGER NOT NULL)");
			return Promise.resolve();
		});
	}
	/** @param {string} name @returns {string | null} the stored password hash, if the site has one */
	get_hash(name) {
		const row = this.ctx.storage.sql.exec("SELECT hash FROM sites WHERE name = ?", name).toArray()[0];
		return row ? String(row.hash) : null;
	}
	/** @param {string} name @returns {number | null} when the site got its first password (ms), if it has one */
	get_created(name) {
		const row = this.ctx.storage.sql.exec("SELECT created FROM sites WHERE name = ?", name).toArray()[0];
		return row ? Number(row.created) : null;
	}
	/** @param {string} name @param {string} hash @returns {{ rotated: boolean }} whether a password existed before */
	set_hash(name, hash) {
		const now = Date.now();
		const existed = this.ctx.storage.sql.exec("SELECT 1 FROM sites WHERE name = ?", name).toArray().length > 0;
		this.ctx.storage.sql.exec("INSERT INTO sites (name, hash, created, rotated) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, rotated = excluded.rotated", name, hash, now, now);
		return { rotated: existed };
	}
	/** @param {string} name @returns {boolean} whether a password existed */
	remove(name) {
		const existed = this.ctx.storage.sql.exec("SELECT 1 FROM sites WHERE name = ?", name).toArray().length > 0;
		this.ctx.storage.sql.exec("DELETE FROM sites WHERE name = ?", name);
		return existed;
	}
}
