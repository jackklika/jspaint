# Site builder Workers

Two Cloudflare Workers (see `docs/DESIGN.md` §4 and §9):

| Worker | URL | Role |
| --- | --- | --- |
| `jspaint-sites` (`sites/`) | `https://jspaint-sites.jklika2.workers.dev/~name/` | **The sandbox.** Serves user pages from the `jspaint-sites` R2 bucket, sanitizes them again, renders `<x-*>` elements server-side (visitor counter, last-updated, guestbook, music) from a per-site Durable Object, handles `POST /~name/x/guestbook`, sends a strict CSP. Read-only bucket access, no secrets. |
| `jspaint-editor` (`editor/`) | `https://jspaint-editor.jklika2.workers.dev/` | The Paint app — which is the whole site builder — at `/` (static assets built into `editor/dist`), the API: site file CRUD behind a shared secret (reads are public), the `<x-*>` registry listing, the GifCities proxy — and the **live rooms**: a `PageRoom` Durable Object per page (`page-room.js`) at `GET /api/sites/:name/rooms/:page?token=<secret>` (WebSocket) holding the shared draft everyone editing that page sees. |

`shared/` holds what both use: name/path validation, the HTMLRewriter sanitizer, and the `<x-*>` registry (`shared/x-elements/`, one file per element).

## Commands (run in this directory)

```sh
npm install                    # wrangler
npm run dev:sites              # http://localhost:8788 (local R2 + DO in .wrangler/state)
npm run dev:editor             # http://localhost:8787 (builds editor/dist first); put SITE_EDIT_SECRET in editor/.dev.vars
npm run deploy                 # both Workers
wrangler secret put SITE_EDIT_SECRET -c editor/wrangler.jsonc
```

One-time: `wrangler r2 bucket create jspaint-sites`.

## Publishing from Paint

**File › Sign In to My Site…** (site name + edit secret), then **File › My Site…** to open, create, upload, or delete pages and files, and **File › Save to My Site…** (or Ctrl+S on a page that came from the site) uploads the page's assets (content-hashed into `gifs/`, the bitmap into `collages/`) and the page, and shows the public URL.

## Adding an `<x-*>` element

Create `shared/x-elements/<name>.js` exporting `{ tag, attrs, editor: { label, description, fallback }, render({ attrs, context }), action?({ form, context }) }` and add it to the list in `shared/x-elements/index.js`. `render` returns inner HTML (dialect-safe); the page keeps the tag around it so it re-imports. `action` (optional) handles `POST /~name/x/<name>` from a form the render emitted and returns `{ status, location }` or `{ status, error }`. State goes through `context.state` (the site's `SiteState` Durable Object in `sites/index.js`). Paint picks the new element up from `/api/x-elements` (label, fallback, attributes) and lists it under Page › Insert; give it a toolbox tool in `src/page-tools.js` if it deserves one.
