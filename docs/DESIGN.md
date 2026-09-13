# Win98 Site Builder — design (working title)

*Status: living design. Decisions below were made with Jack on 2026-09-09 (revised the same day: everything lives inside the Paint view — see §5); open items are marked.*

## 1. Vision

A hosted, Windows-98-styled site builder for web 1.0 pages. `sitename/~jack/` is a small multi-page personal site. The editor **is JS Paint** (this fork): the page is the Paint document — an 800px canvas you paint on — and the toolbox has, below the paint tools, a **Pointer** and one tool per page element (heading, paragraph, marquee, divider, animated GIF, image, table, colored box, guestbook, counter, music, raw HTML). Elements are placed like Paint's own text boxes (click or drag a box), float over the bitmap like stickers, edit in place, and stay real HTML. One document, two first-class exports: the page is a real HTML file you can host anywhere, and the page renders to a looping animated GIF you can paste into a chat.

Reference vibe: <https://renaandjack.com/wedding> — centered flow, `<marquee>`, MP3 with a play button, GeoCities GIFs as dividers, pastel `bgcolor`.

## 2. Decisions so far

| Question | Decision |
| --- | --- |
| Primary artifact | Both first-class: HTML page + animated GIF render |
| Page model | **The page is the Paint document** (revised 2026-09-09): one 800px-wide canvas is the page's background; every element (headings, marquees, GIFs, text, guestbook…) floats over it at a position and size, like Paint's text boxes and selections. No flow layout. |
| Page width | Fixed **800px centered**, one constant (`PAGE_WIDTH`), user-choosable later; new documents are 800×600 |
| Users / hosting | Hosted for non-technical users eventually; **Cloudflare** all the way; **`coolpaint.world/`** is the `root` site and **`coolpaint.world/~name/`** the others (the sandbox Worker); **`edit.coolpaint.world`** is Paint, and `edit.coolpaint.world/~name` opens that site in it (since 2026-09-10; old hostnames redirect) |
| Accounts | Later. Now: single shared secret for Jack |
| App shell | **Just JS Paint** (revised 2026-09-09; the fake-desktop shell was built and then removed). Page elements are toolbox tools; site management is in the File menu; page settings in a Page menu. |
| Blocks v1 | Headings/paragraphs/links, marquee, GIF dividers & stickers, images, tables/colored boxes, background music, tiled wallpaper, guestbook, visitor counter, last-updated, raw HTML (image maps: later) |
| Painting | The bitmap is the page's background layer; paint tools paint under the elements (elements are click-through unless selected, or when the Pointer tool is active). Flatten draws an element into the bitmap. |
| GIF export | The page (bitmap + elements + stickers + text) as one looping GIF |
| GIF source | GifCities for now; users upload their own GIFs/MP3s/wallpapers |
| Text | Classic web-safe fonts rendered by the browser (Comic Sans MS, Times, Arial, Impact, Courier…), editable, linkable |
| AI | Optional assist later; the document must stay agent-editable; nothing AI-facing in v1 |
| Pages | Multiple pages per site with internal links |
| Import | Best-effort import of simple foreign HTML; our own dialect round-trips losslessly |
| Build order | **Blingee half first** (Paint stickers/text/GIF export), then the page editor and hosting |
| Document format | **HTML dialect — the page is the file** (see §3) |

## 3. The document: an HTML dialect

A site is a folder; a page is an HTML file in a dialect the editor can parse back losslessly. Nothing else is the source of truth.

```
~jack/
  index.html          pages are plain HTML in the dialect
  about.html
  style.css           optional, per site
  gifs/               stickers and dividers (copied from GifCities or uploaded)
  collages/hero.png   the bitmap part of a collage
  doodles/index.png   the page's doodle layer
  midi/song.mp3
```

### 3.1 Page skeleton

```html
<!DOCTYPE html>
<html data-page-width="800">
<head>
<meta charset="utf-8">
<title>Jack's Page</title>
<link rel="stylesheet" href="/~jack/style.css">
</head>
<body bgcolor="#ffffd9" background="gifs/stars.gif">
<center>
  …blocks…
</center>
<img class="doodle" src="doodles/index.png">
</body>
</html>
```

Rules that make it parseable:
- `body > center` is the page; each direct child of `<center>` is one **block**. Width comes from `data-page-width` (the one constant) and a tiny generated stylesheet.
- Obsolete-but-still-rendered HTML is allowed and preferred for the look: `<center>`, `<marquee>`, `<font face color size>`, `bgcolor`, `background`, `<table border bgcolor>`. Every browser still renders them.
- Editor-only metadata goes in `data-*` attributes; never in scripts or comments. A page must render correctly with no JavaScript.
- Unknown block-level elements are preserved verbatim as a **raw HTML block** — this is also how import works.

### 3.2 Element vocabulary (blocks)

Every element is a positioned child of the page's `div.collage` with `class="block"` and its box as inline CSS (`left/top/width/height`). The element **is** the semantic tag; `data-kind` disambiguates where the tag alone can't (a colored box is a one-cell table). Registry: `src/block-kinds.js`.

| Element | Markup |
| --- | --- |
| Heading / paragraph | `<h1 class="block" style="…"><font face="Comic Sans MS" color="#ff1493">…</font></h1>`, `<p class="block" style="…">…<a href="about.html">…</a></p>` (inline `<font>`, `<b>`, `<i>`, `<u>`, `<a>` from in-place editing) |
| Marquee | `<marquee behavior="scroll" scrollamount="4" class="block" style="…">…</marquee>` |
| Divider | `<hr size="3" color="#ff69b4" class="block" style="…">` |
| Table / colored box | `<table border="1" cellpadding="4" bgcolor="#fff" class="block" style="…"><tr><td>…`, `<table data-kind="box" border="2" bordercolor="#ff69b4" …>` |
| GIF / image | a **sticker** (§3.3): `<img class="sticker" src="gifs/divider.gif" style="…">`, or `<a class="sticker" href><img></a>` |
| Music | `<x-music src="midi/song.mp3" loop="yes" class="block" style="…">♫ <i>music</i></x-music>` → Worker renders `<audio controls>` (no tool since 2026-09-13; the kind stays for pages that have one) |
| Guestbook | `<x-guestbook class="block" style="…">fallback</x-guestbook>` → Worker renders entries + a POST form to `/~name/x/guestbook` |
| Counter | `<x-counter class="block" style="…">You are visitor number <b>?????</b></x-counter>` → Worker renders the number, DO increments |
| Last updated | `<x-updated class="block" style="…">…</x-updated>` |
| Raw HTML | `<div data-kind="raw" class="block" style="…">anything (sanitized)</div>` (no tool since 2026-09-13 — Page › Insert › Raw HTML; the colored box lost its tool the same day) |

### 3.3 The page (the Blingee)

```html
<body bgcolor="#ffffd9" background="gifs/stars.gif">
<center>
<div class="collage" style="width:800px;height:600px">
  <img class="bitmap" src="collages/index.png">                                  <!-- the Paint bitmap -->
  <h1 class="block" style="left:40px;top:30px;width:420px;height:48px"><font face="Comic Sans MS">hi</font></h1>
  <x-counter class="block" style="left:60px;top:500px;width:300px;height:28px">You are visitor number <b>?????</b></x-counter>
  <img class="sticker" src="gifs/sparkle.gif" style="left:20px;top:30px;width:64px;height:64px">
  <img class="sticker" src="gifs/frog.gif" style="left:400px;top:200px;width:120px;height:90px;transform:scaleX(-1)">
  <a class="text" href="about.html" style="left:200px;top:300px;font:bold 24px Impact;color:#ff1493">about me</a>
  <span class="text" style="left:40px;top:340px;font:16px 'Comic Sans MS';color:#000">~ est. 1999 ~</span>
</div>
</center>
</body>
```

Layers are children in z-order: one bitmap, then the blocks, then stickers (animated GIFs, left as GIFs so the browser animates them), then text layers (the Text tool's "Web" text: real text, optionally links). Position/size/font are plain inline CSS — the export *is* the document, and an agent can edit it. The whole page is one collage; `body` carries `bgcolor`/`text`/`background` (Page › Page Properties…).

### 3.4 Doodle layer

Not needed in the revised model: the bitmap *is* the page-sized paint layer (under the elements). A transparent paint layer *over* the elements (`<img class="doodle">`, `pointer-events: none`) remains a possible later addition.

### 3.5 Extensibility: `<x-*>` elements are the plugin system

Every dynamic or non-trivial block is a custom element in the page file, and *that tag is the contract*. Adding a feature means adding one entry to a registry, never a new file format:

```js
// worker/x-elements/guestbook.js (sketch)
export default {
  tag: "x-guestbook",
  // 1. how the sites Worker renders it when serving the page (server-side, no JS on the page)
  render({ attrs, site, state }) { /* entries + POST form */ },
  // 2. what the editor shows for it (a block card + properties)
  editor: { label: "Guestbook", icon: "guestbook.png", attrs: { title: "text" } },
  // 3. what happens on POST /~name/x/guestbook (optional; the DO gives it per-site storage)
  action({ form, state }) { /* append entry */ },
};
```

Rules for `<x-*>` elements:
- **Fallback content is required.** Whatever is inside the tag is what a browser shows if the page is served raw (exported zip, GitHub Pages, a floppy): `<x-counter>you are visitor #???</x-counter>`. Unknown `<x-*>` tags are inert `HTMLUnknownElement`s, so a page never breaks.
- Attributes are the only inputs (`<x-music src="midi/song.mp3" loop="yes">`). No JSON in attributes, no scripts.
- The Worker replaces `<x-*>` **outside** the browser: server-side substitution at serve time. Rendered output must itself be valid dialect (so a rendered page can be re-imported).
- Editor registration and server rendering live in the same registry file so a tag can't exist half-way.
- Third parties (later): an `<x-*>` tag could be resolved by a URL registry (`<x-weather data-src="https://…">`), sandboxed in an iframe. Not v1, but the tag model leaves room for it.

Planned tags: `x-guestbook`, `x-counter`, `x-music`, `x-updated` (last-modified stamp), `x-webring` (prev/next links), `x-blink`? — the classic set. Everything else is plain HTML.

## 4. Serving (Cloudflare)

- **Worker `sites`** (the sandbox, §9): `GET /~name/` and `/~name/<path>` → object from R2 `sites/name/…`. Pages are served as-is except that `<x-*>` elements are rendered server-side via the registry (§3.5), backed by a per-site Durable Object (guestbook entries, counter). No JavaScript needed on a published page.
- **Worker `editor`** (separate origin — see §9): the desktop app (jspaint + editor windows) as static assets, plus the API: save page, upload asset, list site folder, GifCities search proxy, guestbook post, counter, live-editing room.
- **Storage**: R2 for files (free tier 10 GB; per-site quota), one DO per site for `<x-*>` state (guestbook, counter) in the sites Worker, and one **`PageRoom` DO per page** in the editor Worker: the live draft everyone editing that page shares (layers as JSON, bitmap as a PNG patch log), reached over a WebSocket; joiners get a snapshot, changes are versioned and relayed, presence is relayed. Publishing = the client saving the page to R2; the room is the draft, so a page looks the same wherever you sign in. The room keeps **every change as a version** (2026-09-12): who (the client's name and color), when, what (the label Paint sends: the undoable's name — "Brush", "Add Text Box", "Undo Move Element" — or "New page" / "Saved to My Site" / "Opened" for a seed or replace), its `parent` (the version it was made on) and, for rebuilding, the ops/props payload, the bitmap patch, and a checkpoint of the whole document on seeds/replaces, full-picture resets, and every 25th version. `restore {id}` moves the room's `head` to that version (the document becomes that state, everyone re-fetches a snapshot) and the next change branches from it, so the history is a tree like Paint's own undo tree — shared — and nothing is ever thrown away by going back. Bounded: 500 versions / 48 MB of patches per page, oldest first, never what the head is built from; a version whose base was pruned is listed but can't be brought back (`ok: false`). Rooms from before are migrated on first wake (their document becomes the root version).
- **Publish = save.** No wrangler, no deploy step: the editor PUTs the file into R2 and the page is live. Today's preview-alias machinery is no longer needed for users.

## 5. The editor is JS Paint

Revised 2026-09-09 (Jack: "I want this to ALL be within the jspaint view… add each element via buttons with icons alongside the other ones on the left side"). The fake-desktop shell (`desktop/`, phase 3.1) was built, then removed. In Paint:

- **The globe** — a 50×50 button at the bottom of the toolbox (a web-1.0 spinning pixel earth) with the site's name in 8px type under it (`~jack`, or "sign in"): My Site in one click. The slim bar right above the canvas area (`.page-path-bar`; it and the canvas area share a `.canvas-column` in the toolbox row, so it never covers the page and shows on a phone too) holds the **site's pages as tabs** (2026-09-12): `~jack/` then `index.html` `about.html` … from the site's listing (`list_files`, index first, re-listed on a page open/restore/publish), the current one pressed (`.page-tab.current`). A click switches pages with nothing asked and nothing published: each page's edits live in that page's own local session (`switch_page` in my-site.js — `saved = true`, then the page's remembered draft session via `#local:<id>`, else the page as published; drafts are remembered per `site/page` in localStorage, `jspaint site drafts`); only Save to My Site publishes. Tabs that don't fit hide behind a `…` button (`.page-tabs-more`) that opens My Site › Pages; the current tab always shows (moved first if need be). Before the document becomes another page (a tab, `+`, My Site › Open, New Post…), `before_leaving_page` saves the session and flushes the live room (`flush_live_sync` in live-session.js) — a stroke made a moment before the switch was otherwise lost to the room's older draft when the page came back (found by the tabs test under load, 2026-09-13). A `+` tab (`.page-tabs-new`, 2026-09-13) makes a new page through the same New Page dialog as My Site › Pages (`show_new_page_prompt` in my-site.js: a file name, index.html suggested only when the site has no front page); the fresh page opens and leads the tabs until it's saved. A guest's page, a copy of someone's page, or a picture that isn't on a site shows as one label instead (`.page-path-label`: `~guest/page (guest)`, "page — a copy of ~x's", "untitled — not on a site"), which opens the site view. Signed out it opens Sign In; signed in it shows the site view (address, **Right now: 👁 N viewing (M today) · ✏️ K editing** — viewers are distinct addresses that loaded a page of the site in the last 5 minutes, counted by the sites Worker on each page load into the site's `SiteState` DO and read from `/~name/x/stats.json`; editors are the clients in the site's pages' live rooms, `GET /api/sites/:name/presence` — this page, and for an account **Your sites (n of 5)** — the account's sites as buttons, the current one bold; a click switches to that site and opens its front page (or My Site when it has none); **New Site…** while there's room — My Site…, Save, Share, Sign Out). An account owns up to five sites (`MAX_SITES` in auth.js; the master key's assign ignores the limit); the Sign In dialog lists them too, with the same New Site form (`new_site_form` in my-site.js: a name, or a name plus its password to claim an older site); a guest sees whose page they're on and Share (2026-09-10, `src/site-button.js`).
- **Sections and posts (2026-09-10)** — a **Section** (page tool; kind `section`) is writing that stacks in the page's *column* (Page Properties: left, top, width) and grows with its text; ↑/↓ or dragging reorders; published as `<div class="column">` of `<div class="block section" id="anchor">` (normal flow on the live page, so a reader's fonts push sections down, never over). Sections and free elements mix on one page. Anchors come from the first edit (Element Properties changes them); Page › Copy Link to Section; Ctrl+K links words to a page, a section of it, or an address. The Font toolbar gains Style (Normal, Heading 1–3, Quote, Code), lists, a rule, and a link while a section is edited; a picked GIF goes into the text. A **post is just a page** in a folder that `site.json` marks as posts (`folders.posts.kind = "posts"`): `<x-folder>` lists a folder (the blog index), `<x-toc>` a page's sections, `folder/feed.xml` is its RSS feed, and `site.css` (My Site › Site Style…) is linked into every page at serve time. My Site › New Post… makes `posts/<slug>.html` with a title section and the date. A page's `<title>` is its first section heading.
- **First run** — the Brush tool, largest round size, dark blue foreground (`#000080`): a shared link lands a newcomer ready to paint.
- **Toolbox — the top stays vanilla.** The top of the toolbox is MS Paint's: the 16 classic tools, same order, same icons, same behavior, nothing added or removed (Jack, 2026-09-10: "identical to the original mspaint"). Everything the site builder adds lives **below the groove** in the page tools (`src/page-tools.js`, 16×16 pixel icons inlined as SVG), kept to an even count so the two-column grid has no empty cell (16 as of 2026-09-11): **Pointer** (select, move, resize, double-click to edit), Text Box, **Web Text** (the Text tool's box, but finishing keeps the words as an editable, linkable text layer; letters-in-a-box icon; the Font toolbar's old "Web" toggle is gone), Section, Divider, **Link** (one-shot: the link dialog for the selected element, or for the selected words while editing; it doesn't take focus from the text), GIF (one-shot: opens the GifCities window), Pictures (one-shot: the site's pictures window; Upload…), Table, Colored Box, Guestbook, Visitor Counter, Music, Folder View, Contents, HTML. Element tools work like the Text tool: click, or drag a box. Adding any element switches to the Pointer tool (like Paste switches to Select). Headings are text boxes with a bigger font; scrolling text is the **Marquee toggle in the Font toolbar** (next to B/I/U), which turns the text box being edited into a `<marquee>` and back (2026-09-10).
- **Interaction rule** — elements (stickers, text layers, blocks) are click-through while a paint tool is active, except the selected one; with the Pointer tool they're all live. So you can always paint under things, and always arrange them.
- **What you see is what visitors see** (principle, 2026-09-13 — Jack: "if possible we should always show what the user will see on their rendered page"): whenever it can, the canvas shows exactly what the served page shows. `<x-*>` elements are rendered by the page's own site — `POST /~name/x/preview {page, tag, attrs, page_html?}` on the sites Worker (a look, not a visit: the counter reads instead of counting; CORS open, public data only), `src/x-preview.js` puts the answer into the element on `block-rendered` (cached by tag+attributes+page, re-asked on a save/open, and for a contents list whenever the sections change) — so a Visitor Counter shows the real count, a Folder View the folder's actual pages, Contents the real sections, Last Updated the real date; the model keeps the fallback content (what's written into the page file, what a raw export shows). No editor-only dressing on them: no dotted outline, and the tag badge only while selected. New elements and views should follow this — ask the site for the real thing rather than draw a mock-up; a placeholder only while the answer is on its way or when there's no site to ask (signed out, a copy). Elements that aren't typed into (a folder view, a counter) open their settings on a double-click; the Folder View's folder is a pick from the site's folders (posts folders first, or a new one by name — `BlockProp` type `folder`, `list_site_folders` in my-site.js).

- **Page History** (2026-09-12, Jack: "some interface to move through the delta tree… even if multiple people are live editing the file, or just one") — Edit › Page History… and the globe's site view › History… open `src/page-history.js`: the page's versions from its live room, as a timeline or a tree (indented by depth, like Edit › History's tree mode), each with the editor's color dot, name, what they did, and the time; the version the page is now in bold, its lineage black, other branches gray. Selecting one asks the room for it (`checkout`) and draws a small rendering (bitmap patches replayed, pictures, text, the sections as dashed boxes with their words); **Go to this version** (or Enter, or a double-click) is `restore`: everyone editing the page gets that version and the later ones stay as a branch. A full picture's bands (after a seed, replace, or resize) fold into the version before them. Without a live room (not signed in, a plain picture) the window says where the history lives and offers this copy's History instead — Edit › History stays the local undo tree of this copy.

- **In-place text** — text blocks are `contenteditable`; the Font toolbar (family/size/B/I/U) and the color box apply to the selected words as `<font>`/`<b>`/`<i>`/`<u>` (execCommand with `styleWithCSS=false`, on purpose); the toolbar reflects the formatting at the caret. Links: **one link dialog** (`src/link-dialog.js`, 2026-09-11) for the whole element (Edit › Add Link to Element…, the Link tool: pictures, web text, text boxes — not counters, guestbooks, tables, dividers, raw HTML; `BlockKind.linkable`) and for the selected words of a section (Ctrl+K, the Font toolbar, the Link tool): an Address box, your pages as thumbnail tiles (`src/page-tiles.js`, shared with My Site › Pages; signed out it says so), and a Section list (this page's, or the picked page's). Page properties (background, the sections column) ride on history nodes and in the session sidecar, and the live room keeps the column too.
- **Menus** — File: Sign In to My Site…, My Site… (three tabs — see below), Save to My Site…, Save as Web Page, Save as Animated GIF. Page: Page Properties…, Insert ▸ (every kind), Edit Element Text (Enter), Element Properties…, Edit Element HTML…, Add Link, Bring Forward / Send Backward, Flatten, Delete. View: Layers (text, stickers, blocks, picture), GIF Picker, Live Page.
- **My Site window** (2026-09-11, Jack) — a Windows 98 property sheet with three tabs. **Site**: the globe, `~name` (or the domain for root), the address, and facts — created (when the site got its password, from `/api/whoami`, else the first upload), updated, pages, files, posts folders, how you're signed in — with View Site, Site Style…, Sign Out. **Pages**: every page as a tile (its `collages/<page>.png` bitmap in a 3D frame, name under it, `index.html ★` first — large icons, like a folder of pictures), double-click opens, and a **+** tile at the end makes a new page; Open, View, New Post…, Versions…, Delete below. **Files**: the old folder view (every file, one per line, with the whole toolbar). One selection across Pages and Files. The globe's My Site… and File › My Site… both open on Site.
- **Save** — a page opened from My Site (or saved to it) has `system_file_handle = { site_page }`, so Ctrl+S publishes back to the site; other documents save as files.
- **GifCities** — the GIF picker window (search, grid, click or drag onto the page → sticker); the editor Worker proxies `gifcities.org` (no API, no CORS) and chosen GIFs are copied into the site's `gifs/` on save. **Favorites** (2026-09-13, Jack): a ♥ in the corner of every GIF keeps it in the picker's Favorites tab (`.gif-picker-tab[data-tab=favorites]`, `.gif-heart`); favorites are this browser's — localStorage `jspaint favorite gifs`, by GifCities id (up to 300, newest first), so they're the same GIFs on any editor; the tab counts them and a favorite adds to the page like any result. (Per-account favorites could ride on the `Accounts` DO later.)

## 6. Paint extensions (the Blingee half — phase 1)

Reuse jspaint's primitives rather than replacing them:

- **Sticker layer** — `OnCanvasSticker extends OnCanvasObject`: an animated `<img>` overlay positioned/scaled by `position()` at any magnification, `Handles` for move/resize (as `OnCanvasSelection` does), flip, delete, z-order. Detected on paste/drop: `GIF8` magic + more than one Graphic Control Extension = animated → sticker instead of a rasterized selection. Clipboard reality: copying a GIF from a web page yields a rasterized PNG plus `text/html`; we parse `<img src>` from the HTML item and fetch the GIF (via the Worker when CORS blocks).
- **Text layer** — `OnCanvasTextBox` today rasterizes on commit. Add a persistent mode: the box stays a layer (`<font face>`-style fonts, color, size, optional link), rendered by the browser, only rasterized on "Flatten".
- **Layers window** — list, reorder, hide, flatten. Bitmap stays the base.
- **History** — `gif_layers` / `text_layers` snapshots on history nodes (the `textbox_*` fields are the precedent); blobs in a `Map` by id.
- **Document I/O** — collage ⇄ the §3.3 markup + PNG + GIF blobs. Local save: a folder-ish `.zip` or a single `.html` with data URLs. Later, the same payload is what the editor PUTs to R2.
- **Fonts** — the FontBox offers a fixed web-safe list and nothing from the device: the classic eight (Arial, Comic Sans MS, Courier New, Georgia, Impact, Times New Roman, Trebuchet MS, Verdana) above a separator, then Arial Black, Lucida Console, Lucida Sans Unicode, Palatino Linotype, Tahoma (`WEB_SAFE_FONTS` in `src/$FontBox.js`). It never calls `queryLocalFonts` (2026-09-12: that put a "use fonts on your device?" permission prompt in front of Jack every session), and a page's font outside the list still shows up in the box when its text is edited.

## 7. GIF export

- **Collage → .gif**: decode each sticker's frames (`ImageDecoder` where available, `gifuct-js` fallback), build a common timeline (LCM of frame periods, capped — e.g. ≤ 10 s / ≤ 100 frames, with a note when capped), composite bitmap + stickers + text per frame onto a canvas, encode with the `gif.js` already in `lib/`. Same compositor draws stickers in a static frame for PNG export.
- **Page → .gif**: the same compositor: bitmap, then each block's rasterized copy (an SVG `<foreignObject>` render of its markup — marquees show their first frame), then sticker frames, then text layers. 800px × page height — cap duration/frame rate and warn.

## 8. Import

- Our dialect: lossless by construction.
- Foreign simple HTML (test fixture: the wedding page): top-level children of `<body>`/`<center>` map to blocks when they're known tags (`h1–h6`, `p`, `marquee`, `img`, `table`, `ul`, `audio`), else become raw HTML blocks; images are downloaded into `gifs/`; inline `<style>` is kept as raw. Good enough to bring the wedding page in and keep editing it.

## 9. Security & multi-tenancy — decided: a sandboxed `sites` Worker

User pages are user-authored HTML. They are served by a **separate, deliberately weak Worker** on its own origin:

- **Own origin** (`coolpaint.world`, including the `root` site at `/`), never the editor's (`edit.coolpaint.world`). A page cannot read the editor's cookies or edit secret, full stop.
- **Minimal bindings**: read-only access to the `sites` R2 bucket and the per-site Durable Object used by `<x-*>` renderers. No editor API, no secrets, no write access to R2. If the sandbox is compromised, there is nothing to take but public pages.
- **Content-Security-Policy on every page**: `default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'` (raise `script-src` only for our own optional live-edit snippet, nonce'd — **never for analytics**: published pages carry no scripts and no trackers, on purpose — and `Cache-Control: no-transform` on every page response keeps Cloudflare from injecting its own Web Analytics beacon; product analytics lives on the editor origin only, `worker/shared/analytics.js`). `X-Frame-Options`/`frame-ancestors` so pages can't be framed by the editor for clickjacking, and vice versa.
- **Sanitize on save** in the editor Worker: raw HTML blocks lose `<script>`, `on*=` handlers, `javascript:`/`data:text/html` URLs, `<iframe>`/`<object>`/`<embed>`; `<x-*>` attributes are validated against the registry; guestbook entries are plain text. Sanitize again at serve time (defense in depth; the serve-time pass is cheap).
- **Uploads**: allow-list by magic bytes (gif/png/jpg/webp/mp3/mid/wav), size caps, per-site quota; served with `Content-Type` fixed from the sniffed type and `X-Content-Type-Options: nosniff`.
- **Dynamic actions** (`POST /~name/x/guestbook`) go to the sandbox Worker → DO with rate limits per IP; the editor never proxies user-page traffic.
- **Accounts, minimal** (2026-09-10): each site can have its own random password (80 bits, minted only by the master key `SITE_EDIT_SECRET`), stored as `HMAC-SHA256(SITE_EDIT_SECRET, "site-password:site:password")` in the `Accounts` Durable Object and compared constant-time; it opens that one site (files, invites, rooms). The master key still opens everything. Rotating the master key invalidates every password and invite (re-mint). Open sign-up and Google OAuth come later — an OAuth identity per site can sit next to the hash.
- **Anyone may open any published page in Paint** (`edit.<domain>/~name/page.html`): it opens as a copy, read from the public files API, with no room and no credentials; publishing it back to that address needs that site's password — the copy goes to whatever site you sign in to.
- **Versions** (2026-09-10) — writing a page over keeps the old copy under `versions/` on the site (last 10 per page, with the bitmap each version had, by hash); My Site › Versions… restores one. `versions/` is never served. A brand-new page named like an existing one asks before replacing it.
- **Backups and loading** (2026-09-12) — a session's picture backup is a PNG blob in IndexedDB (`layer-storage.js` `put_backup_image`, beside the layers sidecar) rather than a data URL in localStorage, whose ~5 MB a few big pages filled — which also silently lost the site settings (`save_settings` now clears legacy `image#` entries and retries). Manage Storage lists both. `src/loading-veil.js`: the canvas area shows a Windows-98 "Loading…" panel while a restored session or a fresh visit's page comes in, so the page appears whole (15 s safety timeout).
- **Accounts** (2026-09-12, branch `auth`) — `worker/editor/auth.js` + the `Accounts` DO: users, identities (`google:<sub>` today; email codes, SMS, and passkeys are meant to be more rows of the same table, joined by verified email), sessions (random tokens stored as SHA-256; 90-day HttpOnly SameSite=Lax cookie on the editor origin only), and owners (site → user). `role_of` accepts the session for a site the user owns, next to the master key and site passwords; cookie-authenticated requests must be same-origin (Fetch Metadata / Origin; a cross-site page can't act with the cookie). `GET /auth/google` → Google → `/auth/google/callback` → session → `/?signed_in=1`; `POST /auth/sites {name}` takes a free name; `POST /auth/sites/:name/claim {password}` takes an older site by its password; the owner may mint the site's password. Paint: the Sign In dialog offers the Google button when the editor reports it (`/auth/methods`), an account picks or makes its site, the session rides in the cookie (`authorized()` in site-publish.js), and `root` stays the master key's.
- **Section fixes** (2026-09-12) — pictures inside a section fit the column (`img { max-width: 100% }` in the page CSS); sections re-stack when their contents change height (a `ResizeObserver` on each section's element → `reflow_sections`); `<x-toc>` and the folder view's RSS summaries find sections with `worker/shared/sections.js` (`find_sections`: any attribute order, nested `<div>`s matched by depth) — the old regexes expected `id` after `class` and matched nothing Paint publishes. (The Ghost-style cards experiment lives on the `cards` branch, not in production.)
- **Pictures** (2026-09-11, Jack: portfolios need high-resolution photos) — `src/pictures.js`. A picture put on the page goes to the site right away when signed in: the original under `gifs/<hash>.<ext>` (up to 24 MB), and for a photo bigger than 1200px a page-size copy (`.w1200.jpg`, or `.png` to keep transparency) and a thumbnail (`.w240`). The page shows the copy and links to the full-size original (`<a href><img></a>` in a section's text; a sticker's `href`), so a portfolio loads light and opens sharp. Signed out, a picture in a section's text is inlined as a `data:` URL until the page is saved (then uploaded like a sticker). Addresses in text are the site's public URLs (they work from any folder, in a copy on another site, and for the live room); sticker sources remember their site path (`source.path`), so saving and the live room don't upload them again. The toolbox's **Pictures** tool (was Image) opens the Pictures window: the site's pictures as tiles (click: into the text while writing a section, else a sticker) and Upload….
- **Share links** grant one page, not the site: the key is an HMAC (site, page, expiry) under the edit secret, verified statelessly; a guest can join that page's room and write that page, its bitmap, and hashed media — never delete, never other pages. The secret itself never leaves the owner.

## 10. Phased plan

| Phase | Deliverable | Rough size |
| --- | --- | --- |
| 0 | Repo layout: `desktop/` (shell + editor windows), `worker/` (sites + editor Workers), jspaint stays at root as the Paint app; `PAGE_WIDTH` constant; this doc | ½ day |
| 1 | **Blingee**: sticker + text layers in Paint, layers window, history, collage ⇄ dialect I/O, collage GIF export, local .html/.gif save | 3–4 days |
| 2 | **Hosting skeleton**: `sites` Worker (R2 serve, `~name`), `editor` Worker (save/upload/list, shared secret), My Site window, publish = save | 2 days |
| 3 | **Page elements inside Paint** (revised): the page tools in the toolbox, blocks on the canvas, in-place editing, Page menu, My Site in the File menu, guestbook + music `<x-*>` elements | 4–5 days |
| 4 | **Media + import**: wallpaper upload flow, image maps, HTML import (wedding page as fixture), zip export/import, quotas | 3 days |
| 5 | **Accounts** (magic link or passkeys), quotas, moderation basics | later |

## 11. What carries over from the agent-drive work

- The `Room` Durable Object (live fan-out) grew into `PageRoom` (editor Worker): the same fan-out plus a stored document, versioned ops, and presence — real-time co-editing inside Paint (`src/live-session.js`).
- The in-browser `<foreignObject>` page renderer is the static part of whole-page GIF export.
- Preview-alias deploys and the agent-server's git/wrangler flow were a personal dev tool, removed on 2026-09-10 (in git history); hosted pages are saved to R2, not deployed. The LLM "draw to edit" flow returns later as *AI assist* operating on the dialect.

## 12. Open items

- Product name / eventual domain.
- Reference pages for "looks decent" (Jack to send).
- GifCities proxy (verified 2026-09-09): `GET gifcities.org/search?q=…&offset=N&page_size=M` returns server-rendered HTML; each hit is `<div class="result"><a href="<archived page>"><img width height src="https://blob.gifcities.org/gifcities/<hash>.gif"></a></div>`, so the proxy is a ~40-line HTML→JSON scrape with width/height included. No CORS on search or blobs → everything through the Worker; cache searches in KV; attribute Internet Archive in the window.
- Whole-page GIF caps (duration, fps, max height) — pick defaults once the compositor exists.
- Magnification vs. stickers in Paint: stickers should render crisp (`image-rendering: pixelated`) at zoom like the bitmap does.
