# REFACTOR.md

The site-builder half of this fork (Paint-as-editor + two Workers) grew feature-first, one commit per user-visible capability, and it shows: a handful of very large modules that each own UI, network, storage and document state at once; a document identity (`system_file_handle`) that is a duck-typed object literal touched by 15 modules; and a test suite of imperative scripts that re-implement the same five setup steps.

Nothing here is a bug report, and nothing here has been acted on. Each finding is a structural cost with a directive and the test that should pin the behavior before the change. Surveyed 2026-09-14 at commit `9de5fa28`; line numbers are from that tree and will drift.

---

## Client architecture

### C1. `src/my-site.js` is eight modules in one file (~1,480 lines, 21 exports)

Responsibilities, measured:

| Lines | Responsibility |
|---|---|
| 41–83 | URL/sessionStorage entry protocol (`?site=`, `?signed_in=`, `?new=`), run as a top-level IIFE at import time |
| 92–249 | First-run routing: `open_site_from_url_inner`, `page_restored`, `open_starter_page`, `before_leaving_for_google`, `google_sign_in_url` |
| 255–367 | Editor API client: `page_exists`, `open_page_copy`, `api`, `list_files`, `read_file`, `write_file`, `delete_file`, `hash_blob`, `upload_asset` |
| 376–689 | Accounts/sign-in: `check_sign_in`, `new_site_form`, `show_new_site_dialog`, `switch_site`, `show_sign_in_dialog` (157 lines), `ensure_signed_in`, `sign_out` |
| 696–761 | Drafts + page switching: `load_drafts`, `remember_draft`, `draft_session`, `switch_page`, `before_leaving_page`, `current_site_page_path` |
| 768–902 | Page lifecycle: `open_page_from_site`, `new_site_post`, `new_site_page`, `slug_for` |
| 793–837 | `site.json` settings: `site_settings`, `list_site_folders`, `save_site_settings` |
| 934–1307 | The My Site window: `show_new_page_prompt`, `show_my_site_dialog` (337 lines, with four nested dialog closures: New Post, Folder, Versions, Site Style) |
| 1309–1476 | 167 lines of CSS-in-JS |

Why it's a problem: nothing in this file can be unit-tested or reasoned about in isolation; `show_my_site_dialog` closes over `refresh`, `$status`, `selected`, `listed_files`, so its four nested dialogs cannot be moved without rewriting them; the import-time IIFE means importing the module has side effects on `history.replaceState` and `sessionStorage`; and the module is the hub five other modules import from (`functions.js`, `live-session.js`, `menus.js`, `pictures.js`, `site-button.js`, `x-preview.js`).

**Directive:** split into `src/site-api.js` (the `api`/CRUD/upload block, no DOM), `src/site-session.js` (`check_sign_in`, `switch_site`, `sign_out`, `ensure_signed_in`, `current_role`, `last_sign_in_problem`), `src/site-entry.js` (the IIFE + `open_site_from_url` + starter page + Google URL, with the IIFE exported as `capture_entry_params()` called once from `app.js`), `src/page-drafts.js` (drafts + `switch_page` + `before_leaving_page`), `src/site-settings.js` (`site.json`), and `src/my-site-window.js` (the window and its four dialogs, each a top-level function taking `{ site, on_change }` instead of closing over `refresh`). Keep `my-site.js` as a thin facade re-exporting the same 21 names so the five importers don't churn in the same commit.
**Tests:** `test/site-builder/my-site.test.mjs` and `first-run.test.mjs` already cover sign-in → New Page → Ctrl+S → serve → reopen, and the three front doors. Run them unchanged before and after; they are the contract.

### C2. Document identity is an untyped object literal shared by 15 modules

`system_file_handle` is declared in `src/app-state.js:152` (untyped `let`), and the site builder overloads it with four ad-hoc fields: `{ site_page, copy_of?, guest?, fresh? }`. 67 references across 15 files in `src/`: `my-site.js` (17), `functions.js` (9), `site-publish.js` (6), `live-session.js` (5), `share.js` (5), `app.js` (4), `site-button.js`/`layer-storage.js`/`electron-injected.js` (3 each), `blocks.js`/`collage-format.js`/`x-preview.js`/`gif-export.js`/`app-state.js`/`save-history-as-spritesheet.js` (2 each).

Every reader repeats the same defensive incantation, e.g. `src/site-button.js:172`, `src/site-publish.js:70`, `src/share.js:50`, `src/x-preview.js:33`, `src/my-site.js:178`:

```js
system_file_handle && typeof system_file_handle === "object" && typeof system_file_handle.copy_of === "string" ? system_file_handle.copy_of : ""
```

Three modules *construct* the shape independently — `src/my-site.js:207,862,890`, `src/site-publish.js:195`, `src/layer-storage.js:207` — and `layer-storage.js` reconstructs it from a persisted sidecar with its own re-validation rules. **That round trip drops `copy_of`**: the sidecar stores `site: load_settings().site` even for a copy of someone else's page, so after a reload a copy of `~root/index.html` comes back as *your own* `index.html` — the tabs list it, the replace-guard no longer applies, and Ctrl+S publishes it over your front page without asking. This is a bug, not a smell; it should be fixed before or with the refactor (store `copy_of` in the sidecar and restore it). The four flags interact (`fresh` + `copy_of` decides "ask before replacing" in `site-publish.js:150`; `copy_of` suppresses draft-remembering in `my-site.js:726`; `guest` bypasses sign-in in `my-site.js:910`), and that logic is spread over four files.

Why it's a problem: this is the app's central domain type and it is enforced nowhere. A typo in `site_page` fails silently as "this is not a site page", which degrades to "Ctrl+S saves a file" — the most expensive class of bug in this product.

**Directive:** add `src/site-document.js` exporting a typedef `SiteDocument = { site_page: string, copy_of?: string, guest?: { site, key }, fresh?: boolean }` plus accessors: `current_page()`, `is_copy()`, `copy_source()`, `guest()`, `is_fresh()`, `set_site_document(doc)`, `clear_site_document()` — each doing the type guard once, each emitting the existing `site-page-opened`/`site-settings-changed` events from one place. Replace all 67 call sites mechanically; `site-button.js`'s `current_site_page()`/`guest_info()` (`src/share.js:49–56`) and `my-site.js`'s `current_site_page_path()` (`src/my-site.js:758`) are already three-quarters of this API living in two wrong files — move them in and delete the duplicates.
**Tests:** `page-tabs.test.mjs` (copy vs. own page tab labels), `first-run.test.mjs` (fresh starter page, "Not saved" on replace), `live-room.test.mjs` (guest save scoping) cover all four flags; add a small assertion in `my-site.test.mjs` that a copy → Save flips `copy_of` off.

### C3. `src/site-publish.js` is two modules under one name (353 lines)

Despite the name, this file owns the app's *settings and session*: `load_settings`/`save_settings` (the `jspaint site publish settings` localStorage record, including quota recovery at lines 45–59), `is_signed_in`, `has_account`, `current_site`, `get_site_editor_url`, `get_site_files_base`, `authorized`. Fifteen modules import it — more than any other site-builder module — and most of them want only `get_site_editor_url` or `current_site`, not publishing.

**Directive:** move settings/identity to `src/site-settings-store.js` (`load_settings`, `save_settings`, `is_signed_in`, `has_account`, `current_site`, `get_site_editor_url`, `get_site_files_base`, `authorized`); leave `publish_collage` + `show_publish_dialog` in `site-publish.js`. This also breaks the "everything imports the publish dialog" fan-in, which is why `block-kinds.js` (`src/block-kinds.js:6`) and `layer-storage.js` (`src/layer-storage.js:14`) currently pull in a dialog module to read a URL.
**Tests:** none needed beyond the existing suite passing; the split is import-only.

### C4. Import cycles papered over with dynamic `import()`

Two in the site-builder code (`src/my-site.js:234`, `:754`):

```js
const { flush_session_backup } = await import("./sessions.js"); // (sessions.js imports this module: no static cycle)
await (await import("./live-session.js")).flush_live_sync();
```

Both are "flush before leaving" hooks. The comment is honest about the cause: `sessions.js` → `layer-storage.js` → `site-publish.js`, and `live-session.js` → `my-site.js` (`src/live-session.js:17`, for `upload_asset` alone). The first one was added on 2026-09-14 after a static import silently prevented Paint from booting at all — a cycle-induced TDZ at module load, with no error surfaced in the UI.

**Directive:** invert both. Have `sessions.js` and `live-session.js` register their flush functions into a tiny `src/before-leave.js` registry (`register_flush(fn)` / `flush_all()`), and have `my-site.js` call `flush_all()`. Separately, drop `live-session.js`'s import of `my-site.js` by passing `upload_asset` in through `init_live_session()` or moving `upload_asset` to the new `site-api.js` (which has no UI imports, so no cycle). Then the dynamic imports can become static or disappear.
**Tests:** `page-tabs.test.mjs` exists precisely because a stroke was lost on page switch when the flush didn't run — keep it as the regression gate; `google-auth.test.mjs`'s newcomer round trip covers the other flush.

### C5. `$G` is an untyped global event bus with ~20 custom events and no contract

Emitters and listeners, site-builder subset:

| Event | Emitted by | Listened by |
|---|---|---|
| `site-page-opened` | `my-site.js:785,867,900`, `site-publish.js:200`, `share.js:133` | `live-session.js:1207`, `site-button.js:306,328`, `x-preview.js:122`, `my-site.js:724` |
| `site-page-restored` | `layer-storage.js:210` | same four |
| `site-settings-changed` | `site-publish.js:60`, `my-site.js:209,297,580`, `site-button.js:183` | `gif-picker.js:181`, `site-button.js:306,328`, `x-preview.js:122` |
| `session-update` | `my-site.js:233,752`, `live-session.js:386,474,528` | `sessions.js` (4×, namespaced `.session-hook`), `site-button.js:307`, `$ToolBox.js:153` |
| `history-update` | `live-session.js:385,473` | `layers-window.js:110`, `x-preview.js:118`, `share.js:227`, `page-history` chain |
| `layers-changed` | 17 sites in `blocks.js`/`stickers.js`/`text-layers.js` | `layers-window.js:110`, `x-preview.js:118`, `live-session.js:1206` |
| `block-rendered` | `blocks.js:256` | `x-preview.js:116` |
| `live-version` / `live-state` / `live-history` | `live-session.js:263–307` | `page-history.js:371–373` |
| `gif-favorites-changed` | `gif-picker.js:131,171` | `gif-picker.js:390` + per-tile |
| `status-message` | `blocks.js:289`, `live-session.js:280` | `live-session.js:1224` |

The payload contract exists only in comments: `site-page-opened` carries `[{ page, authoritative, reason }]`, and three of the five emitters omit `reason`. `my-site.js:182` even waits on a *string* of three event names with a 10 s timeout and a 200 ms poll as a belt-and-braces restore detector (`page_restored`) — a sign that the ordering guarantees aren't understood by the code itself. Note too that jQuery `.trigger()` on an element bubbles a custom event up to `$G`; `gif-picker.js` had to switch to `.triggerHandler()` per element to escape an infinite loop.

**Directive:** add `src/site-events.js` exporting the event names as constants and one typedef per payload, plus `emit_page_opened({page, authoritative, reason})` style helpers that fill defaults. Replace string literals at all emit/listen sites. This is mechanical, makes the table above greppable and lets `tsc` catch a missing `reason`. Longer term, the `site-page-opened`/`site-page-restored` pair should collapse into one event with a `restored: boolean`, since all four listeners subscribe to both together.
**Tests:** `x-preview.test.mjs` and `page-tabs.test.mjs` both depend on the refresh-on-event wiring; `live-paint.test.mjs` on the room join.

### C6. Giant single-function UI modules

- `src/page-history.js:146–530` — `show_page_history` is **384 lines**: mode select, list rendering, tree indentation, preview canvas rendering, checkout/restore wiring, keyboard handling, plus a 118-line CSS block.
- `src/pictures.js:214–339` — `show_pictures_window`, 125 lines.
- `src/gif-picker.js:328–415` — `show_gif_picker`, 87 lines, containing a third tab-strip implementation.
- `src/live-session.js:1189–1310` — `init_live_session`, 121 lines of listener wiring.
- `src/blocks.js:114–398` — `OnCanvasBlock`, 284 lines; the file's other 1,200 lines mix font-toolbar sync (399–496), section anchors/links (497–566), execCommand text editing (568–722), the block registry/CRUD (723–906), section reflow (907–987), flatten/draw (988–1033) and live-sync upsert hooks (1099–1165).

**Directive:** for `page-history.js`, extract `render_version_list($list, versions, mode)` and `render_preview(state, canvas)` (the latter already exists at line 49 — pull the rest of the drawing out with it) so the window function becomes wiring. For `blocks.js`, split off `src/block-text-editing.js` (lines 399–722: font sync, execCommand, links, lists, rules) and `src/block-sections.js` (907–987: column geometry, reflow, reorder); the `OnCanvasBlock` class and the registry stay.
**Tests:** `page-history.test.mjs` covers list + checkout + restore; `sections.test.mjs`, `blocks.test.mjs`, `link-tool.test.mjs`, `text-layers.test.mjs` cover the blocks split.

### C7. Window-level singletons re-invented per module

`my-site.js` keeps `$folder` + `switch_folder_tab`, `site-button.js` keeps `$view`, `gif-picker.js` its own open/closed state (`is_gif_picker_open`), `page-history.js` `$window`, `layers-window.js` likewise. Each re-implements "if already open, bringToFront, else create, and null it on close".

**Directive:** add `singleton_window(factory)` to `src/$ToolWindow.js` returning `{ show(options), close(), is_open() }`. Tests: `my-site.test.mjs` already asserts re-opening switches tabs rather than duplicating the window — keep that assertion.

### C8. Three module-level caches that are really one object

`my-site.js` keeps `role`, `sites_url`, `site_created` and `last_sign_in_problem` as separate mutable module globals, all populated only by `check_sign_in`; `current_role()` exports one of them and the My Site summary reads another directly.

**Directive:** fold into one `let whoami = null` record with a `whoami()` accessor (`{ role, sites_url, created, problem, account }`), set in exactly one place.

---

## Duplication

### D1. Five `escape_html`s with three different escape sets

| Location | Escapes |
|---|---|
| `src/block-kinds.js:344` | `& < > " '` |
| `src/collage-format.js:51` | `& < > " '` |
| `src/functions.js:1536` | `& < > " ' ` = /` |
| `worker/shared/x-elements/index.js:91` | `& < > " '` → `&#39;` |
| `worker/editor/index.js:232` | `& < > "` only — **no apostrophe** |

Plus `escape_xml` twice: `src/text-layers.js:49`, `worker/sites/index.js:286`.

Why it's a smell, not just duplication: the editor Worker's copy is used for Open Graph `content="…"` attributes in `share_landing` (`worker/editor/index.js:308`), where the attribute delimiter is `"` — correct today, but the divergence is invisible and the weakest copy is the one on the security boundary.

**Directive:** `worker/shared/escape.js` exporting `escape_html` and `escape_xml`; import it in both Workers (`worker/shared/x-elements/index.js` already lives there and re-exports it, so make that the single definition and have `worker/editor/index.js` and `worker/sites/index.js` import it). On the client, keep one copy in `src/block-kinds.js` and have `collage-format.js` import it; delete the `functions.js` local if it is only used for the one call site.
**Tests:** `sections.test.mjs`, `x-preview.test.mjs` and `root-site.test.mjs` assert rendered markup; add one case with `'` and `"` in a page title to `not-found.test.mjs` or `publish.test.mjs`.

### D2. Four `blob_to_data_url`, two `hash_blob`, two extension maps

- `blob_to_data_url`: `src/blocks.js:67`, `src/collage-format.js:59`, `src/layer-storage.js:100`, `src/pictures.js:31` — byte-identical FileReader wrappers.
- `hash_blob` (SHA-1 → hex): `src/my-site.js:349`, `src/site-publish.js:107` — identical.
- MIME → extension: `UPLOAD_EXTENSIONS` (`src/my-site.js:354`, 8 types incl. audio) vs `extension_for_type` (`src/site-publish.js:113`, 4 image types with a `"png"` default). Two different answers for `image/svg+xml`.

**Directive:** `src/blob-helpers.js` with `blob_to_data_url`, `hash_blob`, `extension_for_type` (one table, audio included). `src/helpers.js` (484 lines, already the shared-utility home) is the alternative host — either is fine, but pick one.
**Tests:** `pictures.test.mjs` (upload paths are content-addressed `gifs/<hash>.<ext>`) and `collage.test.mjs` pin the hashing and extension behavior.

### D3. Four ways to call the editor API

1. `api(path, init)` — `src/my-site.js:307`: bearer + `credentials: include` + JSON error extraction + 401 message mapping. The good one.
2. `authorized(init)` — `src/site-publish.js:96`: headers only, no error handling. Used by `gif-picker.js:141,154`, `link-dialog.js`, `share.js`.
3. Hand-rolled headers inside `publish_collage` — `src/site-publish.js:123–146`: builds `Invite`/`Bearer` headers itself and throws its own strings.
4. Bare `fetch` for public reads — `src/my-site.js:257,276,796,1278`, `src/site-button.js:127–128`, `src/x-preview.js:88`.

Consequence: error messages differ per caller ("The password was rejected." exists in two spellings, `my-site.js:317` and `site-publish.js:141`), and the `?optional` convention (204 instead of 404, `worker/editor/index.js:478`) is re-explained in three comments.

**Directive:** one `src/site-api.js` with `api(path, init)` (authenticated, throws `ApiError {status, message}`), `public_get(path)` (no credentials, understands `?optional` → `null`), and named endpoint functions (`list_files`, `read_page`, `write_file`, `delete_file`, `versions`, `restore_version`, `presence`, `whoami`, `favorites`). `publish_collage` takes an injected uploader so the guest-invite header case is a *parameter*, not a fourth code path.
**Tests:** `site-password.test.mjs` and `versions.test.mjs` hit these endpoints directly; `my-site.test.mjs` covers the UI-visible error strings.

### D4. Five pixel-art → SVG icon builders

| Builder | File | Shape |
|---|---|---|
| `pixel_svg(rows, palette)` | `src/icons.js:11` | 16×16, `<rect>` per pixel, multi-color palette |
| `svg(body)` + `pixel_rects(rows, x, y, color)` | `src/page-tools.js:26,31` | 16×16, `<rect>` per pixel, single color, offset |
| `pixel_icon(rows, color, etched)` | `src/quick-buttons.js:21` | N×N, one `<path>`, etched variant |
| `svg_url(body, w, h)` + `path_of(pixels, fill)` | `src/site-button.js:22,24` | arbitrary size, one `<path>`, returns `url("data:…")` |
| `svg16(body)` + `px(d, fill)` | `src/$FontBox.js:105` | 16×16, raw path data |

`src/icons.js` (36 lines) already exists as the "shared where the same glyph appears twice" module and is used by exactly two files.

**Directive:** grow `src/icons.js` into the one builder: `pixel_icon(rows, { palette, size, etched })` returning markup, plus `icon_data_url(markup)`. Port `page-tools.js`, `quick-buttons.js`, `site-button.js` and `$FontBox.js` to it; the `path_of`-style single-`<path>` output is the better implementation (fewer nodes) — make it the default and delete the `<rect>`-per-pixel versions.
**Tests:** none exist for icons and none are warranted; `npm run lint` plus an eyeball on the toolbox (screenshots at 1× and 4× are the habit that caught the last two icon problems). If you want a gate, `qr.test.mjs` already shows the rasterize-and-assert pattern.

### D5. Three Windows-98 tab strips, hand-rolled

- My Site property sheet: `src/my-site.js:979–1007` (behavior incl. arrow-key roving tabindex) + CSS at `:1404–1444`.
- GIF picker tabs: `src/gif-picker.js` (`.gif-picker-tabs`, `.gif-picker-tab`) with its own CSS in the 125-line block at `:427`.
- Page tabs above the canvas: `src/site-button.js:208–276` + CSS at `:403–448` — different semantics (overflow into a `…` button) but the same visual language.

**Directive:** extract `src/$Tabs.js` — `make_tabs($into, [{id, label}], { on_change })` returning `{ show(id), $panel(id) }`, with the roving-tabindex keyboard handling from `my-site.js` (the most complete implementation) — and one `.tabs`/`.tab` CSS rule set in the stylesheet from D6. Page tabs keep their own overflow logic but inherit the styling.
**Tests:** `my-site.test.mjs:47–49` asserts the three tab labels and the selected tab; `gif-picker.test.mjs` and `gif-favorites.test.mjs` click the Favorites tab; `page-tabs.test.mjs` covers overflow.

### D6. ~1,200 lines of CSS-in-JS across 20 modules

25 `$("<style>").text(...)` blocks in `src/`. The site-builder ones, by size: `site-button.js` 179, `my-site.js` 167, `gif-picker.js` 125, `page-history.js` 118, `blocks.js` 96, `page-tiles.js` 83, `live-session.js` 80, `pictures.js` 53, `pan-joystick.js` 49, `layers-window.js` 46, `share.js` 34, `quick-buttons.js` 34, `stickers.js` 28, `site-publish.js` 24, `text-layers.js` 19, `loading-veil.js` 18, `welcome.js` 17, `page-scroll.js` 15, `page-properties.js` 15, `link-dialog.js` 7.

Costs: no editor tooling (the CSS is a JS string), duplicated `var(--ButtonFace, #c0c0c0)` fallbacks in every block, shared classes defined in whichever module happened to need them first (`.my-site-pages`, `.my-site-empty` and `.inset-deep` are styled in `my-site.js`/`page-tiles.js` but used by `link-dialog.js:34,36`), and per-module `<style>` elements appended in import order, so cascade order depends on the import graph. The theme's own rules also bite: the classic theme paints its B/I/U sprite through `::before`/`::after` on every `.font-box .toggle > .icon`, which garbled three custom toolbar icons until each opted out.

**Directive:** move everything except genuinely computed values into `styles/site-builder.css`, loaded from `index.html` alongside the other stylesheets. Keep a `<style>` block only where the CSS interpolates a runtime value — that is `src/site-button.js:449–477` (globe artwork data URLs, `GLOBE`/`STRIP` sizes) and `$FontBox.js:158`. Do it module by module; each move is independently verifiable.
**Tests:** the suite is DOM/selector-based, not pixel-based, so it will not catch a dropped rule; do this one with a visual pass, and consider it a good moment to check the `.squish` / `min(Npx, 9Xvw)` width dance that is repeated in 9 dialogs.

### D7. Six hand-rolled localStorage JSON accessors — while `src/storage.js` exists

`load_settings`/`save_settings` (`src/site-publish.js:24–61`, with the only quota-recovery logic), `load_drafts`/`remember_draft` (`src/my-site.js:699–719`, with its own 40-entry LRU trim), `load_favorites`/`save_favorites` (`src/gif-picker.js:97–110`, with a 300-entry cap), `welcome_dismissed` (`src/welcome.js:11`), live-sync enabled/name (`src/live-session.js:75,105`), history mode (`src/page-history.js:172`). Each re-implements `try { JSON.parse(…) } catch { default }`; only one handles a full store.

**Directive:** `src/local-json.js` with `load_json(key, fallback)`, `save_json(key, value, { on_full })` and `capped_list(key, max)`. Point all six at it, keeping the `site-publish.js` quota-recovery path as `save_json`'s default `on_full` (it evicts legacy `image#…` entries — that behavior must survive; see the comment at `src/site-publish.js:48–54`).
**Tests:** `autosave.test.mjs`, `gif-favorites.test.mjs`, `first-run.test.mjs` (welcome-seen) and `google-auth.test.mjs:267,310` all read/write these keys directly, so key names and shapes are already pinned.

### D8. Dialog boilerplate repeated ~20 times

Every dialog ends with the same four lines — `$w.$Button("Cancel", …)`, `$w.$content.css({ width: "min(NNNpx, XXvw)" })`, `$w.center()`, `$input.focus()` — 35 `center()` calls in `src/`. The label+input row helper is written three times with three names: `field()` in `src/my-site.js:594` and again in `src/site-publish.js:228`, `row()` in `src/link-dialog.js:27` and `src/site-button.js:115`, plus the `.my-site-row` pattern inline in `show_new_post_dialog` and `show_folder_dialog` (`src/my-site.js:1187–1218`). Checkboxes have a trap of their own: 98.css only draws the box when a `<label for>` *follows* the `<input>`; a wrapping label renders nothing (`welcome.js` hit this).

**Directive:** add to `src/$ToolWindow.js` (or a new `src/$Form.js`): `$DialogWindow.prototype.$Field(label, { type, name, value, placeholder })` returning the `$input`, a `$Checkbox(label, { name, checked })` that emits the input-then-label pair, and `$Dialog({ title, width, main, buttons, focus })` that does the width/center/focus tail. Convert the nine `$DialogWindow` call sites in `my-site.js` first — they are the most repetitive.
**Tests:** every dialog is driven by selector in the suite (`input[name="site-name"]`, `input[name="new-page-name"]`, …) — preserve the `name` attributes and the tests keep passing unchanged, which is exactly the safety net you want here.

### D9. Smaller duplications worth one sweep

- The site-name regex `/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/` is written out in `my-site.js:79, 424, 643` and `site-publish.js:279`, and mirrored server-side in `worker/shared/names.js:valid_site_name`; the page-path regex likewise (`my-site.js:54 PAGE_PATH` vs `site-publish.js:284`). The three user-facing "names are 1–32 lowercase letters…" messages differ slightly.
  **Directive:** export `VALID_SITE_NAME`, `VALID_PAGE_PATH` and `describe_site_name_error()` from `src/site-constants.js` (or import `worker/shared/names.js` directly — it is dependency-free).
- The page-file-name sanitizer in `my-site.js` (`show_new_page_prompt`: `.replace(/\.html?$/i,"").replace(/[^A-Za-z0-9._-]/g,"-")…`) is the inverse of `slug_for`, and `is_page`/`is_index` live in `page-tiles.js`, a rendering module.
  **Directive:** one `src/page-paths.js` with `page_folder`, `slug_for`, `normalize_page_name`, `is_page`, `is_index`.
- `new_site_page` and `new_site_post` repeat a ten-line "reset the document" sequence verbatim.
  **Directive:** `start_fresh_page(path, { starter, blocks })` used by both.

---

## Workers

### W1. `worker/editor/index.js` (~830 lines): a 177-line `fetch` with twelve inline route regexes

The handler is `:622–798`. Route dispatch is a straight-line sequence of `if (/^\/api\/sites\/([^/]+)\/rooms\/(.+?)(\/invite)?$/.exec(...))` blocks — rooms (654), gifcities search (677), gifcities gif (683), gifs/used (690), gifs/top (699), x-elements (705), public file reads (709), whoami (712), presence (726), password (736), versions (760), files (779) — each re-parsing the site name and re-validating it with `valid_site_name`. Two of them (`/api/sites/:name/files`) are matched twice with different regexes (`:709` and `:779`) because public reads must bypass auth.

Auth is scattered and inconsistent:

- `role_of` is called at `:668, 673, 716, 741, 764, 783` — six independent decisions.
- `invite_valid` at `:674` (rooms) and `:788` (files), with the guest page coming from a `?invite=` param in one and an `X-Invite-Page` header in the other.
- `session_of` at `:717` (whoami) and `:744` (password).
- The password route does *not* trust `role_of`'s account path: it re-derives ownership itself (`:743–746`) with the comment "the account that owns the site, not someone holding its password" — a real distinction that `role_of` can't express, because it collapses "owns it" and "knows the password" into the single value `"site"`.

**Directive:** (a) introduce a route table — `const routes = [{ method: "GET", pattern: /^\/api\/whoami$/, auth: "public", handler }, …]` — matched in one loop; the `auth` field names a policy (`"public" | "site" | "master" | "site-or-invite"`) resolved by one `authorize(request, env, policy, site)` function. (b) Make `role_of` return the richer value it already computes: `{ role: "master" | "site", via: "master-key" | "password" | "account" }`, so the password route's special case becomes `auth.via === "account"` instead of a second ownership lookup. (c) Move the extracted groups (password minting `:75–136`, invite keys `:164–226`, versions `:321–435`, share landing `:264–319`, gifcities proxy `:530–552`) into `worker/editor/passwords.js`, `invites.js`, `versions.js`, `share-landing.js`, `gifcities.js` — `index.js` should be routing plus `handle_site_files`.
**Tests:** `site-password.test.mjs` is the closest thing to a route-auth matrix today (it checks 200/401/403 per token). Grow it into an explicit table test over `{route × token-kind}` — that is the single highest-value test to add in this repo, and it makes the router change safe.

### W2. `handle_site_files` does five jobs (`worker/editor/index.js:443–528`, 86 lines)

One function covers: path parsing/validation, the paginated listing, GET/HEAD with the `?optional` convention, invite scoping (`:486`), DELETE, and PUT — where PUT itself branches into `site.json` validation (`:499–510`), HTML sanitization (`:511–516`) and binary magic-byte sniffing (`:517–522`), then version archiving.

**Directive:** split into `list_files(env, prefix)`, `read_file(env, key, request, url)`, `write_file(env, prefix, path, bytes)` with a small `validate_body(path, bytes)` that returns `{ body, error }` and holds the three content rules; keep `handle_site_files` as a five-line method dispatcher.
**Tests:** `publish.test.mjs`, `versions.test.mjs`, `pictures.test.mjs`, `x-preview.test.mjs` exercise all three PUT branches; `not-found.test.mjs` covers `?optional`.

### W3. `handle_auth` is a 167-line if-chain with a dependency inversion hack

`worker/editor/auth.js:176–342` handles nine routes (`/auth/methods`, `/auth/:provider`, `/auth/:provider/callback`, `/auth/sign-out`, `/auth/sites`, `/auth/sites/:site/claim`, `/auth/favorites`, `/auth/sites/:site/owner`, `/auth/sites/:site/assign`). The OAuth start+callback alone is `:182–229`.

It receives `{ role_of, password_hash, site_hash }` as a parameter from `index.js:626` because those live in `index.js` — the cycle is real, the injection is the workaround, and the JSDoc at `:173` still documents a fifth parameter (`site_hashes`, "index.js's cache") that no longer exists in the signature.

Also note `/auth/favorites` (`:280–311`) is GIF-library code sitting in the auth module, with its own `key_of`/`size` validators.

**Directive:** move `password_hash`, `site_hash`, `same_string`, `bearer_of` and `role_of` into `worker/editor/roles.js`, imported by both `index.js` and `auth.js` — the injection parameter disappears and so does the stale doc. Split `auth.js` into `oauth.js` (provider config + start/callback), `sessions.js` (cookie, `session_of`, `issue_session`), `sites.js` (`/auth/sites*`), and move `/auth/favorites` to `worker/editor/favorites.js`. Apply W1's route table here too.
**Tests:** `google-auth.test.mjs` (332 lines) already drives the whole OAuth round trip with a stub provider, plus claim/assign/limit; `gif-favorites.test.mjs` covers favorites.

### W4. `worker/sites/index.js` (~440 lines): DO + router + renderer + feed in one file

Contents: `SiteState` Durable Object (`:38–102`: views, guestbook, counters, SQL schema), `html_response`/`not_found`/`landing_page` (`:111–225`), `handle_action` (`:130–161`), `handle_preview` (`:171–196`), `site_files` capability object (`:232–283`), `rss_feed` (`:297–311`), `with_stylesheet` (`:318–322`), and the ~110-line `fetch` (`:329–440`) that resolves site/path, handles clean URLs, folder redirects, custom 404 fallback and asset caching. `serve_page` is a closure inside `fetch` because it needs `request`, `env`, `ctx` and `site` — a sign the renderer wants to be its own module with those passed explicitly.

The `x_elements` registry (`worker/shared/x-elements/index.js`) is the good pattern here — six elements, each a self-contained `{tag, attrs, editor, render, action?}`, rendered through one `HTMLRewriter` pass, and the *same* registry feeds the editor's `/api/x-elements` (`worker/editor/index.js:705`) and the client's `refresh_x_element_kinds` (`src/block-kinds.js:276`). That is the extension model working as designed.

Against it sit three ad-hoc, hard-coded routes that are conceptually the same thing — "site-level dynamic endpoints": `x/stats.json` (`:374`), `x/preview` (`:337`), `<folder>/feed.xml` (`:370`). Each is matched separately, in a different place in the function, with its own response construction.

**Directive:** (a) move `SiteState` to `worker/sites/site-state.js` and the page renderer (`serve_page`, `with_stylesheet`, `site_files`) to `worker/sites/render.js`. (b) Introduce a small `site_routes` table for the dynamic endpoints — `x/stats.json`, `x/preview`, `x/<element>` (POST action), `*/feed.xml` — so adding "x/search.json" later is an entry, not a new `if` in the middle of path resolution. (c) `void extension_of;` at the end of `fetch` is dead code keeping an unused import alive — delete both.
**Tests:** `root-site.test.mjs` (redirects, root-at-apex), `not-found.test.mjs` (clean addresses, custom 404), `sections.test.mjs` + `x-preview.test.mjs` (rendering + preview), `analytics.test.mjs` (no trackers on pages) already fence this file well.

### W5. `worker/shared/` is thin and should absorb more

Today: `names.js` (91), `sanitize.js` (69), `sections.js` (47), `analytics.js` (139), `x-elements/` (281). The editor and sites Workers each re-implement `escape_html`/`escape_xml` (D1), each have their own `json()` response helper (`worker/editor/index.js:51`, `worker/editor/auth.js:164` — two copies inside the *same* Worker with different default headers), and each have their own CORS constant (`index.js:39`, `auth.js:161`) whose difference is explained in a comment rather than in code.

**Directive:** `worker/shared/http.js` with `json(data, status, headers)`, `CORS_READ`, `CORS_CREDENTIALED` and the `with_dev_cors` logic (`worker/editor/index.js:807–817`); both Workers and both editor route modules import it.
**Tests:** `editor-origin.test.mjs` and `live-room.test.mjs` cover the CORS/credentials behavior that must not change.

### W6. The HTML dialect is enforced twice, by convention

`worker/shared/` is imported by both Workers — good — but the client re-implements pieces of it: `src/block-kinds.js` (`sanitize_tree`, `sanitize_html_fragment`) versus `worker/shared/sanitize.js:sanitize_html`, and `src/collage-format.js` parses the same page dialect that `worker/shared/sections.js:find_sections` parses. Divergence here means the editor shows something the server won't serve, and the escape-set drift in D1 is the same problem in miniature.

**Directive:** publish `worker/shared/` as a path the client can import (it is plain ESM; keep the `HTMLRewriter`-using code in its own file so the pure helpers have no Workers-only APIs). Start with the allow-lists: one `ALLOWED_TAGS`/`ALLOWED_ATTRS` table in `worker/shared/dialect.js` imported by both `sanitize.js` and `block-kinds.js`.
**Tests:** a round-trip test that serializes a page in the browser, sanitizes it with the shared module, and asserts nothing is dropped.

---

## Tests

32 files, ~3,900 lines, of which `helpers.mjs` is 164. The imperative style (top-level `await`, assert as you go) is fine and readable; the problem is that five setup concerns are re-typed per file.

### T1. Six repeated helpers that belong in `helpers.mjs`

1. **The env guard** — identical five-line block in ~16 files (`my-site.test.mjs:7–13` is typical): read `SITE_BUILDER_EDITOR_URL`/`SITES_URL`/`SECRET`, `console.log("x: skipped (set …)")`, `process.exit(0)`.
   → `require_env("my-site", ["editor", "sites", "secret"])` returning `{editor, sites, secret, headers}` or exiting.
2. **Publish-and-wait** — `page.keyboard.press("Control+s")` then `waitForFunction(() => /Done!|Couldn't|rejected|failed/i.test(document.querySelector(".site-publish-log")?.textContent || ""), null, {timeout: 60000})` then `$eval(".site-publish-log", …)` then assert `/Done!/`. Occurs in `my-site.test.mjs` (×4), `google-auth.test.mjs`, `first-run.test.mjs` (×3), `page-tabs.test.mjs` (which wraps it locally), `x-preview.test.mjs`. The regex alternation differs between copies (`failed` vs `expired`).
   → `publish_and_wait(page, { expect: "Done!" | "Not saved" })`.
3. **Site cleanup** — `const listing = await (await fetch(`${editor}/api/sites/${site}/files`, {headers})).json(); for (const file of listing.files) { await fetch(…, {method:"DELETE", headers}) }` in eleven files.
   → `cleanup_site(editor, site, headers, { drop_password: true })`.
4. **Seeding publish settings** — `localStorage.setItem("jspaint site publish settings", JSON.stringify(arg))` as an init script in ten files; several declare an identical local `seed` const.
   → `open_paint({ settings: { editor_url, site, secret, … } })` — a first-class option on the existing helper.
5. **`open_signed_in(label)`** — defined twice, near-identically: `live-paint.test.mjs:21–35` and `page-history.test.mjs:19–33`.
   → move verbatim to `helpers.mjs`.
6. **GifCities stubbing** — `gif-favorites.test.mjs:11` (`stub`) and `open_picker` at `:17`; `gif-picker.test.mjs`, `gif-events.test.mjs` and `google-auth.test.mjs:258` each roll their own route interception.
   → `stub_gifcities(page, results)` and `open_gif_picker(page)`.

**Directive:** add the six helpers above, plus `step(name, fn)` (logs, times, rethrows with the step name — so `close()`'s "page errors" assertion can say which step was in flight) and `with_site(fn)` (mints the site, runs the body, cleans up in a `finally`). Convert two files (`publish.test.mjs`, `page-tabs.test.mjs`) as the pattern, then the rest. Expect ~400 lines to disappear from the suite.

### T2. Flakiness sources

- **50+ `page.waitForTimeout(...)` calls**, plus an unconditional `waitForTimeout(800)` inside `open_paint` (`helpers.mjs`) paid by every file. Worst offenders: `page-scroll.test.mjs` (7), `sections.test.mjs` (5), `text-layers.test.mjs`/`layers.test.mjs`/`blocks.test.mjs`/`app-errors.test.mjs` (4 each).
  **Directive:** replace with `waitForFunction` on the condition actually being waited for (a block count, a selector, a `saved` flag). Where a settle is genuinely needed (debounced autosave), wait on the observable effect — the sidecar in IndexedDB, or the `session-update` event.
- **Shared root-site state.** `first-run.test.mjs` writes and deletes `root/index.html`, `root/collages/index.png`, `root/welcome.html`, and `my-site.test.mjs` also writes to `root`. A run that dies between write and cleanup leaves the starter-page path altered for every later run — and the two files can never be run concurrently.
  **Directive:** make cleanup a `try/finally` that always runs; longer term, let tests point `ROOT_SITE` at a generated name via a settings seed.
- **Load sensitivity.** The full suite has produced spurious 60-second-timeout failures (and once 10–15-minute stalls) whenever anything CPU-heavy ran alongside it — `tsc`, a screenshot script, a code-survey agent grepping the tree. The same tests pass in seconds alone. Once `publish_and_wait` exists, one constant controls the long timeouts; and `run.mjs` should print which test is running so a stall is visible.
- **60-second publish timeouts** used as the default everywhere turn a hang into a two-minute wait rather than a fast failure.

### T3. `run.mjs` (24 lines) is minimal to the point of being unhelpful

Serial `spawnSync` over every `*.test.mjs`, printing `✔`/`✘` and a count. No parallelism (the suite is I/O-bound on a headless browser), no per-file output capture (a failure's stack is interleaved into the parent's stdio), no retry, and the `only` filter is a naive substring match.

Tests also self-skip with `process.exit(0)` when env vars are missing, so a misconfigured run reports "all N test file(s) passed" while having exercised nothing.

**Directive:** keep it tiny, but add: a `--jobs N` flag running files in parallel (safe once T2's shared-root issue is fixed), capture each child's output and print it only for failures, print each file's name when it starts, count skips separately (`24 passed, 4 skipped`, with a `--require-full` flag for CI; `require_env` exits with a distinct code), and a non-zero-exit summary listing the failing files at the end. Do *not* reach for a test framework — the current style is a genuine asset for browser-driving tests.

---

## Housekeeping

- **`docs/DESIGN.md` §5 has become a changelog.** Lines 146–170 are ~16 dense paragraphs, each stamped with a date and a quoted decision ("2026-09-13, Jack: …", "found by the tabs test under load, 2026-09-13"). It is simultaneously the spec, the history and the implementation notes; §5 alone is longer than §§1–4 combined. `docs/PLAN.md`'s status log carries the same dated entries a second time.
  **Directive:** keep §5 as the *current* description of the editor (present tense, no dates), and move the dated decisions into `docs/DECISIONS.md` or the existing `CHANGELOG.md`. The rest of DESIGN.md (§3 the HTML dialect, §3.5 the `<x-*>` registry, §9 security) is genuinely good spec writing and should stay as is.
- **`src/app-analytics.js` reaches for a bare `posthog` global.** `posthog?.capture(...)` still throws `ReferenceError` when the snippet never loaded (dev servers, browsers that block it); `gif-picker.js` wraps its calls in `try/catch` as a shield. The fix is one line in that module (`globalThis.posthog`), and the file is still untracked in git although committed code imports it.
- **Stale/duplicated JSDoc in `src/my-site.js`:** `:371–377` has an orphaned doc comment for `check_sign_in` immediately followed by a second doc comment for `last_sign_in_problem`; `:871–879` has two doc comments stacked on `new_site_page`. `worker/editor/auth.js:173` documents a `site_hashes` parameter the function no longer takes.
- **Dead code:** `void extension_of;` (`worker/sites/index.js`) keeps an unused import from being flagged. `src/sessions.js:562–822` is a ~260-line commented-out `WebSocketSession` class (inherited from upstream, but it is 20% of the file's non-comment budget). `lib/font-detective.js` and the `FontDetective.preload` calls in `src/tools.js` are inert since the fixed web-safe font list. `src/my-site.js:671` has a leftover one-line doc (`/** Signed in, asking first if needed. */`) above a second full doc block.
- **Three copy-pasted `// XXX: Localization hazard: logic based on English action names`** — `src/blocks.js:167`, `src/stickers.js:159`, `src/text-layers.js:114` — the same undo-label sniffing in three OnCanvasObject subclasses, which is itself a sign these three classes want a shared base (all three implement identical `snapshot`/`restore`/`nudge`/`reorder`/`flatten`/`upsert_from_snapshot`/`remove_by_id`/`order_*` sextets: compare `src/stickers.js:276–600` with `src/text-layers.js:265–490`).
- **Two different windows are both titled "My Site":** `show_my_site_dialog` (the tabbed manager, `.my-site-window`) and `show_site_view` (the globe's summary, `.site-view-window`) both call `localize("My Site")` for their title; the tests tell them apart only by class. Rename to `show_site_manager()` / `show_site_summary()` or retitle one.
- **Naming:** `site-publish.js` owns settings (C3); `x-preview.js` exports `init_x_previews` but `refresh_all as refresh_x_previews`; `my-site.js` has `public_url` while `site-constants.js` has `site_public_url` and `site-publish.js` has `get_site_files_base` — three URL builders with overlapping jobs; `page-tiles.js` exports `kb()`, a byte formatter, from a tile-rendering module.
- **`worker/editor/dist/` is a checked-out copy of `src/`** (gitignored, per `worker/.gitignore`), rebuilt by `npm run build:editor`. `docs/PLAN.md` warns "Rebuild `editor/dist` after every Paint change or the Worker serves stale files" — that trap deserves either a watch mode in the dev script or a build-hash check in the Worker's dev path.

---

## Suggested order

Ranked by value ÷ effort. Items 1–4 are worth doing before the next feature lands; 5–8 when touching the relevant area; 9–13 opportunistically.

| # | Change | Value | Effort | Why first |
|---|---|---|---|---|
| 1 | **T1 — test helpers** (`require_env`, `publish_and_wait`, `cleanup_site`, `open_paint({settings})`, `open_signed_in`, `stub_gifcities`) | High | Low | Removes ~400 lines, and every later refactor is verified by this suite. Do it before touching src/. |
| 2 | **C2 — `src/site-document.js`** (typed document identity) | High | Med | Kills the most dangerous duck-typing in the app; touches 15 files but each edit is mechanical and greppable. Fix the `copy_of`-lost-on-reload bug first, on its own. |
| 3 | **W1(b) + T2 — route-auth matrix test, then `role_of` returning `{role, via}`** | High | Low-Med | Grow `site-password.test.mjs` into a `{route × token}` table *first*; it makes the whole worker refactor safe and documents the auth model that currently lives in six scattered calls. |
| 4 | **D3 — one `src/site-api.js`** | High | Med | Collapses four HTTP idioms into one; prerequisite for C1's split and removes `link-dialog`/`gif-picker`/`share` → `site-publish` coupling. |
| 5 | **C1 — split `my-site.js`** into six modules behind a facade | High | High | The biggest single win, but it wants 2 and 4 landed first so the pieces have somewhere to go. |
| 6 | **W1(a) + W3 — route tables in `worker/editor/index.js` and `auth.js`; `roles.js` to kill the injected-dependency hack** | High | Med | 177-line and 167-line handlers become tables; the stale JSDoc problem disappears with the parameter. |
| 7 | **C3 — rename/split `site-publish.js` → `site-settings-store.js` + publish dialog** | Med-High | Low | Import-only change; immediately clarifies why 15 modules import a "publish" module. |
| 8 | **D6 — CSS-in-JS → `styles/site-builder.css`** | Med-High | Med | ~1,200 lines out of JS, cascade order becomes explicit; do it module-by-module, lowest-risk first (`link-dialog`, `welcome`, `page-properties`). |
| 9 | **D1 + D2 + D7 — shared `escape`, blob helpers, `local-json`** | Med | Low | Three afternoons of mechanical de-duplication; D1 also removes a divergence on the HTML-escaping security boundary. |
| 10 | **W4 — split `worker/sites/index.js`** (SiteState DO / render / route table for `x/*` + `feed.xml`) | Med | Med | The `x_elements` registry is the model; make the ad-hoc endpoints follow it. |
| 10b | **W6 — one dialect table shared by client and Workers** | Med | Med | Ends the editor-shows-what-the-server-strips class of bug; pairs with D1. |
| 11 | **C5 — `src/site-events.js`** (event-name constants + payload type definitions) | Med | Low | Makes the `$G` bus greppable and type-checked; cheap, and pays for itself the next time a listener misses a field. |
| 12 | **C6 + D5 + D8 — `$Tabs.js`, `$Field`/`$Checkbox`/`$Dialog` helpers, then split `page-history.js` (384-line function) and `blocks.js`** | Med | Med-High | Do the shared widgets first; the big-function splits then shrink by themselves. |
| 13 | **Housekeeping** — DESIGN §5 → changelog, `void extension_of`, stale JSDoc, commented-out `WebSocketSession`, dead FontDetective, `refresh_x_previews`/`kb()` naming, the two "My Site" titles, C8's `whoami` record, `globalThis.posthog` | Low | Low | Batch into one "tidy" commit; no behavior change, no test risk. |
