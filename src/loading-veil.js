// @ts-check
/* global localize */
// A Windows-98 "Loading…" panel over the canvas area while a page is being brought in (a restored session, the
// site's front page on a fresh visit): the picture appears whole, not white first and then filled in.
const TIMEOUT_MS = 15000; // a safety net: nothing keeps the canvas hidden for good

/** @type {(() => void)[]} the loads in progress; each has its own end */
let pending = [];
/** @type {JQuery | null} */
let $panel = null;
let timer = 0;

/** @param {string} [label] @returns {() => void} call it when the page is in (once; extra calls do nothing) */
function begin_loading(label = localize("Loading…")) {
	let ended = false;
	const end = () => {
		if (ended) { return; }
		ended = true;
		pending = pending.filter((other) => other !== end);
		if (!pending.length) { hide(); }
	};
	pending.push(end);
	show(label);
	clearTimeout(timer);
	timer = window.setTimeout(() => { end_all_loading(); }, TIMEOUT_MS);
	return end;
}

/** Everything that was loading is done (or gave up). */
function end_all_loading() {
	for (const end of pending.slice()) { end(); }
}

/** @param {string} label */
function show(label) {
	document.body.classList.add("page-loading");
	const place = () => {
		const area = document.querySelector(".canvas-area");
		if (!area) { requestAnimationFrame(place); return; } // (the app is still building its UI)
		if (!$panel) {
			$panel = $("<div>").addClass("page-loading-panel").attr({ role: "status", "aria-live": "polite" });
			$("<div>").addClass("page-loading-box").appendTo($panel);
		}
		$panel.find(".page-loading-box").text(label);
		if (!$panel.parent().length) { $panel.appendTo(area); }
	};
	place();
}

function hide() {
	document.body.classList.remove("page-loading");
	clearTimeout(timer);
	$panel?.remove();
}

$("<style>").text(`
	body.page-loading .canvas-area > :not(.page-loading-panel) { visibility: hidden; }
	.page-loading-panel {
		position: absolute;
		inset: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--ButtonFace, #c0c0c0);
	}
	.page-loading-box {
		padding: 14px 28px;
		border: 2px outset var(--ButtonFace, #c0c0c0);
		background: var(--ButtonFace, #c0c0c0);
		color: var(--ButtonText, #000);
		font: 12px sans-serif;
	}
`).appendTo(document.head);

export { begin_loading, end_all_loading };
