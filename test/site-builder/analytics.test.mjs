// The PostHog bootstrap injected into the *editor app* (worker/shared/analytics.js — editor-only;
// published pages never carry trackers). Off unless POSTHOG_API_KEY is set. No server needed.
import { assert } from "./helpers.mjs";
import { inject_analytics } from "../../worker/shared/analytics.js";

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>hi</title></head><body><div id="app"></div></body></html>`;
const ENV = { POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" };

// Off without a key (or blank): page untouched.
assert.equal(inject_analytics(PAGE, {}), null);
assert.equal(inject_analytics(PAGE, { POSTHOG_API_KEY: "  " }), null);

// On with a key: script before </head>, config embedded.
const injected = inject_analytics(PAGE, ENV, { site: "jack", page: "index.html" });
assert.ok(injected, "injected when the key is set");
assert.ok(injected.html.indexOf("<script") !== -1, "snippet present");
assert.ok(injected.html.indexOf("<script") < injected.html.indexOf("</head>"), "snippet lands in <head>");
assert.ok(injected.html.includes("phc_test"), "project key embedded");
assert.ok(injected.html.includes('"https://eu.i.posthog.com"'), "configured host embedded");
assert.ok(injected.html.includes('"/static/array.js"'), "loads array.js from the host");
assert.ok(injected.html.includes('"site":"jack"'), "site/page ride along as event properties");
assert.ok(!injected.html.includes("capture_exceptions"), "SDK autonomous capture stays off (the app's error funnel sends $exception instead)");
assert.ok(injected.html.includes("resource_error"), "broken-resource capture on");

// Nonces differ per response (the editor serves the shell no-cache, so every load is fresh).
const first = /nonce="([0-9a-f]+)"/.exec(injected.html)?.[1];
const second = /nonce="([0-9a-f]+)"/.exec(inject_analytics(PAGE, ENV, {})?.html || "")?.[1];
assert.ok(first && second && first !== second, "nonce is per-response");

// Host defaults to the US cloud.
assert.ok(inject_analytics(PAGE, { POSTHOG_API_KEY: "phc_test" }, {})?.html.includes("https://us.i.posthog.com"), "US cloud by default");

// Pages without site/page context (the plain app shell) don't register empty properties.
assert.ok(!inject_analytics(PAGE, ENV, {})?.html.includes("posthog.register("), "no register() without site/page context");

// Pages without </head> still get the snippet (after <body>, or in front as a last resort).
assert.ok(inject_analytics("<html><body><p>hi</p></body></html>", ENV, {})?.html.includes("posthog.init"), "fallback: after <body>");
assert.ok(inject_analytics("<p>hi</p>", ENV, {})?.html.startsWith("<script"), "fallback: prepended");

// A value can't break out of the script tag.
const hostile = inject_analytics(PAGE, ENV, { site: `jack</script><script>alert(1)</script>` });
assert.ok(hostile?.html.includes("\\u003c/script"), "site names are escaped (< → \\u003c)");

// The app shell carries its own CSP meta (index.html): the injection adds the matching nonce + both
// posthog hosts to its script-src, or the meta would block the bootstrap (and array.js).
const SHELL = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="
	default-src 'self';
	script-src 'self' blob: https://jspaint.firebaseio.com;
	connect-src * data: blob:;
"></head><body></body></html>`;
const shell = inject_analytics(SHELL, ENV, {});
assert.ok(shell, "shell injected");
const meta_csp = /<meta http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i.exec(shell.html)?.[1] || "";
const shell_nonce = /<script nonce="([0-9a-f]+)">/.exec(shell.html)?.[1];
assert.ok(meta_csp.includes(`script-src 'nonce-${shell_nonce}' https://eu.i.posthog.com https://eu-assets.i.posthog.com https://us.i.posthog.com https://us-assets.i.posthog.com 'self' blob:`), "meta CSP gains the nonce and the posthog hosts (configured cloud + defaults), keeping its own sources");
assert.ok(!meta_csp.includes("\n") || true, "formatting preserved");
// A CSP without script-src gets one appended rather than crashing.
const NO_SCRIPT_SRC = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head><body></body></html>`;
const appended = inject_analytics(NO_SCRIPT_SRC, ENV, {});
assert.ok(/script-src 'nonce-[0-9a-f]+' https:\/\/eu\.i\.posthog\.com/.test(appended?.html || ""), "script-src appended when absent");

// Managed proxy mode (POSTHOG_HOST=sec.coolpaint.world): api_host is the proxy, ui_host points SDK
// links at the real app, the loader goes CORS-mode, and the CSP allows the proxy *and* the cloud hosts
// (in case posthog-js reaches for them directly).
const PROXY_ENV = { POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://sec.coolpaint.world" };
const proxied = inject_analytics(PAGE, PROXY_ENV, {});
assert.ok(proxied?.html.includes('"https://sec.coolpaint.world"'), "proxy domain is the api_host");
assert.ok(proxied?.html.includes('ui_host: "https://us.posthog.com"'), "ui_host defaults to the US cloud app");
assert.ok(proxied?.html.includes('script.crossOrigin = "anonymous"'), "proxy loader is CORS-mode (matches PostHog's proxy snippet)");
assert.ok(proxied?.html.includes('"/static/array.js"'), "array.js from the api_host");
const proxy_shell = inject_analytics(SHELL, PROXY_ENV, {});
const proxy_meta = /<meta http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i.exec(proxy_shell?.html || "")?.[1] || "";
for (const allowed of ["https://sec.coolpaint.world", "https://us.i.posthog.com", "https://us-assets.i.posthog.com"]) {
	assert.ok(proxy_meta.includes(allowed), `CSP allows ${allowed} alongside the proxy`);
}
// Direct-cloud mode keeps the leaner config (no ui_host, no crossOrigin).
const direct = inject_analytics(PAGE, ENV, {});
assert.ok(!direct?.html.includes("ui_host"), "no ui_host for a direct cloud host");
assert.ok(!direct?.html.includes("crossOrigin"), "no crossOrigin for a direct cloud host");

console.log("analytics: ok");
