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
}

export interface NotesState {
	notes: NoteTask[];
	nextId: number;
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
	return true;
}

/** Normalize note text: collapse whitespace, trim. Empty string means invalid. */
export function cleanNoteText(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function addNote(state: NotesState, text: unknown, now: number): MutationResult<NotesState> & { note: NoteTask } | string {
	const clean = cleanNoteText(text);
	if (clean.length === 0) return "note text is required";
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
			notes: state.notes.map((candidate) => (candidate.id === id ? { ...candidate, status: NOTE_STATUS.SENT, sentAt: now } : candidate)),
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

export function clearNotes(state: NotesState): { state: NotesState; removed: number } {
	return { state: emptyNotes(), removed: state.notes.length };
}

export function notesSummary(state: NotesState): NotesSummary {
	const sent = state.notes.filter((note) => note.status === NOTE_STATUS.SENT).length;
	return { pending: state.notes.length - sent, sent, total: state.notes.length };
}
