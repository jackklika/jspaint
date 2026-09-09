// @ts-check
// eslint-disable-next-line no-unused-vars
/* global localize, main_canvas, main_ctx, saved:writable, $canvas_area */
// Agent Drive: use the canvas to drive an LLM agent that edits a static website.
//
// The canvas image is sent to a local companion server (see agent-server/),
// which saves it as a numbered "iteration" and either:
// - "display" mode: makes the page show the drawing as-is, or
// - "html" mode: has an agent (opencode) convert the drawing/annotations into real HTML;
//   the resulting page is then rendered (in this browser, via SVG <foreignObject>) back into the canvas for the next round.
// "Publish" commits and pushes the site repo; a GitHub workflow deploys it.
import { $DialogWindow } from "./$ToolWindow.js";
import { cancel, deselect, sanity_check_blob, show_error_message, undoable, update_title } from "./functions.js";
import { E, get_help_folder_icon, load_image_simple, make_canvas } from "./helpers.js";

const DEFAULT_SERVER_URL = "http://localhost:4097";
const SERVER_URL_KEY = "jspaint agent-drive server url";
const MODE_KEY = "jspaint agent-drive mode";
const POLL_INTERVAL_MS = 1000;
const PAGE_URL = "/files/public/index.html"; // the site's page, served by the agent server from the site repo
const LIVE_SESSION_ID = "live";

/** @typedef {"display" | "html"} AgentDriveMode */

/** @type {(OSGUI$Window & I$DialogWindow) | null} */
let $agent_window = null;
/** @type {JQuery<HTMLElement> | null} */
let $log = null;
/** @type {JQuery<HTMLButtonElement>[]} */
let $action_buttons = [];
let busy = false;

/** @returns {string} */
function get_server_url() {
	try {
		return localStorage.getItem(SERVER_URL_KEY) || DEFAULT_SERVER_URL;
	} catch (_error) {
		return DEFAULT_SERVER_URL;
	}
}
/** @param {string} url */
function set_server_url(url) {
	try {
		localStorage.setItem(SERVER_URL_KEY, url.replace(/\/+$/, ""));
	} catch (_error) { /* ignore */ }
}
/** @returns {AgentDriveMode} */
function get_mode() {
	try {
		return localStorage.getItem(MODE_KEY) === "html" ? "html" : "display";
	} catch (_error) {
		return "display";
	}
}
/** @param {AgentDriveMode} mode */
function set_mode(mode) {
	try {
		localStorage.setItem(MODE_KEY, mode);
	} catch (_error) { /* ignore */ }
	$agent_window?.find(`input[name="agent-drive-mode"][value="${mode}"]`).prop("checked", true);
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.href] - make the line a link
 * @param {boolean} [options.error]
 */
function log(text, { href, error } = {}) {
	window.console?.log(`[agent-drive] ${text}`);
	if (!$log) { return; }
	const $line = $(E("div")).addClass("agent-drive-log-line").appendTo($log);
	if (error) { $line.addClass("agent-drive-log-error"); }
	const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	$line.append($(E("span")).addClass("agent-drive-log-time").text(`${time} `));
	if (href) {
		$line.append($(E("a")).attr({ href, target: "_blank" }).text(text));
	} else {
		$line.append(document.createTextNode(text));
	}
	$log[0].scrollTop = $log[0].scrollHeight;
}

/** @param {boolean} value */
function set_busy(value) {
	busy = value;
	for (const $button of $action_buttons) {
		$button.prop("disabled", value);
	}
	$agent_window?.toggleClass("agent-drive-busy", value);
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function api(path, init) {
	const url = `${get_server_url()}${path}`;
	let response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		throw new Error(`Couldn't reach the agent server at ${get_server_url()}.\nStart it with: cd agent-server && npm start\n\n${error}`);
	}
	const text = await response.text();
	/** @type {any} */
	let data;
	try {
		data = JSON.parse(text);
	} catch (_error) {
		throw new Error(`Agent server returned a non-JSON response (HTTP ${response.status}):\n${text.slice(0, 500)}`);
	}
	if (!response.ok) {
		throw new Error(data.error || `Agent server error (HTTP ${response.status})`);
	}
	return data;
}

/**
 * Starts a job and streams its log lines into the window until it finishes.
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>} the job's result
 */
async function run_job(path, init) {
	const { job: job_id } = await api(path, init);
	let lines_shown = 0;
	for (;;) {
		const job = await api(`/api/jobs/${job_id}`);
		for (const line of job.log.slice(lines_shown)) {
			log(line);
		}
		lines_shown = job.log.length;
		if (job.status === "done") {
			return job.result;
		}
		if (job.status === "error") {
			throw new Error(job.error || "Job failed");
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

/**
 * Replaces the document with the given image, as an undoable step.
 * @param {HTMLCanvasElement | HTMLImageElement} image
 * @param {string} name - history entry name
 */
function replace_canvas_contents(image, name) {
	const new_canvas = make_canvas(image);
	deselect();
	cancel();
	undoable({
		name,
		icon: get_help_folder_icon("p_open.png"),
		assume_saved: true,
	}, () => {
		main_ctx.copy(new_canvas);
		$canvas_area.trigger("resize"); // update handles and magnified canvas size
	});
	// The canvas now mirrors what the agent has; treat it as saved so that
	// loading the next render doesn't prompt about unsaved changes.
	saved = true;
	update_title();
}

/**
 * Fetches a file from the site repo (via the agent server) as a data URL.
 * @param {string} relative_url - relative to the site's index.html
 * @returns {Promise<string>}
 */
async function fetch_site_file_as_data_url(relative_url) {
	const base = `${get_server_url()}${PAGE_URL}`;
	const url = new URL(relative_url, base);
	if (!url.href.startsWith(`${get_server_url()}/files/`)) {
		throw new Error(`Refusing to inline non-site asset: ${relative_url}`);
	}
	const response = await fetch(url.href);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${relative_url}`);
	}
	const blob = await response.blob();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => { resolve(/** @type {string} */(reader.result)); };
		reader.onerror = () => { reject(reader.error); };
		reader.readAsDataURL(blob);
	});
}

/**
 * Renders a self-contained HTML page to a canvas, right here in the browser, without a headless browser:
 * the document is serialized as XHTML inside an SVG <foreignObject>, loaded as an image, and drawn to a canvas.
 * Limitations (fine for the agent's single-file pages): scripts don't run, only inline CSS applies,
 * and relative assets must be inlined (done here for <img src> and CSS url()).
 * @param {string} html_text
 * @param {number} width
 * @param {number} height
 * @returns {Promise<HTMLCanvasElement>}
 */
async function render_page_to_canvas(html_text, width, height) {
	const doc = new DOMParser().parseFromString(html_text, "text/html");
	for (const element of doc.querySelectorAll("script, link[rel='stylesheet'], iframe, video, audio, object, embed")) {
		element.remove();
	}
	const inline_url = async (/** @type {string} */ url) => {
		if (/^(data:|blob:|https?:|\/\/|#)/i.test(url)) {
			return url; // nothing to do (or nothing we can do: SVG images can't load external resources)
		}
		try {
			return await fetch_site_file_as_data_url(url);
		} catch (error) {
			window.console?.warn("[agent-drive] Couldn't inline", url, error);
			return url;
		}
	};
	for (const img of doc.querySelectorAll("img[src]")) {
		img.setAttribute("src", await inline_url(img.getAttribute("src")));
		img.removeAttribute("srcset");
	}
	const inline_css_urls = async (/** @type {string} */ css) => {
		const matches = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
		for (const match of matches) {
			css = css.replace(match[0], `url("${await inline_url(match[2])}")`);
		}
		return css;
	};
	for (const style of doc.querySelectorAll("style")) {
		style.textContent = await inline_css_urls(style.textContent);
	}
	for (const styled of doc.querySelectorAll("[style*='url(']")) {
		styled.setAttribute("style", await inline_css_urls(styled.getAttribute("style")));
	}

	// XMLSerializer emits xmlns="http://www.w3.org/1999/xhtml" on the root, as foreignObject needs.
	const xhtml = new XMLSerializer().serializeToString(doc.documentElement)
		.replace(/&nbsp;/g, "&#160;"); // HTML entity that XML (SVG) doesn't know
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
	// A data: URL, not a blob: URL — Chromium taints the canvas when an SVG with <foreignObject>
	// comes from a blob URL, but not from a data URL.
	let img;
	try {
		img = await load_image_simple(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
	} catch (_error) {
		throw new Error("The browser couldn't render the page as an image (the HTML may not be well-formed).");
	}
	const canvas = make_canvas(width, height);
	canvas.ctx.fillStyle = "white"; // pages default to a white background; SVG images are transparent
	canvas.ctx.fillRect(0, 0, width, height);
	canvas.ctx.drawImage(img, 0, 0);
	try {
		canvas.ctx.getImageData(0, 0, 1, 1); // would throw if the browser tainted the canvas
	} catch (_error) {
		throw new Error("The browser refused to read back the rendered page (tainted canvas). Try Chrome or Firefox.");
	}
	return canvas;
}

/**
 * Renders the site's current index.html into the document, and uploads the render to the server
 * (so the agent can compare the clean page against the annotated one next time).
 * @param {object} options
 * @param {string} options.screenshot_name - "current" or a 3-digit iteration number
 * @param {number} options.width
 * @param {number} options.height
 * @param {string} options.history_name
 */
async function load_page_into_canvas({ screenshot_name, width, height, history_name }) {
	const response = await fetch(`${get_server_url()}${PAGE_URL}?t=${Date.now()}`);
	if (!response.ok) {
		throw new Error(`Couldn't load the page from the agent server (HTTP ${response.status})`);
	}
	const canvas = await render_page_to_canvas(await response.text(), width, height);
	replace_canvas_contents(canvas, history_name);
	// Best-effort upload; the iteration itself already succeeded.
	canvas.toBlob(async (blob) => {
		try {
			await api(`/api/screenshots/${screenshot_name}`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: blob });
		} catch (error) {
			log(`Couldn't upload the render for the agent's reference: ${error.message || error}`, { error: true });
		}
	}, "image/png");
}

/**
 * Sends the canvas to the agent server as a new iteration.
 * In "display" mode the page simply shows the drawing.
 * In "html" mode the agent converts the drawing/annotations to HTML and the result is loaded back into the canvas.
 * @param {AgentDriveMode} [mode]
 */
function save_iteration(mode = get_mode()) {
	if (busy) {
		log("Still working on the previous request...", { error: true });
		return;
	}
	show_agent_window();
	// include the selection in the saved image
	deselect();

	const { width, height } = main_canvas;
	main_canvas.toBlob((blob) => {
		sanity_check_blob(blob, async () => {
			set_busy(true);
			log(`Saving ${width}×${height} iteration (${mode === "html" ? "HTML" : "display"} mode)...`);
			try {
				const result = await run_job(`/api/iteration?mode=${mode}`, {
					method: "POST",
					headers: { "Content-Type": "image/png" },
					body: blob,
				});
				if (result.page_url) {
					log("Rendering the updated page into the canvas...");
					await load_page_into_canvas({
						screenshot_name: result.screenshot_name,
						width,
						height,
						history_name: localize("Agent Iteration %1", String(result.iteration)),
					});
				} else {
					saved = true;
					update_title();
				}
				if (result.preview_url) {
					log(result.preview_url, { href: result.preview_url });
				} else if (result.deploy_error) {
					log(`Preview deploy failed: ${result.deploy_error}`, { error: true });
				}
				log(`Iteration ${result.iteration} saved. Publish to Web (Ctrl+Alt+P) puts it on the production URL.`);
			} catch (error) {
				log(String(error.message || error), { error: true });
				show_error_message("Failed to save iteration.", error);
			} finally {
				set_busy(false);
			}
		});
	}, "image/png");
}

/**
 * Commits and pushes the site repo; the site's GitHub workflow deploys it.
 */
async function publish_site() {
	if (busy) {
		log("Still working on the previous request...", { error: true });
		return;
	}
	show_agent_window();
	set_busy(true);
	log("Publishing (git commit + push)...");
	try {
		const result = await run_job("/api/publish", { method: "POST" });
		if (result.pushed) {
			log(`Pushed ${result.commit} to ${result.branch}. Deploy workflow is running.`);
		} else {
			log("Nothing new to publish.");
		}
		if (result.site_url) {
			log(result.site_url, { href: result.site_url });
		}
	} catch (error) {
		log(String(error.message || error), { error: true });
		show_error_message("Failed to publish.", error);
	} finally {
		set_busy(false);
	}
}

/**
 * Renders the current page into the canvas, to annotate.
 */
async function load_site_screenshot() {
	if (busy) { return; }
	set_busy(true);
	log("Rendering the current page...");
	try {
		await load_page_into_canvas({
			screenshot_name: "current",
			width: main_canvas.width,
			height: main_canvas.height,
			history_name: localize("Load Site Page"),
		});
		log("Loaded. Draw your changes, then Save Iteration.");
	} catch (error) {
		log(String(error.message || error), { error: true });
		show_error_message("Failed to render the page.", error);
	} finally {
		set_busy(false);
	}
}

async function check_server_status() {
	try {
		const status = await api("/api/status");
		log(`Connected. Site: ${status.site_dir} (${status.iterations} iteration${status.iterations === 1 ? "" : "s"}, ${status.page_mode} page)`);
		if (status.site_url) {
			log(`Production: ${status.site_url}`, { href: status.site_url });
		}
		if (status.preview_url) {
			log(`Preview: ${status.preview_url}`, { href: status.preview_url });
		}
		update_live_preview_checkbox();
	} catch (error) {
		log(String(error.message || error), { error: true });
	}
}

/**
 * Live preview rides on JS Paint's multi-user "RESTSession" (see sessions.js): the whole canvas is synced to
 * /api/rooms/<id>/data after every stroke, and the agent server turns each write into the display page + a
 * preview deploy. The room API is same-origin only, so this works when JS Paint is served by the agent server.
 */
function live_preview_available() {
	return location.origin === get_server_url();
}
function is_live_preview_on() {
	return new RegExp(`(^#|,)session:${LIVE_SESSION_ID}$`, "i").test(location.hash);
}
/** @param {boolean} on */
function set_live_preview(on) {
	try {
		// sessions.js picks the REST implementation (instead of Firebase) from this dev override.
		if (on) {
			localStorage.setItem("online_session_implementation", "RESTSession");
		} else {
			localStorage.removeItem("online_session_implementation");
		}
	} catch (_error) { /* ignore */ }
	// Changing the hash starts/ends the session (sessions.js listens for hashchange).
	location.hash = on ? `#session:${LIVE_SESSION_ID}` : `#local:${(Math.random() * (2 ** 32)).toString(16).replace(".", "")}`;
	log(on ? "Live preview on: every stroke updates the page and redeploys the preview." : "Live preview off.");
}
function update_live_preview_checkbox() {
	$agent_window?.find(".agent-drive-live input").prop("checked", is_live_preview_on());
}
$(window).on("hashchange", update_live_preview_checkbox);

function show_agent_window() {
	if ($agent_window) {
		$agent_window.bringToFront();
		return;
	}
	$agent_window = $DialogWindow(localize("Agent"));
	$agent_window.addClass("agent-drive-window squish"); // squish: allow text to wrap (see .window:not(.squish) in layout.css)
	$agent_window.on("close", () => {
		$agent_window = null;
		$log = null;
		$action_buttons = [];
	});

	const $main = $agent_window.$main;

	const $modes = $(E("fieldset")).appendTo($main);
	$(E("legend")).text(localize("Output mode")).appendTo($modes);
	/** @type {[AgentDriveMode, string, string][]} */
	const mode_options = [
		["display", localize("Display"), localize("The page shows your drawing as an image, exactly as-is.")],
		["html", localize("HTML"), localize("An agent reads the drawing and turns it into real HTML: text becomes text, underlines become links, boxes become buttons.")],
	];
	for (const [value, label, description] of mode_options) {
		// 98.css styles radios via `input + label`, so they must be siblings.
		const id = `agent-drive-mode-${value}`;
		const $field = $(E("div")).addClass("radio-field agent-drive-mode").appendTo($modes);
		$(E("input")).attr({ type: "radio", name: "agent-drive-mode", id, value })
			.prop("checked", get_mode() === value)
			.on("change", () => { set_mode(value); })
			.appendTo($field);
		$(E("label")).attr({ for: id }).append($(E("b")).text(label)).appendTo($field);
		$(E("div")).addClass("agent-drive-mode-description").text(description).appendTo($field);
	}

	const $server_row = $(E("div")).addClass("agent-drive-server").appendTo($main);
	const $server_label = $(E("label")).text(localize("Server: ")).appendTo($server_row);
	$(E("input")).attr({ type: "text", spellcheck: "false" }).val(get_server_url())
		.on("change", (event) => {
			set_server_url(/** @type {HTMLInputElement} */(event.target).value);
			check_server_status();
		})
		.appendTo($server_label);
	$(E("button")).attr({ type: "button" }).text(localize("Load Current Page")).appendTo($server_row)
		.on("click", () => { load_site_screenshot(); });

	const $live_row = $(E("div")).addClass("agent-drive-live").appendTo($main);
	const live_id = "agent-drive-live-preview";
	$(E("input")).attr({ type: "checkbox", id: live_id }).prop({ checked: is_live_preview_on(), disabled: !live_preview_available() })
		.on("change", (event) => { set_live_preview(/** @type {HTMLInputElement} */(event.target).checked); })
		.appendTo($live_row);
	$(E("label")).attr({ for: live_id }).text(localize("Live preview (Display mode: every stroke updates the page)")).appendTo($live_row);
	if (!live_preview_available()) {
		$(E("div")).addClass("agent-drive-mode-description")
			.text(localize("Open JS Paint at %1 to enable live preview.", `${get_server_url()}/`))
			.appendTo($live_row);
	}

	$log = $(E("div")).addClass("agent-drive-log inset-deep").attr({ role: "log", "aria-live": "polite" }).appendTo($main);

	$action_buttons = [
		$agent_window.$Button(localize("Save Iteration"), () => { save_iteration(); }, { type: "submit" }),
		$agent_window.$Button(localize("Publish to Web"), () => { publish_site(); }),
	];
	$agent_window.$Button(localize("Close"), () => { $agent_window.close(); });
	set_busy(busy);

	$agent_window.$content.css({ width: "min(520px, 90vw)" });
	// Sit at the right, out of the way of the canvas, rather than centered.
	$agent_window.css({
		left: Math.max(0, innerWidth - $agent_window.outerWidth() - 24),
		top: 80,
	});

	check_server_status();
}

function toggle_agent_window() {
	if ($agent_window) {
		$agent_window.close();
	} else {
		show_agent_window();
	}
}

function is_agent_window_open() {
	return !!$agent_window;
}

$("<style>").text(`
	.agent-drive-window fieldset {
		margin: 0 0 8px;
	}
	.agent-drive-mode {
		margin: 4px 0 8px;
	}
	.agent-drive-mode-description {
		margin: 2px 0 0 22px;
		opacity: 0.8;
	}
	.agent-drive-server {
		display: flex;
		gap: 6px;
		align-items: center;
		margin-bottom: 8px;
	}
	.agent-drive-server label {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.agent-drive-server input {
		flex: 1;
		min-width: 0;
	}
	.agent-drive-live {
		margin-bottom: 8px;
	}
	.agent-drive-live input:disabled + label {
		opacity: 0.6;
	}
	.agent-drive-log {
		height: 140px;
		overflow: auto;
		padding: 4px;
		background: white;
		color: #222;
		font-family: monospace;
		font-size: 12px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.agent-drive-log-time {
		opacity: 0.5;
	}
	.agent-drive-log-error {
		color: #b00020;
	}
	.agent-drive-busy .agent-drive-log {
		background: #f4f4f4;
	}
`).appendTo(document.head);

export { is_agent_window_open, load_site_screenshot, publish_site, save_iteration, show_agent_window, toggle_agent_window };
