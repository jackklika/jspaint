// The QR encoder (src/qr.js) round-trips through a real decoder (jsqr) at every version it supports.
import jsQR from "jsqr";
import { assert } from "./helpers.mjs";
import { qr_modules } from "../../src/qr.js";

/** Rasterizes modules to RGBA with a quiet zone, the way a screen would show them. */
function rasterize(modules, scale = 4, quiet = 4) {
	const size = (modules.length + quiet * 2) * scale;
	const data = new Uint8ClampedArray(size * size * 4).fill(255);
	modules.forEach((row, y) => row.forEach((dark, x) => {
		if (!dark) { return; }
		for (let dy = 0; dy < scale; dy++) {
			for (let dx = 0; dx < scale; dx++) {
				const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
				data[i] = data[i + 1] = data[i + 2] = 0;
			}
		}
	}));
	return { data, width: size, height: size };
}

const samples = [
	"hi",
	"https://jspaint-editor.jklika2.workers.dev/#join:jack/index.html/20800.Ab3dE9fGh1kLmNoP",
	"https://jspaint-editor.jklika2.workers.dev/#join:my-longer-site-name/about-the-wedding.html/20800.Ab3dE9fGh1kLmNoPqRsT",
	"x".repeat(150),
	"y".repeat(230),
	"z".repeat(270),
];
for (const text of samples) {
	const modules = qr_modules(text);
	const version = (modules.length - 17) / 4;
	const { data, width, height } = rasterize(modules);
	const decoded = jsQR(data, width, height);
	assert.ok(decoded, `decodable (${text.length} chars, version ${version})`);
	assert.equal(decoded.data, text, `round-trips at version ${version}`);
	console.log(`qr: ${text.length} chars → version ${version} ok`);
}
assert.throws(() => qr_modules("q".repeat(300)), /Too much text/);
console.log("qr: ok");
