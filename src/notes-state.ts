// Gentle Notes pure state: the user's backlog of prompts to send to the chat
// later. Everything here is pure and serializable; persistence lives in
// storage.ts and rendering in notes-card.ts.

export const NOTE_STATUS = {
	PENDING: "pending",
	SENT: "sent",
} as const;

export type NoteStatus = (typeof NOTE_STATUS)[keyof typeof NOTE_STATUS];

export interface NoteTask {
	id: number;
	text: string;
	status: NoteStatus;
	createdAt: number;
	sentAt?: number;
	/** Set the first time the note reaches the sent list and kept when it is
	 * restored, so a note that already travelled can offer its way back to
	 * sent instead of living in the pending list forever. */
	everSent?: boolean;
}

export interface NotesState {
	notes: NoteTask[];
	nextId: number;
	ui?: NotesUIState;
}

export interface NotesUIState {
	railCollapsed?: boolean;
	foldAll?: boolean;
	foldOverrides?: Record<string, boolean>; // noteId -> folded
	sentCollapsed?: boolean;
}

export interface NotesSummary {
	pending: number;
	sent: number;
	total: number;
}

/** Result type shared by the mutating helpers: an error string or a new state. */
export type MutationResult<T> = { state: T } | string;

export function emptyNotes(): NotesState {
	return { notes: [], nextId: 1 };
}

function isNoteTask(value: unknown): value is NoteTask {
	if (!value || typeof value !== "object") return false;
	const note = value as Record<string, unknown>;
	if (typeof note.id !== "number" || !Number.isInteger(note.id) || note.id <= 0) return false;
	if (typeof note.text !== "string" || note.text.trim().length === 0) return false;
	if (note.status !== NOTE_STATUS.PENDING && note.status !== NOTE_STATUS.SENT) return false;
	if (typeof note.createdAt !== "number" || !Number.isFinite(note.createdAt)) return false;
	if (note.everSent !== undefined && typeof note.everSent !== "boolean") return false;
	if (note.status === NOTE_STATUS.SENT) {
		if (typeof note.sentAt !== "number" || !Number.isFinite(note.sentAt)) return false;
	} else if (note.sentAt !== undefined) return false;
	return true;
}

/** Structural guard for data loaded from disk or received over events. */
export function isNotesState(value: unknown): value is NotesState {
	if (!value || typeof value !== "object") return false;
	const state = value as Record<string, unknown>;
	if (!Array.isArray(state.notes) || !state.notes.every(isNoteTask)) return false;
	if (typeof state.nextId !== "number" || !Number.isInteger(state.nextId) || state.nextId < 1) return false;
	if (state.ui !== undefined) {
		if (typeof state.ui !== "object" || state.ui === null) return false;
		const ui = state.ui as Record<string, unknown>;
		if (ui.railCollapsed !== undefined && typeof ui.railCollapsed !== "boolean") return false;
		if (ui.foldAll !== undefined && typeof ui.foldAll !== "boolean") return false;
		if (ui.sentCollapsed !== undefined && typeof ui.sentCollapsed !== "boolean") return false;
		if (ui.foldOverrides !== undefined) {
			if (typeof ui.foldOverrides !== "object" || ui.foldOverrides === null) return false;
			for (const [k, v] of Object.entries(ui.foldOverrides)) {
				if (!/^\d+$/.test(k) || typeof v !== "boolean") return false;
			}
		}
	}
	return true;
}

/** Drop one matched pair of wrapping quotes, so `/note "buy milk"` and
 * `/note buy milk` capture the same text. Only a symmetric pair is unwrapped;
 * a lone quote is part of the note. */
export function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "\u201c" && last === "\u201d")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

/** Longest note the store accepts. A note is a line of thought the user wants
 * back later, not a document: without a cap a single paste turns into a
 * multi-megabyte JSON file that every session re-reads and re-wraps. */
export const MAX_NOTE_LENGTH = 2000;

/** Characters that must never reach the store, the render or the terminal:
 * C0 and DEL (raw control), C1 (their 8-bit forms, where `\u009b` is a CSI
 * introducer), the bidi embeddings/overrides and isolates (they let a note
 * reorder the row it is painted in), the invisible operators, the zero-width
 * space, the directional marks and the BOM.
 *
 * Deliberately kept: U+200C (ZWNJ) and U+200D (ZWJ) — they are content, not
 * control, and stripping them would break emoji sequences and complex
 * scripts. `\s` handles the line/paragraph separators and U+FEFF. */
const CONTROL_AND_FORMAT = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** Remove every character that could act as a terminal escape or spoof the
 * visual order of a row. The single source of truth for note text hygiene:
 * the store sanitizes on the way in, the card sanitizes on the way out. */
export function stripControlSequences(text: string): string {
	return text.replace(CONTROL_AND_FORMAT, "");
}

/** Normalize note text: collapse whitespace, strip control sequences, trim.
 * Empty string means invalid.
 *
 * Order matters and was learned the hard way: whitespace is folded to a space
 * BEFORE the controls are removed. Tab, newline and carriage return are C0
 * controls, so stripping first would glue a pasted paragraph into one long
 * word ("a\tb" -> "ab") instead of separating it ("a b"). */
export function cleanNoteText(value: unknown): string {
	if (typeof value !== "string") return "";
	return stripControlSequences(value.replace(/\s/g, " ")).replace(/ +/g, " ").trim();
}

/** The one message a too-long note gets, shared by add and edit so the limit
 * reads the same everywhere it is enforced. */
function tooLongMessage(length: number): string {
	return `note is too long (${length} chars, max ${MAX_NOTE_LENGTH})`;
}

export function addNote(state: NotesState, text: unknown, now: number): { state: NotesState; note: NoteTask } | string {
	const clean = cleanNoteText(text);
	if (clean.length === 0) return "note text is required";
	if (clean.length > MAX_NOTE_LENGTH) return tooLongMessage(clean.length);
	const note: NoteTask = { id: state.nextId, text: clean, status: NOTE_STATUS.PENDING, createdAt: now };
	return { state: { notes: [...state.notes, note], nextId: state.nextId + 1 }, note };
}

export function markSent(state: NotesState, id: number, now: number): MutationResult<NotesState> {
	const note = state.notes.find((candidate) => candidate.id === id);
	if (!note) return `no note #${id}`;
	if (note.status === NOTE_STATUS.SENT) return `note #${id} was already sent`;
	return {
		state: {
			...state,
			notes: state.notes.map((candidate) => (candidate.id === id ? { ...candidate, status: NOTE_STATUS.SENT, sentAt: now, everSent: true } : candidate)),
		},
	};
}

/** Inline editing: replace a pending note's text, keeping every other field.
 * Sent notes refuse to be edited — the prompt already left. */
export function updateNoteText(state: NotesState, id: number, text: unknown): MutationResult<NotesState> {
	const note = state.notes.find((candidate) => candidate.id === id);
	if (!note) return `no note #${id}`;
	if (note.status === NOTE_STATUS.SENT) return `note #${id} was already sent`;
	const clean = cleanNoteText(text);
	if (clean.length === 0) return "note text is required";
	if (clean.length > MAX_NOTE_LENGTH) return tooLongMessage(clean.length);
	return {
		state: {
			...state,
			notes: state.notes.map((candidate) => (candidate.id === id ? { ...candidate, text: clean } : candidate)),
		},
	};
}

/** Remove one note for good — the only hard delete. Ids never rewind, so a
 * note added later never reuses a deleted id. */
export function deleteNote(state: NotesState, id: number): MutationResult<NotesState> {
	const note = state.notes.find((candidate) => candidate.id === id);
	if (!note) return `no note #${id}`;
	return {
		state: {
			...state,
			notes: state.notes.filter((candidate) => candidate.id !== id),
		},
	};
}

/** Remove every note. The view flags survive on purpose: clearing the backlog
 * is not a reason to reopen a block the user collapsed. */
export function clearNotes(state: NotesState): { state: NotesState; removed: number } {
	const next = emptyNotes();
	return { state: state.ui ? { ...next, ui: state.ui } : next, removed: state.notes.length };
}

/** Remove every note in one status, keeping the other group, the id counter
 * and the view flags. Returns the same state object when nothing matched, so
 * the storage queue skips the write. */
export function clearByStatus(state: NotesState, status: NoteStatus): { state: NotesState; removed: number } {
	const kept = state.notes.filter((note) => note.status !== status);
	const removed = state.notes.length - kept.length;
	if (removed === 0) return { state, removed };
	return { state: { ...state, notes: kept }, removed };
}

export function notesSummary(state: NotesState): NotesSummary {
	const sent = state.notes.filter((note) => note.status === NOTE_STATUS.SENT).length;
	return { pending: state.notes.length - sent, sent, total: state.notes.length };
}

/** Restore a sent note back to pending — clears the sentAt timestamp. */
export function restoreNote(state: NotesState, id: number): MutationResult<NotesState> {
	const note = state.notes.find((candidate) => candidate.id === id);
	if (!note) return `no note #${id}`;
	if (note.status === NOTE_STATUS.PENDING) return `note #${id} is already pending`;
	return {
		state: {
			...state,
			notes: state.notes.map((candidate) => (candidate.id === id ? { ...candidate, status: NOTE_STATUS.PENDING, sentAt: undefined, everSent: true } : candidate)),
		},
	};
}

/** Update the persisted UI state (collapse, fold, sent collapse). */
export function setUIState(state: NotesState, ui: Partial<NotesUIState>): MutationResult<NotesState> {
	return {
		state: {
			...state,
			ui: { ...state.ui, ...ui },
		},
	};
}
