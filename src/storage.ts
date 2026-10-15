// Gentle Notes persistence: one JSON file per project under the gentle config
// home (~/.pi/gentle-ai/notes, overridable through GENTLE_PI_CONFIG_HOME).
// Writes are atomic (temp file + rename) and serialized per file so two
// concurrent sessions in the same project never interleave a read-modify-write.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { emptyNotes, isNotesState, type NotesState } from "./notes-state.ts";

export function notesConfigHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.GENTLE_PI_CONFIG_HOME || join(homedir(), ".pi", "gentle-ai");
}

/** Sanitized project basename plus a short hash of the resolved path, so the
 * same directory name under different parents never shares a file. */
export function projectSlug(projectPath: string): string {
	const resolved = resolve(projectPath);
	const raw = basename(resolved)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
	return `${raw || "project"}--${hash}`;
}

export function notesFilePath(projectPath: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(notesConfigHome(env), "notes", `${projectSlug(projectPath)}.json`);
}

/** Read the persisted state. Missing, malformed or invalid files degrade to an
 * empty state; this never throws so a bad file cannot break session start. */
function readState(path: string): NotesState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isNotesState(parsed) ? parsed : emptyNotes();
	} catch {
		return emptyNotes();
	}
}

function writeState(path: string, state: NotesState): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

// Per-file mutation queue: every read-modify-write waits for the previous one
// on the same path. Settled tails stay in the map; the map is bounded by the
// number of distinct projects used in the process.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(path: string, operation: () => T): Promise<T> {
	const tail = (queues.get(path) ?? Promise.resolve()).then(
		() => {},
		() => {},
	);
	const run = tail.then(operation);
	queues.set(
		path,
		run.then(
			() => {},
			() => {},
		),
	);
	return run;
}

/** Load the current state for a project. Sync on purpose: this is the initial
 * read at session start. Use mutateNotes for everything that can race. */
export function loadNotes(projectPath: string, env: NodeJS.ProcessEnv = process.env): NotesState {
	return readState(notesFilePath(projectPath, env));
}

export function saveNotes(projectPath: string, state: NotesState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const path = notesFilePath(projectPath, env);
	return enqueue(path, () => {
		writeState(path, state);
	});
}

/** Read-modify-write through the per-file queue. The mutator returns a new
 * state (persisted) or an error string (rejected, nothing written). Returning
 * the same state object skips the write. */
export function mutateNotes(
	projectPath: string,
	mutator: (state: NotesState) => { state: NotesState } | string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<NotesState> {
	const path = notesFilePath(projectPath, env);
	return enqueue(path, () => {
		const current = readState(path);
		const result = mutator(current);
		if (typeof result === "string") throw new Error(result);
		if (result.state !== current) writeState(path, result.state);
		return result.state;
	});
}
