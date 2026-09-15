// When the server fails (a 5xx, no answer), people see one plain sentence — never the server's detail (a Cloudflare
// quota, a stack, an HTTP status); that goes to the console and to PostHog. A 4xx they can act on keeps its words.
import { assert, click_menu_item, open_paint } from "./helpers.mjs";

const editor = "http://localhost:8799"; // nothing listens there: every request is stubbed below (and the first whoami, before the stubs, just fails — a 401 would have dropped the account)
const site = "stubbed";
const PLAIN = "Something went wrong on our side. Please try again in a little while.";
const DETAIL = "Exceeded allowed rows read in Durable Objects free tier.";
const { page, close } = await open_paint({
	// (a stand-in PostHog: the browser funnel — app-analytics.js track_app_error → posthog.captureException — is what the
	// app's own error reports go through; here it just records them)
	init: (arg) => {
		localStorage.setItem("jspaint site publish settings", JSON.stringify(arg));
		window.__caught = [];
		window.posthog = { captureException: (error, props) => { window.__caught.push({ message: String(error && error.message || error), ...props }); }, capture: () => {} };
	},
	init_arg: { editor_url: editor, site, secret: "", remember_secret: false, page: "index.html", account: { email: "pat@example.com", name: "Pat", via: "google", sites: [site] } },
});
await page.waitForTimeout(800);
const console_lines = [];
page.on("console", (m) => { console_lines.push(m.text()); });

// The editor over its quota: a 503 with a code — the Sign In dialog says the plain sentence, not the detail
await page.route("**/api/whoami*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: PLAIN, code: "storage-quota", detail: DETAIL }) }));
await click_menu_item(page, "Sign In to My Site...");
await page.waitForSelector(".my-site-sign-in-account", { timeout: 10000 });
await page.click(`.my-site-sign-in-account button[data-site="${site}"]`);
await page.waitForFunction(() => /Something went wrong on our side/.test(document.querySelector(".my-site-sign-in .my-site-status")?.textContent || ""), null, { timeout: 10000 });
const status_text = await page.$eval(".my-site-sign-in .my-site-status", (el) => el.textContent);
assert.equal(status_text, PLAIN);
assert.doesNotMatch(status_text, /Cloudflare|Durable|quota|503|HTTP/);
await page.evaluate(() => { [...document.querySelectorAll(".my-site-sign-in button")].find((b) => b.textContent === "Cancel")?.click(); });

// A 500 with a raw message during a save: the publish log gets the plain sentence and the error dialog too
await page.unroute("**/api/whoami*");
await page.route("**/api/whoami*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, role: "site", site, created: null, sites_url: "http://localhost:8788", editor_url: editor, user: { id: "u1", email: "pat@example.com", name: "Pat" }, sites: [site] }) }));
await page.route("**/api/sites/*/files", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: DETAIL }) }));
await page.route("**/auth/methods", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ google: false, password: true, site_limit: 5, sites_url: "http://localhost:8788" }) }));
await page.evaluate(() => { document.querySelector(".page-loading-panel")?.remove(); document.body.classList.remove("page-loading"); });
await page.evaluate(async () => { (await import("/src/my-site.js")).save_page_to_site("index.html"); });
await page.waitForFunction(() => /Something went wrong on our side/.test(document.querySelector(".site-publish-log")?.textContent || ""), null, { timeout: 30000 });
const log = await page.$eval(".site-publish-log", (el) => el.textContent);
assert.doesNotMatch(log, /Exceeded|Durable|Cloudflare|HTTP 500/, `no detail on the screen: ${log}`);
await page.waitForFunction(() => [...document.querySelectorAll(".window")].some((w) => /Something went wrong on our side/.test(w.textContent) && !w.classList.contains("site-publish-window")), null, { timeout: 10000 });
const dialogs = await page.evaluate(() => [...document.querySelectorAll(".window")].map((w) => w.textContent).join("\n"));
assert.doesNotMatch(dialogs, /Exceeded|Durable|Cloudflare/, "the error dialog is plain too");
// …while the detail did reach the console, for anyone looking
assert.ok(console_lines.some((line) => line.includes("editor request failed") && line.includes(DETAIL)), console_lines.filter((l) => /request failed/.test(l)).join("\n"));

// …and reached PostHog through the app's funnel, as an exception with the detail
await page.waitForFunction(() => window.__caught.some((c) => /Exceeded allowed rows/.test(c.message) && c.error_kind === "request"), null, { timeout: 5000 });
const caught = await page.evaluate(() => window.__caught);
assert.ok(caught.some((c) => c.error_kind === "request" && /\(500\)/.test(c.message)), JSON.stringify(caught));
// (that dialog was plain on purpose — the request itself was already reported; a dialog that carries an error reports it)
await page.evaluate(async () => { (await import("/src/functions.js")).show_error_message("Couldn't do the thing.", new Error("the thing broke")); });
await page.waitForFunction(() => window.__caught.some((c) => c.error_kind === "dialog" && /the thing broke/.test(c.message)), null, { timeout: 5000 });
await page.evaluate(() => { [...document.querySelectorAll(".window button")].find((b) => b.textContent === "OK")?.click(); });

// A 4xx the person can act on keeps the server's words
await page.evaluate(() => { for (const w of document.querySelectorAll(".window .window-close-button")) { w.click(); } });
await page.route("**/auth/sites", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "That name is taken" }) }));
await click_menu_item(page, "Sign In to My Site...");
await page.waitForSelector(".my-site-sign-in-account", { timeout: 10000 });
await page.evaluate(() => { [...document.querySelectorAll(".my-site-sign-in button")].find((b) => b.textContent === "New Site…")?.click(); });
await page.waitForSelector(".new-site-window", { timeout: 5000 });
await page.fill('.new-site-window input[name="new-site-name"]', "taken-name");
await page.click(".new-site-window button[type=submit]");
await page.waitForFunction(() => /That name is taken/.test(document.querySelector(".new-site-window .my-site-status")?.textContent || ""), null, { timeout: 10000 });

// (the browser itself logs the stubbed 500 as a failed resource — that's the point of this test, so no page-errors check)
void close;
await page.context().browser().close();
console.log("server-errors: ok");
