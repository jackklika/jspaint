#!/usr/bin/env node
// Copies the Paint app's static files into editor/dist for the jspaint-editor Worker's assets.
// Only what the app needs at runtime is copied (no node_modules, tests, docs, or source maps).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "worker", "editor", "dist");
const files = ["index.html", "about.html", "privacy.html", "favicon.ico", "manifest.webmanifest", "browserconfig.xml"];
const directories = ["src", "lib", "images", "styles", "help", "audio", "localization", "desktop"];
const skip = (/** @type {string} */ file) => /\.(map|psd|md)$/i.test(file) || /(^|\/)\.[^/]+$/.test(file);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
let count = 0;
for (const file of files) {
	fs.copyFileSync(path.join(root, file), path.join(dist, file));
	count++;
}
for (const directory of directories) {
	fs.cpSync(path.join(root, directory), path.join(dist, directory), {
		recursive: true,
		filter: (source) => {
			const relative = path.relative(root, source);
			if (fs.statSync(source).isDirectory()) { return true; }
			if (skip(relative)) { return false; }
			count++;
			return true;
		},
	});
}
fs.writeFileSync(path.join(dist, ".assetsignore"), "*.map\n");
console.log(`editor/dist: ${count} files`);
