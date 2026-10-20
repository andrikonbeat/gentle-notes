// Card-parity check: runs gentle-shell's own card renderer and this
// repository's replica side by side and compares the output byte for byte.
//
// The replica exists because the shell exposes no importable module for the
// card frame: an extension cannot reach `lib/shell-card.ts` of an installed
// `gentle-pi`, so the frame is copied here on purpose (see the header of
// src/card-chrome.ts). That copy is correct today and can drift silently the
// day upstream changes a border, a padding or the hint grammar, because the
// golden fixtures in tests/card-chrome.test.ts are strings generated once.
// This script is the guard against that drift: it is a development-time check,
// not a build step, so a clone without the (gitignored) upstream checkout
// reports it as unavailable instead of failing.
//
// Usage:
//   npm run check:card-parity
//   GENTLE_SHELL_ROOT=/path/to/gentle-shell npm run check:card-parity
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STYLE_SLOT = Symbol.for("gentle-pi.card-style");
const WIDTH = 46;
const STYLES = ["float", "neon"];

const root = process.env.GENTLE_SHELL_ROOT ?? "upstream/gentle-shell";
const upstreamFile = resolve(root, "lib/shell-card.ts");
const oursFile = resolve("src/card-chrome.ts");

if (!existsSync(upstreamFile)) {
	console.log(`card-parity: no upstream checkout at ${upstreamFile} — skipped (not a failure).`);
	process.exit(0);
}

const theme = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	bg: (role, text) => `[bg:${role}]${text}\x1b[49m`,
};

const ours = await import(pathToFileURL(oursFile).href);
let upstream;
try {
	upstream = await import(pathToFileURL(upstreamFile).href);
} catch (error) {
	console.error(`card-parity: the upstream renderer at ${upstreamFile} could not be loaded: ${error.message}`);
	process.exit(1);
}

const card = {
	title: "Notes",
	subtitle: "2 pend · 1 sent",
	body: [
		"<accent>✉</accent> revisar el padding del footer del blog <muted>➤</muted>",
		"<success>✓</success> <dim>~~mandar el PR~~</dim>",
	],
	tone: ours.CARD_TONE.INFO,
	glyph: ours.CARD_GLYPH,
};

const previous = globalThis[STYLE_SLOT];
const drifted = [];
try {
	for (const style of STYLES) {
		globalThis[STYLE_SLOT] = style;
		const theirs = upstream.renderCard(card, theme, WIDTH, { panel: true, expanded: true, hint: "alt+n" });
		const mine = ours.renderCardPanel(card, theme, WIDTH, { expanded: true, hint: "alt+n" });
		if (JSON.stringify(mine) === JSON.stringify(theirs)) {
			console.log(`card-parity: ${style} — identical (${mine.length} rows)`);
			continue;
		}
		drifted.push(style);
		console.error(`card-parity: ${style} — DIFFERS from upstream`);
		const rows = Math.max(mine.length, theirs.length);
		for (let index = 0; index < rows; index += 1) {
			if (mine[index] === theirs[index]) continue;
			console.error(`  row ${index}`);
			console.error(`    ours:     ${JSON.stringify(mine[index])}`);
			console.error(`    upstream: ${JSON.stringify(theirs[index])}`);
		}
	}
} finally {
	if (previous === undefined) delete globalThis[STYLE_SLOT];
	else globalThis[STYLE_SLOT] = previous;
}

if (drifted.length > 0) {
	console.error(`card-parity: ${drifted.length}/${STYLES.length} styles drifted — update src/card-chrome.ts or its golden fixtures.`);
	process.exit(1);
}
console.log(`card-parity: ${STYLES.length}/${STYLES.length} styles identical to ${root} at ${WIDTH} columns.`);
