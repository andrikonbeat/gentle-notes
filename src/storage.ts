// Gentle Notes persistence: one JSON file per project under the gentle config
// home (~/.pi/gentle-ai/notes, overridable through GENTLE_PI_CONFIG_HOME).
// Writes are atomic (temp file + rename) and serialized per file so two
// concurrent sessions in the same project never interleave a read-modify-write.
// Real-time sync: file watcher notifies all sessions of external changes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, watch, type FSWatcher } from "node:fs";
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

/** A store read: the state to work with, plus whether the file on disk existed
 * but could not be understood. Callers must not overwrite an unreadable file
 * without preserving it first — that is the difference between a corrupt file
 * and a lost backlog. */
interface StoreRead {
	state: NotesState;
	unreadable: boolean;
}

/** Read the persisted state. Missing, malformed or invalid files degrade to an
 * empty state; this never throws so a bad file cannot break session start. */
function readStore(path: string): StoreRead {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		// A missing file is just the first save. Any other read failure — no
		// permission, a directory sitting in its place, a broken mount — means
		// the file is there and we cannot see it, so it has to be treated as
		// unreadable: the next write sets it aside instead of clobbering data
		// this process was never allowed to read.
		const code = (error as NodeJS.ErrnoException).code;
		return { state: emptyNotes(), unreadable: code !== "ENOENT" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isNotesState(parsed)) return { state: parsed, unreadable: false };
	} catch {
		// Fall through: the file exists but is not JSON.
	}
	return { state: emptyNotes(), unreadable: true };
}

function readState(path: string): NotesState {
	return readStore(path).state;
}

/** Move an unreadable store aside before it is replaced. Throws when the file
 * cannot be preserved: refusing to save is better than writing over the user's
 * data, and the caller surfaces the error. */
function preserveUnreadable(path: string): void {
	// Timestamps collide — two sessions preserving the same project inside one
	// millisecond — and a rename would silently overwrite the earlier payload,
	// which is the one thing this path exists to keep. The pid separates
	// processes and the loop separates calls within one.
	const stamp = Date.now();
	let backup = `${path}.corrupt-${stamp}-${process.pid}`;
	for (let attempt = 1; existsSync(backup); attempt += 1) {
		backup = `${path}.corrupt-${stamp}-${process.pid}-${attempt}`;
	}
	try {
		renameSync(path, backup);
	} catch (error) {
		throw new Error(
			`refusing to overwrite an unreadable notes file (${path}): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Directory and file modes for the store: notes can hold anything the user
 * pasted, so this follows the same rule as every gentle-shell store (see
 * `lib/agents-runner.ts` there): the owner reads and writes, nobody else does.
 * `mode` only applies to entries this process creates; an existing directory
 * keeps the permissions the user gave it. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function writeState(path: string, state: NotesState): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf8", mode: FILE_MODE });
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
		if (readStore(path).unreadable) preserveUnreadable(path);
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
		const current = readStore(path);
		const result = mutator(current.state);
		if (typeof result === "string") throw new Error(result);
		if (result.state !== current.state) {
			if (current.unreadable) preserveUnreadable(path);
			writeState(path, result.state);
		}
		return result.state;
	});
}

/** Callback fired when the notes file changes externally. */
export type NotesChangeCallback = (newState: NotesState) => void;

/** One watcher per notes file, shared by every session in this process. */
const watchers = new Map<string, { watcher: FSWatcher; callbacks: Set<NotesChangeCallback> }>();

/** Delay before re-reading after an event: the writer only finished renaming,
 * and a burst of events must collapse into one notification. */
const WATCH_DEBOUNCE_MS = 10;

/** Watch the notes file of a project and call `callback` with the new state
 * after every external write. Returns a cleanup function.
 *
 * The containing directory is watched, not the file: writes here are atomic
 * (temp file + rename), which replaces the inode and makes a file watcher go
 * deaf after the first save. The directory also exists before the first note,
 * so a brand new project has nothing to miss. */
export function watchNotes(projectPath: string, callback: NotesChangeCallback, env: NodeJS.ProcessEnv = process.env): () => void {
	const path = notesFilePath(projectPath, env);
	let entry = watchers.get(path);
	if (!entry) {
		const dir = dirname(path);
		const target = basename(path);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const created = { callbacks: new Set<NotesChangeCallback>() };
		const notify = (): void => {
			timer = undefined;
			const newState = readState(path);
			for (const cb of created.callbacks) {
				// A subscriber that throws (a repaint against a disposed TUI, say)
				// must not skip the others, and must never reach the event loop:
				// this runs in a timer, where an escaping throw is fatal to Pi.
				try {
					cb(newState);
				} catch {
					// Isolated on purpose: the file watcher is best effort.
				}
			}
		};
		let watcher: FSWatcher;
		try {
			mkdirSync(dir, { recursive: true });
			watcher = watch(dir, { persistent: true }, (_eventType, filename) => {
				// `filename` is null on some platforms: treat it as "this file changed".
				if (filename !== null && filename !== target && !filename.startsWith(`.${target}.`)) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(notify, WATCH_DEBOUNCE_MS);
			});
		} catch {
			// Best effort by contract: a config home that cannot be created or
			// watched (EACCES, ENOTDIR, a broken mount) must not throw out of
			// session start. The session simply runs without live sync.
			return () => {};
		}
		// A watcher error (the directory vanished, the process is out of inotify
		// handles) must never break the session: the UI just stops auto-syncing.
		watcher.on("error", () => {});
		// Never hold the event loop open: a Pi session keeps its own handles, and
		// a test or a short script must be able to exit with a watcher alive.
		watcher.unref();
		entry = { watcher, callbacks: created.callbacks };
		watchers.set(path, entry);
	}
	entry.callbacks.add(callback);

	return () => {
		const current = watchers.get(path);
		if (!current) return;
		current.callbacks.delete(callback);
		if (current.callbacks.size === 0) {
			current.watcher.close();
			watchers.delete(path);
		}
	};
}

/** Force reload the current state from disk (for manual sync). */
export function reloadNotes(projectPath: string, env: NodeJS.ProcessEnv = process.env): NotesState {
	return readState(notesFilePath(projectPath, env));
}
