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
import { NOTE_STATUS, notesSummary, stripControlSequences, type NoteTask, type NotesState, type NotesSummary } from "./notes-state.ts";
import { CARD_TONE, panelBodyWidth, panelExtraRows, panelHeaderRow, panelInnerWidth, paintPanelRows, renderCardPanel, renderPanelHeaderLine, type PanelCard } from "./card-chrome.ts";

export const NOTE_GLYPH = {
	pending: "✉",
	sent: "✓",
} as const;

export type NoteStatusKey = keyof typeof NOTE_GLYPH;

/** Hoverable send affordance drawn at the end of a pending rail row. */
export const SEND_GLYPH = "➤";

/** Per-row delete affordance after the send glyph (L27); muted, accent while
 * hovered — same grammar as the send glyph. */
export const DELETE_GLYPH = "×";

/** The trailing affordance of a pending row that already travelled: it goes
 * back to the sent list without another trip to the chat. Same column and
 * grammar as the × it replaces, success while hovered, so the row keeps one
 * shape and the reader learns the difference from the glyph alone. */
export const REVERT_GLYPH = "✓";

/** Restore affordance at the end of a sent row: puts the note back in the
 * pending list. Muted, accent while hovered — the send glyph's grammar. */
export const RESTORE_GLYPH = "↶";

/** Above this many notes the body folds: sent notes collapse into "✓ N sent"
 * and the pending tail into "… K more" (TODO grammar). Scaled to the taller
 * rail card (L24): half the screen shows ~19 body rows, so the list folds at
 * 18 instead of the Todos' 12. */
export const NOTES_ROW_CAP = 18;

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
	/** Pending rows: send, delete and inline edit all start on their first line. */
	hits: NotesCardHit[];
	/** Sent rows, mapped the same way, for the restore affordance. */
	sentHits: NotesCardHit[];
	/** The "✓ N sent ▾ Collapse" row: where it landed and the control text the
	 * click map looks for on that rendered line. Absent when no summary is
	 * painted (no sent notes, or a short expanded list). */
	sentHeader?: { row: number; control: string };
	summary: NotesSummary;
	/** Row index where the hidden note's inline editor belongs. Set only when
	 * hiddenNoteId named a pending note that was skipped from the body. */
	editSlot?: number;
}

/** Strip control characters so stored text can never smuggle terminal escapes. */
export function sanitizeNoteText(text: string): string {
	// Render-time belt for text that entered the store before the ingest rule
	// existed (see `stripControlSequences`): a repo upgraded in place must not
	// paint an escape sequence that is already on disk.
	return stripControlSequences(text);
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
 * affordance (accent while hovered, muted otherwise), air, ✕ delete affordance
 * (L27, same hover grammar); wrapped continuations indent to the text column. */
export function pendingRowLines(note: NoteTask, theme: NotesCardTheme, inner: number, hoveredId?: number, folded = false, deleteHoveredId?: number): string[] {
	// Three glyphs flank the text — status lead, send affordance, delete
	// affordance — each keeping its two columns of air (L11, L27).
	const width = Math.max(1, inner - GLYPH_GAP * 3 - 3);
	const segments = wrapNoteText(sanitizeNoteText(note.text), width);
	const [first = "", ...rest] = segments;
	const sendRole = hoveredId === note.id ? "accent" : "muted";
	// The trailing affordance is delete for a note the agent never saw, and
	// "back to sent" for one that already travelled: same column, same
	// grammar, different glyph — the note's own history decides which.
	const recycled = note.everSent === true;
	const deleteRole = deleteHoveredId === note.id ? (recycled ? "success" : "accent") : "muted";
	// Folded the note keeps one row: the first line, ellipsized when the note
	// goes on, padded to the text column so the send glyph holds its place and
	// the click target lands where the unfolded row had it.
	const head = folded ? padToColumns(foldedText(first, rest, width), width) : padToColumns(first, width);
	const lines = [
		`${theme.fg("accent", NOTE_GLYPH.pending)}${" ".repeat(GLYPH_GAP)}${theme.fg("text", head)}${" ".repeat(GLYPH_GAP)}${theme.fg(sendRole, SEND_GLYPH)}${" ".repeat(GLYPH_GAP)}${theme.fg(deleteRole, recycled ? REVERT_GLYPH : DELETE_GLYPH)}`,
	];
	if (folded) return lines;
	for (const segment of rest) lines.push(`${" ".repeat(GLYPH_GAP + 1)}${theme.fg("text", segment)}`);
	return lines;
}

/** Sent rail row: ✓ success glyph, air, the note struck through and dim per
 * line, and the ↶ restore affordance right-aligned (muted, accent while
 * hovered) so a sent note can go back to pending with one click; wrapped
 * continuations indent to the text column. */
export function sentRowLines(note: NoteTask, theme: NotesCardTheme, inner: number, folded = false, restoreHoveredId?: number): string[] {
	// Lead glyph, two columns of air, the text column, two more, and the
	// restore glyph: the row fills `inner` columns exactly.
	const width = Math.max(1, inner - GLYPH_GAP * 2 - 2);
	const segments = wrapNoteText(sanitizeNoteText(note.text), width);
	const [first = "", ...rest] = segments;
	const restoreRole = restoreHoveredId === note.id ? "accent" : "muted";
	const head = folded ? padToColumns(foldedText(first, rest, width), width) : padToColumns(first, width);
	const lines = [
		`${theme.fg("success", NOTE_GLYPH.sent)}${" ".repeat(GLYPH_GAP)}${theme.fg("dim", theme.strikethrough(head))}${" ".repeat(GLYPH_GAP)}${theme.fg(restoreRole, RESTORE_GLYPH)}`,
	];
	if (folded) return lines;
	for (const segment of rest) lines.push(`${" ".repeat(GLYPH_GAP + 1)}${theme.fg("dim", theme.strikethrough(segment))}`);
	return lines;
}

/** Pad a painted row to `width` visible columns. `padEnd` counts UTF-16 code
 * units, so a note carrying a double-width character (CJK, emoji) came out
 * wider than its column budget; the card clips in columns, and the trailing
 * affordance — the whole click target — fell off the row. Text that already
 * fills or overflows the budget simply gets no padding. */
function padToColumns(text: string, width: number): string {
	const pad = width - visibleWidth(text);
	return pad > 0 ? `${text}${" ".repeat(pad)}` : text;
}

/** The card body plus its hit map: pending rows first, sent rows last, folding
 * long lists into "✓ N sent" + "… K more" exactly like the TODO card. Every
 * pending row that survives folding maps its first physical line to its id so
 * the interactive card can hit-test the send glyph. Empty body for an empty
 * state — callers hide the widget instead. Pass hiddenNoteId while that note
 * is being edited inline: its rows are skipped and editSlot reports the row
 * where its editor belongs. foldedIds names the individual notes rendered as
 * one line (the per-note view state; the header control folds every note by
 * naming them all). sentCollapsed hides the individual sent notes behind the
 * summary row with a collapse/expand control. */
export function buildNotesCard(state: NotesState, theme: NotesCardTheme, inner: number, hoveredId?: number, hiddenNoteId?: number, options: { foldedIds?: ReadonlySet<number>; hoveredDeleteId?: number; hoveredRestoreId?: number; sentCollapsed?: boolean; sentCollapseHovered?: boolean } = {}): NotesCardView {
	const foldedIds = options.foldedIds ?? new Set<number>();
	const summary = notesSummary(state);
	const pending = state.notes.filter((note) => note.status === NOTE_STATUS.PENDING);
	const sent = state.notes.filter((note) => note.status === NOTE_STATUS.SENT);
	const bodyRows: string[] = [];
	const hits: NotesCardHit[] = [];
	const sentHits: NotesCardHit[] = [];
	let sentHeader: { row: number; control: string } | undefined;
	let editSlot: number | undefined;
	const pushPending = (note: NoteTask): void => {
		if (note.id === hiddenNoteId) {
			editSlot = bodyRows.length;
			return;
		}
		hits.push({ row: bodyRows.length, id: note.id });
		bodyRows.push(...pendingRowLines(note, theme, inner, hoveredId, foldedIds.has(note.id), options.hoveredDeleteId));
	};
	const sentCollapsed = options.sentCollapsed;
	const sentCollapseHovered = options.sentCollapseHovered ?? false;
	/** The sent note at the top of a rendered row; null while the row belongs
	 * to a pending note, the editor or the frame. */
	const pushSent = (note: NoteTask): void => {
		sentHits.push({ row: bodyRows.length, id: note.id });
		bodyRows.push(...sentRowLines(note, theme, inner, foldedIds.has(note.id), options.hoveredRestoreId));
	};

	// Long lists fold their sent notes by default (TODO grammar) and a short
	// list keeps them open — unless the view says otherwise: an explicit
	// collapse has to win over the list length, or the persisted state and the
	// control's own click would be ignored on a short backlog.
	const isLongList = state.notes.length > NOTES_ROW_CAP;
	const effectiveSentCollapsed = sentCollapsed ?? isLongList;
	const control = effectiveSentCollapsed ? "▸ Expand" : "▾ Collapse";
	/** The `✓ N sent` header and the rows it labels, pushed where the sent
	 * section actually starts. The control is always there when the section
	 * exists: a toggle that vanished once flipped would strand the section —
	 * collapsed with no way in on a short list, expanded with no way out on a
	 * long one — which is exactly what a short backlog used to do. */
	const pushSentSection = (): void => {
		if (sent.length === 0) return;
		const controlStyle = sentCollapseHovered ? "warning" : "accent";
		sentHeader = { row: bodyRows.length, control };
		bodyRows.push(`${theme.fg("success", NOTE_GLYPH.sent)}${" ".repeat(GLYPH_GAP)}${theme.fg("muted", `${sent.length} sent`)}  ${theme.fg(controlStyle, control)}`);
		if (!effectiveSentCollapsed) for (const note of sent) pushSent(note);
	};

	if (isLongList) {
		// Long list: the folded sent section first, the pending tail capped by
		// the row budget, and one row counting what the cap hid.
		pushSentSection();
		const foldedRows = sentHeader !== undefined ? 1 : 0;
		const room = NOTES_ROW_CAP - foldedRows - (pending.length > NOTES_ROW_CAP - foldedRows ? 1 : 0);
		for (const note of pending.slice(0, room)) pushPending(note);
		if (pending.length > room) bodyRows.push(theme.fg("muted", `… ${pending.length - room} more`));
	} else {
		// Short list: everything fits, pendings first because they are what the
		// user still has to send, then the sent section underneath its header.
		for (const note of pending) pushPending(note);
		pushSentSection();
	}
	return { bodyRows, hits, sentHits, summary, ...(sentHeader !== undefined ? { sentHeader } : {}), ...(editSlot !== undefined ? { editSlot } : {}) };
}

/** The single body row a collapsed block shows: the first pending note (or the
 * first sent one, struck), folded to one line; a muted placeholder when the
 * notepad is empty. Informational: the collapsed block exposes no actions. */
export function collapsedNoteRow(state: NotesState, theme: NotesCardTheme, inner: number): string[] {
	const width = Math.max(1, inner - GLYPH_GAP * 2);
	const note = state.notes.find((candidate) => candidate.status === NOTE_STATUS.PENDING)
		?? state.notes.find((candidate) => candidate.status === NOTE_STATUS.SENT);
	if (!note) return [theme.fg("muted", padToColumns("No notes", width))];
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
 * Visible column (0-based) where a glyph starts in a rendered row, skipping
 * ANSI escape sequences; undefined when the row has no such glyph.
 * Hit-testing reads the glyph position off the rendered line itself, so the
 * click target stays correct in every card style.
 */
/** Walks a rendered row glyph by glyph, reporting each one with the visible
 * column it starts at and the cells it occupies, while skipping ANSI escape
 * sequences. Every affordance column in this module reads rows through this one
 * walk: escapes, astral code points and double-width cells are handled in a
 * single place instead of four copies that could drift apart. */
function eachGlyph(line: string, visit: (character: string, column: number, width: number) => void): void {
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
		visit(character, column, width);
		column += width;
		index += character.length;
	}
}

/** Visible column (0-based) where a row's send affordance starts; undefined
 * when the row has no send glyph. The *last* match is the affordance: the note's
 * text is always painted before it, so a pending note whose own text carries a
 * `➤` cannot move the click target. */
export function sendGlyphColumn(line: string): number | undefined {
	return lastGlyphColumnOf(line, SEND_GLYPH);
}

/** Visible column (0-based) where the row's delete affordance starts (L27);
 * undefined when the row has no delete glyph. Last match, for the same reason
 * as the send affordance. */
export function deleteGlyphColumn(line: string): number | undefined {
	return lastGlyphColumnOf(line, DELETE_GLYPH);
}

/** Visible column (0-based) where the row's back-to-sent affordance starts;
 * undefined when the row carries no revert glyph. Last match, for the same
 * reason as the send affordance. */
export function revertGlyphColumn(line: string): number | undefined {
	return lastGlyphColumnOf(line, REVERT_GLYPH);
}

/** The column of a pending row's trailing affordance, whichever it paints:
 * × for a note that never travelled, ✓ for one that came back. The *last*
 * match is the affordance — the text always sits before it — so a note that
 * itself contains a ✓ or a × cannot move the target, and the row's chrome
 * (borders, padding) after it cannot either. Callers read it off a row the
 * hit maps vouch for. */
export function trailingGlyphColumn(line: string): number | undefined {
	let last: number | undefined;
	eachGlyph(line, (character, column) => {
		if (character === DELETE_GLYPH || character === REVERT_GLYPH) last = column;
	});
	return last;
}

/** Visible column (0-based) where the *last* occurrence of a glyph starts in a
 * rendered row, skipping ANSI escape sequences; undefined when the row has no
 * such glyph. A row whose text may carry the glyph itself reads its affordance
 * this way: the affordance is always painted after the text, so the last match
 * is the button and the note can never move the target. */
function lastGlyphColumnOf(line: string, glyph: string): number | undefined {
	let last: number | undefined;
	eachGlyph(line, (character, column) => {
		if (character === glyph) last = column;
	});
	return last;
}

/** Visible column (0-based) where a sent row's restore affordance starts;
 * undefined when the row carries no restore glyph. The last match wins, for the
 * same reason the trailing affordance does: a sent note whose own text contains
 * `↶` sits before the glyph that is painted after the padded text, so reading
 * the first match would let the note's content steal the click. */
export function restoreGlyphColumn(line: string): number | undefined {
	return lastGlyphColumnOf(line, RESTORE_GLYPH);
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
	eachGlyph(line, (character, column, width) => cells.push({ ch: character, column, width }));
	const plain = cells.map((cell) => cell.ch).join("");
	const at = plain.indexOf(needle, from);
	if (at < 0) return undefined;
	const first = cells[at] as { column: number };
	const last = cells[at + needle.length - 1] as { column: number; width: number };
	return { start: first.column, end: last.column + last.width - 1 };
}

/** Width from which the compact control shows its label, mirroring the Todos. */
const CONTROL_LABEL_WIDTH = 28;
/** Note rows the expanded compact shows per window; the wheel scrolls the
 * rest (L26). */
export const COMPACT_ROW_CAP = 8;

/** The expand/collapse control in the Todos grammar: chevron plus label while
 * the header has room, painted with the hover role while the pointer is on it
 * and the accent role otherwise. `text` is the unstyled label: it doubles as the
 * needle the click map finds on the rendered header row. */
function expandControl(collapsed: boolean, hovered: boolean, theme: NotesCardTheme, labelFits: boolean): { text: string; styled: string; width: number } {
	const text = `${collapsed ? "▸" : "▾"}${labelFits ? ` ${collapsed ? "Expand" : "Collapse"}` : ""}`;
	return { text, styled: hovered ? theme.fg("warning", text) : theme.fg("accent", text), width: text.length };
}

export interface CompactNotesView {
	rows: string[];
	/** Row the header (and its control) paints on. */
	headerRow: number;
	/** Visible column span of the control, while the header fits unclipped. */
	control?: { start: number; end: number };
	/** Pending-note hit rows, in rendered coordinates. */
	hits: NotesCardHit[];
	/** Sent-note hit rows, in rendered coordinates, for the restore glyph. */
	sentHits: NotesCardHit[];
	/** Body rows behind the expanded window: the widget clamps its scroll with it. */
	bodyTotal: number;
}

/** The compact notepad above the editor: one card-styled line — title, the
 * expand/collapse control inline, counts and the last note's first words —
 * with the panel's tone background, like the Todos header, and one blank row
 * of air below so the widget never reads as glued to the chat input (L23,
 * L28). No row above: pi already draws a spacer ahead of the whole
 * above-editor widget group, and the Todos card ends with its own blank row,
 * so a leading row here stacked two empty lines between the two headers.
 * Expanded it grows into the bounded note list with the same send glyphs as
 * the rail. */
export function buildCompactNotesRow(
	state: NotesState,
	theme: NotesCardTheme,
	width: number,
	options: { collapsed: boolean; controlHovered?: boolean; hoveredId?: number; hoveredDeleteId?: number; hoveredRestoreId?: number; scrollTop?: number },
): CompactNotesView {
	if (state.notes.length === 0) return { rows: [], headerRow: 0, hits: [], sentHits: [], bodyTotal: 0 };
	const summary = notesSummary(state);
	const counts = `${summary.pending} pend · ${summary.sent} sent`;
	// The control begins right after the rail mark, its air and the title word
	// — a fixed column in every style, two left of where the glyph put it —
	// and stays hit-testable while the control itself fits, even when the
	// counts and preview clip after it.
	const controlStart = 10;
	const inner = Math.floor(width) - 2;
	const label = `${options.collapsed ? "▸" : "▾"} ${options.collapsed ? "Expand" : "Collapse"}`;
	const labelFits = width >= CONTROL_LABEL_WIDTH && controlStart + label.length + 2 + visibleWidth(counts) <= inner;
	const control = expandControl(options.collapsed, options.controlHovered === true, theme, labelFits);
	// The last written note trails the counts, clipped to the room the header
	// leaves after them: the preview grows with the window and never widens
	// the row — the panel clips whatever is left over.
	const summaryStart = controlStart + control.width + 2;
	const previewRoom = inner - summaryStart - visibleWidth(counts);
	const last = state.notes[state.notes.length - 1];
	const preview = last && previewRoom >= 4 ? ` — ${truncateToWidth(sanitizeNoteText(last.text), previewRoom - 3, "…")}` : "";
	const card: PanelCard = { title: `Notes ${control.styled}`, subtitle: `${counts}${preview}`, body: [], tone: CARD_TONE.INFO, glyph: "" };
	// The control is hit-tested off the rendered header row, in both card
	// styles: the outlined frame paints the same control inside its title, so a
	// column derived from the float panel alone left it dead under NEON —
	// painted, but impossible to click, and the compact list never opened.
	//
	// One blank row of air below keeps the widget off the chat input. No row
	// above: pi already draws a single spacer ahead of the whole above-editor
	// widget group, and the Todos card ends with its own blank row, so a
	// leading row here stacked two empty lines between the two headers (L28).
	const spaced = (rows: string[], headerRow: number, hits: NotesCardHit[], sentHits: NotesCardHit[], bodyTotal: number): CompactNotesView => ({
		rows: [...rows, ""],
		headerRow,
		control: controlSpan(rows[headerRow] ?? "", control.text),
		hits,
		sentHits,
		bodyTotal,
	});
	if (options.collapsed) {
		return spaced(renderPanelHeaderLine(card, theme, width), 0, [], [], 0);
	}
	const view = buildNotesCard(state, theme, panelInnerWidth(theme, width), options.hoveredId, undefined, { hoveredDeleteId: options.hoveredDeleteId, hoveredRestoreId: options.hoveredRestoreId });
	const total = view.bodyRows.length;
	// The expanded list windows itself like the rail's body (L26): the wheel
	// scrolls it and the hint reports the range, so a long backlog is
	// reachable instead of dead-ending at "… N more".
	const scrollTop = Math.max(0, Math.min(options.scrollTop ?? 0, Math.max(0, total - COMPACT_ROW_CAP)));
	const visible = view.bodyRows.slice(scrollTop, scrollTop + COMPACT_ROW_CAP);
	const rows = renderCardPanel({ ...card, body: visible }, theme, width, { expanded: true });
	if (total > visible.length) {
		rows.push(...paintPanelRows([theme.fg("muted", truncateToWidth(`↑↓ ${scrollTop + 1}–${scrollTop + visible.length}/${total}`, panelBodyWidth(theme, width)))], theme, width));
	}
	const headerRow = panelHeaderRow(theme, width);
	// The float panel pads around its header; the outline frame does not.
	const bodyStart = panelExtraRows(theme, width) + 1;
	const windowed = (candidates: NotesCardHit[]): NotesCardHit[] => candidates
		.filter((hit) => hit.row >= scrollTop && hit.row < scrollTop + visible.length)
		.map((hit) => ({ ...hit, row: bodyStart + hit.row - scrollTop }));
	return spaced(rows, headerRow, windowed(view.hits), windowed(view.sentHits), total);
}
