// Gentle Notes pure rendering. Row builders stay plain and theme-injected
// (duck-typed to Pi's Theme: fg + strikethrough); the rail card's chrome lives
// in card-chrome.ts (gentle-shell panel replica), and the extension composes
// the two: buildNotesCard produces body rows and their hit map, the card
// wrapper adds the frame exactly like the Status/Todos panels.
//
// Strikethrough follows the TODO grammar: wrap the text first, then style each
// physical line, so every line closes its own SGR 9 before padding and rails.
// Glyphs: pending ✉ (accent), sent ✓ (success, dim strikethrough), send
// affordance ➤ (muted, accent while hovered, rail rows only).

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { NOTE_STATUS, notesSummary, type NoteTask, type NotesState, type NotesSummary } from "./notes-state.ts";
import { CARD_TONE, panelExtraRows, panelFloatApplies, panelHeaderRow, panelInnerWidth, renderCardPanel, renderPanelHeaderLine, type PanelCard } from "./card-chrome.ts";

export const NOTE_GLYPH = {
	pending: "✉",
	sent: "✓",
} as const;

export type NoteStatusKey = keyof typeof NOTE_GLYPH;

/** Hoverable send affordance drawn at the end of a pending rail row. */
export const SEND_GLYPH = "➤";

/** Above this many body rows the sent notes fold into one line (TODO grammar). */
export const NOTES_ROW_CAP = 12;

export interface NotesCardTheme {
	fg(role: string, text: string): string;
	strikethrough(text: string): string;
}

/** One clickable pending row inside the card body, by physical line. */
export interface NotesCardHit {
	/** Zero-based line index within the card's body rows. */
	row: number;
	/** The pending note that starts on that line; the send glyph sits on it. */
	id: number;
}

export interface NotesCardView {
	/** Pre-fit body rows for a panel body (callers pass panelInnerWidth). */
	bodyRows: string[];
	hits: NotesCardHit[];
	summary: NotesSummary;
	/** Row index where the hidden note's inline editor belongs. Set only when
	 * hiddenNoteId named a pending note that was skipped from the body. */
	editSlot?: number;
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

/** Columns of breathing room around the row glyphs (L11): the glyphs never
 * touch the note text, and wrapped continuations align with its first column. */
const GLYPH_GAP = 2;

/** The single line a folded note keeps: its first wrapped line, ellipsized
 * when the note goes on, so a folded list reads like a compact TODO. */
function foldedText(first: string, rest: readonly string[], width: number): string {
	return rest.length === 0 ? first : `${truncateToWidth(first, Math.max(1, width - 1), "")}…`;
}

/** Pending rail row: ✉ glyph, air, text padded to the right edge, air, ➤ send
 * affordance (accent while hovered, muted otherwise); wrapped continuations
 * indent to the text column. */
export function pendingRowLines(note: NoteTask, theme: NotesCardTheme, inner: number, hoveredId?: number, folded = false): string[] {
	const width = Math.max(1, inner - GLYPH_GAP * 2 - 2);
	const segments = wrapNoteText(sanitizeNoteText(note.text), width);
	const [first = "", ...rest] = segments;
	const sendRole = hoveredId === note.id ? "accent" : "muted";
	// Folded the note keeps one row: the first line, ellipsized when the note
	// goes on, padded to the text column so the send glyph holds its place and
	// the click target lands where the unfolded row had it.
	const head = folded ? foldedText(first, rest, width).padEnd(width) : first.padEnd(width);
	const lines = [
		`${theme.fg("accent", NOTE_GLYPH.pending)}${" ".repeat(GLYPH_GAP)}${theme.fg("text", head)}${" ".repeat(GLYPH_GAP)}${theme.fg(sendRole, SEND_GLYPH)}`,
	];
	if (folded) return lines;
	for (const segment of rest) lines.push(`${" ".repeat(GLYPH_GAP + 1)}${theme.fg("text", segment)}`);
	return lines;
}

/** Sent rail row: ✓ success glyph, air, and the note struck through, dim, per
 * line; continuations indent to the text column. */
export function sentRowLines(note: NoteTask, theme: NotesCardTheme, inner: number, folded = false): string[] {
	const width = Math.max(1, inner - GLYPH_GAP * 2 - 2);
	const segments = wrapNoteText(sanitizeNoteText(note.text), width);
	const [first = "", ...rest] = segments;
	const lines = [`${theme.fg("success", NOTE_GLYPH.sent)}${" ".repeat(GLYPH_GAP)}${theme.fg("dim", theme.strikethrough(folded ? foldedText(first, rest, width) : first))}`];
	if (folded) return lines;
	for (const segment of rest) lines.push(`${" ".repeat(GLYPH_GAP + 1)}${theme.fg("dim", theme.strikethrough(segment))}`);
	return lines;
}

/** The card body plus its hit map: pending rows first, sent rows last, folding
 * long lists into "✓ N sent" + "… K more" exactly like the TODO card. Every
 * pending row that survives folding maps its first physical line to its id so
 * the interactive card can hit-test the send glyph. Empty body for an empty
 * state — callers hide the widget instead. Pass hiddenNoteId while that note
 * is being edited inline: its rows are skipped and editSlot reports the row
 * where its editor belongs. foldedIds names the individual notes rendered as
 * one line (the per-note view state; the header control folds every note by
 * naming them all). */
export function buildNotesCard(state: NotesState, theme: NotesCardTheme, inner: number, hoveredId?: number, hiddenNoteId?: number, options: { foldedIds?: ReadonlySet<number> } = {}): NotesCardView {
	const foldedIds = options.foldedIds ?? new Set<number>();
	const summary = notesSummary(state);
	const pending = state.notes.filter((note) => note.status === NOTE_STATUS.PENDING);
	const sent = state.notes.filter((note) => note.status === NOTE_STATUS.SENT);
	const bodyRows: string[] = [];
	const hits: NotesCardHit[] = [];
	let editSlot: number | undefined;
	const pushPending = (note: NoteTask): void => {
		if (note.id === hiddenNoteId) {
			editSlot = bodyRows.length;
			return;
		}
		hits.push({ row: bodyRows.length, id: note.id });
		bodyRows.push(...pendingRowLines(note, theme, inner, hoveredId, foldedIds.has(note.id)));
	};
	if (state.notes.length <= NOTES_ROW_CAP) {
		for (const note of pending) pushPending(note);
		for (const note of sent) bodyRows.push(...sentRowLines(note, theme, inner, foldedIds.has(note.id)));
	} else {
		if (sent.length > 0) bodyRows.push(`${theme.fg("success", NOTE_GLYPH.sent)}${" ".repeat(GLYPH_GAP)}${theme.fg("muted", `${sent.length} sent`)}`);
		const foldedRows = sent.length > 0 ? 1 : 0;
		const room = NOTES_ROW_CAP - foldedRows - (pending.length > NOTES_ROW_CAP - foldedRows ? 1 : 0);
		for (const note of pending.slice(0, room)) pushPending(note);
		if (pending.length > room) bodyRows.push(theme.fg("muted", `… ${pending.length - room} more`));
	}
	return { bodyRows, hits, summary, ...(editSlot !== undefined ? { editSlot } : {}) };
}

/** The single body row a collapsed block shows: the first pending note (or the
 * first sent one, struck), folded to one line; a muted placeholder when the
 * notepad is empty. Informational: the collapsed block exposes no actions. */
export function collapsedNoteRow(state: NotesState, theme: NotesCardTheme, inner: number): string[] {
	const width = Math.max(1, inner - GLYPH_GAP * 2);
	const note = state.notes.find((candidate) => candidate.status === NOTE_STATUS.PENDING)
		?? state.notes.find((candidate) => candidate.status === NOTE_STATUS.SENT);
	if (!note) return [theme.fg("muted", "No notes".padEnd(width))];
	const [first = "", ...rest] = wrapNoteText(sanitizeNoteText(note.text), width);
	const text = foldedText(first, rest, width);
	if (note.status === NOTE_STATUS.SENT) return [`${theme.fg("success", NOTE_GLYPH.sent)}${" ".repeat(GLYPH_GAP)}${theme.fg("dim", theme.strikethrough(text))}`];
	return [`${theme.fg("accent", NOTE_GLYPH.pending)}${" ".repeat(GLYPH_GAP)}${theme.fg("text", text)}`];
}

/** The two header controls in the Todos grammar: the chevron shows the current
 * state, the label names what a click does, and the label is dropped when the
 * header has no room for it. The texts double as the needles the click map
 * looks up on the rendered header row (controlSpan). */
export function railControlText(options: { collapsed: boolean; folded: boolean; labelFits: boolean }): { collapse: string; fold: string } {
	const chevron = (open: boolean): string => (open ? "▾" : "▸");
	const label = (text: string): string => (options.labelFits ? ` ${text}` : "");
	return {
		collapse: `${chevron(!options.collapsed)}${label(options.collapsed ? "Expand" : "Collapse")}`,
		// "Fold"/"Full" instead of "Fold"/"Unfold": the rail header is 42
		// columns wide, and the longer pair overflowed it in the folded state.
		fold: `${chevron(!options.folded)}${label(options.folded ? "Full" : "Fold")}`,
	};
}

const ANSI_OR_CONTROL = /^\x1b\[[0-9;?]*[A-Za-z]/;

/**
 * Visible column (0-based) where the send glyph starts in a rendered row,
 * skipping ANSI escape sequences; undefined when the row has no send glyph.
 * Hit-testing reads the glyph position off the rendered line itself, so the
 * click target stays correct in every card style.
 */
export function sendGlyphColumn(line: string): number | undefined {
	let column = 0;
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\x1b") {
			const match = ANSI_OR_CONTROL.exec(line.slice(index));
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		const codePoint = line.codePointAt(index) as number;
		const character = String.fromCodePoint(codePoint);
		if (character === SEND_GLYPH) return column;
		column += visibleWidth(character);
		index += character.length;
	}
	return undefined;
}

/**
 * Visible column span of a control needle inside a rendered row, skipping ANSI
 * escapes and measuring in columns, so the click target stays correct in every
 * card style. Searches from `from` so two identical chevrons (collapsed block,
 * folded notes) can be told apart by order.
 */
export function controlSpan(line: string, needle: string, from = 0): { start: number; end: number } | undefined {
	if (needle.length === 0) return undefined;
	const cells: { ch: string; column: number; width: number }[] = [];
	let index = 0;
	let column = 0;
	while (index < line.length) {
		if (line[index] === "\x1b") {
			const match = ANSI_OR_CONTROL.exec(line.slice(index));
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		const codePoint = line.codePointAt(index) as number;
		const character = String.fromCodePoint(codePoint);
		const width = visibleWidth(character);
		cells.push({ ch: character, column, width });
		column += width;
		index += character.length;
	}
	const plain = cells.map((cell) => cell.ch).join("");
	const at = plain.indexOf(needle, from);
	if (at < 0) return undefined;
	const first = cells[at] as { column: number };
	const last = cells[at + needle.length - 1] as { column: number; width: number };
	return { start: first.column, end: last.column + last.width - 1 };
}

/** Width from which the compact control shows its label, mirroring the Todos. */
const CONTROL_LABEL_WIDTH = 28;
/** Note rows the expanded compact shows before folding the rest. */
const COMPACT_ROW_CAP = 8;

/** The expand/collapse control in the Todos grammar: chevron plus label while
 * the header has room, painted with the hover role while the pointer is on it
 * and the accent role otherwise. */
function expandControl(collapsed: boolean, hovered: boolean, theme: NotesCardTheme, labelFits: boolean): { styled: string; width: number } {
	const text = `${collapsed ? "▸" : "▾"}${labelFits ? ` ${collapsed ? "Expand" : "Collapse"}` : ""}`;
	return { styled: hovered ? theme.fg("warning", text) : theme.fg("accent", text), width: text.length };
}

export interface CompactNotesView {
	rows: string[];
	/** Row the header (and its control) paints on. */
	headerRow: number;
	/** Visible column span of the control, while the header fits unclipped. */
	control?: { start: number; end: number };
	/** Pending-note hit rows, in rendered coordinates. */
	hits: NotesCardHit[];
}

/** The compact notepad above the editor: one card-styled line — glyph with
 * its air, title, the expand/collapse control inline, summary trailing —
 * with the panel's tone background, like the Todos header. Expanded it
 * grows into the bounded note list with the same send glyphs as the rail. */
export function buildCompactNotesRow(
	state: NotesState,
	theme: NotesCardTheme,
	width: number,
	options: { collapsed: boolean; controlHovered?: boolean; hoveredId?: number },
): CompactNotesView {
	if (state.notes.length === 0) return { rows: [], headerRow: 0, hits: [] };
	const summary = notesSummary(state);
	const subtitle = `${summary.pending} pend · ${summary.sent} sent`;
	// The control begins right after the rail, the glyph and the title word —
	// a fixed column in every style — and only hit-tests while the header
	// fits the row without clipping.
	const controlStart = 12;
	const room = width - 2;
	const label = `${options.collapsed ? "▸" : "▾"} ${options.collapsed ? "Expand" : "Collapse"}`;
	const labelFits = width >= CONTROL_LABEL_WIDTH && 13 + label.length + visibleWidth(subtitle) <= room;
	const control = expandControl(options.collapsed, options.controlHovered === true, theme, labelFits);
	const span = panelFloatApplies(theme, width) && 13 + control.width + visibleWidth(subtitle) <= room
		? { start: controlStart, end: controlStart + control.width - 1 }
		: undefined;
	const card: PanelCard = { title: `Notes ${control.styled}`, subtitle, body: [], tone: CARD_TONE.INFO, glyph: "✉ " };
	if (options.collapsed) {
		return { rows: renderPanelHeaderLine(card, theme, width), headerRow: 0, control: span, hits: [] };
	}
	const view = buildNotesCard(state, theme, panelInnerWidth(theme, width), options.hoveredId);
	const body = view.bodyRows.slice(0, COMPACT_ROW_CAP);
	if (view.bodyRows.length > body.length) body.push(theme.fg("muted", `… ${view.bodyRows.length - body.length} more`));
	const rows = renderCardPanel({ ...card, body }, theme, width, { expanded: true });
	const headerRow = panelHeaderRow(theme, width);
	// The float panel pads around its header; the outline frame does not.
	const bodyStart = panelExtraRows(theme, width) + 1;
	return {
		rows,
		headerRow,
		control: span,
		hits: view.hits.filter((hit) => hit.row < COMPACT_ROW_CAP).map((hit) => ({ ...hit, row: bodyStart + hit.row })),
	};
}
