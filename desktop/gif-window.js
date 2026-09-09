// @ts-check
// The GIFs window: search GifCities through the editor's proxy; drag a result into the Page Editor
// (it becomes an <img> block, uploaded to the site) or click to insert it at the selection.
import { gifcities_search } from "./api.js";
import { show_window } from "./desktop.js";

export const GIF_DRAG_TYPE = "application/x-jspaint-gif-url";

export function open_gif_window() {
	return show_window("gifs", "GIFs", "icons/gifs.svg", () => {
		const $w = $Window({ title: "GIFs — GifCities", resizable: true, innerWidth: 420, innerHeight: 420 });
		$w.$content.html(`
			<div class="tool-window-body">
				<form class="toolbar"><input type="search" placeholder="sparkle, under construction, welcome…" style="flex:1"><button type="submit">Search</button></form>
				<div class="gif-results"></div>
				<div class="toolbar"><span class="status-line" style="flex:1">Type a word and press Enter. Drag a GIF into the Page Editor, or click to insert.</span><button type="button" class="more" disabled>More</button></div>
				<div style="font-size:10px;opacity:.8">GIFs from <a href="https://gifcities.org" target="_blank" rel="noopener">GifCities</a>, the Internet Archive's GeoCities collection.</div>
			</div>
		`);
		const $results = $w.$content.find(".gif-results");
		const $status = $w.$content.find(".status-line");
		const $more = $w.$content.find(".more");
		const $query = $w.$content.find("input[type=search]");
		let query = "";
		/** @type {number | null} */
		let next = 0;
		const search = async (append = false) => {
			if (!append) {
				query = String($query.val()).trim();
				next = 0;
				$results.empty();
			}
			if (next === null) { return; }
			$status.text("Searching…");
			$more.prop("disabled", true);
			try {
				const data = await gifcities_search(query, next);
				for (const result of data.results) {
					const tile = document.createElement("button");
					tile.type = "button";
					tile.className = "gif-tile";
					tile.draggable = true;
					tile.title = `${result.width}×${result.height}`;
					tile.innerHTML = `<img src="${result.url}" alt="" loading="lazy" draggable="false">`;
					tile.addEventListener("dragstart", (e) => {
						e.dataTransfer.setData(GIF_DRAG_TYPE, result.url);
						e.dataTransfer.setData("text/uri-list", result.url);
						e.dataTransfer.effectAllowed = "copy";
					});
					tile.addEventListener("click", () => {
						document.dispatchEvent(new CustomEvent("insert-gif", { detail: result.url }));
					});
					$results.append(tile);
				}
				next = data.next_offset;
				$status.text(`${$results.children().length} GIFs${next === null ? "" : " …"}`);
				$more.prop("disabled", next === null);
			} catch (error) {
				$status.text(`Search failed: ${error.message}`);
			}
		};
		$w.$content.find("form").on("submit", (e) => { e.preventDefault(); search(); });
		$more.on("click", () => search(true));
		$w.css({ left: innerWidth - 470, top: 40 });
		setTimeout(() => $query.focus(), 50);
		return $w;
	});
}
