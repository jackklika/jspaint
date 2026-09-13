// Accounts: one Durable Object (name "global") holding each site's password — as a hash only. The editor Worker
// computes HMAC-SHA256(SITE_EDIT_SECRET, "site-password:<site>:<password>") and asks this DO for the stored hash to
// compare against (index.js role_of), so the DO never sees a secret or a password. Passwords are minted with the
// master key (POST /api/sites/:name/password) and edit that one site.
// Also the accounts (auth.js): users, their identities (a Google account; later an email, a phone, a passkey — one
// row each, joined by verified email), sessions (as hashes), and which user owns which site.
import { DurableObject } from "cloudflare:workers";

export class Accounts extends DurableObject {
	/**
	 * @param {DurableObjectState} ctx
	 * @param {any} env
	 */
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(() => {
			const sql = this.ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS sites (name TEXT PRIMARY KEY, hash TEXT NOT NULL, created INTEGER NOT NULL, rotated INTEGER NOT NULL)");
			sql.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL)");
			sql.exec("CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created INTEGER NOT NULL, PRIMARY KEY (provider, subject))");
			sql.exec("CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)");
			sql.exec("CREATE TABLE IF NOT EXISTS owners (site TEXT PRIMARY KEY, user_id TEXT NOT NULL, claimed INTEGER NOT NULL)");
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
	// ---- accounts ----
	/** @param {string} id @returns {{ id: string, email: string, name: string } | null} */
	get_user(id) {
		const row = this.ctx.storage.sql.exec("SELECT id, email, name FROM users WHERE id = ?", id).toArray()[0];
		return row ? { id: String(row.id), email: String(row.email || ""), name: String(row.name || "") } : null;
	}
	/**
	 * Someone signed in with a provider: their user (found by the identity, else by the verified email, else new).
	 * @param {{ provider: string, subject: string, email: string, name: string }} identity
	 * @returns {{ user: { id: string, email: string, name: string }, created: boolean }}
	 */
	sign_in_identity({ provider, subject, email, name }) {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		let row = sql.exec("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", provider, subject).toArray()[0];
		let user_id = row ? String(row.user_id) : "";
		let created = false;
		if (!user_id && email) {
			row = sql.exec("SELECT id FROM users WHERE email = ?", email).toArray()[0];
			user_id = row ? String(row.id) : "";
		}
		if (!user_id) {
			user_id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
			sql.exec("INSERT INTO users (id, email, name, created, seen) VALUES (?, ?, ?, ?, ?)", user_id, email || null, name || null, now, now);
			created = true;
		} else {
			sql.exec("UPDATE users SET seen = ?, name = COALESCE(NULLIF(?, ''), name), email = COALESCE(email, NULLIF(?, '')) WHERE id = ?", now, name, email, user_id);
		}
		sql.exec("INSERT INTO identities (provider, subject, user_id, email, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET email = excluded.email", provider, subject, user_id, email || null, now);
		return { user: /** @type {any} */ (this.get_user(user_id)), created };
	}
	/** @param {string} email @returns {{ id: string, email: string, name: string } | null} */
	user_by_email(email) {
		const row = this.ctx.storage.sql.exec("SELECT id FROM users WHERE email = ?", email.toLowerCase()).toArray()[0];
		return row ? this.get_user(String(row.id)) : null;
	}
	/** @param {string} hash - SHA-256 of the session token @param {string} user_id @param {number} expires - ms */
	create_session(hash, user_id, expires) {
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
		sql.exec("INSERT INTO sessions (hash, user_id, created, expires) VALUES (?, ?, ?, ?)", hash, user_id, Date.now(), expires);
		return { expires };
	}
	/** @param {string} hash @returns {{ user: { id: string, email: string, name: string }, expires: number } | null} */
	get_session(hash) {
		const row = this.ctx.storage.sql.exec("SELECT user_id, expires FROM sessions WHERE hash = ?", hash).toArray()[0];
		if (!row) { return null; }
		if (Number(row.expires) < Date.now()) {
			this.ctx.storage.sql.exec("DELETE FROM sessions WHERE hash = ?", hash);
			return null;
		}
		const user = this.get_user(String(row.user_id));
		return user ? { user, expires: Number(row.expires) } : null;
	}
	/** @param {string} hash */
	delete_session(hash) {
		this.ctx.storage.sql.exec("DELETE FROM sessions WHERE hash = ?", hash);
	}
	/** @param {string} site @returns {string | null} the owning user's id */
	owner_of(site) {
		const row = this.ctx.storage.sql.exec("SELECT user_id FROM owners WHERE site = ?", site).toArray()[0];
		return row ? String(row.user_id) : null;
	}
	/** @param {string} site @param {string} user_id */
	claim_site(site, user_id) {
		this.ctx.storage.sql.exec("INSERT INTO owners (site, user_id, claimed) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET user_id = excluded.user_id, claimed = excluded.claimed", site, user_id, Date.now());
	}
	/** @param {string} user_id @returns {string[]} the sites this user owns, oldest first */
	sites_of(user_id) {
		return this.ctx.storage.sql.exec("SELECT site FROM owners WHERE user_id = ? ORDER BY claimed", user_id).toArray().map((row) => String(row.site));
	}
}
