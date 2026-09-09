#!/usr/bin/env node
// Keeps the site repo's configuration under the control of this fork.
//
// Everything in site-template/ (Worker configs, the live-preview room Worker, the deploy workflow,
// AGENTS.md, README.md, .gitignore) is copied verbatim into the site repo, overwriting what's there.
// The site repo's own content — public/ — is never touched.
//
//   node sync-site.js                 sync (also done by server.js on startup)
//   node sync-site.js --set-live-secret   generate LIVE_SECRET if missing, save to config.json, push to the room Worker
//
// Used as a module by server.js: `sync_site_template(site_dir, log)`.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, "site-template");

/**
 * @param {string} dir
 * @returns {string[]} relative paths of all files under dir
 */
function walk(dir) {
	/** @type {string[]} */
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(absolute).map((relative) => path.join(entry.name, relative)));
		} else {
			files.push(entry.name);
		}
	}
	return files;
}

/**
 * Copies site-template/ into the site repo. Returns the files that changed.
 * @param {string} site_dir
 * @param {(line: string) => void} [log]
 * @returns {string[]}
 */
export function sync_site_template(site_dir, log = console.log) {
	/** @type {string[]} */
	const changed = [];
	for (const relative of walk(TEMPLATE_DIR)) {
		const source = path.join(TEMPLATE_DIR, relative);
		const target = path.join(site_dir, relative);
		const content = fs.readFileSync(source);
		if (fs.existsSync(target) && fs.readFileSync(target).equals(content)) {
			continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
		changed.push(relative);
	}
	if (changed.length) {
		log(`Synced site-template → ${site_dir}: ${changed.join(", ")}`);
	}
	return changed;
}

/**
 * Ensures config.json has live.secret, and pushes it to the jspaint-live Worker as LIVE_SECRET.
 * @param {string} site_dir
 * @param {string} config_path
 */
export function set_live_secret(site_dir, config_path) {
	const config = fs.existsSync(config_path) ? JSON.parse(fs.readFileSync(config_path, "utf8")) : {};
	config.live = config.live || {};
	if (!config.live.secret) {
		config.live.secret = crypto.randomBytes(32).toString("base64url");
		fs.writeFileSync(config_path, `${JSON.stringify(config, null, "\t")}\n`);
		console.log(`Generated live.secret in ${config_path}`);
	}
	console.log("Setting LIVE_SECRET on the jspaint-live Worker...");
	const result = spawnSync("npx", ["wrangler", "secret", "put", "LIVE_SECRET", "-c", "live/wrangler.jsonc"], {
		cwd: site_dir,
		input: config.live.secret,
		stdio: ["pipe", "inherit", "inherit"],
		env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
	});
	if (result.status !== 0) {
		throw new Error(`wrangler secret put failed with code ${result.status}. Has the room Worker been deployed yet? (npm run deploy-live in the site repo)`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const config_path = path.join(__dirname, "config.json");
	const config = fs.existsSync(config_path) ? JSON.parse(fs.readFileSync(config_path, "utf8")) : {};
	const site_dir = path.resolve(__dirname, process.env.AGENT_DRIVE_SITE_DIR || config.site_dir || "../../jspaint-site");
	if (!fs.existsSync(site_dir)) {
		console.error(`Site directory not found: ${site_dir}`);
		process.exit(1);
	}
	if (process.argv.includes("--set-live-secret")) {
		set_live_secret(site_dir, config_path);
	} else {
		const changed = sync_site_template(site_dir);
		console.log(changed.length ? `${changed.length} file(s) updated.` : "Site repo already matches site-template.");
	}
}
