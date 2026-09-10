// @ts-check
// Serve-time analytics for published pages (docs/DESIGN.md §9: our own snippet, nonce'd — pages stay script-free in R2).
// When POSTHOG_API_KEY is set, the sites Worker injects a PostHog bootstrap into every HTML response
// (pages, 404s, form-action error pages) *after* sanitization, so it survives every save and never
// round-trips into the editor. Answers: who visits (autocapture pageviews, anonymous distinct_id),
// for how long (sessions), and what breaks (capture_exceptions for JS errors, resource_error for
// broken image/media links). The CSP gains `script-src 'nonce-…' <host>; connect-src <host>` on
// instrumented responses only.

/** PostHog US cloud; EU projects set POSTHOG_HOST=https://eu.i.posthog.com. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Methods the bootstrap stubs — the official snippet's list (only init/capture/register are used here).
 * Dotted names (people.set) queue on a sub-array, matching array.js's contract.
 */
const STUB_METHODS = "capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset".split(" ");

/**
 * Embeds a value in the snippet safely: JSON, with < escaped so a value can't break out of the <script>.
 * @param {string | string[] | Record<string, string>} value
 */
function literal(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The injected bootstrap. It implements the official PostHog snippet's contract, written readably:
 * `window.posthog` is an array of queued calls with stub methods plus an `_i` list of instances;
 * array.js (loaded from the host) drains both and replaces the stubs with the real library.
 * @param {string} key
 * @param {string} host
 * @param {string} nonce
 * @param {{ site?: string, page?: string }} [ctx] the site/page this response is about, for event filtering
 */
function analytics_snippet(key, host, nonce, ctx = {}) {
	/** @type {Record<string, string>} */
	const props = {};
	if (ctx.site) { props.site = ctx.site; }
	if (ctx.page) { props.page = ctx.page; }
	const register = Object.keys(props).length ? `posthog.register(${literal(props)});` : "";
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
			script.async = true;
			script.src = config.api_host + "/static/array.js";
			(document.getElementsByTagName("script")[0] || document.head.lastChild).parentNode.insertBefore(script, document.head.lastChild);
		};
	}
	posthog.init(key, { api_host: host, capture_exceptions: true });
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
 * Injects the analytics bootstrap into an HTML response; null when analytics is off (no POSTHOG_API_KEY).
 * @param {string} html
 * @param {{ POSTHOG_API_KEY?: string, POSTHOG_HOST?: string }} env
 * @param {{ site?: string, page?: string, base_csp: string }} ctx `base_csp` is the response's CSP; the returned one adds the nonce'd script exception
 * @returns {{ html: string, csp: string } | null}
 */
function inject_analytics(html, env, ctx) {
	const key = (env.POSTHOG_API_KEY || "").trim();
	if (!key) {
		return null;
	}
	const host = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).trim().replace(/\/+$/, "");
	const nonce = crypto.randomUUID().replace(/-/g, "");
	const snippet = analytics_snippet(key, host, nonce, ctx);
	let with_snippet;
	if (/<\/head>/i.test(html)) {
		with_snippet = html.replace(/<\/head>/i, () => `${snippet}</head>`);
	} else if (/<body[^>]*>/i.test(html)) {
		with_snippet = html.replace(/(<body[^>]*>)/i, (_match, open_tag) => open_tag + snippet);
	} else {
		with_snippet = `${snippet}${html}`;
	}
	// posthog-js loads its modules from a sibling assets host (us.i.posthog.com → us-assets.i.posthog.com);
	// both need script-src (module loads) and connect-src (the remote config fetch). 'self' covers
	// Cloudflare's RUM beacon (cdn-cgi/rum) on custom domains.
	const assets_host = host.replace(/^(https?:\/\/)([a-z]+)\.i\.posthog\.com$/i, "$1$2-assets.i.posthog.com");
	const hosts = assets_host === host ? host : `${host} ${assets_host}`;
	return {
		html: with_snippet,
		csp: `${ctx.base_csp}; script-src 'nonce-${nonce}' ${hosts}; connect-src 'self' ${hosts}`,
	};
}

export { inject_analytics };
