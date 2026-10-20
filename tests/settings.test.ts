import assert from "node:assert/strict";
import { existsSync, statSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	DEFAULT_SETTINGS,
	SEND_DESTINATION,
	isNotesSettings,
	readSettings,
	settingsFilePath,
	writeSettings,
} from "../src/settings.ts";

const bases: string[] = [];

function newBase(): string {
	const base = mkdtempSync(join(tmpdir(), "gentle-notes-settings-"));
	bases.push(base);
	return base;
}

function envFor(base: string): NodeJS.ProcessEnv {
	return { GENTLE_PI_CONFIG_HOME: base } as NodeJS.ProcessEnv;
}

function writeRaw(base: string, body: string): string {
	const path = settingsFilePath(envFor(base));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, "utf8");
	return path;
}

afterEach(() => {
	while (bases.length) rmSync(bases.pop() as string, { recursive: true, force: true });
});

describe("notes settings", () => {
	it("lives beside the per-project note stores", () => {
		const path = settingsFilePath(envFor("/config/home"));
		assert.equal(path, join("/config/home", "notes", "settings.json"));
	});

	it("falls back to the defaults when nothing was ever saved", () => {
		const base = newBase();
		assert.deepEqual(readSettings(envFor(base)), DEFAULT_SETTINGS);
		assert.equal(readSettings(envFor(base)).sendDestination, SEND_DESTINATION.CHAT);
	});

	it("reads a saved destination", () => {
		const base = newBase();
		writeRaw(base, JSON.stringify({ version: 1, sendDestination: SEND_DESTINATION.EDITOR }));
		assert.deepEqual(readSettings(envFor(base)), { version: 1, sendDestination: SEND_DESTINATION.EDITOR });
	});

	it("keeps working when the file is malformed or unreadable", () => {
		const base = newBase();
		writeRaw(base, "{ not json");
		assert.deepEqual(readSettings(envFor(base)), DEFAULT_SETTINGS);
		// A directory where the file should be is unreadable for readFileSync:
		// session start must survive it instead of throwing.
		const other = newBase();
		mkdirSync(settingsFilePath(envFor(other)), { recursive: true });
		assert.deepEqual(readSettings(envFor(other)), DEFAULT_SETTINGS);
	});

	it("drops an unknown destination instead of trusting it", () => {
		const base = newBase();
		writeRaw(base, JSON.stringify({ version: 1, sendDestination: "telepathy" }));
		assert.equal(readSettings(envFor(base)).sendDestination, SEND_DESTINATION.CHAT);
	});

	it("validates the shape before trusting a value", () => {
		assert.equal(isNotesSettings({ version: 1, sendDestination: SEND_DESTINATION.EDITOR }), true);
		assert.equal(isNotesSettings({ version: 1, sendDestination: "telepathy" }), false);
		assert.equal(isNotesSettings({ sendDestination: SEND_DESTINATION.CHAT }), false);
		assert.equal(isNotesSettings(null), false);
		assert.equal(isNotesSettings([]), false);
	});

	it("writes atomically, leaving no temporary file behind", () => {
		const base = newBase();
		writeSettings({ version: 1, sendDestination: SEND_DESTINATION.EDITOR }, envFor(base));
		const path = settingsFilePath(envFor(base));
		assert.ok(existsSync(path), "the settings file exists");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, sendDestination: SEND_DESTINATION.EDITOR });
		assert.deepEqual(
			readdirSync(dirname(path)),
			["settings.json"],
			"no .tmp file survives the write",
		);
		assert.deepEqual(readSettings(envFor(base)), { version: 1, sendDestination: SEND_DESTINATION.EDITOR });
	});
	it("writes the settings file owner-only", () => {
		const base = newBase();
		const env = envFor(base);
		writeSettings({ version: 1, sendDestination: SEND_DESTINATION.EDITOR }, env);
		assert.equal(statSync(settingsFilePath(env)).mode & 0o777, 0o600);
	});
});
