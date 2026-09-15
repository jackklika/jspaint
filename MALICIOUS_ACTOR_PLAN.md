# Malicious and buggy actors — the plan

Assume people will try to break coolpaint.world: to burn its Cloudflare budget, to use it as free file hosting, to
publish phishing pages, to spam guestbooks, or simply because a client of ours has a bug that does the same thing
by accident. This plan lists what such an actor can do today, what it costs or harms, and the change that stops it,
in the order to build. Every mitigation is sized so that a person painting normally never notices it.

Status: **plan only** (2026-09-14). Nothing below is built yet. Facts about the current code carry file references so
each item can be checked before it is started.

## Principles

1. **Budgets are shared.** One Durable Object (DO) rows-read budget, one rows-written budget, one request budget for
   every site. One actor over the line takes everyone down, as the free-tier outage did on 2026-09-14. Protecting
   the budget is the first job; protecting content is the second.
2. **The origin is shared.** Every site lives under `coolpaint.world/~name/`. The server-side sanitizer
   (`worker/shared/sanitize.js`) is the only wall between sites and their visitors. No script, ever, from any site.
3. **Ten times human speed.** Nobody makes more than three strokes a second, publishes more than once a second, or
   signs a guestbook more than once a minute. Limits sit an order of magnitude above that, so only scripts hit them.
4. **Degrade, never disconnect, never lose work.** Over a limit, the server drops or delays the excess and says so
   once. The client keeps painting locally, keeps its local session (`#local:<id>`), and retries. Work is never lost
   to a limit.
5. **See it in PostHog.** Every limit hit, quota refusal, and disable is an event, so an attack is visible as it
   starts and a false positive on a real person is visible too.
6. **Fail soft as a whole.** A global read-only switch keeps every page serving and every editor drawing locally
   while writes are paused during an incident.

## What already protects us

- Guestbook: 30 s between posts and 20 a day per visitor, 2000 entries per site, name and message length caps,
  same-origin form posts only (`worker/sites/index.js` `GUESTBOOK_*`, `handle_action`, `add_guestbook_entry`).
- Pages are sanitized on write (editor `PUT`) and again on read (sites `serve_page`); uploads are size-capped at
  24 MB, images and audio are sniffed, `site.json` is capped at 64 KB (`worker/editor/index.js` `handle_site_files`).
- Rooms: 16 clients, 900 KB messages, 3 MB patches, 500 versions and 48 MB of history per page, op items capped
  (`worker/editor/page-room.js` `MAX_*`). The room only relays presence and strokes; it never stores them.
- Accounts: 5 sites per account (`worker/editor/auth.js` `MAX_SITES`); sessions are random 256-bit tokens stored as
  hashes; OAuth state and `safe_next` checks; cookie requests must be same-origin (`cookie_request_allowed`).
- Invite keys are HMAC-signed and may only write their own page plus hashed media (`invite_may_write`).
- The GifCities GIF relay is cached at the edge for a day (`cf: { cacheTtl, cacheEverything }`).
- Live clients reconnect with exponential backoff up to 30 s (`src/live-session.js` `socket.onclose`).
- Server failures reach PostHog as `$exception` and never show detail to users (`worker/shared/exceptions.js`).
- Master-only debug and password routes use constant-time comparison (`same_string`).

## Threat model

Cost figures are Workers Paid overage: $1.00 per million DO rows written, $0.15 per million DO requests, incoming
WebSocket messages metered at 20 messages per request, outgoing free.

| # | Actor and action | Cost or harm today | Mitigation | Phase |
|---|---|---|---|---|
| T1 | Anyone, loops `POST /api/gifs/used` | 2 row writes per call, no auth, no limit (`GifStats.record`) | Require a session or site token; tally in memory and flush by alarm; per-IP limit | 0 |
| T2 | Anyone, loops `GET /api/sites/:name/presence` | 1 R2 list plus up to 50 DO requests per call, one per page room (`worker/editor/index.js` `presence_match`) | Per-isolate cache of 10 s per site; per-IP limit; cap pages consulted at 20 | 0 |
| T3 | Anyone, loops `GET /~name/x/stats.json` | Two `COUNT(DISTINCT)` queries over the day's view rows per call, so rows read scale with the site's traffic (`SiteState.viewers`) | Per-isolate cache of 5 s; `Cache-Control: max-age=5`; per-IP limit | 0 |
| T4 | Anyone, loops `POST /~name/x/preview` | Sanitize plus render of up to 512 KB HTML, folder previews list R2, CORS open (`handle_preview`) | Origin must be the editor or the sites host; per-IP limit; keep the body caps | 0 |
| T5 | Crawler or `curl` loop on pages | 2 row writes per view (`record_view` and `hit`), plus R2 read and render | Batch view writes in SiteState memory, flush by alarm; count at most one view per IP per page per minute via the rate-limit binding; skip known crawler user agents | 0 |
| T6 | Owner or guest scripts the room | 2 row writes per patch, one DO request per 20 messages, at any rate the socket allows | Per-connection token bucket in PageRoom; `slow-down` message, then a close after repeated abuse; per-account daily room-write budget | 0 then 1 |
| T7 | Connect storm, malicious or a reconnect bug | Each upgrade is a DO request plus a full snapshot sent (`PageRoom.fetch`, `hello`) | Per-IP and per-session limit on the rooms upgrade route; the client's backoff stays | 0 |
| T8 | Password guessing against legacy site tokens | Unlimited `Authorization: Bearer <guess>` attempts at full speed | Per-IP limit on failed authorizations (401s); a hit is a PostHog event | 0 |
| T9 | Free file hosting | 24 MB per file, unlimited files per site, every HTML overwrite archives a copy and every bitmap change keeps a PNG under `versions/bitmaps/` (`archive_before_overwrite`) | Per-site quota in bytes and files, guest uploads charged to the owner, bitmap archive cap per page | 1 |
| T10 | Account farming | 5 sites per Google account, unlimited accounts | Sites per account stays; add a global new-sites-per-hour alert and a soft cap that asks for the master key above it | 1 |
| T11 | Phishing, impersonation, spam sites | `paypal-login`, `google`, SEO pages full of links; nothing stops it after sanitization | Reserved-name list; Report link on every page footer and 404; per-site `disabled` flag checked when serving; `rel="nofollow ugc"` on outbound links; `noindex` for a site's first day | 2 |
| T12 | Leaked invite key | Signed with the global edit secret, so revoking one means rotating every key on the platform (`invite_signature`) | Per-page nonce in the room, included in the signature; a Revoke button in Share | 2 |
| T13 | Room member spoofs another's `client_id` | `hello` accepts any `client_id`, which drives cursors and block locks | Server assigns the id; the client's is only a reconnect hint matched against the attachment | 2 |
| T14 | Anyone relays GifCities through us | Search results are Worker-generated, so `gifcities_search` fetches upstream per distinct query; GIFs are edge-cached | Cache search results with the Cache API for an hour; per-IP limit on search | 2 |
| T15 | Our own bug, e.g. a patch per mouse move | Looks exactly like T6 | T6 catches it; `$exception` and the `rate_limited` event name the client build | 0 |
| T16 | Platform incident, budget nearly gone | Silent until people notice, as on 2026-09-14 | Read-only switch; daily budget alarm from the GraphQL analytics | 3 |

## The tool: Cloudflare's Rate Limiting binding

Free, no storage, declared in each `wrangler.jsonc`:

```jsonc
"ratelimits": [
	{ "name": "LIMIT_IP_10S", "namespace_id": "1001", "simple": { "limit": 60, "period": 10 } },
	{ "name": "LIMIT_IP_60S", "namespace_id": "1002", "simple": { "limit": 300, "period": 60 } },
	{ "name": "LIMIT_VIEWS", "namespace_id": "1003", "simple": { "limit": 1, "period": 60 } },
	{ "name": "LIMIT_AUTH_FAIL", "namespace_id": "1004", "simple": { "limit": 20, "period": 60 } }
]
```

```js
const { success } = await env.LIMIT_IP_60S.limit({ key: `gifs-used:${ip}` });
```

Caveats from the docs: `period` is 10 or 60 seconds only; limits are per Cloudflare location and eventually
consistent, so they are a brake, not an accounting system. That is what we want here. Accounting (quotas, daily
budgets) lives in Durable Objects, where it is exact.

Shared helper, new file `worker/shared/limits.js`:

- `limited(binding, key)` → boolean; on a hit, emits a sampled `rate_limited` PostHog event `{ key_kind, worker,
  route }` through `worker/shared/analytics.js` (never the raw IP; hash it as `record_view` already does).
- `too_many(retry_after_s)` → `429 { error: "Slow down a little and try again.", code: "rate-limited" }` with
  `Retry-After`; HTML variant for the sites Worker in the same plain style as the "Back soon" page.
- `client_ip(request)` → `CF-Connecting-IP` or `"unknown"`.

Zone-level, set in the dashboard (no code): Bot Fight Mode on the `coolpaint.world` zone; the one free WAF
rate-limiting rule on `edit.coolpaint.world/api/*` at something generous like 600 requests per minute per IP.

## Phase 0 — stop the budget burns (small, this week)

Each item is a few lines behind the helper above. Ship together with the bindings.

1. **`POST /api/gifs/used`** (`worker/editor/index.js` ~692): require `session_of` or a site token; refuse others
   with 401. In `GifStats` (`worker/editor/gif-stats.js`), `record()` adds to an in-memory `Map<gif|site, count>`
   and sets an alarm 60 s out; the alarm writes each tally as one `ON CONFLICT` row. Per-IP limit through
   `LIMIT_IP_60S` at 60 a minute. Rows written drop from two per click to two per GIF per minute across everyone.
2. **`GET /api/sites/:name/presence`** (~735): a module-level `Map<site, { at, body }>` returning the cached body
   for 10 s; cap the pages consulted at 20 (the globe only needs a count); `LIMIT_IP_10S` per IP. The globe's
   refresh (`src/site-button.js` `refresh`) already coalesces, so no client change.
3. **`GET /~name/x/stats.json`** (`worker/sites/index.js` ~394): same 5 s cache and `Cache-Control: public,
   max-age=5`; `LIMIT_IP_10S`. Consider a `viewers_cache` row in `SiteState` refreshed at most every 5 s so the
   two `COUNT(DISTINCT)` queries run once per period, not per call.
4. **`POST /~name/x/preview`** (`handle_preview`): require `Origin` to be the editor origin (the sites Worker
   knows `EDITOR_URL`) or the sites host itself; `LIMIT_IP_60S` at 120 a minute; reduce the CORS allow-origin from
   `*` to the editor origin.
5. **Page views** (`serve_page`): before `record_view`, `LIMIT_VIEWS.limit({ key: `${ip_hash}:${site}:${page}` })`
   so a reload loop counts once a minute; skip `record_view` when the user agent matches a short crawler list
   (`bot|crawl|spider|slurp|facebookexternalhit|preview`). In `SiteState`, `record_view` and `hit` add to memory
   and an alarm flushes every 15 s: `views` rows become one insert per visitor per flush and `counters` one
   `UPDATE` per page per flush. `viewers()` reads the flushed table plus the in-memory delta so the globe stays live.
6. **Room token bucket** (`worker/editor/page-room.js` `webSocketMessage`): a `Map<WebSocket, { tokens, at,
   strikes }>` refilled at 30 tokens a second with a burst of 120 for all messages, and a second bucket of 10 a
   second for `patch`, `ops`, `restore`, `label`. Over budget: drop the message and send
   `{ type: "slow-down", retry_in_ms }` once per second at most. Ten drops in a minute is a strike; three strikes
   close the socket with code 1013 and reason `"slow down"`, which the client treats as a normal reconnect with
   its backoff, not as a refusal. Presence and stroke pieces are the first to be dropped since they are
   ephemeral; patches are never dropped, only delayed, so no work is lost.
7. **Rooms upgrade route** (~656): `LIMIT_IP_60S` at 60 connects a minute per IP and, when a session is present,
   per session id.
8. **Failed authorizations**: wherever `role_of` returns null for a request that carried a `Bearer` or `?token=`
   (`worker/editor/index.js` ~148, `bearer_of`), count on `LIMIT_AUTH_FAIL` per IP; over the limit, answer 429
   before touching the Accounts object. Same for `invite_valid` failures.
9. **Client side** (`src/live-session.js`): handle `slow-down` by pausing presence and stroke streaming for
   `retry_in_ms`, keeping patches queued; show the status-area text "Syncing a little slower…" once. Handle 429 from
   `api()` in `src/my-site.js` and `site-publish.js` by retrying once after `Retry-After`, then the plain message.

Tests: `test/site-builder/rate-limits.test.mjs` (Node, WebSocket): 300 presence messages in a burst produce a
`slow-down` and no disconnect; 300 patches are all applied, spread out; a flood of `POST /api/gifs/used` without a
session is 401; `x/preview` from a foreign `Origin` is 403; `/presence` twice within 10 s hits the cache (assert
via a header `X-Cache: hit`). `wrangler dev` supports `ratelimits` bindings locally; if a binding is missing in a
test environment the helper treats it as unlimited so the rest of the suite is unaffected.

## Phase 1 — quotas (exact accounting in Durable Objects)

1. **Per-site storage quota.** `Accounts` gains a `usage` table `(site, bytes, files, updated)`. `handle_site_files`
   adjusts it on `PUT` (new size minus the old object's size, from the `head` it already effectively does in
   `archive_before_overwrite`) and `DELETE`. Limits: 200 MB and 1000 files per site by default, raised per site by
   the master key (`POST /api/sites/:name/quota`). Over the limit: `413 { error: "This site is full (200 MB). Delete
   something in My Site to make room.", code: "quota" }`. A `GET /api/sites/:name/usage` feeds a bar in My Site.
   A nightly rebuild from an R2 listing corrects drift.
2. **Archive caps.** `prune_versions` already keeps `VERSIONS_KEPT` HTML versions and their referenced bitmaps; add
   a cap of 20 bitmap archives per page regardless, and count archives toward the site's quota so an author who
   publishes a 3 MB bitmap 500 times pays for it in their own bar, not the platform's.
3. **Guest uploads** through invite keys count against the owner's site and are capped at 32 MB a day per key.
4. **Room write budget.** `PageRoom.record()` counts versions per UTC day in `doc.writes_today`; over 5000 a day per
   page, the room answers patches with `slow-down` for the rest of the day and the client keeps working locally.
   Five thousand is about ten hours of continuous painting by a fast human.
5. **Publish rate.** `PUT` on HTML paths: `LIMIT_IP_10S` at 20 per 10 s per site, since a publish uploads several
   files at once.
6. **Site creation velocity.** In `/auth/sites` (`auth.js` ~251) count global creations in `Accounts` per hour; above
   50 an hour, emit `site_creation_surge` to PostHog and require the master key until the hour passes. Existing users
   are unaffected; a bot farm is stopped at the door.

## Phase 2 — content and access abuse

1. **Reserved names** in `worker/shared/names.js`: a list (`admin, login, signin, account, api, www, mail, support,
   help, security, paypal, google, apple, microsoft, facebook, instagram, coolpaint, root…`) refused by
   `valid_site_name` for new claims; existing sites are unaffected. Also refuse names containing `login`, `signin`,
   `verify`, `wallet`.
2. **Report a site.** Every served page gets a one-line footer link `Report this page` to `/~name/x/report`, also on
   the 404 page. The action stores `(site, page, reason, ip_hash, created)` in `SiteState`, rate-limited to 3 a day
   per visitor, and emits `site_reported` to PostHog with site and page so you see it in the activity feed.
3. **Disable a site.** `SiteState` gains `disabled INTEGER` set by `POST /~name/x/moderate {disabled}` with the master
   key on the sites Worker. `serve_page` checks it in the same DO call that records the view (it becomes one call in
   the caching plan) and answers a plain "This site is unavailable" page with 451. The editor's publish of a disabled
   site is refused with a plain message. Undo is the same route with `disabled: false`.
4. **Links.** The sanitizer sets `rel="nofollow ugc noopener"` on every `<a href>` whose host is not
   `coolpaint.world`, and strips `target` values other than `_blank`. Removes the SEO value of spam pages without
   changing how they look.
5. **New sites are `noindex` for a day.** `SiteState` records `first_published` on the first generation bump;
   `serve_page` adds `X-Robots-Tag: noindex` while younger than 24 h. Search engines still find real sites a day
   later; a spam site seeded and abandoned never gets indexed.
6. **Revocable invites.** `PageRoom` stores `doc.invite_nonce` (random, created on demand). `make_invite` and
   `invite_valid` include it in the HMAC message, fetched from the room by a `nonce()` RPC and cached per isolate for
   a minute. A `POST …/rooms/:page/invite/revoke` sets a new nonce; the Share dialog gets a "Revoke all share links"
   button. Existing keys keep working until the first revoke, since a missing nonce hashes as today.
7. **Server-assigned client ids.** `hello` ignores the client's `client_id` except to match a reconnect against the
   attachment it already holds; presence and locks use the server's id.
8. **Guestbook Turnstile**, only if spam appears despite the cooldowns: Cloudflare Turnstile is free; the widget is a
   plain `<div>` the sanitizer would need to allow on the sites host only.

## Phase 3 — resilience and operations

1. **Read-only switch.** `Accounts` holds `settings.read_only`, set by `POST /api/admin/read-only {on, message}` with
   the master key, read by both Workers once a minute per isolate (the sites Worker asks the editor Worker's public
   `GET /api/status`, cached). When on: pages serve, rooms accept connections and relay presence, but `patch`,
   `ops`, `PUT`, `DELETE`, guestbook posts answer `{ code: "read-only", error: message }` and the client shows the
   message once in the status area and keeps every change in its local session for when it lifts.
2. **Budget alarm.** A scheduled Worker (cron, hourly) queries the GraphQL `durableObjectsPeriodicGroups` for the
   day's rows read, rows written, and requests per namespace, and posts `budget_check` to PostHog with the
   percentages; at 70 % and 90 % of the plan it posts `budget_warning`. PostHog alerts can then email or page you.
   The same numbers appear on a small admin page (`/api/admin/usage`, master key) so the tier explanation in
   `docs/DEPLOY.md` stays checkable.
3. **Abuse dashboard in PostHog.** Events from this plan: `rate_limited`, `quota_exceeded`, `site_reported`,
   `site_disabled`, `site_creation_surge`, `budget_warning`, `read_only_changed`. One insight per event, grouped by
   `key_kind` or `site`, is enough to spot an attack or a false positive.
4. **Kill switch for a single site's rooms.** `PageRoom` honors `disabled` too, closing sockets with 1008 and the
   plain message, so a site being abused live can be stopped without a deploy.

## Keeping the experience good

| Action | A fast human | The limit | What they see over it |
|---|---|---|---|
| Strokes | 3 a second | 10 patches a second per connection | Nothing; the excess is queued a moment |
| Presence and stroke pieces | 10 messages a second after the presence fix | 30 a second, burst 120 | A slightly less live cursor for a second |
| Room connects | 1 per page open | 60 a minute per IP | "Reconnecting…" a little longer |
| Publishes | 1 every few minutes | 20 uploads per 10 s per site | "Slow down a little and try again." |
| Guestbook | 1 a day | 1 per 30 s, 20 a day (today) | The existing polite refusal |
| GIF clicks | 1 every few seconds | 60 a minute per IP | Stats not counted; the GIF still lands |
| Page reloads by one visitor | a few | 1 counted view a minute | The counter does not tick on a reload |
| Storage | tens of MB | 200 MB, 1000 files per site | A clear "site is full" with the bar in My Site |

Rules for every limit: the message is plain, says what to do, and never shows detail; the client retries once on
its own before showing anything; local work is never discarded; and the master key can raise any cap per site or
account without a deploy.

## Order and size

| Phase | Files | Size | Deploy |
|---|---|---|---|
| 0 | `worker/shared/limits.js` (new), `worker/editor/index.js`, `page-room.js`, `gif-stats.js`, `worker/sites/index.js`, both `wrangler.jsonc`, `src/live-session.js`, `src/my-site.js`, `src/site-publish.js`, `docs/DESIGN.md`, `docs/DEPLOY.md` | ~350 lines, one to two days | Both Workers |
| 1 | `worker/editor/accounts.js`, `auth.js`, `index.js`, `page-room.js`, `src/my-site.js` (usage bar) | ~300 lines, two days | Editor |
| 2 | `worker/shared/names.js`, `sanitize.js`, `worker/sites/index.js`, `worker/editor/page-room.js`, `index.js`, `src/share-preview.js` or the Share dialog | ~350 lines, two to three days | Both |
| 3 | new `worker/admin/` cron Worker or a cron trigger on the editor, `accounts.js`, both Workers' status checks, client status handling | ~250 lines, one to two days | Both, plus a cron trigger |

Phase 0 before the paid plan's first real traffic; phase 1 before any public launch; phases 2 and 3 as the first
reports and the first budget scare arrive, which they will.

## Related

- `docs/DESIGN.md` §9 (server errors) and the caching plan for published pages: the per-view DO call this plan adds
  (`disabled`, batched views) is the same call the cache design keys on, so build them together.
- `REFACTOR.md`: the auth helpers (`role_of`, `session_of`) this plan wraps are the ones slated for the signed
  session cookie; do the token bucket and the limits first, the cookie after, so limits do not depend on the
  cookie's shape.
