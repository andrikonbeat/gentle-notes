#!/usr/bin/env node
// Re-applies the local `notes` rail-section patch to an installed gentle-pi
// (S12, L50).
//
// gentle-shell paints a hardcoded allowlist of fullscreen rail sections
// (["footer", "agents", "todo"]). This extension registers its card as the
// "notes" part, so a shell without that key never paints the notes, and
// src/sidebar-interop.ts then also suppresses the compact row above the editor:
// the notes render nowhere. The `notes` entry is a local patch to gentle-shell,
// kept in this repository's own checkout (`upstream/gentle-shell`, branch
// `notes-rail-section`), never upstream code. `gentle-pi` updates itself at
// startup and replaces the installed shell, which drops the patch again.
//
// Usage:
//   npm run patch:shell-rail              re-apply the patch, then restart Pi
//   npm run patch:shell-rail -- --check   report only (exit 1 when it is missing)
//
// The installed package comes from --root, else GENTLE_SHELL_ROOT, else
// ~/.pi/agent/npm/node_modules/gentle-pi. Only the two patched lines change,
// each file is replaced atomically and keeps its mode, and an unrecognised
// shape refuses the whole run instead of leaving a half-patched shell.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ROOT = join(homedir(), ".pi", "agent", "npm", "node_modules", "gentle-pi");
const USAGE = "patch-shell-rail: usage: patch-shell-rail [--check] [--root <path>]";

const TARGETS = [
	{
		file: "lib/shell-sidebar-layout.ts",
		what: "rail section list",
		patched: /^\s*const sections = \[[^\]]*"notes"[^\]]*\]/m,
		unpatched: /^([\t ]*)const sections = \["footer", "agents", "todo"\]\.filter\(\(key\) => key !== "todo" \|\| state\.visibility\?\.todo !== false\)\.map\(\(key\) => \{$/m,
		patch: (indent) =>
			`${indent}const sections = ["footer", "agents", "todo", "notes"].filter((key) => (key !== "todo" || state.visibility?.todo !== false) && (key !== "notes" || state.visibility?.notes !== false)).map((key) => {`,
	},
	{
		file: "lib/shell-sidebar.ts",
		what: "visibility type",
		patched: /^\s*visibility\?: \{[^}]*notes\?: boolean[^}]*\};$/m,
		unpatched: /^([\t ]*)visibility\?: \{ todo\?: boolean \};$/m,
		patch: (indent) => `${indent}visibility?: { todo?: boolean; notes?: boolean };`,
	},
];

const PREFIX = "patch-shell-rail: ";

/** Read-only plan for one package root: `patch`, `already`, `missing` or `unsupported`. */
function inspect(root) {
	return TARGETS.map((target) => {
		const path = join(root, target.file);
		const entry = { target, path, state: "unsupported", result: undefined };
		if (!existsSync(path)) {
			entry.state = "missing";
			return entry;
		}
		const text = readFileSync(path, "utf8");
		if (target.patched.test(text)) {
			entry.state = "already";
			return entry;
		}
		const match = target.unpatched.exec(text);
		if (!match) return entry;
		entry.state = "patch";
		entry.result = text.replace(target.unpatched, target.patch(match[1]));
		return entry;
	});
}

function report(lines) {
	for (const line of lines) console.error(line);
	return 1;
}

/** Replace the file atomically, keeping its mode. */
function write(path, text) {
	const mode = statSync(path).mode & 0o7777;
	const temporary = `${path}.patch-shell-rail-${process.pid}`;
	writeFileSync(temporary, text);
	chmodSync(temporary, mode);
	renameSync(temporary, path);
}

function main(argv) {
	let check = false;
	let root = process.env.GENTLE_SHELL_ROOT || DEFAULT_ROOT;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--check") {
			check = true;
			continue;
		}
		if (argument === "--root") {
			const value = argv[++index];
			if (value === undefined) return report([`${PREFIX}--root needs a path`, USAGE]);
			root = value;
			continue;
		}
		return report([`${PREFIX}unknown option ${argument}`, USAGE]);
	}
	if (!existsSync(root)) {
		return report([`${PREFIX}no gentle-pi package at ${root}`, `${PREFIX}pass --root <path> or set GENTLE_SHELL_ROOT`]);
	}

	const plan = inspect(root);
	const blocked = plan.filter((entry) => entry.state === "missing" || entry.state === "unsupported");
	if (blocked.length > 0) {
		return report([
			...blocked.map((entry) =>
				entry.state === "missing" ? `${PREFIX}${entry.target.file} is missing` : `${PREFIX}${entry.target.file} has no recognisable ${entry.target.what}`,
			),
			`${PREFIX}nothing written`,
		]);
	}

	const pending = plan.filter((entry) => entry.state === "patch");
	if (check) {
		for (const entry of plan) console.log(`${PREFIX}${entry.target.file} ${entry.state === "already" ? "already patched" : "needs patching"}`);
		if (pending.length === 0) {
			console.log(`${PREFIX}notes rail section present`);
			return 0;
		}
		console.log(`${PREFIX}run npm run patch:shell-rail`);
		return 1;
	}

	for (const entry of pending) write(entry.path, entry.result);
	for (const entry of plan) console.log(`${PREFIX}${entry.target.file} ${entry.state === "already" ? "already patched" : "patched"}`);
	if (pending.length === 0) console.log(`${PREFIX}nothing to do — the notes rail section is already patched`);
	else console.log(`${PREFIX}${pending.length} change${pending.length === 1 ? "" : "s"} applied — restart Pi to load the notes rail section`);
	return 0;
}

process.exit(main(process.argv.slice(2)));