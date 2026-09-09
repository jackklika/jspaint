// @ts-check
// The fake Windows 98 desktop that hosts the site builder (docs/DESIGN.md §5): a taskbar with a Start menu,
// desktop icons, and os-gui windows for Paint (the jspaint app in a frame), the Page Editor, My Site, and GIFs.
import { load_settings, save_settings, whoami } from "./api.js";
import { open_gif_window } from "./gif-window.js";
import { open_my_site } from "./my-site.js";
import { open_page_editor } from "./page-editor.js";
import { open_paint } from "./paint-window.js";

/** @type {Map<string, { $window: OSGUI$Window, button: HTMLButtonElement }>} */
const open_windows = new Map();

/**
 * Registers a window with the taskbar. Windows are singletons by id: opening again brings it to the front.
 * @param {string} id
 * @param {string} title
 * @param {string} icon - image URL for the taskbar button
 * @param {() => OSGUI$Window} create
 */
export function show_window(id, title, icon, create) {
	const existing = open_windows.get(id);
	if (existing) {
		existing.$window.restore();
		existing.$window.bringToFront();
		existing.$window.focus();
		return existing.$window;
	}
	const $window = create();
	const button = document.createElement("button");
	button.type = "button";
	button.className = "task-button";
	button.innerHTML = `<img src="${icon}" alt=""> `;
	button.append(document.createTextNode(title));
	button.addEventListener("click", () => {
		if ($window.hasClass("minimized") || $window.hasClass("minimized-without-taskbar")) {
			$window.restore();
			$window.bringToFront();
			$window.focus();
		} else if ($window.hasClass("focused")) {
			$window.minimize();
		} else {
			$window.bringToFront();
			$window.focus();
		}
	});
	document.getElementById("tasks").append(button);
	$window.setMinimizeTarget(button);
	$window.on("close", () => {
		button.remove();
		open_windows.delete(id);
	});
	open_windows.set(id, { $window, button });
	return $window;
}

function update_taskbar() {
	for (const { $window, button } of open_windows.values()) {
		button.classList.toggle("active", $window.hasClass("focused") && !$window.hasClass("minimized"));
	}
}
setInterval(update_taskbar, 300);

/** Sign in: editor URL, site name, secret. Resolves once /api/whoami accepts the secret. */
export function show_sign_in({ force = false } = {}) {
	return new Promise((resolve) => {
		const settings = load_settings();
		const $w = $Window({ title: "Sign in to your site", resizable: false, maximizeButton: false, minimizeButton: false, innerWidth: 380 });
		$w.$content.html(`
			<form class="dialog-body">
				<p style="margin:0 0 4px">Your pages live at <b>sites/~name/</b>. One edit secret unlocks them for now; accounts come later.</p>
				<div class="sign-in-row"><label for="si-site">Site name</label><input id="si-site" type="text" autocapitalize="off" spellcheck="false" placeholder="jack"></div>
				<div class="sign-in-row"><label for="si-secret">Edit secret</label><input id="si-secret" type="password"></div>
				<div class="sign-in-row"><label for="si-editor">Editor URL</label><input id="si-editor" type="url" spellcheck="false"></div>
				<div class="status-line" id="si-status"></div>
			</form>
			<div class="dialog-buttons"><button type="submit" class="default" id="si-ok">OK</button><button type="button" id="si-cancel">Cancel</button></div>
		`);
		const $site = $w.$content.find("#si-site").val(settings.site);
		const $secret = $w.$content.find("#si-secret").val(settings.secret);
		const $editor = $w.$content.find("#si-editor").val(settings.editor_url);
		const $status = $w.$content.find("#si-status");
		let done = false;
		const submit = async () => {
			const next = { site: String($site.val()).trim().toLowerCase(), secret: String($secret.val()), editor_url: String($editor.val()).trim().replace(/\/+$/, "") };
			if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(next.site)) { $status.text("Site names are 1–32 lowercase letters, digits, or hyphens."); return; }
			if (!next.secret) { $status.text("The edit secret is required."); return; }
			save_settings(next);
			$status.text("Checking…");
			try {
				await whoami();
				done = true;
				$w.close();
				document.getElementById("site-indicator").textContent = `~${next.site}`;
				resolve(true);
			} catch (error) {
				$status.text(error.status === 401 ? "That secret was rejected." : `Couldn't reach the editor: ${error.message}`);
			}
		};
		$w.$content.find("form").on("submit", (e) => { e.preventDefault(); submit(); });
		$w.$content.find("#si-ok").on("click", submit);
		$w.$content.find("#si-cancel").on("click", () => { $w.close(); resolve(false); });
		$w.on("close", () => { if (!done) { resolve(false); } });
		$w.center();
		($site.val() ? $secret : $site).focus();
		void force;
	});
}

/** Makes sure we're signed in before doing something that needs the API. */
export async function ensure_signed_in() {
	const settings = load_settings();
	if (settings.site && settings.secret) {
		try {
			await whoami();
			document.getElementById("site-indicator").textContent = `~${settings.site}`;
			return true;
		} catch (_error) { /* fall through to the dialog */ }
	}
	return show_sign_in();
}

const APPS = [
	{ id: "paint", title: "Paint", icon: "../images/icons/32x32.png", small: "../images/icons/16x16.png", open: () => open_paint() },
	{ id: "page-editor", title: "Page Editor", icon: "icons/page-editor.svg", small: "icons/page-editor.svg", open: () => open_page_editor() },
	{ id: "my-site", title: "My Site", icon: "icons/my-site.svg", small: "icons/my-site.svg", open: () => open_my_site() },
	{ id: "gifs", title: "GIFs", icon: "icons/gifs.svg", small: "icons/gifs.svg", open: () => open_gif_window() },
];

function build_desktop() {
	const icons = document.getElementById("icons");
	for (const app of APPS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "desktop-icon";
		button.innerHTML = `<img src="${app.icon}" alt="">`;
		button.append(document.createTextNode(app.title));
		button.addEventListener("dblclick", () => app.open());
		button.addEventListener("keydown", (e) => { if (e.key === "Enter") { app.open(); } });
		icons.append(button);
	}
	const start = document.getElementById("start-button");
	const menu = document.getElementById("start-menu");
	menu.innerHTML = APPS.map((app) => `<button type="button" data-app="${app.id}"><img src="${app.small}" alt=""> ${app.title}</button>`).join("") +
	`<hr><button type="button" data-action="sign-in"><img src="../images/icons/16x16.png" alt=""> Sign in as…</button>
		<button type="button" data-action="view-site"><img src="icons/my-site.svg" alt=""> View my site</button>`;
	start.addEventListener("click", () => { menu.hidden = !menu.hidden; });
	menu.addEventListener("click", (e) => {
		const button = /** @type {HTMLElement} */ (e.target).closest("button");
		if (!button) { return; }
		menu.hidden = true;
		const app = APPS.find((a) => a.id === button.dataset.app);
		if (app) { app.open(); }
		if (button.dataset.action === "sign-in") { show_sign_in({ force: true }); }
		if (button.dataset.action === "view-site") {
			const { site } = load_settings();
			if (site) { window.open(`https://jspaint-sites.jklika2.workers.dev/~${site}/`, "_blank", "noopener"); }
		}
	});
	document.addEventListener("pointerdown", (e) => {
		if (!menu.hidden && !menu.contains(/** @type {Node} */ (e.target)) && !start.contains(/** @type {Node} */ (e.target))) {
			menu.hidden = true;
		}
	});
	const clock = document.getElementById("clock");
	const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
	tick();
	setInterval(tick, 10000);
	const { site } = load_settings();
	if (site) { document.getElementById("site-indicator").textContent = `~${site}`; }
}

build_desktop();
// First run: sign in, then open the Page Editor.
ensure_signed_in().then((ok) => { if (ok) { open_page_editor(); } });
