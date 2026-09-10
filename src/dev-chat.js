// @ts-check
/* global localize */
// The Code Agent window (Extras > Code Agent): chat with opencode about THIS app's code while using it. Each
// message runs `opencode run` on the repo through the local agent server (agent-server/server.js, POST
// /api/dev/prompt); the window streams what the agent reads, edits, and runs, then reloads JS Paint when files
// that make up the app changed — the conversation, the drawing (autosaved), and the elements come back.
// Follow-ups continue the same opencode session. Only for Paint served from the agent server (a dev tool).
import { $DialogWindow } from "./$ToolWindow.js";
import { api, get_server_url } from "./agent-drive.js";
import { $G, E } from "./helpers.js";

const STORAGE_KEY = "jspaint code agent";
const POLL_INTERVAL_MS = 700;
const MAX_TRANSCRIPT = 300;

/** @typedef {{ role: "user" | "assistant" | "tool" | "note" | "error", text: string, tool?: string }} ChatEntry */
/**
 * @typedef {object} CodeAgentState
 * @property {string | null} session - opencode session id to continue
 * @property {string} model - provider/model override; "" = the server's default
 * @property {boolean} auto_reload
 * @property {boolean} open - reopen the window after a reload
 * @property {ChatEntry[]} transcript
 * @property {string | null} job - a job we were polling when the page reloaded
 * @property {number} events_seen - how many of that job's events are already in the transcript
 * @property {string} draft
 */

/** @returns {CodeAgentState} */
function load_state() {
	/** @type {Partial<CodeAgentState>} */
	let stored = {};
	try {
		stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
	} catch (_error) { /* ignore */ }
	return {
		session: stored.session || null,
		model: stored.model || "",
		auto_reload: stored.auto_reload !== false,
		open: !!stored.open,
		transcript: Array.isArray(stored.transcript) ? stored.transcript : [],
		job: stored.job || null,
		events_seen: stored.events_seen || 0,
		draft: stored.draft || "",
	};
}
function save_state() {
	try {
		if (state.transcript.length > MAX_TRANSCRIPT) { state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT); }
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch (_error) { /* ignore */ }
}
const state = load_state();

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $window = null;
/** @type {JQuery<HTMLElement> | null} */
let $transcript = null;
/** @type {JQuery<HTMLTextAreaElement> | null} */
let $prompt = null;
/** @type {JQuery<HTMLElement> | null} */
let $status = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $send = null;
/** @type {JQuery<HTMLButtonElement> | null} */
let $stop = null;
let polling = false;

const TOOL_ICONS = { write: "✎", edit: "✎", patch: "✎", read: "👁", bash: "$", glob: "🔍", grep: "🔍", list: "📁", webfetch: "🌐", websearch: "🌐", todowrite: "☑", todoread: "☑", task: "⚙" };

/**
 * @param {ChatEntry} entry
 * @param {boolean} [persist=true]
 */
function add_entry(entry, persist = true) {
	if (persist) {
		state.transcript.push(entry);
		save_state();
	}
	if (!$transcript) { return; }
	render_entry(entry).appendTo($transcript);
	$transcript[0].scrollTop = $transcript[0].scrollHeight;
}

/** @param {ChatEntry} entry */
function render_entry(entry) {
	const $entry = $(E("div")).addClass(`code-agent-entry code-agent-${entry.role}`);
	if (entry.role === "user") {
		$entry.append($(E("b")).text(`${localize("You")}: `), document.createTextNode(entry.text));
	} else if (entry.role === "tool") {
		$entry.text(`${TOOL_ICONS[entry.tool || ""] || "•"} ${entry.tool} ${entry.text}`.trim());
	} else {
		$entry.text(entry.text);
	}
	return $entry;
}

/** @param {boolean} busy */
function set_busy(busy) {
	$send?.prop("disabled", busy);
	$stop?.prop("disabled", !busy);
	$window?.toggleClass("code-agent-busy", busy);
	$status?.toggleClass("working", busy);
	if (busy && $status) { $status.text(localize("Working…")); }
}

/** @param {string} text */
function set_status(text) {
	if ($status && !$window?.hasClass("code-agent-busy")) { $status.text(text); }
}

async function check_status() {
	try {
		const status = await api("/api/status");
		if (!status.dev) {
			set_status(localize("The Code Agent is disabled on the server (dev.enabled)."));
			return false;
		}
		set_status(`${status.dev.repo_dir.replace(/^.*\//, "")} @ ${status.dev.branch || "?"} · ${state.model || status.dev.model || localize("opencode's default model")}`);
		if (status.dev.running_job && !state.job) {
			state.job = status.dev.running_job; // e.g. started before a reload we didn't record
			save_state();
			poll_job(status.dev.running_job);
		}
		return true;
	} catch (error) {
		set_status(`${localize("Not connected:")} ${error.message.split("\n")[0]}`);
		return false;
	}
}

async function send_prompt() {
	if (!$prompt) { return; }
	const prompt = String($prompt.val()).trim();
	if (!prompt || state.job) { return; }
	add_entry({ role: "user", text: prompt });
	$prompt.val("");
	state.draft = "";
	set_busy(true);
	try {
		const { job } = await api("/api/dev/prompt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt, session: state.session, model: state.model }),
		});
		state.job = job;
		state.events_seen = 0;
		save_state();
		poll_job(job);
	} catch (error) {
		add_entry({ role: "error", text: error.message });
		set_busy(false);
	}
}

/**
 * Streams a job's events into the transcript until it finishes; reloads the app if its files changed.
 * @param {string} job_id
 */
async function poll_job(job_id) {
	if (polling) { return; }
	polling = true;
	set_busy(true);
	let cost = 0;
	try {
		for (;;) {
			const job = await api(`/api/jobs/${job_id}`);
			const events = job.events || [];
			for (const event of events.slice(state.events_seen)) {
				if (event.type === "text") {
					add_entry({ role: "assistant", text: event.text });
				} else if (event.type === "tool") {
					add_entry({ role: "tool", tool: event.tool, text: event.title || "" });
				} else if (event.type === "error") {
					add_entry({ role: "error", text: event.text });
				} else if (event.type === "step") {
					cost += event.cost || 0;
				}
			}
			state.events_seen = events.length;
			if (job.session && job.session !== state.session) {
				state.session = job.session;
			}
			save_state();
			if (job.status === "running") {
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				continue;
			}
			state.job = null;
			state.events_seen = 0;
			if (job.status === "error") {
				add_entry({ role: "error", text: job.error || localize("The agent failed.") });
			} else if (job.result) {
				const result = job.result;
				const files = result.changed_files || [];
				const money = result.cost || cost ? ` · $${(result.cost || cost).toFixed(3)}` : "";
				if (result.aborted) {
					add_entry({ role: "note", text: `${localize("Stopped.")}${files.length ? ` ${localize("Changed:")} ${files.join(", ")}` : ""}` });
				} else {
					add_entry({ role: "note", text: `${files.length ? `${localize("Changed:")} ${files.join(", ")}` : localize("No files changed.")}${money}` });
				}
				if (result.app_changed && state.auto_reload && !result.aborted) {
					add_entry({ role: "note", text: localize("Reloading the app with the changes…") });
					save_state();
					setTimeout(() => { location.reload(); }, 1200);
					return;
				}
			}
			save_state();
			break;
		}
	} catch (error) {
		add_entry({ role: "error", text: error.message }, false);
		state.job = null;
		save_state();
	} finally {
		polling = false;
		set_busy(false);
		check_status();
	}
}

async function stop_job() {
	if (!state.job) { return; }
	try {
		await api(`/api/dev/abort/${state.job}`, { method: "POST" });
	} catch (error) {
		add_entry({ role: "error", text: error.message }, false);
	}
}

function new_conversation() {
	state.session = null;
	state.transcript = [];
	save_state();
	$transcript?.empty();
	add_entry({ role: "note", text: localize("New conversation. The agent starts fresh (it re-reads the repo notes).") }, false);
}

function show_code_agent_window() {
	if ($window) {
		$window.bringToFront();
		$prompt?.trigger("focus");
		return;
	}
	state.open = true;
	save_state();
	$window = $DialogWindow(localize("Code Agent"));
	$window.addClass("code-agent-window squish");
	const $main = $window.$main;

	$status = $(E("div")).addClass("code-agent-status").text(localize("Connecting…")).appendTo($main);
	$transcript = $(E("div")).addClass("code-agent-transcript inset-deep").attr({ role: "log", "aria-live": "polite" }).appendTo($main);
	for (const entry of state.transcript) {
		render_entry(entry).appendTo($transcript);
	}
	if (state.transcript.length === 0) {
		add_entry({ role: "note", text: localize("Describe a change to this app (JS Paint, this very page). opencode edits the code; when it's done, the app reloads with the change. Follow-ups continue the same conversation.") }, false);
	}
	$transcript[0].scrollTop = $transcript[0].scrollHeight;

	$prompt = /** @type {JQuery<HTMLTextAreaElement>} */ ($(E("textarea")).addClass("code-agent-prompt inset-deep").attr({
		rows: 3,
		placeholder: localize("e.g. make the Marquee tool default to scrolling right, slowly"),
		spellcheck: "true",
	}).val(state.draft).appendTo($main));
	$prompt.on("input", () => {
		state.draft = String($prompt.val());
		save_state();
	});
	$prompt.on("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			send_prompt();
		}
	});

	const $options = $(E("div")).addClass("code-agent-options").appendTo($main);
	const reload_id = "code-agent-auto-reload";
	$(E("input")).attr({ type: "checkbox", id: reload_id }).prop("checked", state.auto_reload).on("change", (e) => {
		state.auto_reload = /** @type {HTMLInputElement} */ (e.target).checked;
		save_state();
	}).appendTo($options);
	$(E("label")).attr({ for: reload_id }).text(localize("Reload the app when its files change")).appendTo($options);
	const $model_label = $(E("label")).addClass("code-agent-model").text(`${localize("Model:")} `).appendTo($options);
	$(E("input")).attr({ type: "text", spellcheck: "false", autocomplete: "off", placeholder: localize("opencode default (provider/model)") }).val(state.model).on("change", (e) => {
		state.model = String(/** @type {HTMLInputElement} */ (e.target).value).trim();
		save_state();
		check_status();
	}).appendTo($model_label);

	$send = $window.$Button(localize("Send"), () => { send_prompt(); }, { type: "submit" });
	$send.attr("title", localize("Ctrl+Enter"));
	$stop = $window.$Button(localize("Stop"), () => { stop_job(); });
	$window.$Button(localize("New Conversation"), () => { new_conversation(); });
	$window.$Button(localize("Reload App"), () => { save_state(); location.reload(); });
	$window.$Button(localize("Close"), () => { $window.close(); });
	$window.on("close", () => {
		state.open = false;
		save_state();
		$window = null;
		$transcript = null;
		$prompt = null;
		$status = null;
		$send = null;
		$stop = null;
		$G.triggerHandler("code-agent-toggled");
	});
	set_busy(!!state.job);

	$window.$content.css({ width: "min(560px, 92vw)" });
	$window.css({
		left: Math.max(0, innerWidth - $window.outerWidth() - 24),
		top: 60,
	});
	$G.triggerHandler("code-agent-toggled");
	check_status().then((ok) => {
		if (ok && state.job) { poll_job(state.job); }
	});
	$prompt.trigger("focus");
}

function toggle_code_agent_window() {
	if ($window) {
		$window.close();
	} else {
		show_code_agent_window();
	}
}

function is_code_agent_window_open() {
	return !!$window;
}

// After a reload the agent triggered (or any reload with the window open), come back to the conversation.
$(() => {
	if (state.open || state.job) {
		setTimeout(() => { show_code_agent_window(); }, 600);
	}
});

$("<style>").text(`
	.code-agent-status {
		font-size: 11px;
		opacity: 0.85;
		margin-bottom: 4px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.code-agent-status.working::before {
		content: "⏳ ";
	}
	.code-agent-transcript {
		height: min(360px, 45vh);
		overflow: auto;
		padding: 6px;
		background: #fff;
		color: #222;
		font-size: 12px;
		line-height: 1.35;
	}
	.code-agent-entry {
		margin: 0 0 6px;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}
	.code-agent-user {
		background: #ffffcc;
		padding: 3px 5px;
		border: 1px solid #e0e0a0;
	}
	.code-agent-tool {
		font: 11px "Courier New", monospace;
		color: #555;
		margin: 0 0 2px 8px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.code-agent-note {
		color: #000080;
		font-style: italic;
	}
	.code-agent-error {
		color: #a00000;
	}
	.code-agent-prompt {
		display: block;
		width: 100%;
		box-sizing: border-box;
		margin-top: 6px;
		font: 12px sans-serif;
		resize: vertical;
	}
	.code-agent-options {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 6px;
		font-size: 11px;
	}
	.code-agent-model {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
		min-width: 180px;
	}
	.code-agent-model input {
		flex: 1;
		min-width: 0;
	}
`).appendTo(document.head);

export { is_code_agent_window_open, show_code_agent_window, toggle_code_agent_window, get_server_url as code_agent_server_url };
