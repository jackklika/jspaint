// @ts-check
// Constants shared by the Paint app, the page editor, and the Workers (see docs/DESIGN.md).

/** Fixed width of a page's centered column, in CSS pixels. The one layout constant; user-choosable later. */
export const PAGE_WIDTH = 800;

/** Longest animated GIF export, in milliseconds. Sticker timelines longer than this are cut at the cap. */
export const GIF_EXPORT_MAX_DURATION_MS = 10000;

/** Most frames an animated GIF export will contain; longer timelines are quantized to fit. */
export const GIF_EXPORT_MAX_FRAMES = 200;

/** The hosted editor Worker (Paint app + publish API + GifCities proxy). Overridable in File > Save to My Site. */
export const DEFAULT_EDITOR_URL = "https://jspaint-editor.jklika2.workers.dev";

/** Where published sites live: `${DEFAULT_SITES_URL}/~name/`. */
export const DEFAULT_SITES_URL = "https://jspaint-sites.jklika2.workers.dev";
