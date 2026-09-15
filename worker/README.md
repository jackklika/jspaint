# Site builder Workers

Two Cloudflare Workers (see `docs/DESIGN.md` §4 and §9):

| Worker | URL | Role |
| --- | --- | --- |
| `jspaint-sites` (`sites/`) | `https://coolpaint.world/` (the `root` site) and `https://coolpaint.world/~name/` | **The sandbox.** Serves user pages from the `jspaint-sites` R2 bucket, sanitizes them again, renders `<x-*>` elements server-side (visitor counter, last-updated, guestbook, music, folder view, contents) from a per-site Durable Object, handles `POST /~name/x/guestbook` and `POST /~name/x/preview` (one element rendered for the editor's canvas — a look, not a visit), serves clean addresses (`/~name/about` → `about.html`; a folder's bare address → its slash) and a site's own `404.html` as its not-found page, sends a strict CSP. Read-only bucket access, no secrets. |
| `jspaint-editor` (`editor/`) | `https://edit.coolpaint.world/` (`/~name` opens that site in Paint) | The Paint app — which is the whole site builder — at `/` (static assets built into `editor/dist`), the API: site file CRUD (reads are public; writes need the master key `SITE_EDIT_SECRET` or that site's password — random, minted by the master with `POST /api/sites/:name/password`, stored only as a keyed hash in the `Accounts` Durable Object, `GET /api/whoami?site=` checks one), the `<x-*>` registry listing, the GifCities proxy — and the **live rooms**: a `PageRoom` Durable Object per page (`page-room.js`) at `GET /api/sites/:name/rooms/:page?token=<secret>` (WebSocket) holding the shared draft everyone editing that page sees — and its **history**: every change as a version with who/when/what and its parent; `history` lists them, `checkout {id}` rebuilds one, `restore {id}` makes it the page for everyone (the next change branches from it; nothing is deleted). **Share keys**: `POST …/rooms/:page/invite` (owner) mints `{ key, expires }`; a guest joins the room with `?invite=<key>` and saves that page with `Authorization: Invite <key>` + `X-Invite-Page: <page>` (writes limited to the page, its bitmap, its `previews/` card, `gifs/`, `midi/`). **GIF usage**: `POST /api/gifs/used {gif, site?}` tallies a GifCities id per site and overall in the `GifStats` Durable Object (SQLite); `GET /api/gifs/top?site=&limit=` lists the most used (site omitted = everyone) — the raw material for "top GIFs". **Link previews**: `GET /?join=<site>/<page>/<key>` (the share link) serves Paint with Open Graph / Twitter tags for that page — `previews/<page>.png` (the card Paint uploads when sharing, saving, and while drawing), else `collages/<page>.png`, else the app icon — so messaging apps unfurl the current picture. Keys are HMAC-SHA256 of site, page, and expiry day under the edit secret, so they're stateless and don't reveal it. |

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

## Domain

`coolpaint.world` is a zone on the account; both Workers use **Custom Domains** in their `wrangler.jsonc` `routes` (`coolpaint.world` + `www` + the former `sites.` → sites, `edit.coolpaint.world` → editor), so `wrangler deploy` creates the DNS records and certificates. **A hostname must never be listed in both configs**: wrangler treats the list as the Worker's complete set and, without a TTY, silently re-points a hostname listed for another Worker. Old hostnames (`*.workers.dev`, `www`, `sites.`) 301 to the domain; `coolpaint.world/?join=…` (old share links) 302 to the editor. Canonical URLs come from the `EDITOR_URL` / `SITES_URL` vars and `src/site-constants.js`; the pages must stay on a different origin from the editor (sandbox, docs/DESIGN.md §9).

## Site passwords

`npm run site-password <site>` (in `worker/`; `--delete` to revoke; `--editor http://localhost:8787` for local dev) mints a random password for a site with the master key and writes it to `editor/.passwords/<site>.txt` (gitignored) — it is never printed. Sign in in Paint with the site name and that password. The master key opens every site and is the only thing that can mint. The `root` site is the domain itself: `npm run site-password root`, then sign in as `root`.

## Analytics (editor app only — published pages have no trackers)

Set `POSTHOG_API_KEY` as a **dashboard Secret** on `jspaint-editor` (Workers & Pages → jspaint-editor → Settings → Variables and Secrets), or from `worker/` with `npx wrangler secret put POSTHOG_API_KEY -c editor/wrangler.jsonc`, to a PostHog project's **client** key (`phc_…` — the public one by design). `POSTHOG_HOST` (a wrangler.jsonc var) is the api_host — currently **`https://sec.coolpaint.world`, PostHog's managed reverse proxy** (events and SDK assets route through it; the bootstrap then follows PostHog's proxy snippet: `ui_host` so SDK links point at the real app, CORS-mode loader; `POSTHOG_UI_HOST` overrides the `https://us.posthog.com` default for an EU project). The editor Worker injects the bootstrap into the app shell (`/` and `/index.html`) and the share-landing page at serve time: autocapture pageviews (anonymous `distinct_id` — who), sessions (how long), and app events via `track_app_event()` (`src/app-analytics.js`): `gif_picker_opened`, `gif_search { query, append, site }` (user searches only — the starter search on open isn't one), and **every "Internal application error" dialog via `posthog.captureException`** (uncaught or unhandled rejection, with `error_kind`) — Error tracking needs the metadata `captureException` attaches (`$exception_list` & co.; a hand-rolled `capture("$exception")` ingests but never shows in the Errors tab — posthog-js warns about this), so it's the SDK method, exactly once per user-visible error. No key = fully off.

**Published pages (`sites.coolpaint.world/~name`) never carry scripts or trackers** — that's the product's privacy posture (DESIGN.md §9): the sites Worker's CSP stays `script-src` closed (it even blocks Cloudflare's own RUM beacon), and nothing is injected there, ever.

## Server-side events and Discord notifications

The editor Worker also captures product events server-side (`capture_event` in `worker/editor/auth.js`, using the `POSTHOG_API_KEY` secret, kept alive past the response with `ctx.waitUntil`): **`signup`** when `sign_in_identity` creates a user, **`site_claimed`** when a `~name` is claimed. In PostHog, two **Discord destination Hog Functions** post to a Discord webhook — [signups](https://us.posthog.com/project/602512/functions/01a09caa-daa6-0000-6ebb-ce26644764d7) (`signup`, `site_claimed`) and [exceptions](https://us.posthog.com/project/602512/functions/01a09cb9-5f50-0000-4469-918306a7d845) (`$exception`). Paste a webhook URL (Server Settings → Integrations → Webhooks) into their `webhookUrl` inputs and enable. Notifications for other events are another Hog Function on a filter — no code changes.

## Publishing from Paint

**File › Sign In to My Site…** (site name + edit secret), then **File › My Site…** to open, create, upload, or delete pages and files, and **File › Save to My Site…** (or Ctrl+S on a page that came from the site) uploads the page's assets (content-hashed into `gifs/`, the bitmap into `collages/`) and the page, and shows the public URL.

## Adding an `<x-*>` element

Create `shared/x-elements/<name>.js` exporting `{ tag, attrs, editor: { label, description, fallback }, render({ attrs, context }), action?({ form, context }) }` and add it to the list in `shared/x-elements/index.js`. `render` returns inner HTML (dialect-safe); the page keeps the tag around it so it re-imports. `action` (optional) handles `POST /~name/x/<name>` from a form the render emitted and returns `{ status, location }` or `{ status, error }`. State goes through `context.state` (the site's `SiteState` Durable Object in `sites/index.js`). Paint picks the new element up from `/api/x-elements` (label, fallback, attributes) and lists it under Page › Insert; give it a toolbox tool in `src/page-tools.js` if it deserves one.
