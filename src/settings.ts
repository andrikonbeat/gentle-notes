// Gentle Notes settings: one plugin-wide file beside the per-project note
// stores. A preference like "where does a sent note land" belongs to the
// plugin, not to one repository, so it lives once in the config home instead
// of inside every project's notes file.
// Reads are tolerant (a corrupt file degrades to defaults, never throws at
// session start) and writes are atomic, exactly like the note store.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { notesConfigHome } from "./storage.ts";

/** Where a sent note goes: straight to the agent, or into the chat's editor
 * so the user can still edit it before pressing Enter. */
export const SEND_DESTINATION = {
	CHAT: "chat",
	EDITOR: "editor",
} as const;

export type SendDestination = (typeof SEND_DESTINATION)[keyof typeof SEND_DESTINATION];

export interface NotesSettings {
	version: 1;
	sendDestination: SendDestination;
}

/** Sending straight to the chat is the historical behavior: an upgrade never
 * changes what the user already learned to expect. */
export const DEFAULT_SETTINGS: NotesSettings = {
	version: 1,
	sendDestination: SEND_DESTINATION.CHAT,
};

/** `~/.pi/gentle-ai/notes/settings.json`: the same directory as the per-project
 * stores, one level up from any project. */
export function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(notesConfigHome(env), "notes", "settings.json");
}

/** Structural guard for a file that may have been hand-edited or written by an
 * older build. */
export function isNotesSettings(value: unknown): value is NotesSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const settings = value as Record<string, unknown>;
	if (settings.version !== 1) return false;
	return settings.sendDestination === SEND_DESTINATION.CHAT || settings.sendDestination === SEND_DESTINATION.EDITOR;
}

/** Read the settings. A missing, malformed or partial file degrades to the
 * defaults; the caller never has to guard the result. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): NotesSettings {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsFilePath(env), "utf8"));
		if (isNotesSettings(parsed)) return { version: 1, sendDestination: parsed.sendDestination };
		// A file with a valid destination but a wrong/absent version still
		// carries the user's choice: keep it rather than silently resetting.
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const destination = (parsed as Record<string, unknown>).sendDestination;
			if (destination === SEND_DESTINATION.CHAT || destination === SEND_DESTINATION.EDITOR) {
				return { version: 1, sendDestination: destination };
			}
		}
		return DEFAULT_SETTINGS;
	} catch {
		return DEFAULT_SETTINGS;
	}
}

/** Persist the settings atomically: temp file in the same directory, then a
 * rename, so a crash mid-write can never leave a truncated settings file. */
/** Owner-only, like every store gentle-shell owns (`lib/agents-runner.ts`
 * there uses the same pair). Settings are not secret, but a config file the
 * whole machine can rewrite is not worth the exception. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function writeSettings(settings: NotesSettings, env: NodeJS.ProcessEnv = process.env): void {
	const path = settingsFilePath(env);
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf8", mode: FILE_MODE });
	renameSync(tmp, path);
}
