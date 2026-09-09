# Site-builder UI tests

Playwright scripts that drive the real JS Paint page (no mocks): stickers, text layers, the collage
web-page format and animated GIF export, the Layers window, layer autosave, and the GIF picker.

```sh
npm install                       # playwright is a devDependency
npx playwright install chromium   # once
npm run test:site-builder         # starts a static server on :11822 and runs everything
```

- `node test/site-builder/run.mjs stickers` runs only files whose name contains "stickers".
- `JSPAINT_URL=http://localhost:1999/ node test/site-builder/run.mjs` runs against an already-running server (e.g. `npm run dev`).
- `publish.test.mjs` needs both Workers running locally (`cd worker && npm run dev:sites` / `npm run dev:editor`, secret in `worker/editor/.dev.vars`): `JSPAINT_URL=http://localhost:8787/ SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=<secret> node test/site-builder/run.mjs publish`; skipped otherwise.
- `desktop.test.mjs` needs the same two local Workers as `publish.test.mjs` (same env vars); it drives the desktop at `/desktop/`.
- `gif-picker.test.mjs` needs network and the GifCities proxy: `SITE_BUILDER_PROXY_URL=http://localhost:4097` with `agent-server` running; it's skipped otherwise.
- GIF fixtures are generated in the page with `lib/gif.js`, so there are no binary files here.
- Gotchas the tests encode: a selected layer's `Handles` grab ring (~10px) covers its edges, so click centers; `preventDefault()` on `pointerdown` suppresses the browser's `dblclick`, so double-click is two clicks within 400ms.
