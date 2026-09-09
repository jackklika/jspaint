// @ts-check
// My Site: the folder view. Pages and assets on the site, with open / delete / upload / new page — GeoCities file manager energy.
import { delete_file, list_files, load_settings, public_url, upload_asset, write_file } from "./api.js";
import { blank_page_html } from "./dialect.js";
import { ensure_signed_in, show_window } from "./desktop.js";
import { open_page_editor } from "./page-editor.js";

export function open_my_site() {
	return show_window("my-site", "My Site", "icons/my-site.svg", () => {
		const $w = $Window({ title: "My Site", resizable: true, innerWidth: 460, innerHeight: 380 });
		$w.$content.html(`
			<div class="tool-window-body">
				<div class="toolbar">
					<button type="button" class="new-page">New Page…</button>
					<button type="button" class="upload">Upload…</button>
					<button type="button" class="open" disabled>Open</button>
					<button type="button" class="view" disabled>View</button>
					<button type="button" class="delete" disabled>Delete</button>
					<span class="spacer"></span>
					<button type="button" class="refresh">Refresh</button>
				</div>
				<div class="file-list"></div>
				<div class="status-line"></div>
				<input type="file" multiple accept="image/gif,image/png,image/jpeg,image/webp,audio/mpeg,audio/midi,audio/wav,audio/ogg" hidden>
			</div>
		`);
		const $list = $w.$content.find(".file-list");
		const $status = $w.$content.find(".status-line");
		const $file_input = $w.$content.find("input[type=file]");
		/** @type {{ path: string, size: number, uploaded: string } | null} */
		let selected = null;
		const update_buttons = () => {
			$w.$content.find(".open").prop("disabled", !selected || !/\.html?$/i.test(selected.path));
			$w.$content.find(".view").prop("disabled", !selected);
			$w.$content.find(".delete").prop("disabled", !selected);
		};
		const refresh = async () => {
			if (!await ensure_signed_in()) { return; }
			$status.text("Loading…");
			$list.empty();
			selected = null;
			update_buttons();
			try {
				const { files } = await list_files();
				const { site } = load_settings();
				$w.title(`My Site — ~${site}`);
				if (files.length === 0) {
					$list.append($("<div>").text("Nothing here yet. Make a page with New Page…").css({ padding: 8, opacity: 0.7 }));
				}
				for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
					const $row = $("<div class='file-row' tabindex='0'>");
					const icon = /\.html?$/i.test(file.path) ? "icons/page-editor.svg" : /\.(gif|png|jpe?g|webp)$/i.test(file.path) ? "icons/gifs.svg" : "icons/my-site.svg";
					$row.append($("<img width='16' height='16' alt=''>").attr("src", icon));
					$row.append($("<span class='file-name'>").text(file.path));
					$row.append($("<span class='file-meta'>").text(`${Math.max(1, Math.round(file.size / 1024))} KB · ${new Date(file.uploaded).toLocaleDateString()}`));
					$row.on("click focus", () => {
						$list.find(".file-row").removeClass("selected");
						$row.addClass("selected");
						selected = file;
						update_buttons();
					});
					$row.on("dblclick", () => {
						if (/\.html?$/i.test(file.path)) { open_page_editor(file.path); } else { window.open(public_url(file.path), "_blank", "noopener"); }
					});
					$list.append($row);
				}
				$status.text(`${files.length} file${files.length === 1 ? "" : "s"} · ${public_url("")}`);
			} catch (error) {
				$status.text(`Couldn't list files: ${error.message}`);
			}
		};
		$w.$content.find(".refresh").on("click", refresh);
		$w.$content.find(".open").on("click", () => { if (selected) { open_page_editor(selected.path); } });
		$w.$content.find(".view").on("click", () => { if (selected) { window.open(public_url(selected.path), "_blank", "noopener"); } });
		$w.$content.find(".delete").on("click", async () => {
			// eslint-disable-next-line no-alert -- a plain confirm is period-appropriate here
			if (!selected || !confirm(`Delete ${selected.path} from your site?`)) { return; }
			try {
				await delete_file(selected.path);
				refresh();
			} catch (error) {
				$status.text(`Couldn't delete: ${error.message}`);
			}
		});
		$w.$content.find(".new-page").on("click", async () => {
			// eslint-disable-next-line no-alert
			const name = prompt("Page file name (like about.html):", "about.html");
			if (!name) { return; }
			const path = name.trim().replace(/\.html?$/i, "").replace(/[^A-Za-z0-9._-]/g, "-") + ".html";
			try {
				await write_file(path, blank_page_html(path.replace(/\.html$/, "")), "text/html");
				refresh();
				open_page_editor(path);
			} catch (error) {
				$status.text(`Couldn't create the page: ${error.message}`);
			}
		});
		$w.$content.find(".upload").on("click", () => $file_input.trigger("click"));
		$file_input.on("change", async () => {
			const files = [...(/** @type {HTMLInputElement} */ ($file_input[0]).files || [])];
			$file_input.val("");
			for (const file of files) {
				try {
					$status.text(`Uploading ${file.name}…`);
					await upload_asset(file);
				} catch (error) {
					$status.text(`Couldn't upload ${file.name}: ${error.message}`);
					return;
				}
			}
			refresh();
		});
		$w.css({ left: 120, top: 60 });
		refresh();
		return $w;
	});
}
