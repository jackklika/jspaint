# Agent server (Code Agent + Agent Drive)

Local companion for two JS Paint windows:

- **Extras › Code Agent** — chat with opencode about *this* app's code while you use it. Each message runs `opencode run` on the JS Paint repo (`dev.repo_dir`, default `..`) with the user's request appended to `dev-chat-prompt.md`; the window streams what the agent reads/edits/runs (`--format json`), follow-ups continue the same opencode session (`--session`), and when files under `src/`, `styles/`, `index.html`… changed the app reloads itself — drawing, elements, and conversation come back (autosave + localStorage). Pick the model via `dev.model` in `config.json` (or the window's Model field), e.g. your z.ai GLM as `provider/model` from `opencode models`; empty means opencode's own default. Only one Code Agent job runs at a time; **Stop** kills it. Mutating API calls are only accepted from pages served on localhost, plus any origins listed in `allowed_origins` (the hosted copy of Paint, so it can drive this server from the web; its edits land on disk and show up locally, not in the hosted page).
- **Extras › Agent Window** (Agent Drive) — the older tool: the canvas drives an agent that edits a separate static website, deployed to Cloudflare.

```
JS Paint ──Ctrl+Alt+I──▶ agent-server ──▶ site repo public/index.html ──wrangler──▶ preview URL   (seconds)
 draw / annotate          save iteration     edited by opencode (HTML mode)
       ▲                        │                       │
       └── page rendered in ────┘          Ctrl+Alt+P: git push ──▶ GitHub Actions ──▶ production URL
           your browser
```

Two output modes, chosen in the Agent window:

| Mode | What "Save Iteration" does |
| --- | --- |
| **Display** | Saves the drawing as `public/iterations/NNN.png` and rewrites `public/index.html` so the page shows it pixel-for-pixel. No LLM involved; live on the preview URL in a few seconds. |
| **HTML** | Saves the drawing, then runs `opencode run` in the site repo with the image attached. The agent reads the text in the drawing (typed *or* hand-drawn), turns underlines into links, boxes into buttons, etc., and edits `public/index.html`. JS Paint then renders the new page into the canvas (in your browser, via SVG `<foreignObject>` — no headless browser needed), so the next round of drawing is an annotation on the real page. |

Every iteration is deployed **directly** to the preview alias with `wrangler versions upload` — GitHub Actions is out of the hot path. **Publish to Web** commits and pushes the site repo; its GitHub workflow runs `wrangler deploy` for production.

**Live preview** (Display mode, optional): tick *Live preview* in the Agent window and every stroke is pushed to viewers in a few hundred milliseconds — no reload. It rides on JS Paint's built-in multi-user `RESTSession`: the canvas is PUT to this server after each stroke, and the server (1) rewrites `public/latest.png` + the display page, (2) forwards the image to the **`jspaint-live` room Worker** (a Durable Object that fans out over WebSockets to every open copy of the page), and (3) redeploys the preview alias, coalesced to one deploy per few seconds, so the deployed page is right even for viewers who arrive later. `RESTSession` uses same-origin URLs, so open JS Paint at **http://localhost:4097/** (this server serves it) rather than the `npm run dev` port.

## The site repo is generated from here

Everything in the site repo except `public/` is a copy of `site-template/` in this directory — the two Worker configs (`wrangler.jsonc` for the static site, `live/` for the room), the deploy workflow, `AGENTS.md`, `README.md`, `.gitignore`. Edit them here; the server re-syncs on startup (`site_template.sync_on_start`) or run `npm run sync-site`. `npm run set-live-secret` generates the room's shared secret into `config.json` and pushes it to the Worker as `LIVE_SECRET`.

## Setup

1. Have the site repo checked out (default: `../jspaint-site`, i.e. `/Users/jack/git/jspaint-site`) and run `npm install` in it once — that provides the pinned `wrangler`. Deploys use your `wrangler login` session.
2. In this directory (no `npm install` needed — the server has no dependencies):

   ```sh
   cp config.example.json config.json
   ```

3. Edit `config.json`:
   - `site_dir` — path to the site repo (relative to this directory, or absolute)
   - `site_url` — the production URL, shown as a link after publishing
   - `opencode.model` — optional `provider/model` override; the model must support **images** for HTML mode. Leave empty to use your opencode default.
   - `opencode.auto_approve` — `--auto` lets the agent edit files without an interactive permission prompt (it's a sandboxed site repo, so this is the intended setting)
   - `deploy.enabled` — set `false` to keep everything local (or run with `AGENT_DRIVE_NO_DEPLOY=1`)
   - `live.url` / `live.room` / `live.secret` — the room Worker; leave `url` empty to disable realtime pushes
4. Run it:

   ```sh
   npm start
   ```

5. Open <http://localhost:4097/> (JS Paint served from the repo, so the Code Agent's edits are what you're running) and **Extras > Code Agent** (or **Extras > Agent Window** for Agent Drive). The status line shows the repo, branch, and model.

## Shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+Alt+I` | Save Iteration (also **File > Save Iteration to Agent**) |
| `Ctrl+Alt+P` | Publish to Web (also **File > Publish to Web**) |

On macOS use the physical Control key (Cmd+Option+I is taken by the browser's dev tools).

## Tuning the agent

`html-mode-prompt.md` is the prompt template for HTML mode; it's re-read on every request, so edit it freely. The site repo's `AGENTS.md` is also read by opencode and describes the repo conventions.

## API

All responses are JSON; long-running work returns `{ "job": id }` to poll at `GET /api/jobs/:id`.

- `GET /api/status` (includes `dev: { repo_dir, branch, model, running_job }`)
- `POST /api/dev/prompt` — JSON `{ prompt, session?, model? }` → `{ job }`; the job carries `events` (`text`, `tool`, `step`, `error`) and a result `{ session, reply, changed_files, app_changed, cost, tokens }`
- `POST /api/dev/abort/:job` — stop a running Code Agent job
- `POST /api/iteration?mode=display|html` — body: PNG bytes
- `PUT /api/screenshots/<NNN|current>` — body: PNG bytes; JS Paint uploads its render of the page here
- `POST /api/publish`
- `GET|PUT /api/rooms/<id>/data` — JS Paint's RESTSession protocol (PNG data URI); writes fan out to the live room Worker
- `GET /files/<path>` — static files from the site repo (`public/`, `screenshots/`)
- `GET /<anything else>` — JS Paint's own static files

The server binds to `127.0.0.1` only. Requires Node ≥ 18, plus `git`, `opencode`, and (in the site repo) `wrangler`.
