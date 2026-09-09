#!/usr/bin/env node
// Runs every *.test.mjs in this directory in sequence and exits non-zero if any fails.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).filter((name) => only.length === 0 || only.some((part) => name.includes(part))).sort();
let failed = 0;
for (const file of files) {
	const started = Date.now();
	const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: "inherit" });
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (result.status === 0) {
		console.log(`✔ ${file} (${seconds}s)`);
	} else {
		failed++;
		console.log(`✘ ${file} failed (${seconds}s)`);
	}
}
console.log(failed ? `${failed} of ${files.length} test file(s) failed` : `all ${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
