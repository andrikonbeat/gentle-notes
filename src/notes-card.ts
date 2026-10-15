// Gentle Notes pure rendering: the card lines for the gentle-shell rail and
// the compact summary row for regular mode. Pure string building — the theme
// is injected (duck-typed to Pi's Theme: fg + strikethrough) so tests can pin
// exact output and the module stays free of runtime imports.
//
// Strikethrough follows the TODO grammar: wrap the text first, then style each
// physical line, so every line closes its own SGR 9 before padding and rails
// (mirrors shell-todo.ts taskRow). Glyphs: pending ✉ (accent), sent ✓ (success,
// dim strikethrough), send affordance ➤ (muted, accent while hovered, rail only).

import { NOTE_STATUS, notesSummary, type NoteTask, type NotesState } from "./notes-state.ts";

export const NOTE_GLYPH = {
	pending: "✉",
	sent: "✓",
} as const;

export type NoteStatusKey = keyof typeof NOTE_GLYPH;

/** Hoverable send affordance drawn at the end of a pending rail row. */
export const SEND_GLYPH = "➤";

/** Above this many note rows the sent notes fold into one line (TODO grammar). */
export const NOTES_ROW_CAP = 12;

export interface NotesCardTheme {
	fg(role: string, text: string): string;
	strikethrough(text: string): string;
}

/** One clickable pending row inside the rendered card, by physical line. */
export interface NotesCardHit {
	/** Zero-based line index within the card's own rendered lines. */
	row: number;
	/** The pending note that starts on that line; the send glyph sits on it. */
	id: number;
}

export interface NotesCardView {
	lines: string[];
	hits: NotesCardHit[];
}

/** Strip control characters so stored text can never smuggle terminal escapes. */
export function sanitizeNoteText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * Greedy word wrap for plain single-line text. Words longer than the width are
 * hard-split. Width is measured in code units — good enough for the accented
 * Latin scripts the notepad targets; exotic wide glyphs may overflow the card
 * edge visually but never break the layout tree.
 */
export function wrapNoteText(text: string, width: number): string[] {
	if (width < 1 || text.length === 0) return [];
	const words = text.split(" ").filter((word) => word.length > 0);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		let piece = word;
		while (piece.length > width) {
			if (current.length > 0) {
				lines.push(current);
				current = "";
			}
			lines.push(piece.slice(0, width));
			piece = piece.slice(width);
		}
		if (piece.length === 0) continue;
		const candidate = current.length === 0 ? piece : `${current} ${piece}`;
		if (candidate.length <= width) current = candidate;
		else {
			if (current.length > 0) lines.push(current);
			current = piece;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

/** Pending rail row: ✉ glyph, text padded to the right edge, ➤ send affordance
 * on the first line (accent while hovered, muted otherwise); wrapped
 * continuations are indented under the glyph. */
export function pendingRowLines(note: NoteTask, theme: NotesCardTheme, inner: number, hoveredId?: number): string[] {
	const width = Math.max(1, inner - 4);
	const segments = wrapNoteText(sanitizeNoteText(note.text), width);
	const [first = "", ...rest] = segments;
	const sendRole = hoveredId === note.id ? "accent" : "muted";
	const lines = [
		`${theme.fg("accent", NOTE_GLYPH.pending)} ${theme.fg("text", first.padEnd(width))}${theme.fg(sendRole, SEND_GLYPH)}`,
	];
	for (const segment of rest) lines.push(`  ${theme.fg("text", segment)}`);
	return lines;
}

/** Sent rail row: ✓ success glyph and the note struck through, dim, per line. */
export function sentRowLines(note: NoteTask, theme: NotesCardTheme, inner: number): string[] {
	const width = Math.max(1, inner - 4);
	const segments = wrapNoteText(sanitizeNoteText(note.text), width);
	const [first = "", ...rest] = segments;
	const lines = [`${theme.fg("success", NOTE_GLYPH.sent)} ${theme.fg("dim", theme.strikethrough(first))}`];
	for (const segment of rest) lines.push(`  ${theme.fg("dim", theme.strikethrough(segment))}`);
	return lines;
}

function cardHeader(state: NotesState, theme: NotesCardTheme): string {
	const summary = notesSummary(state);
	return `${theme.fg("accent", NOTE_GLYPH.pending)} ${theme.fg("text", "Notes")} ${theme.fg("muted", `· ${summary.pending} pend · ${summary.sent} sent`)}`;
}

/** The full rail card with its hit map: header plus pending rows first, sent
 * rows last, folding long lists into "✓ N sent" + "… K more" exactly like the
 * TODO card. Every pending row that survives folding maps its first physical
 * line to its id so the interactive card can hit-test the send glyph. Returns
 * no lines for an empty state — callers hide the widget instead. */
export function buildNotesCard(state: NotesState, theme: NotesCardTheme, inner: number, hoveredId?: number): NotesCardView {
	if (state.notes.length === 0) return { lines: [], hits: [] };
	const pending = state.notes.filter((note) => note.status === NOTE_STATUS.PENDING);
	const sent = state.notes.filter((note) => note.status === NOTE_STATUS.SENT);
	const lines: string[] = [cardHeader(state, theme)];
	const hits: NotesCardHit[] = [];
	const pushPending = (note: NoteTask): void => {
		hits.push({ row: lines.length, id: note.id });
		lines.push(...pendingRowLines(note, theme, inner, hoveredId));
	};
	if (state.notes.length <= NOTES_ROW_CAP) {
		for (const note of pending) pushPending(note);
		for (const note of sent) lines.push(...sentRowLines(note, theme, inner));
	} else {
		if (sent.length > 0) lines.push(`${theme.fg("success", NOTE_GLYPH.sent)} ${theme.fg("muted", `${sent.length} sent`)}`);
		const foldedRows = sent.length > 0 ? 1 : 0;
		const room = NOTES_ROW_CAP - foldedRows - (pending.length > NOTES_ROW_CAP - foldedRows ? 1 : 0);
		for (const note of pending.slice(0, room)) pushPending(note);
		if (pending.length > room) lines.push(theme.fg("muted", `… ${pending.length - room} more`));
	}
	return { lines, hits };
}

/** Lines-only view of the card (kept for callers that do not hit-test). */
export function notesCardLines(state: NotesState, theme: NotesCardTheme, inner: number): string[] {
	return buildNotesCard(state, theme, inner).lines;
}

/** Compact one-row summary for regular mode: header plus the last pending note
 * by id, truncated with an ellipsis to fit the row. The quote is dropped when
 * the row is too narrow to hold a useful fragment. */
export function notesSummaryRow(state: NotesState, theme: NotesCardTheme, inner: number): string {
	const summary = notesSummary(state);
	const header = cardHeader(state, theme);
	if (summary.pending === 0) return header;
	const lastPending = state.notes.filter((note) => note.status === NOTE_STATUS.PENDING).pop();
	if (!lastPending) return header;
	const base = `✉ Notes · ${summary.pending} pend · ${summary.sent} sent`.length;
	const available = inner - base - 3;
	if (available < 5) return header;
	const budget = available - 2;
	const text = sanitizeNoteText(lastPending.text);
	const shown = text.length <= budget ? text : `${text.slice(0, Math.max(1, budget - 1))}…`;
	return `${header}${theme.fg("muted", ` — "${shown}"`)}`;
}
