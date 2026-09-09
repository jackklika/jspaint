#!/usr/bin/env node
// Agent Drive server: the local companion to JS Paint's Agent window (src/agent-drive.js).
//
// It owns a checkout of the *site repo* (a separate git repository, see config.site_dir) whose
// `public/` directory is deployed as a Cloudflare Worker with static assets. Endpoints:
//   GET  /api/status                      connection check + site summary + URLs
//   POST /api/iteration?mode=display|html canvas PNG in the body → saves public/iterations/NNN.png, then either
//                                           display: rewrites public/index.html to show the drawing as-is
//                                           html:    runs `opencode run` to turn the drawing into HTML
//                                         …then deploys the preview alias (wrangler versions upload)
//   PUT  /api/screenshots/:name           JS Paint uploads its render of the page (PNG) as screenshots/<name>.png,
//                                           so the agent can compare "before" and "annotated" images next round
//   POST /api/publish                     git add/commit/push; the site repo's GitHub workflow deploys production
//   GET  /api/jobs/:id                    poll a job started by the POST endpoints (status, log lines, result)
//   GET|PUT /api/rooms/:id/data           JS Paint's built-in multi-user RESTSession protocol (whole canvas as a
//                                           data URI, synced after every stroke). Used for *live preview*: each
//                                           write updates public/latest.png (+ the display page) and redeploys.
//   GET  /files/<path>                    static files from the site repo (public/, screenshots/)
//   GET  /<anything else>                 JS Paint itself (this repo), so http://localhost:4097/#session:live
//                                           runs JS Paint on the same origin as the room API
//
// No dependencies beyond Node ≥ 18 (plus `git`, `opencode`, and `wrangler` — installed in the site repo — on the PATH).
// Rendering the page to an image happens in JS Paint itself (SVG <foreignObject>), not here.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sync_site_template } from "./sync-site.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// #region Config

const default_config = {
	port: 4097,
	site_dir: "../../jspaint-site",
	site_url: "",
	site_title: "JS Paint Site",
	opencode: {
		command: "opencode",
		model: "",
		agent: "",
		auto_approve: true,
		timeout_minutes: 15,
		extra_args: [],
	},
	deploy: {
		enabled: true,
		command: "npx wrangler", // run in the site repo, which has wrangler as a devDependency
		preview_alias: "preview",
		min_interval_ms: 3000, // live preview coalesces strokes into at most one deploy per interval
		timeout_minutes: 5,
	},
	live: {
		url: "", // the jspaint-live Worker (site-template/live/); empty disables realtime pushes
		room: "live",
		secret: "", // LIVE_SECRET on that Worker; `npm run set-live-secret` generates and pushes it
	},
	site_template: {
		sync_on_start: true, // copy site-template/ into the site repo when the server starts
	},
	git: {
		remote: "origin",
	},
};

function load_config() {
	const config_path = path.join(__dirname, "config.json");
	let user_config = {};
	if (fs.existsSync(config_path)) {
		user_config = JSON.parse(fs.readFileSync(config_path, "utf8"));
	} else {
		console.log(`No config.json found; using defaults. Copy config.example.json to config.json to customize.`);
	}
	const config = {
		...default_config,
		...user_config,
		opencode: { ...default_config.opencode, ...(user_config.opencode || {}) },
		deploy: { ...default_config.deploy, ...(user_config.deploy || {}) },
		live: { ...default_config.live, ...(user_config.live || {}) },
		site_template: { ...default_config.site_template, ...(user_config.site_template || {}) },
		git: { ...default_config.git, ...(user_config.git || {}) },
	};
	if (process.env.AGENT_DRIVE_SITE_DIR) { config.site_dir = process.env.AGENT_DRIVE_SITE_DIR; }
	if (process.env.AGENT_DRIVE_PORT) { config.port = Number(process.env.AGENT_DRIVE_PORT); }
	if (process.env.AGENT_DRIVE_NO_DEPLOY) { config.deploy.enabled = false; }
	if (process.env.AGENT_DRIVE_LIVE_ROOM) { config.live.room = process.env.AGENT_DRIVE_LIVE_ROOM; } // e.g. a scratch room for tests
	return config;
}

const config = load_config();
const SITE_DIR = path.resolve(__dirname, config.site_dir);
const PUBLIC_DIR = path.join(SITE_DIR, "public");
const JSPAINT_DIR = path.resolve(__dirname, "..");
const PAGE_URL = "/files/public/index.html";
const DISPLAY_MARKER = "<!-- agent-drive: display -->";

if (!fs.existsSync(SITE_DIR)) {
	console.error(`Site directory not found: ${SITE_DIR}\nSet "site_dir" in agent-server/config.json (or AGENT_DRIVE_SITE_DIR) to your site repo checkout.`);
	process.exit(1);
}
if (!fs.existsSync(path.join(SITE_DIR, ".git"))) {
	console.warn(`Warning: ${SITE_DIR} is not a git repository; Publish will fail until it is (git init && git remote add origin ...).`);
}
fs.mkdirSync(path.join(PUBLIC_DIR, "iterations"), { recursive: true });
fs.mkdirSync(path.join(SITE_DIR, "screenshots"), { recursive: true });
if (config.site_template.sync_on_start) {
	// The site repo's configuration is owned by this fork; keep it in sync.
	sync_site_template(SITE_DIR);
}

/** @param {...string} parts */
const site = (...parts) => path.join(SITE_DIR, ...parts);
/** @param {...string} parts */
const pub = (...parts) => path.join(PUBLIC_DIR, ...parts);

// #endregion

// #region Jobs

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} type
 * @property {"running" | "done" | "error"} status
 * @property {string[]} log
 * @property {any} [result]
 * @property {string} [error]
 * @property {number} created
 */

/** @typedef {(line: string) => void} Logger */

/** @type {Map<string, Job>} */
const jobs = new Map();
const MAX_LOG_LINES = 600;
const MAX_LINE_LENGTH = 400;

/** @param {string} line */
function clean_line(line) {
	// eslint-disable-next-line no-control-regex
	line = String(line).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trimEnd(); // strip ANSI colors
	if (line.length > MAX_LINE_LENGTH) { line = `${line.slice(0, MAX_LINE_LENGTH)}…`; }
	return line;
}

/**
 * @param {string} type
 * @param {(job: Job, log: Logger) => Promise<any>} fn
 * @returns {Job}
 */
function start_job(type, fn) {
	/** @type {Job} */
	const job = { id: crypto.randomUUID(), type, status: "running", log: [], created: Date.now() };
	jobs.set(job.id, job);
	/** @type {Logger} */
	const log = (line) => {
		line = clean_line(line);
		if (!line) { return; }
		job.log.push(line);
		if (job.log.length > MAX_LOG_LINES) { job.log.splice(0, job.log.length - MAX_LOG_LINES); }
		console.log(`[${type} ${job.id.slice(0, 8)}] ${line}`);
	};
	fn(job, log).then((result) => {
		job.result = result;
		job.status = "done";
	}, (error) => {
		job.error = error?.message || String(error);
		job.status = "error";
		log(`Error: ${job.error}`);
	});
	// Forget old jobs eventually.
	for (const [id, old] of jobs) {
		if (old.status !== "running" && Date.now() - old.created > 60 * 60 * 1000) { jobs.delete(id); }
	}
	return job;
}

// #endregion

// #region Helpers

/**
 * Runs a command, streaming its output lines to `log`. Resolves with the full stdout.
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @param {Logger} options.log
 * @param {string} [options.prefix]
 * @param {number} [options.timeout_ms]
 * @returns {Promise<string>}
 */
function run(command, args, { cwd, log, prefix = "", timeout_ms }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1", WRANGLER_SEND_METRICS: "false" },
		});
		let stdout = "";
		let stderr = "";
		let timed_out = false;
		const timer = timeout_ms ? setTimeout(() => {
			timed_out = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		}, timeout_ms) : null;

		/** @param {NodeJS.ReadableStream} stream @param {(chunk: string) => void} on_chunk */
		const forward_lines = (stream, on_chunk) => {
			let buffer = "";
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				on_chunk(chunk);
				buffer += chunk;
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) { log(prefix + line); }
			});
			stream.on("end", () => { if (buffer) { log(prefix + buffer); } });
		};
		forward_lines(child.stdout, (chunk) => { stdout += chunk; });
		forward_lines(child.stderr, (chunk) => { stderr += chunk; });

		child.on("error", (error) => {
			if (timer) { clearTimeout(timer); }
			if (error.code === "ENOENT") {
				reject(new Error(`Command not found: ${command}. Is it installed and on your PATH?`));
			} else {
				reject(error);
			}
		});
		child.on("close", (code) => {
			if (timer) { clearTimeout(timer); }
			if (timed_out) {
				reject(new Error(`${command} timed out after ${Math.round(timeout_ms / 60000)} minutes`));
			} else if (code !== 0) {
				reject(new Error(`${command} ${args[0] || ""} exited with code ${code}${stderr.trim() ? `:\n${stderr.trim().slice(-1000)}` : ""}`));
			} else {
				resolve(stdout);
			}
		});
	});
}

/**
 * @param {string[]} args
 * @param {Logger} log
 */
const git = (args, log) => run("git", args, { cwd: SITE_DIR, log, prefix: "git: " });

/**
 * Reads the dimensions from a PNG's IHDR chunk.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number }}
 */
function png_dimensions(buffer) {
	const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
	if (buffer.length < 24 || signature.some((byte, i) => buffer[i] !== byte)) {
		throw new Error("Body is not a PNG image");
	}
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** @returns {number[]} sorted iteration numbers present in public/iterations/ */
function iteration_numbers() {
	return fs.readdirSync(pub("iterations"))
		.map((name) => /^(\d+)\.png$/.exec(name)?.[1])
		.filter(Boolean)
		.map(Number)
		.sort((a, b) => a - b);
}

/** @returns {"none" | "display" | "html"} */
function page_mode() {
	if (!fs.existsSync(pub("index.html"))) { return "none"; }
	return fs.readFileSync(pub("index.html"), "utf8").includes(DISPLAY_MARKER) ? "display" : "html";
}

/** @returns {string | null} site-relative path of the newest numbered screenshot, if any */
function latest_screenshot() {
	const files = fs.readdirSync(site("screenshots"))
		.filter((name) => /^\d+\.png$/.test(name))
		.sort();
	return files.length ? path.join("screenshots", files[files.length - 1]) : null;
}

/**
 * @param {string} text
 */
function escape_html(text) {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

/**
 * The "display" page: shows the latest drawing as-is, pixel-perfect.
 * The marker comment tells the server (and the agent, in HTML mode) that this page is a placeholder.
 * @param {{ version: number | string, width: number, height: number }} info
 */
function render_display_page({ version, width, height }) {
	return `<!DOCTYPE html>
${DISPLAY_MARKER}
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escape_html(config.site_title)}</title>
	<style>
		html, body { margin: 0; min-height: 100%; background: #808080; }
		body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
		img { display: block; width: min(100vw, ${width}px); height: auto; image-rendering: pixelated; }
	</style>
</head>
<body>
	<img src="latest.png?v=${version}" width="${width}" height="${height}" alt="Drawing">
	<script>
		// Live view. Two channels, no page reloads:
		// 1. Realtime: a WebSocket to the jspaint-live room announces every stroke; we fetch the new image.
		// 2. Fallback: poll latest.png (static assets return an ETag) to pick up new deploys.
		// If the page itself changed (an HTML-mode iteration replaced this display page), reload once.
		(() => {
			const LIVE_URL = ${JSON.stringify(config.live.url ? config.live.url.replace(/\/+$/, "") : "")};
			const ROOM = ${JSON.stringify(config.live.room)};
			const img = document.querySelector("img");
			let image_tag = null;
			let page_tag = null;
			let ticks = 0;
			const show = (src) => {
				const next = new Image();
				next.onload = () => {
					img.width = next.naturalWidth;
					img.height = next.naturalHeight;
					img.style.width = "min(100vw, " + next.naturalWidth + "px)";
					const previous = img.src;
					img.src = src;
					if (previous.startsWith("blob:")) { URL.revokeObjectURL(previous); }
				};
				next.src = src;
			};
			const check_image = async () => {
				const response = await fetch("latest.png", { cache: "no-store" });
				if (!response.ok) { return; }
				const blob = await response.blob();
				const tag = "deploy:" + (response.headers.get("ETag") || String(blob.size));
				if (tag === image_tag) { return; }
				image_tag = tag;
				show(URL.createObjectURL(blob));
			};
			const check_page = async () => {
				const response = await fetch(location.pathname, { cache: "no-store" });
				const tag = response.headers.get("ETag") || String((await response.text()).length);
				if (page_tag && tag !== page_tag) { location.reload(); }
				page_tag = tag;
			};
			const fetch_room = async () => {
				const response = await fetch(LIVE_URL + "/rooms/" + ROOM + "/data", { cache: "no-store" });
				if (!response.ok) { return; }
				const tag = "room:" + (response.headers.get("ETag") || "");
				if (tag === image_tag) { return; }
				image_tag = tag;
				show(await response.text());
			};
			let live = false;
			if (LIVE_URL) {
				let retry = 1000;
				const connect = () => {
					const socket = new WebSocket(LIVE_URL.replace(/^http/, "ws") + "/rooms/" + ROOM + "/ws");
					const keepalive = setInterval(() => { if (socket.readyState === 1) { socket.send("ping"); } }, 30000);
					socket.onopen = () => { live = true; retry = 1000; fetch_room().catch(() => {}); };
					socket.onmessage = (event) => { if (event.data !== "pong") { fetch_room().catch(() => {}); } };
					socket.onclose = () => {
						live = false;
						clearInterval(keepalive);
						setTimeout(connect, retry);
						retry = Math.min(retry * 2, 30000);
					};
				};
				connect();
			}
			setInterval(() => {
				if (document.visibilityState !== "visible") { return; }
				ticks++;
				// With the room connected, strokes arrive over the socket; polling only needs to catch deploys/page swaps.
				if (!live || ticks % 4 === 0) { check_image().catch(() => {}); }
				if (ticks % 4 === 0) { check_page().catch(() => {}); }
			}, 1500);
		})();
	</script>
</body>
</html>
`;
}

/**
 * Writes public/latest.png (and, unless the page is agent-written HTML, the display page).
 * @param {Buffer} png
 * @param {number | string} version - cache-busting value for the <img>
 * @param {Logger} log
 * @returns {{ width: number, height: number, wrote_page: boolean }}
 */
function write_latest(png, version, log) {
	const { width, height } = png_dimensions(png);
	fs.writeFileSync(pub("latest.png"), png);
	const wrote_page = page_mode() !== "html";
	if (wrote_page) {
		fs.writeFileSync(pub("index.html"), render_display_page({ version, width, height }));
	} else {
		log("Page is agent-written HTML; updated latest.png only. Save an iteration in Display mode to replace the page with the drawing.");
	}
	return { width, height, wrote_page };
}

/**
 * Builds the HTML-mode prompt from html-mode-prompt.md (read each time so it can be tweaked without restarting).
 * @param {{ image: string, previous_screenshot: string | null, width: number, height: number }} info
 */
function build_prompt({ image, previous_screenshot, width, height }) {
	const template = fs.readFileSync(path.join(__dirname, "html-mode-prompt.md"), "utf8");
	const previous_note = previous_screenshot ?
		`\nAlso attached: \`${previous_screenshot}\`, a clean screenshot of the current \`public/index.html\` taken before the user drew on it. Compare the two images to see exactly what the user added or changed.\n` :
		"\n";
	return template
		.replaceAll("{{ITERATION_IMAGE}}", image)
		.replaceAll("{{PREVIOUS_SCREENSHOT_NOTE}}", previous_note)
		.replaceAll("{{WIDTH}}", String(width))
		.replaceAll("{{HEIGHT}}", String(height));
}

// #endregion

// #region Preview deploys (coalesced)

let last_preview_url = /** @type {string | null} */ (null);
let last_deploy_error = /** @type {string | null} */ (null);
let deploy_chain = Promise.resolve();
let deploy_last_started = 0;
/** @type {{ loggers: Logger[], promise: Promise<string | null>, resolve: (url: string | null) => void, reject: (error: Error) => void } | null} */
let deploy_batch = null;

/**
 * `wrangler versions upload --preview-alias <alias>` in the site repo: a new non-production version,
 * reachable at a stable alias URL. Production is untouched (that's `wrangler deploy`, via the GitHub workflow).
 * @param {Logger} log
 * @returns {Promise<string | null>} the preview URL
 */
async function run_preview_deploy(log) {
	const [command, ...base_args] = config.deploy.command.split(/\s+/);
	// wrangler is chatty; forward only the lines worth seeing in the Agent window's log.
	const quiet_log = (/** @type {string} */ line) => {
		if (/Found \d+ new|Success!|Alias URL|error|warn|fail/i.test(line)) { log(line); }
	};
	const stdout = await run(command, [...base_args, "versions", "upload", "--preview-alias", config.deploy.preview_alias], {
		cwd: SITE_DIR,
		log: quiet_log,
		prefix: "wrangler: ",
		timeout_ms: config.deploy.timeout_minutes * 60 * 1000,
	});
	const urls = [...stdout.matchAll(/https:\/\/\S+workers\.dev\S*/g)].map((match) => match[0].replace(/[),.]+$/, ""));
	return urls.find((url) => url.includes(`//${config.deploy.preview_alias}-`)) || urls[urls.length - 1] || null;
}

/**
 * Requests a preview deploy of the current public/ contents. Requests arriving while a deploy is
 * pending share that deploy; requests arriving while one is running get the next one. At most one
 * deploy starts per `min_interval_ms`, so live preview can fire after every stroke.
 * @param {Logger} log
 * @returns {Promise<string | null>} the preview URL (null if deploys are disabled)
 */
function schedule_preview_deploy(log) {
	if (!config.deploy.enabled) { return Promise.resolve(null); }
	if (deploy_batch) {
		deploy_batch.loggers.push(log);
		return deploy_batch.promise;
	}
	/** @type {typeof deploy_batch} */
	const batch = { loggers: [log], promise: null, resolve: null, reject: null };
	batch.promise = new Promise((resolve, reject) => { batch.resolve = resolve; batch.reject = reject; });
	deploy_batch = batch;
	deploy_chain = deploy_chain.then(async () => {
		const wait = deploy_last_started + config.deploy.min_interval_ms - Date.now();
		if (wait > 0) { await new Promise((resolve) => setTimeout(resolve, wait)); }
		deploy_batch = null; // requests from here on belong to the next deploy
		deploy_last_started = Date.now();
		const fan_out = (/** @type {string} */ line) => { for (const logger of batch.loggers) { logger(line); } };
		fan_out("Deploying preview...");
		try {
			const url = await run_preview_deploy(fan_out);
			last_preview_url = url || last_preview_url;
			last_deploy_error = null;
			fan_out(`Preview live: ${url || "(no URL reported)"}`);
			batch.resolve(url);
		} catch (error) {
			last_deploy_error = error.message;
			batch.reject(error);
		}
	});
	return batch.promise;
}

/**
 * @param {Logger} log
 * @returns {Promise<{ preview_url: string | null, deploy_error: string | null }>}
 */
async function deploy_preview_for_result(log) {
	try {
		return { preview_url: await schedule_preview_deploy(log), deploy_error: null };
	} catch (error) {
		log(`Preview deploy failed (the iteration itself is saved): ${error.message}`);
		return { preview_url: null, deploy_error: error.message };
	}
}

// #endregion

// #region Live room (jspaint-live Worker)

let warned_live_not_configured = false;

/**
 * Pushes the canvas to the realtime room so open display pages update within a few hundred ms,
 * long before the preview deploy lands. Best-effort; failures are logged, never fatal.
 * @param {string} data_uri
 * @param {Logger} log
 */
async function forward_to_live_room(data_uri, log) {
	if (!config.live.url || !config.live.secret) {
		if (!warned_live_not_configured) {
			warned_live_not_configured = true;
			log("Live room not configured (live.url / live.secret in config.json); viewers will update on deploy only.");
		}
		return;
	}
	try {
		const response = await fetch(`${config.live.url.replace(/\/+$/, "")}/rooms/${config.live.room}/data`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${config.live.secret}`, "Content-Type": "text/plain" },
			body: data_uri,
		});
		if (!response.ok) {
			log(`Live room rejected the update: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
			return;
		}
		const { version, clients } = await response.json();
		log(`Live room updated (v${version}, ${clients} viewer${clients === 1 ? "" : "s"} notified).`);
	} catch (error) {
		log(`Live room unreachable: ${error.message}`);
	}
}

/** @param {Buffer} png */
const png_to_data_uri = (png) => `data:image/png;base64,${png.toString("base64")}`;

// #endregion

// #region Job implementations

/**
 * @param {Job} _job
 * @param {Logger} log
 * @param {"display" | "html"} mode
 * @param {Buffer} png
 */
async function iteration_job(_job, log, mode, png) {
	const { width, height } = png_dimensions(png);
	const numbers = iteration_numbers();
	const iteration = (numbers[numbers.length - 1] || 0) + 1;
	const name = String(iteration).padStart(3, "0");
	const image = path.join("public", "iterations", `${name}.png`);

	// Grab the pre-annotation render before anything changes, to help the agent diff.
	const previous_screenshot = mode === "html" ? latest_screenshot() : null;

	await fsp.writeFile(site(image), png);
	await fsp.copyFile(site(image), pub("latest.png"));
	log(`Saved ${image} (${width}×${height})`);

	if (mode === "display") {
		await fsp.writeFile(pub("index.html"), render_display_page({ version: iteration, width, height }));
		log("public/index.html now displays the drawing as-is.");
		room_data_uri = png_to_data_uri(png);
		const [deploy] = await Promise.all([deploy_preview_for_result(log), forward_to_live_room(room_data_uri, log)]);
		return { iteration, mode, image_url: `/files/${image}`, ...deploy };
	}

	const prompt = build_prompt({ image, previous_screenshot, width, height });
	const args = [
		"run",
		"--dir", SITE_DIR,
		"--file", site(image),
		...(previous_screenshot ? ["--file", site(previous_screenshot)] : []),
		...(config.opencode.auto_approve ? ["--auto"] : []),
		...(config.opencode.model ? ["--model", config.opencode.model] : []),
		...(config.opencode.agent ? ["--agent", config.opencode.agent] : []),
		...config.opencode.extra_args,
		prompt,
	];
	log(`Running ${config.opencode.command} run${config.opencode.model ? ` (${config.opencode.model})` : ""} on the site repo... (this can take a few minutes)`);
	const stdout = await run(config.opencode.command, args, {
		cwd: SITE_DIR,
		log,
		prefix: "agent: ",
		timeout_ms: config.opencode.timeout_minutes * 60 * 1000,
	});
	if (!fs.existsSync(pub("index.html"))) {
		throw new Error("The agent finished but public/index.html doesn't exist.");
	}
	return {
		iteration,
		mode,
		image_url: `/files/${image}`,
		// JS Paint renders this itself and uploads the result to /api/screenshots/<screenshot_name>
		page_url: PAGE_URL,
		screenshot_name: name,
		agent_summary: stdout.trim().slice(-1500),
		...(await deploy_preview_for_result(log)),
	};
}

/**
 * @param {Job} _job
 * @param {Logger} log
 */
async function publish_job(_job, log) {
	if (!fs.existsSync(site(".git"))) {
		throw new Error(`${SITE_DIR} is not a git repository. Run: git init && git remote add origin <your repo>`);
	}
	const remote_url = await git(["remote", "get-url", config.git.remote], () => {}).catch(() => "");
	if (!remote_url.trim()) {
		throw new Error(`The site repo has no "${config.git.remote}" remote to push to. In ${SITE_DIR}, run:\n  gh repo create jspaint-site --private --source=. --remote=origin --push\n(or git remote add origin <url>). See its README.md for the Cloudflare setup.`);
	}
	await git(["add", "-A"], log);
	const status = await git(["status", "--porcelain"], () => {});
	const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], () => {})).trim();
	if (status.trim()) {
		const numbers = iteration_numbers();
		const iteration = numbers[numbers.length - 1] || 0;
		await git(["commit", "-m", `Iteration ${iteration} (${page_mode()} page)`], log);
	} else {
		log("Working tree clean; nothing new to commit.");
	}
	// Push even when there was nothing to commit, in case an earlier push failed.
	const ahead = (await git(["rev-list", "--count", `@{upstream}..HEAD`], () => {}).catch(() => "1")).trim();
	if (ahead === "0" && !status.trim()) {
		return { pushed: false, branch, site_url: config.site_url };
	}
	await git(["push", "--set-upstream", config.git.remote, branch], log);
	const commit = (await git(["rev-parse", "--short", "HEAD"], () => {})).trim();
	log(`Pushed ${commit}. The site repo's GitHub workflow deploys production from here.`);
	return { pushed: true, commit, branch, site_url: config.site_url };
}

// #endregion

// #region Live preview room (JS Paint RESTSession protocol)

// JS Paint's multi-user RESTSession (src/sessions.js) PUTs the whole canvas as a PNG data URI after every
// stroke (debounced 100ms) and polls GET every second. Any room ID maps to this one site.
/** @type {string | null} */
let room_data_uri = null;

/** @returns {string | null} */
function current_room_data_uri() {
	if (room_data_uri) { return room_data_uri; }
	if (fs.existsSync(pub("latest.png"))) {
		room_data_uri = `data:image/png;base64,${fs.readFileSync(pub("latest.png")).toString("base64")}`;
	}
	return room_data_uri;
}

/**
 * @param {string} data_uri
 */
function handle_room_write(data_uri) {
	const match = /^data:image\/png;base64,(.+)$/s.exec(data_uri.trim());
	if (!match) {
		throw new Error("Room data must be a PNG data URI");
	}
	const png = Buffer.from(match[1], "base64");
	const { width, height, wrote_page } = write_latest(png, Date.now(), (line) => console.log(`[live] ${line}`));
	room_data_uri = data_uri;
	console.log(`[live] latest.png updated (${width}×${height})${wrote_page ? ", display page rewritten" : ""}`);
	const live_log = (/** @type {string} */ line) => console.log(`[live] ${line}`);
	forward_to_live_room(data_uri, live_log);
	schedule_preview_deploy(live_log).catch((error) => {
		console.error(`[live] preview deploy failed: ${error.message}`);
	});
}

// #endregion

// #region HTTP

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const CONTENT_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".cur": "image/x-icon",
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".xml": "application/xml",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

/** @param {http.IncomingMessage} req @returns {Promise<Buffer>} */
function read_body(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** @param {http.ServerResponse} res @param {number} status @param {any} data */
function send_json(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

/** @param {http.ServerResponse} res @param {number} status @param {string} text */
function send_text(res, status, text) {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(text);
}

/**
 * Serves one file from under `root`, refusing paths that escape it or hit .git / node_modules / agent-server.
 * @param {http.ServerResponse} res
 * @param {string} root
 * @param {string} relative
 */
async function send_file(res, root, relative) {
	const absolute = path.resolve(root, relative);
	const inside = absolute.startsWith(root + path.sep);
	const blocked = /(^|[\\/])(\.git|node_modules|agent-server)([\\/]|$)/.test(path.relative(root, absolute));
	if (!inside || blocked) {
		send_json(res, 404, { error: "Not found" });
		return;
	}
	let stat;
	try {
		stat = await fsp.stat(absolute);
	} catch (_error) {
		send_json(res, 404, { error: "Not found" });
		return;
	}
	if (!stat.isFile()) {
		send_json(res, 404, { error: "Not found" });
		return;
	}
	res.writeHead(200, {
		"Content-Type": CONTENT_TYPES[path.extname(absolute).toLowerCase()] || "application/octet-stream",
		"Content-Length": stat.size,
		"Cache-Control": "no-store",
	});
	fs.createReadStream(absolute).pipe(res);
}

const server = http.createServer(async (req, res) => {
	// JS Paint may run on a different origin (e.g. localhost:1999), so allow cross-origin requests.
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}
	const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
	const room_match = /^\/api\/rooms\/([^/]+)\/data$/.exec(url.pathname);
	try {
		if (req.method === "GET" && url.pathname === "/api/status") {
			send_json(res, 200, {
				ok: true,
				site_dir: SITE_DIR,
				site_url: config.site_url,
				preview_url: last_preview_url,
				deploy_enabled: config.deploy.enabled,
				deploy_error: last_deploy_error,
				page_url: PAGE_URL,
				live_url: config.live.url && config.live.secret ? `${config.live.url.replace(/\/+$/, "")}/rooms/${config.live.room}/data` : null,
				iterations: iteration_numbers().length,
				page_mode: page_mode(),
			});
		} else if (req.method === "POST" && url.pathname === "/api/iteration") {
			const mode = url.searchParams.get("mode") === "html" ? "html" : "display";
			const png = await read_body(req);
			png_dimensions(png); // validate before starting the job
			const job = start_job("iteration", (job, log) => iteration_job(job, log, mode, png));
			send_json(res, 202, { job: job.id });
		} else if (req.method === "PUT" && url.pathname.startsWith("/api/screenshots/")) {
			const name = url.pathname.slice("/api/screenshots/".length);
			if (!/^(\d{3}|current)$/.test(name)) {
				send_json(res, 400, { error: "Screenshot name must be a 3-digit iteration number or \"current\"" });
				return;
			}
			const png = await read_body(req);
			png_dimensions(png);
			const relative = path.join("screenshots", `${name}.png`);
			await fsp.writeFile(site(relative), png);
			send_json(res, 200, { ok: true, url: `/files/${relative}` });
		} else if (req.method === "POST" && url.pathname === "/api/publish") {
			const job = start_job("publish", publish_job);
			send_json(res, 202, { job: job.id });
		} else if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
			const job = jobs.get(url.pathname.slice("/api/jobs/".length));
			if (!job) {
				send_json(res, 404, { error: "No such job" });
			} else {
				send_json(res, 200, job);
			}
		} else if (room_match && req.method === "GET") {
			const data_uri = current_room_data_uri();
			if (data_uri) {
				send_text(res, 200, data_uri);
			} else {
				send_text(res, 404, ""); // JS Paint treats 404 as "new session" and uploads its canvas
			}
		} else if (room_match && req.method === "PUT") {
			handle_room_write((await read_body(req)).toString("utf8"));
			send_text(res, 200, "ok");
		} else if (req.method === "GET" && url.pathname.startsWith("/files/")) {
			await send_file(res, SITE_DIR, decodeURIComponent(url.pathname.slice("/files/".length)));
		} else if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
			// JS Paint itself, so the room API is same-origin: http://localhost:4097/#session:live
			let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
			if (relative === "" || relative.endsWith("/")) { relative += "index.html"; }
			await send_file(res, JSPAINT_DIR, relative);
		} else {
			send_json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
		}
	} catch (error) {
		console.error(error);
		send_json(res, 400, { error: error?.message || String(error) });
	}
});

server.listen(config.port, "127.0.0.1", () => {
	console.log(`Agent Drive server listening on http://localhost:${config.port}`);
	console.log(`Site repo: ${SITE_DIR} (${iteration_numbers().length} iterations, ${page_mode()} page)`);
	console.log(`JS Paint (same-origin, for live preview): http://localhost:${config.port}/`);
	console.log(`In JS Paint: Extras > Agent Window, or Ctrl+Alt+I to save an iteration, Ctrl+Alt+P to publish.`);
});

// #endregion
