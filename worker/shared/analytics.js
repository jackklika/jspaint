// @ts-check
// Analytics for the *editor app only* (worker/editor/index.js injects it into the app shell and the
// share-landing page when the POSTHOG_API_KEY secret is set). Published pages (~name, the sites Worker)
// never carry scripts or trackers — that's the product's privacy posture (docs/DESIGN.md §9).
// The bootstrap implements the official PostHog snippet's contract, written readably: `window.posthog`
// is an array of queued calls with stub methods plus an `_i` list of instances; array.js (loaded from
// the host) drains both and replaces the stubs with the real library. It gives the editor pageviews,
// sessions (who uses the builder, for how long), and `track_app_event()` (src/app-analytics.js) for
// product events like gif_picker_opened / gif_search. Internal app errors flow through the app's own
// error funnel (error-handling-enhanced.js → track_app_error → `$exception`) — the SDK's autonomous
// capture_exceptions stays off so each user-visible error is counted exactly once.

/** PostHog US cloud; EU projects set POSTHOG_HOST=https://eu.i.posthog.com. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Methods the bootstrap stubs — the official snippet's list, plus captureException: the app's error
 * funnel (track_app_error) uses it, because a hand-rolled capture("$exception") is missing the
 * metadata Error tracking groups on ($exception_list & co. — posthog-js warns about this).
 * Dotted names (people.set) queue on a sub-array, matching array.js's contract.
 */
const STUB_METHODS = "capture captureException identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset".split(" ");

/**
 * Embeds a value in the snippet safely: JSON, with < escaped so a value can't break out of the <script>.
 * @param {string | string[] | Record<string, string>} value
 */
function literal(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The injected bootstrap (see the file comment; the editor origin is ours, so no CSP is involved —
 * the nonce attribute is inert and kept for parity with the official snippet).
 * @param {string} key
 * @param {string} host api_host: a PostHog cloud or a managed-proxy domain (sec.coolpaint.world)
 * @param {string} nonce
 * @param {{ site?: string, page?: string }} [ctx] what this page is about, as event properties
 * @param {{ ui_host?: string, cross_origin?: boolean }} [proxy] only in proxy mode (PostHog's proxy snippet): `ui_host` keeps SDK-generated links pointing at the real app; the loader script goes CORS-mode
 */
function analytics_snippet(key, host, nonce, ctx = {}, proxy = {}) {
	/** @type {Record<string, string>} */
	const props = {};
	if (ctx.site) { props.site = ctx.site; }
	if (ctx.page) { props.page = ctx.page; }
	const register = Object.keys(props).length ? `posthog.register(${literal(props)});` : "";
	const init_config = `{ api_host: host${proxy.ui_host ? `, ui_host: ${literal(proxy.ui_host)}` : ""} }`;
	return `<script nonce="${nonce}">
(function (key, host) {
	var posthog = window.posthog;
	if (!posthog || !posthog.__SV) {
		posthog = window.posthog = [];
		posthog.__SV = 1;
		posthog._i = [];
		var add_method = function (name) {
			var parts = name.split("."), target = posthog;
			if (parts.length === 2) { target = posthog[parts[0]] = posthog[parts[0]] || []; name = parts[1]; }
			target[name] = function () { target.push([name].concat(Array.prototype.slice.call(arguments, 0))); };
		};
		${JSON.stringify(STUB_METHODS)}.forEach(add_method);
		posthog.init = function (api_key, config, name) {
			posthog._i.push([api_key, config, name]);
			var script = document.createElement("script");
			script.type = "text/javascript";
			${proxy.cross_origin ? 'script.crossOrigin = "anonymous";' : ""}
			script.async = true;
			script.src = config.api_host + "/static/array.js";
			(document.getElementsByTagName("script")[0] || document.head.lastChild).parentNode.insertBefore(script, document.head.lastChild);
		};
	}
	posthog.init(key, ${init_config});
	${register}
	window.addEventListener("error", function (event) {
		var target = event.target;
		if (target && target !== window && (target.src || target.href)) {
			posthog.capture("resource_error", { url: String(target.src || target.href), tag: target.tagName || "" });
		}
	}, true);
})(${literal(key)}, ${literal(host)});
</script>`;
}

/**
 * The app shell carries its own CSP meta tag (index.html) with `script-src 'self' blob: …` — no nonce,
 * no posthog hosts — so it would block the injected bootstrap. Add the per-response nonce and the
 * posthog hosts to its script-src (a nonce-source only *adds* allowance; nothing else changes).
 * @param {string} html
 * @param {string} nonce
 * @param {string} hosts `host` or `host assets_host`
 */
function patch_meta_csp(html, nonce, hosts) {
	return html.replace(/(<meta http-equiv="Content-Security-Policy"[^>]*content=")([^"]*)(")/i, (_match, before, csp, after) => {
		const addition = `'nonce-${nonce}' ${hosts}`;
		const patched = /\bscript-src\b/.test(csp)
			? csp.replace(/\bscript-src\s+/, (/** @type {string} */ directive) => `${directive}${addition} `)
			: `${csp.trimEnd()}; script-src ${addition}`;
		return before + patched + after;
	});
}

/**
 * Injects the analytics bootstrap into an HTML response; null when analytics is off (no POSTHOG_API_KEY).
 * POSTHOG_HOST is the api_host: a PostHog cloud (default US) or a managed-proxy domain (sec.coolpaint.world —
 * then the bootstrap follows PostHog's proxy snippet: ui_host so SDK links point at the real app, CORS-mode
 * loader). POSTHOG_UI_HOST overrides the ui_host default (https://us.posthog.com) for an EU project proxied.
 * @param {string} html
 * @param {{ POSTHOG_API_KEY?: string, POSTHOG_HOST?: string, POSTHOG_UI_HOST?: string }} env
 * @param {{ site?: string, page?: string }} [ctx]
 * @returns {{ html: string } | null}
 */
function inject_analytics(html, env, ctx = {}) {
	const key = (env.POSTHOG_API_KEY || "").trim();
	if (!key) {
		return null;
	}
	const host = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).trim().replace(/\/+$/, "");
	const nonce = crypto.randomUUID().replace(/-/g, "");
	// posthog-js loads its modules from a sibling assets host (us.i.posthog.com → us-assets.i.posthog.com);
	// a managed-proxy domain serves them itself — but allow the cloud hosts too, in case the SDK reaches
	// for them directly (an unmet script-src means the library stalls and silently sends nothing).
	/** @param {string} api_host */
	const assets_host_of = (api_host) => api_host.replace(/^(https?:\/\/)([a-z]+)\.i\.posthog\.com$/i, "$1$2-assets.i.posthog.com");
	/** @type {string[]} */
	const all_hosts = [host, assets_host_of(host), DEFAULT_POSTHOG_HOST, assets_host_of(DEFAULT_POSTHOG_HOST)];
	const hosts = Array.from(new Set(all_hosts)).join(" ");
	const is_proxy = !/\.i\.posthog\.com$/i.test(host);
	const snippet = analytics_snippet(key, host, nonce, ctx, is_proxy ? { ui_host: (env.POSTHOG_UI_HOST || "https://us.posthog.com").trim().replace(/\/+$/, ""), cross_origin: true } : {});
	let with_snippet = patch_meta_csp(html, nonce, hosts);
	if (/<\/head>/i.test(with_snippet)) {
		with_snippet = with_snippet.replace(/<\/head>/i, () => `${snippet}</head>`);
	} else if (/<body[^>]*>/i.test(with_snippet)) {
		with_snippet = with_snippet.replace(/(<body[^>]*>)/i, (_match, open_tag) => open_tag + snippet);
	} else {
		with_snippet = `${snippet}${with_snippet}`;
	}
	return { html: with_snippet };
}

export { inject_analytics };
