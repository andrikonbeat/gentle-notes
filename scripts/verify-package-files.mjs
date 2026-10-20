#!/usr/bin/env node
/**
 * Verify what the published package actually contains.
 *
 * Mirrors the check gentle-shell runs on its own package
 * (`scripts/verify-package-files.mjs` there): pack, then assert the entries an
 * installable extension needs are inside the tarball. A missing `index.ts` or a
 * missing `src/` turns the package into something Pi cannot load, and nothing
 * else in the pipeline would notice — the tests run from the checkout, where
 * every file is present by definition.
 *
 * Run with `npm run verify:package`. Exits non-zero on any missing required
 * entry, and on any development file that leaked into the package.
 */
import { execFileSync } from "node:child_process";

/** Entries an install must carry: Pi's directory entry point, the modules it
 * imports, and the files npm always includes for a published package. */
const REQUIRED = ["package.json", "index.ts", "src/extension.ts", "src/host-contract.ts", "README.md", "LICENSE"];

/** Directories that are development-only; `files` in package.json should keep
 * them out, and npm only adds package.json, README and LICENSE on its own. */
const DEVELOPMENT_ONLY = ["tests/", "odd/", "proposal/", ".github/", "scripts/"];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
// npm 12 returns an object keyed by package name; older npm returns an array of
// the same entries. Accept both instead of pinning to one npm major.
const parsed = JSON.parse(raw);
const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const entries = (packed?.files ?? []).map((file) => file.path);

const missing = REQUIRED.filter((path) => !entries.includes(path));
if (missing.length > 0) {
	console.error(`verify-package-files: missing from the package: ${missing.join(", ")}`);
	process.exit(1);
}

const leaked = entries.filter((path) => DEVELOPMENT_ONLY.some((prefix) => path.startsWith(prefix)));
if (leaked.length > 0) {
	console.error(`verify-package-files: development files in the package: ${leaked.join(", ")}`);
	process.exit(1);
}

console.log(`verify-package-files: ${entries.length} files, required entries present, no development files`);
