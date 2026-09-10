# Agent notes for this repo

This is a fork of JS Paint that is becoming a Windows-98-style site builder for web-1.0 pages (the page is the Paint document; elements float over the bitmap; sites are hosted on Cloudflare). Start with `docs/PLAN.md` ("How to resume") and `docs/DESIGN.md`.

- Code style: tabs, `// @ts-check`, snake_case like the surrounding code. ES modules live in `src/` and must be listed as `<script type="module">` in `index.html`; globals from classic scripts are declared with `/* global … */`.
- Check your work with `npm run lint` (cspell + tsc + eslint). New words go in `cspell.json`. UI tests: `npm run test:site-builder` (Playwright; see `test/site-builder/README.md`).
- Page elements: kinds in `src/block-kinds.js`, toolbox tools in `src/page-tools.js`, on-canvas behavior in `src/blocks.js`, server-rendered `<x-*>` elements in `worker/shared/x-elements/`.
- Don't commit or push unless asked. Never edit `agent-server/config.json`, `worker/editor/.secret.txt`, or `*.dev.vars` (secrets, gitignored).
- `agent-server/` is a local dev tool (the Code Agent window and the older Agent Drive); `worker/` holds the two Cloudflare Workers.
