// @ts-check
// <x-music src="midi/song.mp3">: background music with the browser's own play button. The file must be on the
// site (the page's CSP only allows same-origin media); MP3, OGG, and WAV play everywhere, MIDI mostly doesn't.
import { escape_html } from "./index.js";

export default {
	tag: "x-music",
	attrs: ["src", "autoplay", "loop", "label"],
	editor: {
		label: "Music",
		description: "Background music with a play button (upload the MP3 in My Site first).",
		fallback: "♫ <i>music</i>",
	},
	render({ attrs }) {
		const src = attrs.src || "";
		if (!src || /^(?:[a-z]+:|\/\/)/i.test(src)) {
			return `♫ <i>${escape_html(attrs.label || (src ? "music must be a file on this site (like midi/song.mp3)" : "no song chosen"))}</i>`;
		}
		const autoplay = /^(yes|true|1|autoplay)$/i.test(attrs.autoplay || "") ? " autoplay" : "";
		const loop = /^(yes|true|1|loop)$/i.test(attrs.loop || "") ? " loop" : "";
		return `${attrs.label ? `${escape_html(attrs.label)} ` : ""}<audio controls${autoplay}${loop} preload="none" src="${escape_html(src)}" style="height:24px;vertical-align:middle;max-width:100%"></audio>`;
	},
};
