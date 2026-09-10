#!/usr/bin/env node
// Gives a site a new random password (or removes it) with the master key, and writes the password to
// editor/.passwords/<site>.txt — never to the terminal, so it never lands in a log.
//
//   npm run site-password <site> [--editor <url>] [--delete]
//
// Master key: SITE_EDIT_SECRET in the environment; else, for a localhost editor, SITE_EDIT_SECRET= from editor/.dev.vars;
// else editor/.secret.txt (production). Editor URL: --editor, else SITE_BUILDER_EDITOR_URL, else the hosted editor.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const worker_dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const site = args.find((arg) => !arg.startsWith("--"));
const remove = args.includes("--delete");
const editor_flag = args.indexOf("--editor");
const editor = (editor_flag >= 0 ? args[editor_flag + 1] : process.env.SITE_BUILDER_EDITOR_URL || "https://edit.coolpaint.world").replace(/\/+$/, "");
if (!site || !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(site)) {
	console.error("Usage: npm run site-password <site> [--editor <url>] [--delete]   (site: 1–32 lowercase letters, digits, hyphens)");
	process.exit(2);
}

function master_key() {
	if (process.env.SITE_EDIT_SECRET) { return process.env.SITE_EDIT_SECRET; }
	if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(editor)) {
		const dev_vars = fs.readFileSync(path.join(worker_dir, "editor", ".dev.vars"), "utf8");
		const match = /^SITE_EDIT_SECRET=(.*)$/m.exec(dev_vars);
		if (match) { return match[1].trim().replace(/^["']|["']$/g, ""); }
	}
	return fs.readFileSync(path.join(worker_dir, "editor", ".secret.txt"), "utf8").trim();
}

const response = await fetch(`${editor}/api/sites/${site}/password`, { method: remove ? "DELETE" : "POST", headers: { Authorization: `Bearer ${master_key()}` } });
const body = await response.json().catch(() => ({}));
if (!response.ok) {
	console.error(`HTTP ${response.status}: ${body.error || "failed"}`);
	process.exit(1);
}
const file = path.join(worker_dir, "editor", ".passwords", `${site}.txt`);
if (remove) {
	try { fs.unlinkSync(file); } catch (_error) { /* nothing to remove */ }
	console.log(`Removed the password for ~${site}${body.removed ? "" : " (it had none)"}.`);
} else {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${body.password}\n`, { mode: 0o600 });
	console.log(`Wrote the password for ~${site} to editor/.passwords/${site}.txt (replaced the old one: ${body.rotated ? "yes" : "no"}). Sign in with site name "${site}" and that password.`);
}
