import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { addNote, emptyNotes, markSent } from "../src/notes-state.ts";
import {
	loadNotes,
	mutateNotes,
	notesConfigHome,
	notesFilePath,
	projectSlug,
	saveNotes,
	watchNotes,
} from "../src/storage.ts";

function unwrap<V>(result: V | string): V {
	if (typeof result === "string") throw new Error(result);
	return result;
}

const bases: string[] = [];
let counter = 0;

function newBase(): string {
	const base = mkdtempSync(join(tmpdir(), "gentle-notes-test-"));
	bases.push(base);
	return base;
}

function newProject(base: string): string {
	const dir = join(base, `Proy ${++counter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

afterEach(() => {
	while (bases.length) rmSync(bases.pop() as string, { recursive: true, force: true });
});

describe("notesConfigHome", () => {
	it("honors GENTLE_PI_CONFIG_HOME when set", () => {
		assert.equal(notesConfigHome({ GENTLE_PI_CONFIG_HOME: "/tmp/x" }), "/tmp/x");
	});

	it("defaults to ~/.pi/gentle-ai", () => {
		assert.equal(notesConfigHome({}), join(homedir(), ".pi", "gentle-ai"));
	});
});

describe("projectSlug", () => {
	it("is the sanitized basename plus a stable short hash of the resolved path", () => {
		const path = "/some/where/My Project!";
		const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
		assert.equal(projectSlug(path), `my-project--${hash}`);
		assert.equal(projectSlug(path), projectSlug(path));
	});

	it("disambiguates the same basename under different parents", () => {
		assert.notEqual(projectSlug("/a/proj"), projectSlug("/b/proj"));
	});

	it("falls back to a stable slug when the basename has no usable characters", () => {
		assert.match(projectSlug("/"), /^project--[0-9a-f]{8}$/);
	});
});

describe("notesFilePath", () => {
	it("places one JSON file per project under <configHome>/notes", () => {
		const env = { GENTLE_PI_CONFIG_HOME: "/tmp/cfg" };
		const path = notesFilePath("/work/my proj", env);
		assert.equal(dirname(path), "/tmp/cfg/notes");
		assert.ok(path.endsWith(".json"));
		assert.ok(basename(path).startsWith("my-proj--"));
	});
});

describe("loadNotes", () => {
	it("returns an empty state when the file does not exist", () => {
		const base = newBase();
		const project = newProject(base);
		assert.deepEqual(loadNotes(project, { GENTLE_PI_CONFIG_HOME: base }), emptyNotes());
	});

	it("degrades to an empty state on malformed JSON", () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const path = notesFilePath(project, env);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ not json", "utf8");
		assert.deepEqual(loadNotes(project, env), emptyNotes());
	});

	it("degrades to an empty state on a valid JSON with an invalid shape", () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const path = notesFilePath(project, env);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ notes: "x", nextId: 3 }), "utf8");
		assert.deepEqual(loadNotes(project, env), emptyNotes());
	});
});

describe("saveNotes", () => {
	it("persists a roundtrip of pending and sent notes", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		let state = emptyNotes();
		state = unwrap(addNote(state, "uno", 10)).state;
		state = unwrap(addNote(state, "dos", 11)).state;
		state = unwrap(markSent(state, 1, 20)).state;
		await saveNotes(project, state, env);
		assert.deepEqual(loadNotes(project, env), state);
	});

	it("creates the notes directory and leaves no temp files behind", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const state = unwrap(addNote(emptyNotes(), "a", 1)).state;
		await saveNotes(project, state, env);
		const dir = join(base, "notes");
		assert.equal(existsSync(dir), true);
		const entries = readdirSync(dir);
		assert.equal(entries.length, 1);
		assert.ok(entries[0]?.endsWith(".json"));
	});

	it("overwrites the previous snapshot in place", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		await saveNotes(project, unwrap(addNote(emptyNotes(), "a", 1)).state, env);
		await saveNotes(project, unwrap(addNote(emptyNotes(), "b", 2)).state, env);
		const loaded = loadNotes(project, env);
		assert.deepEqual(
			loaded.notes.map((note) => note.text),
			["b"],
		);
	});
});

describe("mutateNotes", () => {
	it("applies a mutation and persists it", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const state = await mutateNotes(project, (current) => addNote(current, "hola", 1), env);
		assert.equal(state.notes.length, 1);
		assert.deepEqual(loadNotes(project, env), state);
	});

	it("serializes concurrent read-modify-write operations", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		await Promise.all([
			mutateNotes(project, (current) => addNote(current, "a", 1), env),
			mutateNotes(project, (current) => addNote(current, "b", 2), env),
		]);
		const loaded = loadNotes(project, env);
		assert.deepEqual(
			loaded.notes.map((note) => [note.id, note.text]),
			[[1, "a"], [2, "b"]],
		);
	});

	it("aborts without writing when the mutator returns an error", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const initial = await mutateNotes(project, (current) => addNote(current, "keep", 1), env);
		await assert.rejects(mutateNotes(project, () => "boom", env), /boom/);
		assert.deepEqual(loadNotes(project, env), initial);
	});

	it("skips the write when the mutator returns the same state", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const state = await mutateNotes(project, (current) => addNote(current, "a", 1), env);
		const path = notesFilePath(project, env);
		const before = readdirSync(join(base, "notes"));
		await mutateNotes(project, (current) => ({ state: current }), env);
		assert.deepEqual(loadNotes(project, env), state);
		// No atomic-rename churn: the same file entry remains.
		assert.deepEqual(readdirSync(join(base, "notes")), before);
	});
	it("creates its own store directory 0700 and the file 0600", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		await mutateNotes(project, (current) => addNote(current, "privada", 1), env);
		const dir = dirname(notesFilePath(project, env));
		const mode = (path: string): number => statSync(path).mode & 0o777;
		// Notes can hold anything the user pasted, so the store follows the same
		// rule as every gentle-shell store: owner only.
		assert.equal(mode(notesFilePath(project, env)), 0o600, "the notes file is owner read/write");
		assert.equal(mode(dir), 0o700, "the directory that holds it is owner only");
	});

	it("preserves an unreadable store instead of overwriting it", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const path = notesFilePath(project, env);
		mkdirSync(dirname(path), { recursive: true });
		const garbage = "{ this is not json";
		writeFileSync(path, garbage, "utf8");
		assert.deepEqual(loadNotes(project, env), emptyNotes(), "an unreadable file degrades to empty");

		await mutateNotes(project, (current) => addNote(current, "sobrevive", 1), env);

		const backup = readdirSync(dirname(path)).find((name) => name.includes("corrupt"));
		assert.ok(backup, `the unreadable payload is kept aside: ${JSON.stringify(readdirSync(dirname(path)))}`);
		assert.equal(readFileSync(join(dirname(path), backup as string), "utf8"), garbage, "byte for byte");
		assert.equal(loadNotes(project, env).notes[0]?.text, "sobrevive", "the store is usable again");
	});

	it("sets aside a store it cannot read instead of overwriting it", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const path = notesFilePath(project, env);
		mkdirSync(dirname(path), { recursive: true });
		const original = JSON.stringify({ notes: [], nextId: 7 });
		writeFileSync(path, original, "utf8");
		// A file that exists but cannot be read (EACCES) is not the same as a
		// missing one: the next save must not clobber what it could not see.
		chmodSync(path, 0o000);
		try {
			await mutateNotes(project, (current) => addNote(current, "sobrevive", 7), env);
		} finally {
			chmodSync(path, 0o600);
		}
		const dir = dirname(path);
		const backup = readdirSync(dir).find((name) => name.includes("corrupt"));
		assert.ok(backup, `the unreadable payload is kept aside: ${JSON.stringify(readdirSync(dir))}`);
		// The rename keeps the original mode, so the backup is as unreadable as
		// the file was: reopen it to prove the bytes survived.
		const backupPath = join(dir, backup as string);
		chmodSync(backupPath, 0o600);
		assert.equal(readFileSync(backupPath, "utf8"), original, "byte for byte");
		assert.equal(loadNotes(project, env).notes[0]?.text, "sobrevive", "the store is usable again");
	});

	it("keeps every preserved copy when two preserves land in the same millisecond (D3)", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const path = notesFilePath(project, env);
		const dir = dirname(path);
		mkdirSync(dir, { recursive: true });
		// Two sessions preserving the same project inside one millisecond is the
		// case a timestamp-only name loses: the rename silently overwrites the
		// first payload, which is the one thing this path exists to keep.
		const realNow = Date.now;
		Date.now = () => 1_700_000_000_000;
		try {
			writeFileSync(path, "primera basura", { mode: 0o600 });
			await mutateNotes(project, (current) => addNote(current, "uno", 1), env);
			writeFileSync(path, "segunda basura", { mode: 0o600 });
			await mutateNotes(project, (current) => addNote(current, "dos", 2), env);
		} finally {
			Date.now = realNow;
		}
		const backups = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
		assert.equal(backups.length, 2, `both payloads are preserved: ${JSON.stringify(backups)}`);
		const payloads = backups.map((name) => readFileSync(join(dir, name), "utf8")).sort();
		assert.deepEqual(payloads, ["primera basura", "segunda basura"], "each backup keeps its own bytes");
	});

	it("sets aside a store whose ids collide instead of merging them (P1.3)", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const path = notesFilePath(project, env);
		mkdirSync(dirname(path), { recursive: true });
		// A hand-edited store with one id on two notes: loading it would make
		// every id-keyed mutation speak for both, so it takes the same path as
		// any other unreadable file — preserved first, never merged.
		const colliding = JSON.stringify({
			notes: [
				{ id: 1, text: "una", status: "pending", createdAt: 1 },
				{ id: 1, text: "dos", status: "pending", createdAt: 2 },
			],
			nextId: 2,
		});
		writeFileSync(path, colliding, "utf8");
		assert.deepEqual(loadNotes(project, env), emptyNotes(), "a store that would delete two notes at once is not loaded");

		await mutateNotes(project, (current) => addNote(current, "sobrevive", 3), env);

		const dir = dirname(path);
		const backup = readdirSync(dir).find((name) => name.includes("corrupt"));
		assert.ok(backup, `the colliding payload is kept aside: ${JSON.stringify(readdirSync(dir))}`);
		assert.equal(readFileSync(join(dir, backup as string), "utf8"), colliding, "byte for byte");
		assert.equal(loadNotes(project, env).notes[0]?.text, "sobrevive", "the store is usable again");
	});

	it("keeps the other watchers alive when one subscriber throws", async () => {
		const base = newBase();
		const env = { GENTLE_PI_CONFIG_HOME: base };
		const project = newProject(base);
		const seen: string[] = [];
		const stopThrowing = watchNotes(project, () => {
			throw new Error("subscriber blew up");
		}, env);
		const stopOk = watchNotes(project, (state) => {
			seen.push(`ok:${state.notes.length}`);
		}, env);
		try {
			await mutateNotes(project, (current) => addNote(current, "a", 1), env);
			for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.deepEqual(seen, ["ok:1"], "the healthy subscriber still hears about the change");
		} finally {
			stopThrowing();
			stopOk();
		}
	});
});
