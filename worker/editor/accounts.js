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
			// The GIFs an account hearted in the GIF picker (GifCities ids), so favorites follow the person, not the browser
			sql.exec("CREATE TABLE IF NOT EXISTS favorites (user_id TEXT NOT NULL, gif TEXT NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (user_id, gif))");
			// `gif` is `source:id` (gifcities:ABC…); rows from before stores were named are bare GifCities ids
			sql.exec("UPDATE favorites SET gif = 'gifcities:' || gif WHERE gif NOT LIKE '%:%'");
			// What each site holds in the bucket (every object under sites/<name>/, archives included) against its quota;
			// null limits mean the defaults (index.js QUOTA_*). Kept in step by every write, recounted from a listing after.
			sql.exec("CREATE TABLE IF NOT EXISTS usage (site TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, files INTEGER NOT NULL DEFAULT 0, limit_bytes INTEGER, limit_files INTEGER, updated INTEGER NOT NULL DEFAULT 0)");
			// What each share key's guests uploaded per UTC day (the key as a hash)
			sql.exec("CREATE TABLE IF NOT EXISTS guest_uploads (key_hash TEXT NOT NULL, day INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key_hash, day))");
			// A locked account can't sign in or act (the admin's lever); `note` is the admin's reason
			for (const column of ["locked INTEGER NOT NULL DEFAULT 0", "note TEXT"]) {
				try { sql.exec(`ALTER TABLE users ADD COLUMN ${column}`); } catch (_error) { /* already there */ }
			}
			// Visitors' reports of pages (the sites Worker forwards its form), three a day per visitor
			sql.exec("CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, page TEXT NOT NULL, reason TEXT NOT NULL, ip_hash TEXT NOT NULL, created INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0)");
			return Promise.resolve();
		});
	}
	// ---- the admin's view and levers ----
	/** @param {string} id @param {boolean} locked @param {string} [note] */
	set_locked(id, locked, note = "") {
		this.ctx.storage.sql.exec("UPDATE users SET locked = ?, note = ? WHERE id = ?", locked ? 1 : 0, note || null, id);
		if (locked) { this.delete_sessions_of(id); }
	}
	/** @param {string} user_id */
	delete_sessions_of(user_id) {
		this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", user_id);
	}
	/** Every account, newest first. @returns {{ id: string, email: string, name: string, created: number, seen: number, locked: boolean, note: string }[]} */
	all_users() {
		return this.ctx.storage.sql.exec("SELECT id, email, name, created, seen, locked, note FROM users ORDER BY created DESC LIMIT 5000").toArray()
			.map((row) => ({ id: String(row.id), email: String(row.email || ""), name: String(row.name || ""), created: Number(row.created), seen: Number(row.seen), locked: Number(row.locked) === 1, note: String(row.note || "") }));
	}
	/** Every site's owner. @returns {{ site: string, user_id: string, claimed: number }[]} */
	all_owners() {
		return this.ctx.storage.sql.exec("SELECT site, user_id, claimed FROM owners ORDER BY claimed DESC LIMIT 10000").toArray()
			.map((row) => ({ site: String(row.site), user_id: String(row.user_id), claimed: Number(row.claimed) }));
	}
	/** Every site's usage row. @returns {{ site: string, bytes: number, files: number, limit_bytes: number | null, limit_files: number | null }[]} */
	all_usage() {
		return this.ctx.storage.sql.exec("SELECT site, bytes, files, limit_bytes, limit_files FROM usage LIMIT 10000").toArray()
			.map((row) => ({ site: String(row.site), bytes: Number(row.bytes), files: Number(row.files), limit_bytes: row.limit_bytes === null ? null : Number(row.limit_bytes), limit_files: row.limit_files === null ? null : Number(row.limit_files) }));
	}
	/** A site is gone: its owner, usage, and password rows go too. @param {string} site */
	remove_site(site) {
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM owners WHERE site = ?", site);
		sql.exec("DELETE FROM usage WHERE site = ?", site);
		sql.exec("DELETE FROM sites WHERE name = ?", site);
	}
	/**
	 * A visitor's report of a page: kept unless this visitor has made three today.
	 * @param {{ site: string, page: string, reason: string, ip_hash: string }} report
	 * @returns {{ ok: boolean, id?: number }}
	 */
	add_report({ site, page, reason, ip_hash }) {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const today = Number(sql.exec("SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created > ?", ip_hash, now - 24 * 60 * 60 * 1000).one().n);
		if (today >= 3) { return { ok: false }; }
		sql.exec("INSERT INTO reports (site, page, reason, ip_hash, created) VALUES (?, ?, ?, ?, ?)", site, page, reason, ip_hash, now);
		return { ok: true, id: Number(sql.exec("SELECT last_insert_rowid() AS id").one().id) };
	}
	/** Newest first. @param {number} limit @returns {{ id: number, site: string, page: string, reason: string, created: number, resolved: boolean }[]} */
	reports(limit = 200) {
		return this.ctx.storage.sql.exec("SELECT id, site, page, reason, created, resolved FROM reports ORDER BY id DESC LIMIT ?", limit).toArray()
			.map((row) => ({ id: Number(row.id), site: String(row.site), page: String(row.page), reason: String(row.reason), created: Number(row.created), resolved: Number(row.resolved) === 1 }));
	}
	/** @param {number} id @param {boolean} resolved */
	resolve_report(id, resolved = true) {
		this.ctx.storage.sql.exec("UPDATE reports SET resolved = ? WHERE id = ?", resolved ? 1 : 0, id);
	}
	// ---- storage: what each site holds, against its quota ----
	/** @param {string} site @returns {{ bytes: number, files: number, limit_bytes: number | null, limit_files: number | null, updated: number }} */
	usage_of(site) {
		const row = this.ctx.storage.sql.exec("SELECT bytes, files, limit_bytes, limit_files, updated FROM usage WHERE site = ?", site).toArray()[0];
		if (!row) { return { bytes: 0, files: 0, limit_bytes: null, limit_files: null, updated: 0 }; }
		return { bytes: Number(row.bytes), files: Number(row.files), limit_bytes: row.limit_bytes === null ? null : Number(row.limit_bytes), limit_files: row.limit_files === null ? null : Number(row.limit_files), updated: Number(row.updated) };
	}
	/** @param {string} site @param {number} bytes @param {number} files */
	set_usage(site, bytes, files) {
		this.ctx.storage.sql.exec("INSERT INTO usage (site, bytes, files, updated) VALUES (?, ?, ?, ?) ON CONFLICT(site) DO UPDATE SET bytes = excluded.bytes, files = excluded.files, updated = excluded.updated", site, Math.max(0, Math.round(bytes)), Math.max(0, Math.round(files)), Date.now());
	}
	/** The master raises (or lowers) a site's limits; null puts a default back. @param {string} site @param {number | null} limit_bytes @param {number | null} limit_files */
	set_quota(site, limit_bytes, limit_files) {
		this.ctx.storage.sql.exec("INSERT INTO usage (site, bytes, files, limit_bytes, limit_files, updated) VALUES (?, 0, 0, ?, ?, 0) ON CONFLICT(site) DO UPDATE SET limit_bytes = excluded.limit_bytes, limit_files = excluded.limit_files", site, limit_bytes, limit_files);
	}
	/** Adds a guest's upload to its share key's day and returns the day's total. @param {string} key_hash @param {number} day @param {number} bytes */
	add_guest_upload(key_hash, day, bytes) {
		const sql = this.ctx.storage.sql;
		sql.exec("INSERT INTO guest_uploads (key_hash, day, bytes) VALUES (?, ?, ?) ON CONFLICT(key_hash, day) DO UPDATE SET bytes = bytes + excluded.bytes", key_hash, day, bytes);
		if (Math.random() < 0.02) { sql.exec("DELETE FROM guest_uploads WHERE day < ?", day - 2); }
		return Number(sql.exec("SELECT bytes FROM guest_uploads WHERE key_hash = ? AND day = ?", key_hash, day).one().bytes);
	}
	/** How many sites were claimed since `since` (ms): the platform-wide pace, for the surge brake. @param {number} since */
	claims_since(since) {
		return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM owners WHERE claimed > ?", since).one().n);
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
	/** @param {string} id @returns {{ id: string, email: string, name: string, locked: boolean } | null} */
	get_user(id) {
		const row = this.ctx.storage.sql.exec("SELECT id, email, name, locked FROM users WHERE id = ?", id).toArray()[0];
		return row ? { id: String(row.id), email: String(row.email || ""), name: String(row.name || ""), locked: Number(row.locked) === 1 } : null;
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
	/** Every account with an email (there should be one; support looks when a sign-in seems to have split). @param {string} email */
	users_by_email(email) {
		return this.ctx.storage.sql.exec("SELECT id, email, name FROM users WHERE LOWER(email) = ? ORDER BY created", email.toLowerCase()).toArray()
			.map((row) => ({ id: String(row.id), email: String(row.email || ""), name: String(row.name || "") }));
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
		if (user && user.locked) {
			this.ctx.storage.sql.exec("DELETE FROM sessions WHERE hash = ?", hash); // (a locked account's sessions are over)
			return null;
		}
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
	/** @param {string} user_id @returns {{ id: string, width: number, height: number, at: number }[]} the user's favorite GIFs (`source:id`), newest first */
	favorites_of(user_id) {
		return this.ctx.storage.sql.exec("SELECT gif, width, height, at FROM favorites WHERE user_id = ? ORDER BY at DESC, gif LIMIT 300", user_id).toArray()
			.map((row) => ({ id: String(row.gif), width: Number(row.width), height: Number(row.height), at: Number(row.at) }));
	}
	/**
	 * Hearts and un-hearts, together: the picker's toggles and the merge on sign-in.
	 * @param {string} user_id
	 * @param {{ id: string, width: number, height: number, at: number }[]} add - kept with their own `at` (a favorite hearted earlier elsewhere keeps its place)
	 * @param {string[]} remove
	 */
	update_favorites(user_id, add, remove) {
		const sql = this.ctx.storage.sql;
		for (const gif of remove) { sql.exec("DELETE FROM favorites WHERE user_id = ? AND gif = ?", user_id, gif); }
		for (const item of add) {
			sql.exec("INSERT INTO favorites (user_id, gif, width, height, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, gif) DO UPDATE SET width = excluded.width, height = excluded.height, at = MAX(favorites.at, excluded.at)", user_id, item.id, item.width, item.height, item.at);
		}
		// Room for 300: the oldest go
		sql.exec("DELETE FROM favorites WHERE user_id = ? AND gif NOT IN (SELECT gif FROM favorites WHERE user_id = ? ORDER BY at DESC, gif LIMIT 300)", user_id, user_id);
	}
}
