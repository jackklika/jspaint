# Deploying coolpaint.world

How the live site gets updated. It works well; keep doing it this way. (Written 2026-09-11.)

## What runs where

| Worker | Config | Hostnames | Serves |
| --- | --- | --- | --- |
| `jspaint-sites` | `worker/sites/wrangler.jsonc` | `coolpaint.world`, `www.`, `sites.` (custom domains) | the published pages from the R2 bucket `jspaint-sites` (`sites/<name>/…`; `root` at `/`, others at `/~name/`), RSS, `site.css`, the `<x-*>` elements |
| `jspaint-editor` | `worker/editor/wrangler.jsonc` | `edit.coolpaint.world` (custom domain) | Paint itself (static assets built into `worker/editor/dist`) plus the API: files, versions, passwords (`Accounts` DO), live rooms (`PageRoom` DO), GIF stats (`GifStats` DO) |

Both Workers share the bucket and the code under `worker/shared/`. The zone `coolpaint.world` is on the same Cloudflare account, so custom domains (DNS + certificates) are created by the deploy itself.

## The routine

From the repo root:

```sh
npm run lint                                   # eslint + tsc + cspell
# run the site-builder tests against local Workers (see "Testing" below)
cd worker
npm run deploy                                 # = deploy:sites, then deploy:editor
```

- `deploy:sites` = `wrangler deploy -c sites/wrangler.jsonc`.
- `deploy:editor` = `node build-editor.mjs` (copies Paint's files into `editor/dist` — the `DEFAULT_*` URLs in `src/site-constants.js` are baked in, so always rebuild) then `wrangler deploy -c editor/wrangler.jsonc`. Assets are content-hashed; only changed files upload.
- Deploy only what changed: a client-only change needs `npm run deploy:editor`; a change under `worker/shared/` needs both.
- Wrangler prints the version id and the hostnames it attached. A transient `fetch failed` from wrangler means retry that one script.
- Secrets never go through git: `SITE_EDIT_SECRET` (the master key) is a Worker secret on `jspaint-editor` (`npx wrangler secret put SITE_EDIT_SECRET -c editor/wrangler.jsonc`; the value is kept in the gitignored `worker/editor/.secret.txt`); locally it lives in the gitignored `worker/editor/.dev.vars`. Site passwords are minted with `npm run site-password <site>` and written to the gitignored `worker/editor/.passwords/<site>.txt` — never printed.
- Optional: `SESSION_SIGNING_KEY` signs the hour-long claims cookie that spares the Accounts object a lookup per request (docs/DESIGN.md §9). Without it the key is derived from `SITE_EDIT_SECRET`, so nothing needs setting; set one (`npx wrangler secret put SESSION_SIGNING_KEY -c editor/wrangler.jsonc`, any long random string) to be able to rotate it on its own — a rotation only costs every signed-in browser one session lookup.
- Quotas and brakes (MALICIOUS_ACTOR_PLAN.md): a site holds 200 MB / 1000 files by default. Raise one with the master key: `curl -X POST https://edit.coolpaint.world/api/sites/<name>/quota -H "Authorization: Bearer $(cat worker/editor/.secret.txt)" -H "Content-Type: application/json" -d '{"bytes": 1073741824, "files": 5000}'` (null puts a default back); `GET …/usage?recount` lists the bucket and shows what it holds. The rate limits live in each `wrangler.jsonc` under `ratelimits` (change a number, deploy); hits show up in PostHog as `rate_limited` events by `kind`.
- Durable Object classes need a migration entry in `worker/editor/wrangler.jsonc` (`migrations`: v1 `PageRoom`, v2 `GifStats`, v3 `Accounts`); add a new tag for a new class, never edit an old one.

## Sign in with Google (once)

The editor's Google sign-in (`worker/editor/auth.js`) needs an OAuth client from the Google Cloud console — `gcloud` can't make this kind (its `iam oauth-clients` are Workforce Identity clients for an organization's own users). Project `coolpaintworld`, account `jack@silversense.org`:

1. **APIs & Services → OAuth consent screen** (Google Auth Platform): audience **External**; app name "coolpaint.world", support email, developer contact; scopes `openid`, `email`, `profile` only (no verification needed for those); then **Publish** it out of testing mode (one click; testing mode allows only 100 listed test users).
2. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**: authorized JavaScript origin `https://edit.coolpaint.world`; authorized redirect URI `https://edit.coolpaint.world/auth/google/callback` (add `http://localhost:8787/auth/google/callback` to sign in against a local editor with the real Google).
3. Put the client ID in `worker/editor/wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID` (it's public), and the secret in the Worker: `cd worker && npx wrangler secret put GOOGLE_CLIENT_SECRET -c editor/wrangler.jsonc`. Deploy the editor. `GET https://edit.coolpaint.world/auth/methods` says `{"google":true}` when it's on; with the ID empty the button simply doesn't show.

**Handing a site to an account** (root included), once that person has signed in with Google at least once:

```sh
curl -X POST https://edit.coolpaint.world/auth/sites/<site>/assign -H "Authorization: Bearer $(cat worker/editor/.secret.txt)" -H "Content-Type: application/json" -d '{"email":"person@example.com"}'
```

Who owns a site (and whether several accounts share that email):

```sh
curl https://edit.coolpaint.world/auth/sites/<site>/owner -H "Authorization: Bearer $(cat worker/editor/.secret.txt)"
```

Locally, `worker/editor/.dev.vars` points `GOOGLE_AUTH_URL`/`GOOGLE_TOKEN_URL`/`GOOGLE_USERINFO_URL` at the fake Google that `test/site-builder/google-auth.test.mjs` runs on `:8790`, and `AUTH_ORIGIN=http://localhost:8787` (wrangler dev reports the custom domain as the request host, so the callback address comes from config).

## Custom domains: the one rule

**Never list a hostname in both wrangler configs.** Wrangler treats a config's `routes` as that Worker's *complete* set of custom domains and, in a non-TTY shell, silently re-points a hostname that another Worker holds. Moving a hostname between Workers: attach it to the new Worker's config and deploy, then remove it from the old config and deploy that, right away, and commit both.

## After a deploy

```sh
curl -sI https://coolpaint.world/ | head -3          # 200, the sandbox CSP, Cache-Control: no-cache, no-transform
curl -sI https://edit.coolpaint.world/ | head -1     # 200
curl -s -o /dev/null -w '%{http_code}\n' 'https://edit.coolpaint.world/api/sites/root/versions?page=index.html'   # 401 without a key
```

Then the real thing: open `https://edit.coolpaint.world/` in the browser (a hard reload if the shell looks stale), sign in, open a page, draw, Ctrl+S, and look at the page on `coolpaint.world`. Jack tests in his browser right after each deploy, so expect follow-ups about defaults and empty states.

## Testing before a deploy

Three local servers, in three shells (or in the background):

```sh
cd worker && npm run dev:sites                                   # sites Worker on :8788
cd worker && npm run dev:editor                                  # builds dist, editor Worker on :8787
npm run test:start-server                                        # Paint's files on :11822 (the page's load event never fires here; the tests wait on app-ready)
SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=<from worker/editor/.dev.vars> node test/site-builder/run.mjs          # all files; or name some: run.mjs sections my-site
```

Both `wrangler dev` processes persist to `worker/.wrangler/state` (R2 and the DOs), so a test site written by one is visible to the other. Stop them afterwards (`pkill -f "wrangler dev"`; `pkill -f "live-server.*11822"`).

## Git

Commit as you go with a message that says what changed for whom; push `live-sync` and fast-forward `master` to it (`git push origin live-sync:master`). Never stage another person's in-progress files (the analytics work, as of 2026-09-11: untracked `src/app-analytics.js`, `worker/shared/analytics.js`, their tests, and hunks in `index.html`, `src/gif-picker.js`, `src/error-handling-enhanced.js`, `worker/README.md`, `worker/editor/wrangler.jsonc`, `docs/PLAN.md`) — stage your own hunks, and build `docs/PLAN.md`'s staged copy from `HEAD` plus your entry (`git hash-object -w` + `git update-index --cacheinfo`).

## Cloudflare limits (Durable Objects)

The `Accounts`, `PageRoom`, `SiteState` and `GifStats` Durable Objects use SQLite storage, which the **Workers Free** plan meters per day: 5 million rows read, 100,000 rows written. When a limit is hit every request that touches a DO fails with `Exceeded allowed rows read in Durable Objects free tier.` until midnight UTC — in Paint that shows as "Couldn't reach the editor" / "The editor's storage is over its daily limit", "viewers unknown", and live rooms that won't connect; static pages, the files API and the master key keep working. This happened on 2026-09-14. **Workers Paid** ($5/month) lifts both limits (billed per million rows beyond a large allowance). The live room writes a row per stroke and the code avoids per-stroke table scans (`page-room.js`: counters instead of `patch_stats` queries, `PRUNE_EVERY`), but a busy day of live painting on the free plan can still reach the write limit.

## Is Error tracking wired up?

The editor Worker sends its own failures to PostHog as `$exception` events (`worker/shared/exceptions.js`) when it has the `POSTHOG_API_KEY` secret; the browser sends the app's error dialogs and failed requests through `app-analytics.js`. To prove the server side end to end:

```sh
curl -X POST https://edit.coolpaint.world/api/debug/exception -H "Authorization: Bearer $(cat worker/editor/.secret.txt)"
# → {"reported":true,"posthog_status":200,"configured":true}; then look for "Test exception from the editor Worker" in PostHog › Error tracking
```

The sites Worker (`coolpaint.world`) reports only once it has the key too: `cd worker && npx wrangler secret put POSTHOG_API_KEY -c sites/wrangler.jsonc`.
