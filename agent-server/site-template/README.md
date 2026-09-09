# jspaint-site

A one-page website edited by drawing in [JS Paint](https://github.com/jackklika/jspaint). **Everything here except `public/` is generated** from the jspaint fork's `agent-server/site-template/` — edit configuration there; the agent server re-syncs it on startup (or `npm run sync-site` in `agent-server/`).

```
public/
  index.html          the page. Display mode: shows latest.png (and live-updates). HTML mode: rewritten by the agent.
  latest.png          the newest drawing from JS Paint
  iterations/NNN.png  every "Save Iteration", in order — the design history
live/                 jspaint-live Worker: Durable Object room that pushes strokes to viewers over WebSockets
wrangler.jsonc        jspaint-site Worker (static assets from public/)
.github/workflows/    production deploy of both Workers on push to main
AGENTS.md             conventions the agent follows when editing
```

## URLs

| | URL | Deployed by |
| --- | --- | --- |
| Production | `https://jspaint-site.jklika2.workers.dev` | GitHub Actions on push to `main` (**Publish to Web** in JS Paint) |
| Preview | `https://preview-jspaint-site.jklika2.workers.dev` | agent-server directly, on every **Save Iteration** |
| Live room | `https://jspaint-live.jklika2.workers.dev/rooms/live/data` | GitHub Actions (and `npm run deploy-live`); agent-server pushes every stroke here |

The site Worker is assets-only on purpose: Workers with Durable Objects don't get preview URLs, so the realtime room is its own Worker. The display page opens a WebSocket to the room and swaps the image on each update (~200–400 ms after a stroke), and falls back to polling `latest.png` for new deploys.

## Setup status

GitHub repo, both Workers, and the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets are in place (the token must be an **account** token, `cfat_…`; a user token `cfut_…` fails with auth error 10000). The room's `LIVE_SECRET` is set from `agent-server/` with `npm run set-live-secret`, which also stores it in `agent-server/config.json` (gitignored).

Local deploys use your `wrangler login` OAuth session; `npm install` here provides the pinned `wrangler`.
