# Site builder Workers

Two Cloudflare Workers (see `docs/DESIGN.md` §4 and §9):

| Worker | URL | Role |
| --- | --- | --- |
| `jspaint-sites` (`sites/`) | `https://jspaint-sites.jklika2.workers.dev/~name/` | **The sandbox.** Serves user pages from the `jspaint-sites` R2 bucket, sanitizes them again, renders `<x-*>` elements server-side (visitor counter, last-updated) from a per-site Durable Object, sends a strict CSP. Read-only bucket access, no secrets. |
| `jspaint-editor` (`editor/`) | `https://jspaint-editor.jklika2.workers.dev/` | The Paint app at `/`, the **site builder desktop at `/desktop/`** (both static assets built into `editor/dist`), and the API: site file CRUD behind a shared secret (reads are public), the `<x-*>` registry listing, and the GifCities proxy. |

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

**File › Save to My Site…** asks for the site name, page name, editor URL and secret, uploads the collage's assets (content-hashed into `gifs/`, the bitmap into `collages/`) and the page, and shows the public URL.

## Adding an `<x-*>` element

Create `shared/x-elements/<name>.js` exporting `{ tag, attrs, editor: { label, description, fallback }, render({ attrs, context }) }` and add it to the list in `shared/x-elements/index.js`. `render` returns inner HTML (dialect-safe); the page keeps the tag around it so it re-imports. State goes through `context.state` (the site's `SiteState` Durable Object in `sites/index.js`).
