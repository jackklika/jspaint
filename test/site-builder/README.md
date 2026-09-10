# Site-builder UI tests

Playwright scripts that drive the real JS Paint page (no mocks): stickers, text layers, page elements
(blocks) and the toolbox, the page web-page format and animated GIF export, the Layers window, layer
autosave, the GIF picker, and My Site.

```sh
npm install                       # playwright is a devDependency
npx playwright install chromium   # once
npm run test:site-builder         # starts a static server on :11822 and runs everything
```

- `node test/site-builder/run.mjs blocks` runs only files whose name contains "blocks".
- `JSPAINT_URL=http://localhost:1999/ node test/site-builder/run.mjs` runs against an already-running server (e.g. `npm run dev`).
- `publish.test.mjs` and `my-site.test.mjs` need both Workers running locally (`cd worker && npm run dev:sites` / `npm run dev:editor`, secret in `worker/editor/.dev.vars`): `JSPAINT_URL=http://localhost:8787/ SITE_BUILDER_EDITOR_URL=http://localhost:8787 SITE_BUILDER_SITES_URL=http://localhost:8788 SITE_BUILDER_SECRET=<secret> node test/site-builder/run.mjs publish my-site`; skipped otherwise.
- `page-scroll.test.mjs` covers the make-page-longer button, Page menu longer/shorter, and Pointer-tool panning. For phone behavior, Playwright's `devices["iPhone 13"]` on WebKit (`npx playwright install webkit`) reproduces iOS Safari focus and tap quirks well.
- `live-room.test.mjs` (the room's WebSocket protocol, from Node) needs the editor Worker; `live-paint.test.mjs` (three copies of Paint editing one page) needs both Workers and, to avoid rebuilding `editor/dist` on every change, `JSPAINT_URL=http://localhost:11822/` from `npm run test:start-server`. Both also run against production with the real URLs and secret.
- `gif-picker.test.mjs` needs network and the GifCities proxy: `SITE_BUILDER_PROXY_URL=http://localhost:4097` with `agent-server` running; it's skipped otherwise.
- GIF fixtures are generated in the page with `lib/gif.js`, so there are no binary files here.
- Gotchas the tests encode: a selected layer's `Handles` grab ring (~10px) covers its edges, so click centers; `preventDefault()` on `pointerdown` suppresses the browser's `dblclick`, so double-click is two clicks within 400ms; elements are click-through unless selected or the Pointer tool is active, so select the Pointer tool before clicking one.
