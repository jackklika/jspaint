# Win98 Site Builder — build plan

Companion to [DESIGN.md](DESIGN.md). This file is the hand-off between work sessions: tick boxes as things land, keep the *Status log* current, and read *How to resume* before touching code.

## How to resume (read me first)

- Repo root is the **Paint** app (jspaint fork). New site-builder code goes in `src/` for Paint-side features (stickers, text layers, collage I/O, GIF export), `desktop/` for the Win98 shell + Page Editor windows (phase 3), `worker/` for the Cloudflare Workers (phase 2+).
- Lint/typecheck: `npm run lint` (cspell + tsc + eslint). New words go in `cspell.json`. Tabs, `// @ts-check`, snake_case like the surrounding code.
- Dev server for Paint: `npm run dev` (live-server on :1999). UI tests: `npm run test:site-builder` (Playwright is a devDependency; `npx playwright install chromium` once). See `test/site-builder/README.md`. Add a test file there for every new feature — they've caught real bugs (canvas tainting, dblclick suppression, focus stealing, a floating window covering the click target).
- The one layout constant: `PAGE_WIDTH = 800` (create it in `src/site-constants.js` when first needed; the desktop and Workers import it).
- The document format is the HTML dialect in DESIGN.md §3. **Never add a second source of truth** (no JSON sidecars that outlive a session; blobs referenced from the HTML).
- Extension model: `<x-*>` elements via one registry (DESIGN.md §3.5). No feature-specific formats.
- Security posture is DESIGN.md §9: user pages come from the sandboxed `sites` Worker only.
- Existing "Agent Drive" code (`src/agent-drive.js`, `agent-server/`, `jspaint-site` repo) is a personal dev tool now; leave it working, don't build on it.

## Phase 1 — the Blingee half (Paint extensions)

Goal: paste/drop animated GIFs onto a Paint canvas, keep them animating, arrange them with real text, export a collage as the HTML dialect and as an animated GIF.

- [x] 1.1 **Sticker layer** — `src/stickers.js`: `OnCanvasSticker extends OnCanvasObject` (animated `<img>`, `Handles` for move/resize, flip H/V, delete, z-order), a `stickers` registry + blob store, `image-rendering: pixelated` at zoom.
- [x] 1.2 **Animated-GIF detection on paste/drop** — `GIF8` magic + >1 Graphic Control Extension → sticker, else the normal rasterized selection. Handle clipboard `text/html` `<img src>` (browsers put a rasterized PNG on the clipboard when copying a GIF) by fetching the URL.
- [x] 1.3 **History integration** — sticker snapshots on history nodes (`make_history_node` fields, restore in `go_to_history_node`, clear on new/open), undo/redo of add/move/resize/delete.
- [x] 1.4 **Selection & keyboard** — click selects a sticker, Delete removes, Escape deselects, arrow keys nudge; stickers don't steal pointer events from painting when not hit.
- [x] 1.5 **Text layers** — persistent mode for `OnCanvasTextBox`: stays a layer (classic web-safe fonts, color, size, optional `href`), rendered by the browser, rasterized only on Flatten. FontBox lists the classic set first.
- [x] 1.6 **Layers window** — os-gui tool window: list (bitmap, stickers, text), reorder, hide, flatten-one, flatten-all.
- [x] 1.7 **Collage I/O** — `src/collage-format.js`: serialize canvas + layers to the `div.collage` dialect (bitmap PNG + GIF blobs; local save = single `.html` with data URLs, or a folder zip) and parse it back losslessly. *File › Save as Web Page*, *File › Open* accepts it.
- [x] 1.8 **GIF export** — `src/gif-export.js`: decode sticker frames (`ImageDecoder`, `gifuct-js` fallback), common timeline (LCM, capped), composite bitmap + stickers + text per frame, encode with `lib/gif.js`. *File › Save as Animated GIF*.
- [x] 1.9 **Autosave of layers** — sidecar in `localStore` keyed by session id so a refresh doesn't lose stickers (the HTML file remains the real format).
- [x] 1.10 Tests: `test/site-builder/` (Playwright, `npm run test:site-builder`) — stickers, text layers, collage format + GIF export, Layers window, autosave, GIF picker (needs the proxy).
- [x] 1.11 **GIF picker button** (requested 2026-09-09): a button on the left (toolbox side) that opens the GifCities window — search, results grid, click to select, drag/drop onto the canvas as a sticker. Needs the GifCities proxy (Worker or, until then, agent-server) because gifcities.org has no CORS. Pulls 3.4 forward; the same window later serves the Page Editor.

Order note: 1.7 (collage I/O) and 1.8 (GIF export) come before 1.5/1.6 — they close the loop the whole thing is for (paste GIF → export animated GIF / HTML); text layers and the layers window build on that.

## Phase 2 — hosting skeleton (Cloudflare)

- [x] 2.1 `worker/sites/` — the sandbox Worker: serve `/~name/<path>` from R2, `<x-*>` server rendering via the registry, CSP headers, DO binding for dynamic blocks.
- [x] 2.2 `worker/editor/` — editor Worker: static desktop app, API (save page, upload asset, list folder, GifCities proxy), shared-secret auth (cookie), sanitizer.
- [x] 2.3 `worker/shared/x-elements/` registry with `x-counter` and `x-updated` as the first two tags (no forms yet).
- [ ] 2.4 Wrangler configs for both Workers under `worker/` (done); deploy to `*.workers.dev` — **blocked on enabling R2 in the Cloudflare dashboard** (API error 10042 on bucket create).
- [x] 2.5 Paint "Save to my site" → PUT collage + assets into the site folder; the page appears at `/~jack/`.

Phase 2 notes (2026-09-09): everything verified against local `wrangler dev` (shared `--persist-to .wrangler/state` so both Workers see one R2). Editor Worker needs a distinct `--inspector-port` when both run. `worker/editor/.dev.vars` carries `SITE_EDIT_SECRET` and `SITES_URL=http://localhost:8788` for local runs. The sanitizer is HTMLRewriter-based (strips scripts, frames, forms, handlers, `javascript:` URLs, unknown `<x-*>` attributes); `<x-*>` rendering keeps the tag and replaces its content so pages re-import. `test/site-builder/publish.test.mjs` covers Paint → editor → sites, including hashed-asset reuse and cleanup.

## Phase 3 — Page Editor + desktop

- [ ] 3.1 `desktop/` shell: os-gui desktop with taskbar; windows: Paint, Page Editor, GifCities, My Site.
- [ ] 3.2 Page Editor: parse dialect → blocks; block handles (select, move, delete, properties); inline text editing with a `<font>` toolbar (classic fonts); add-block menu.
- [ ] 3.3 Doodle layer: transparent Paint canvas over the 800px column → `img.doodle`.
- [ ] 3.4 GifCities window: search via proxy, drag → sticker (collage) or divider (page); copies GIF into `gifs/`.
- [ ] 3.5 My Site window: folder view, upload, rename, delete, new page, zip export.
- [ ] 3.6 Live preview of the page while editing (reuse the Room DO pattern).

## Phase 4 — dynamic blocks, media, import

- [ ] 4.1 `x-guestbook` (entries + POST form, plain text, rate-limited), `x-music` (audio + play button), tiled wallpaper, image maps, tables/colored boxes.
- [ ] 4.2 Whole-page GIF export (foreignObject render + sticker/marquee compositing; caps).
- [ ] 4.3 HTML import (best-effort; wedding page as fixture), zip import.
- [ ] 4.4 Quotas and upload validation.

## Phase 5 — accounts

- [ ] Magic-link or passkey sign-in, `~name` claiming, owner moderation of guestbooks.

## Status log

- 2026-09-09 — Design agreed (DESIGN.md). Plan written.
- 2026-09-09 — Jack's additions before Phase 2: **sticker rotation** (Image › Rotate Sticker Right/Left/By Angle…; `Ctrl+.`/`Ctrl+,` rotate a selected sticker instead of the picture; rotation is on the `<img>` so handles stay axis-aligned; exported as a CSS `rotate()` transform, composited in GIF export), **links on any element** (Edit › Add Link to Element… for the selected sticker or text layer; stickers serialize as `<a class="sticker" href><img></a>`; 🔗 badge on canvas), and **Image › Make Sticker from Selection** so any pasted image (PNG/JPEG, not just animated GIFs) becomes a layer that can be rotated/linked. Sticker sources now carry a sniffed MIME type; non-GIF sources export as a single frame. Known: resizing a rotated sticker uses the un-rotated box.
- 2026-09-09 — 1.10 + 1.11 landed: `test/site-builder/` harness (helpers build GIF fixtures in-page with gif.js — no binaries; six test files, all passing in ~18s) with `npm run test:site-builder`. GIF picker: `src/gif-picker.js` window (search GifCities, click or drag a tile onto the canvas → sticker, More for paging, attribution), opened by a **GIFs button under the tools** in the toolbox or View › GIF Picker; drops carry `application/x-jspaint-gif-url` (app.js drop handler). Proxy for now in agent-server (`/api/gifcities/search`, `/api/gifcities/gif/:id`, 1h cache, CORS) — Phase 2 moves it into the editor Worker. Paint's server URL setting (Agent window) doubles as the proxy base until then.
- 2026-09-09 — 1.6 + 1.9 landed: `src/layers-window.js` (View › Layers: rows for text layers, stickers, and the picture; click selects on the canvas; ▲▼ reorder, ⤓ flatten one, ✕ delete — all undoable) with explicit z-order APIs in stickers.js/text-layers.js (`reorder_*`, `flatten_*`, `delete_*`; selecting no longer auto-raises). Known limitation: text layers always stack above stickers (two lists), reordering is within a kind. `src/layer-storage.js`: the `layers#<session>` localStorage sidecar (stickers as data URLs, cached per source) saved with every autosave and restored on session load; Manage Storage removes it with the image. Verified: reload restores both layer kinds into the root history state.
- 2026-09-09 — 1.5 landed: `src/text-layers.js` (OnCanvasText: browser-rendered text scaled with magnification, move/resize handles, click-select, arrows/Delete, double-click → back into the Text tool's textbox and re-commit keeps the id, Image › Text Layer Link… dialog, rasterized copy via SVG foreignObject for Flatten/GIF export). The switch is a **"Web" toggle in the Font toolbar** (the `.tool-options` box is a fixed 41×66px and can't hold a labeled control). `meld_textbox_into_canvas` creates a layer instead of pixels when Web text is on or when re-editing a layer. Collage format writes `span.text`/`a.text` with the font as CSS and parses it back (font family re-quoted, since CSSOM strips quotes). Font box lists the classic web-safe fonts first. Gotchas learned: `preventDefault()` on pointerdown suppresses the browser's `dblclick`, so double-click is detected by timing; a selected object's `Handles` grab-region ring (~10px) covers its edges, so tests must click centers.
- 2026-09-09 — 1.7 + 1.8 landed: `src/collage-format.js` (serialize/parse the `div.collage` dialect; `text/html` registered as a save format so File › Save As / Open handle collage pages; Ctrl+S keeps saving HTML after opening one), `src/gif-export.js` (ImageDecoder frame decode with 0→100 ms delay normalization, LCM timeline capped by `GIF_EXPORT_MAX_DURATION_MS`/`MAX_FRAMES` in `src/site-constants.js`, gif.js encode, preview + Save window), File-menu items *Save as Animated GIF…* / *Save as Web Page (HTML)…*. Verified headless: round-trip lossless (bitmap + sticker rectangles + flips), exported GIF loops with correct per-frame delays. Tuning note: two stickers with 500 ms and 1400 ms loops → LCM 7 s → 169 frames / 600 KB at 683×384; consider preferring the longest single loop when the LCM exceeds ~4 s.
- 2026-09-09 — 1.1–1.4 landed: `src/stickers.js` (OnCanvasSticker, sources, history snapshots, keyboard, flatten, flips), hooks in `functions.js` (history node `stickers` field, paste), `app.js` (init, keys, clipboard `text/html` GIF preference, drop), Image-menu items. Verified headless: paste → animate → drag → nudge → undo/redo → paint under → drop → delete → static GIF still a selection. Clipboard `text/html` path is implemented but untested with a real browser clipboard.
