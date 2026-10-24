import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NOTE_STATUS, addNote, emptyNotes, markSent, type NoteTask } from "../src/notes-state.ts";
import {
	NOTES_ROW_CAP,
	DELETE_GLYPH,
	NOTE_GLYPH,
	REVERT_GLYPH,
	SEND_GLYPH,
	buildNotesCard,
	buildCompactNotesRow,
	collapsedNoteRow,
	controlSpan,
	deleteGlyphColumn,
	railControlText,
	pendingRowLines,
	restoreGlyphColumn,
	revertGlyphColumn,
	trailingGlyphColumn,
	sanitizeNoteText,
	sendGlyphColumn,
	sentRowLines,
	wrapNoteText,
	type NotesCardTheme,
} from "../src/notes-card.ts";

/** Deterministic fake theme: roles become readable tags, strikethrough tildes. */
const theme: NotesCardTheme = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	strikethrough: (text) => `~~${text}~~`,
};

const STYLE_SLOT = Symbol.for("gentle-pi.card-style");
const previousStyle = (globalThis as Record<symbol, unknown>)[STYLE_SLOT];

afterEach(() => {
	if (previousStyle === undefined) delete (globalThis as Record<symbol, unknown>)[STYLE_SLOT];
	else (globalThis as Record<symbol, unknown>)[STYLE_SLOT] = previousStyle;
});

function unwrap<V>(result: V | string): V {
	if (typeof result === "string") throw new Error(result);
	return result;
}

function pendingNote(id: number, text: string, everSent = false): NoteTask {
	return { id, text, status: NOTE_STATUS.PENDING, createdAt: id, ...(everSent ? { everSent: true } : {}) };
}

function sentNote(id: number, text: string): NoteTask {
	return { id, text, status: NOTE_STATUS.SENT, createdAt: id, sentAt: id + 100 };
}

describe("folded rows (S8)", () => {
	const inner = 40;
	it("folds a long pending note to a single row with an ellipsis", () => {
		const note = pendingNote(1, "una nota larguisima que se extiende mucho mas alla de una sola fila visible");
		assert.ok(pendingRowLines(note, theme, inner).length > 1, "unfolded rows wrap");
		const folded = pendingRowLines(note, theme, inner, undefined, true);
		assert.equal(folded.length, 1, `folded pending rows: ${folded.length}`);
		assert.ok(folded[0]!.includes("…"), `folded row marks the hidden text: ${folded[0]}`);
		assert.ok(folded[0]!.includes(SEND_GLYPH), "the send affordance stays on the folded row");
	});

	it("keeps the send glyph column where the unfolded row had it", () => {
		const note = pendingNote(2, "una nota larguisima que se extiende mucho mas alla de una sola fila visible");
		const unfolded = pendingRowLines(note, theme, inner)[0]!;
		const folded = pendingRowLines(note, theme, inner, undefined, true)[0]!;
		assert.equal(sendGlyphColumn(folded), sendGlyphColumn(unfolded));
	});

	it("folds sent notes to one struck row and leaves short notes alone", () => {
		const long = sentNote(3, "una nota enviada que ocupa bastante mas que una sola fila visible del bloque");
		const short = sentNote(4, "corta");
		assert.equal(sentRowLines(long, theme, inner, true).length, 1);
		assert.ok(sentRowLines(long, theme, inner, true)[0]!.includes("~~"), "strikethrough survives folding");
		assert.ok(sentRowLines(long, theme, inner, true)[0]!.includes("…"), "hidden text is marked");
		assert.ok(!sentRowLines(short, theme, inner, true)[0]!.includes("…"), "a note that fits is not clipped");
		assert.equal(sentRowLines(short, theme, inner, true)[0], sentRowLines(short, theme, inner)[0]);
	});

	it("buildNotesCard folds every note on request and keeps the hit map", () => {
		const state = { notes: [pendingNote(1, "corta"), sentNote(2, "enviada corta")], nextId: 3 };
		const plain = buildNotesCard(state, theme, inner);
		const folded = buildNotesCard(state, theme, inner, undefined, undefined, { foldedIds: new Set([1, 2]) });
		assert.equal(folded.bodyRows.length, plain.bodyRows.length, "one-row notes fold to the same rows");
		const long = { notes: [pendingNote(1, "una nota larguisima que se extiende mucho mas alla de una sola fila")], nextId: 2 };
		assert.ok(buildNotesCard(long, theme, inner).bodyRows.length > 1);
		assert.equal(buildNotesCard(long, theme, inner, undefined, undefined, { foldedIds: new Set([1]) }).bodyRows.length, 1);
		assert.deepEqual(buildNotesCard(long, theme, inner, undefined, undefined, { foldedIds: new Set([1]) }).hits, [{ row: 0, id: 1 }]);
	});

	it("folds only the notes the view names (L21)", () => {
		const first = pendingNote(1, "una nota larguisima que se extiende mucho mas alla de una sola fila visible");
		const second = pendingNote(2, "otra nota larguisima que tambien pasa de una sola fila visible del bloque");
		const state = { notes: [first, second], nextId: 3 };
		const view = buildNotesCard(state, theme, inner, undefined, undefined, { foldedIds: new Set([1]) });
		assert.deepEqual(view.bodyRows.slice(0, 1), pendingRowLines(first, theme, inner, undefined, true), "the named note folds to one row");
		assert.deepEqual(view.bodyRows.slice(1), pendingRowLines(second, theme, inner), "the other keeps its full text");
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 1, id: 2 }], "both rows stay clickable");
	});

	it("shows the first pending note when the block collapses", () => {
		const state = { notes: [sentNote(1, "enviada primero"), pendingNote(2, "pendiente larga que se pasa del ancho de una fila")], nextId: 3 };
		const row = collapsedNoteRow(state, theme, inner);
		assert.equal(row.length, 1, `collapsed body: ${row.length} rows`);
		assert.ok(row[0]!.includes("pendiente larga"), `first pending note: ${row[0]}`);
		assert.ok(!row[0]!.includes("enviada"), "the sent note stays out of the collapsed row");
		assert.ok(row[0]!.includes("…"), "the collapsed row clips long text");
	});

	it("falls back to the sent note, then to a muted placeholder", () => {
		const onlySent = { notes: [sentNote(1, "enviada corta")], nextId: 2 };
		assert.ok(collapsedNoteRow(onlySent, theme, inner)[0]!.includes("~~"), "the sent fallback is struck");
		const empty = collapsedNoteRow(emptyNotes(), theme, inner)[0]!;
		assert.ok(empty.includes("<muted>"), `empty placeholder: ${empty}`);
	});
});

describe("rail controls (S8)", () => {
	it("names the action each click performs, with the state in the chevron", () => {
		const idle = railControlText({ collapsed: false, folded: false, labelFits: true });
		assert.deepEqual(idle, { collapse: "▾ Collapse", fold: "▾ Fold" });
		const closed = railControlText({ collapsed: true, folded: true, labelFits: true });
		assert.deepEqual(closed, { collapse: "▸ Expand", fold: "▸ Full" });
	});

	it("keeps the chevrons and drops the labels when the header is tight", () => {
		const tight = railControlText({ collapsed: false, folded: false, labelFits: false });
		assert.deepEqual(tight, { collapse: "▾", fold: "▾" });
	});

	it("finds each control's span on a rendered header, ANSI and all", () => {
		const line = "\x1b[38;5;238m▎ \x1b[0m\x1b[38;5;114m✎ Notes \x1b[0m\x1b[38;5;114m▾ Collapse\x1b[0m \x1b[38;5;114m▾ Fold\x1b[0m";
		assert.deepEqual(controlSpan(line, "▾ Collapse"), { start: 10, end: 19 });
		assert.deepEqual(controlSpan(line, "▾ Fold"), { start: 21, end: 26 });
		// Two identical chevrons: the search offset tells them apart by order.
		assert.deepEqual(controlSpan(line, "▾", 11), { start: 21, end: 21 });
		assert.equal(controlSpan(line, "Expand"), undefined);
	});
});

describe("constants", () => {
	it("pins the glyph grammar and the row cap", () => {
		assert.equal(NOTE_GLYPH.pending, "✉");
		assert.equal(NOTE_GLYPH.sent, "✓");
		assert.equal(SEND_GLYPH, "➤");
		assert.equal(NOTES_ROW_CAP, 18);
	});
});

describe("sanitizeNoteText", () => {
	it("strips control characters", () => {
		assert.equal(sanitizeNoteText("ho\u0001la\u007f"), "hola");
	});

	it("keeps regular text untouched", () => {
		assert.equal(sanitizeNoteText("números ácéntòs ✓"), "números ácéntòs ✓");
		// C1 controls are the 8-bit encoding of ESC and friends, and the bidi
		// overrides let a note spoof the order of the row it is painted in.
		assert.equal(sanitizeNoteText("a\u009b2Jb\u202Ec\u200Ed"), "a2Jbcd");
		assert.equal(sanitizeNoteText("\u{1F468}\u200D\u{1F469}"), "\u{1F468}\u200D\u{1F469}", "ZWJ stays");
	});
});

describe("wrapNoteText", () => {
	it("wraps on word boundaries", () => {
		assert.deepEqual(wrapNoteText("hola mundo", 5), ["hola", "mundo"]);
	});

	it("keeps a fitting text in one segment", () => {
		assert.deepEqual(wrapNoteText("hola mundo", 11), ["hola mundo"]);
		assert.deepEqual(wrapNoteText("hola", 4), ["hola"]);
	});

	it("hard-splits words longer than the width", () => {
		assert.deepEqual(wrapNoteText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
	});

	it("ignores repeated inner spaces", () => {
		assert.deepEqual(wrapNoteText("hola  mundo", 5), ["hola", "mundo"]);
	});

	it("returns nothing for empty text or non-positive width", () => {
		assert.deepEqual(wrapNoteText("", 10), []);
		assert.deepEqual(wrapNoteText("hola", 0), []);
	});
});

describe("pendingRowLines", () => {
	it("renders one line with the send affordance right-aligned", () => {
		const lines = pendingRowLines(pendingNote(1, "hola"), theme, 46);
		assert.deepEqual(lines, [
			`<accent>✉</accent>  <text>${"hola".padEnd(37)}</text>  <muted>➤</muted>  <muted>×</muted>`,
		]);
	});

	it("wraps long notes and puts the send glyph only on the first line", () => {
		const lines = pendingRowLines(pendingNote(1, "uno dos tres cuatro cinco seis siete"), theme, 14);
		assert.deepEqual(lines, [
			`<accent>✉</accent>  <text>${"uno".padEnd(5)}</text>  <muted>➤</muted>  <muted>×</muted>`,
			`   <text>dos</text>`,
			`   <text>tres</text>`,
			`   <text>cuatr</text>`,
			`   <text>o</text>`,
			`   <text>cinco</text>`,
			`   <text>seis</text>`,
			`   <text>siete</text>`,
		]);
	});
});

describe("delete affordance (L27)", () => {
	// Geometry needs real ANSI escapes: tag fakes inflate visibleWidth and
	// spread the glyph columns apart (L8, applied again).
	const ansiTheme: NotesCardTheme = {
		fg: (role, text) => `\x1b[38;5;${role === "accent" ? 205 : role === "muted" ? 242 : 255}m${text}\x1b[0m`,
		strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
	};

	it("paints the delete glyph after the send glyph with two columns of air", () => {
		const row = pendingRowLines(pendingNote(1, "corta"), ansiTheme, 46)[0]!;
		const send = sendGlyphColumn(row);
		const del = deleteGlyphColumn(row);
		assert.ok(send !== undefined && del !== undefined, `both glyphs paint: ${row}`);
		assert.equal((del as number) - (send as number), 3, `air between the glyphs: send ${send}, delete ${del}`);
		assert.ok(row.includes("\x1b[38;5;242m×\x1b[0m"), `the delete glyph paints muted: ${JSON.stringify(row)}`);
	});

	it("keeps both glyph columns where the unfolded row had them", () => {
		const note = pendingNote(2, "una nota larguisima que se extiende mucho mas alla de una sola fila visible");
		const unfolded = pendingRowLines(note, ansiTheme, 40)[0]!;
		const folded = pendingRowLines(note, ansiTheme, 40, undefined, true)[0]!;
		assert.equal(sendGlyphColumn(folded), sendGlyphColumn(unfolded));
		assert.equal(deleteGlyphColumn(folded), deleteGlyphColumn(unfolded));
	});

	it("paints the delete glyph with the hover role while the pointer is on it", () => {
		const idle = pendingRowLines(pendingNote(3, "corta"), ansiTheme, 46)[0]!;
		assert.ok(idle.includes("\x1b[38;5;242m×\x1b[0m"), `idle paints muted: ${JSON.stringify(idle)}`);
		const hovered = pendingRowLines(pendingNote(3, "corta"), ansiTheme, 46, undefined, false, 3)[0]!;
		assert.ok(hovered.includes("\x1b[38;5;205m×\x1b[0m"), `hover paints the accent role: ${JSON.stringify(hovered)}`);
		assert.ok(hovered.includes("\x1b[38;5;242m➤\x1b[0m"), "the send glyph keeps its idle role");
	});
});

describe("sentRowLines", () => {
	it("renders the sent glyph with strikethrough dim text and the restore glyph", () => {
		const lines = sentRowLines(sentNote(1, "hola"), theme, 46);
		// 46 columns: lead glyph, two of air, a 37-column text pad, then ↶ and ✕
		// with their own two columns of air (L45).
		assert.deepEqual(lines, [`<success>✓</success>  <dim>~~${"hola".padEnd(37)}~~</dim>  <muted>↶</muted>  <muted>×</muted>`]);
	});

	it("applies strikethrough per physical wrapped line", () => {
		const lines = sentRowLines(sentNote(1, "uno dos tres"), theme, 12);
		assert.deepEqual(lines, [
			`<success>✓</success>  <dim>~~uno~~</dim>  <muted>↶</muted>  <muted>×</muted>`,
			`   <dim>~~dos~~</dim>`,
			`   <dim>~~tre~~</dim>`,
			`   <dim>~~s~~</dim>`,
		]);
	});

	it("keeps the affordances on the row when the note carries wide characters (D2)", () => {
		// padEnd counts UTF-16 code units while the card clips in columns, so a
		// double-width character used to push the affordance off the row: the
		// send/restore target vanished, and a note painting the glyph itself
		// could take the click instead.
		const ansi: NotesCardTheme = {
			fg: (role, text) => `\x1b[38;5;${role === "accent" ? 205 : 242}m${text}\x1b[0m`,
			strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
		};
		const sentRow = sentRowLines(sentNote(1, "漢字↶"), ansi, 46)[0] as string;
		assert.equal(visibleWidth(sentRow), 46, "the sent row fills its columns exactly");
		assert.equal(deleteGlyphColumn(sentRow), visibleWidth(sentRow) - 1, "the delete target is the last cell, not the note's own glyph");
		assert.equal(restoreGlyphColumn(sentRow), visibleWidth(sentRow) - 4, "the restore target keeps its own column beside it");
		const wide = addNote(emptyNotes(), "漢字➤", 1);
		const plain = addNote(emptyNotes(), "ascii", 1);
		assert.ok(typeof wide !== "string" && typeof plain !== "string", "the pending notes are accepted");
		const wideRow = pendingRowLines((wide as { note: NoteTask }).note, ansi, 46)[0] as string;
		const plainRow = pendingRowLines((plain as { note: NoteTask }).note, ansi, 46)[0] as string;
		// A pending row carries three glyphs (lead, send, delete/back-to-sent), so
		// the property is not "the send glyph is last" but "wide text moves
		// nothing": the row still fills its columns and every target keeps the
		// column the ASCII row gave it.
		assert.equal(visibleWidth(wideRow), 46, "the pending row fills its columns exactly");
		assert.equal(sendGlyphColumn(wideRow), sendGlyphColumn(plainRow), "wide text does not move the send target");
		assert.equal(trailingGlyphColumn(wideRow), visibleWidth(wideRow) - 1, "the trailing affordance stays the last cell");
	});

	it("keeps the restore glyph at one column on folded and unfolded rows", () => {
		const unfolded = sentRowLines(sentNote(1, "una nota bastante larga como para plegarse"), theme, 30)[0]!;
		const folded = sentRowLines(sentNote(1, "una nota bastante larga como para plegarse"), theme, 30, true)[0]!;
		assert.equal(restoreGlyphColumn(folded), restoreGlyphColumn(unfolded));
	});

	it("takes the last restore glyph, so text carrying one cannot steal it (P1.4)", () => {
		const line = "   texto con ↶ adentro   ↶";
		assert.equal(restoreGlyphColumn(line), visibleWidth(line.slice(0, line.lastIndexOf("↶"))), "the affordance is the last glyph, measured in columns");
		const row = sentRowLines(sentNote(1, "esto ↶ vuelve a la lista"), theme, 46)[0] as string;
		assert.notEqual(row.indexOf("↶"), row.lastIndexOf("↶"), "the note paints its own glyph before the affordance");
		assert.equal(restoreGlyphColumn(row), row.lastIndexOf("↶"), "the click target stays on the affordance");
	});

	it("paints the restore glyph with the hover role while the pointer is on it", () => {
		// Real ANSI escapes: the tag fakes would inflate the visible columns.
		const ansiTheme: NotesCardTheme = {
			fg: (role, text) => `\x1b[38;5;${role === "accent" ? 205 : role === "muted" ? 242 : 255}m${text}\x1b[0m`,
			strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
		};
		const idle = sentRowLines(sentNote(3, "corta"), ansiTheme, 46)[0]!;
		assert.ok(idle.includes("\x1b[38;5;242m↶\x1b[0m"), `idle paints muted: ${JSON.stringify(idle)}`);
		const hovered = sentRowLines(sentNote(3, "corta"), ansiTheme, 46, false, 3)[0]!;
		assert.ok(hovered.includes("\x1b[38;5;205m↶\x1b[0m"), `hover paints the accent role: ${JSON.stringify(hovered)}`);
	});
});

describe("sent section: one row delete and one group delete (L45)", () => {
	// Real ANSI escapes: the tag fakes inflate the visible columns.
	const ansiTheme: NotesCardTheme = {
		fg: (role, text) => `\x1b[38;5;${role === "accent" ? 205 : role === "muted" ? 242 : role === "success" ? 46 : 255}m${text}\x1b[0m`,
		strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
	};

	it("uses a single delete glyph in the whole card", () => {
		assert.equal(DELETE_GLYPH, "×", "the smaller, thinner × is gone: one weight and one size (S11)");
		assert.equal(visibleWidth(DELETE_GLYPH), 1, "the glyph takes exactly one column");
	});

	it("carries a delete glyph beside the restore glyph on every sent row", () => {
		const row = sentRowLines(sentNote(1, "corta"), ansiTheme, 46)[0] as string;
		const restore = restoreGlyphColumn(row);
		const remove = deleteGlyphColumn(row);
		assert.ok(restore !== undefined && remove !== undefined, `both affordances paint: ${JSON.stringify(row)}`);
		assert.equal(remove - restore, 3, `air between the two affordances: restore ${restore}, delete ${remove}`);
		assert.equal(remove, visibleWidth(row) - 1, "the delete glyph closes the row");
		assert.equal(visibleWidth(row), 46, "the row fills its columns exactly");
	});

	it("paints the sent row's delete with the hover role and keeps ↶ idle", () => {
		const idle = sentRowLines(sentNote(3, "corta"), ansiTheme, 46)[0] as string;
		assert.ok(idle.includes("\x1b[38;5;242m×\x1b[0m"), `idle paints muted: ${JSON.stringify(idle)}`);
		const hovered = sentRowLines(sentNote(3, "corta"), ansiTheme, 46, false, undefined, 3)[0] as string;
		assert.ok(hovered.includes("\x1b[38;5;205m×\x1b[0m"), `hover paints the accent role: ${JSON.stringify(hovered)}`);
		assert.ok(hovered.includes("\x1b[38;5;242m↶\x1b[0m"), "the restore glyph keeps its idle role");
	});

	it("keeps both sent affordances at one column on folded and unfolded rows", () => {
		const note = sentNote(1, "una nota bastante larga como para plegarse a una sola linea visible");
		const unfolded = sentRowLines(note, ansiTheme, 30)[0] as string;
		const folded = sentRowLines(note, ansiTheme, 30, true)[0] as string;
		assert.equal(deleteGlyphColumn(folded), deleteGlyphColumn(unfolded));
		assert.equal(restoreGlyphColumn(folded), restoreGlyphColumn(unfolded));
	});

	it("drops the ✓ lead from the section header and paints the group ×", () => {
		const state = { notes: [pendingNote(1, "p"), sentNote(2, "s")], nextId: 3 };
		const view = buildNotesCard(state, theme, 46);
		const header = view.bodyRows[1] as string;
		assert.ok(!header.includes(`<success>${NOTE_GLYPH.sent}</success>`), `the header no longer leads with the status glyph: ${header}`);
		assert.equal(header, `<muted>1 sent</muted>  <accent>▾ Collapse</accent>  <muted>Delete All</muted>`);
		assert.deepEqual(view.sentHeader, { row: 1, control: "▾ Collapse", remove: "Delete All" }, "both controls are hit-testable");
	});

	it("lights the group delete with the hover role", () => {
		const state = { notes: [sentNote(2, "s")], nextId: 3 };
		const view = buildNotesCard(state, theme, 46, undefined, undefined, { sentDeleteHovered: true });
		assert.equal(view.bodyRows[0], `<muted>1 sent</muted>  <accent>▾ Collapse</accent>  <accent>Delete All</accent>`);
	});

	it("keeps the group delete while the section is collapsed", () => {
		const state = { notes: [pendingNote(1, "p"), sentNote(2, "s")], nextId: 3 };
		const view = buildNotesCard(state, theme, 46, undefined, undefined, { sentCollapsed: true });
		assert.equal(view.sentHits.length, 0, "the rows are folded away");
		assert.equal(view.sentHeader?.remove, "Delete All", "the group delete is still offered");
	});

	it("keeps the group delete on the row when the header is tight", () => {
		const state = { notes: [pendingNote(1, "p"), sentNote(2, "s"), sentNote(3, "t")], nextId: 4 };
		const view = buildNotesCard(state, theme, 20);
		const header = view.bodyRows[view.sentHeader?.row ?? -1] as string;
		assert.ok(header !== undefined, `the header paints on a narrow card: ${JSON.stringify(view.bodyRows)}`);
		assert.ok(header.includes("Delete All"), `the group delete survives the narrow card: ${header}`);
	});
});

describe("buildNotesCard (body rows, no chrome)", () => {
	it("returns no body rows and no hits for an empty state", () => {
		assert.deepEqual(buildNotesCard(emptyNotes(), theme, 46), {
			bodyRows: [],
			hits: [],
			sentHits: [],
			summary: { pending: 0, sent: 0, total: 0 },
		});
	});

	it("orders pending rows first, then sent, in id order per group", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "aa", 1)).state;
		state = unwrap(addNote(state, "bb", 2)).state;
		state = unwrap(markSent(state, 2, 100)).state;
		state = unwrap(addNote(state, "cc", 3)).state;
		const view = buildNotesCard(state, theme, 46);
		assert.deepEqual(view.bodyRows, [
			`<accent>✉</accent>  <text>${"aa".padEnd(37)}</text>  <muted>➤</muted>  <muted>×</muted>`,
			`<accent>✉</accent>  <text>${"cc".padEnd(37)}</text>  <muted>➤</muted>  <muted>×</muted>`,
			`<muted>1 sent</muted>  <accent>▾ Collapse</accent>  <muted>Delete All</muted>`,
			`<success>✓</success>  <dim>~~${"bb".padEnd(37)}~~</dim>  <muted>↶</muted>  <muted>×</muted>`,
		]);
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 1, id: 3 }]);
		assert.deepEqual(view.sentHits, [{ row: 3, id: 2 }], "the sent row maps to its own hit list, under the header");
		assert.deepEqual(view.summary, { pending: 2, sent: 1, total: 3 });
	});

	it("folds long lists: sent summary first, capped pendings, overflow line", () => {
		const notes: NoteTask[] = [];
		for (let id = 1; id <= 21; id++) notes.push(pendingNote(id, `p${id}`));
		for (let id = 22; id <= 24; id++) notes.push(sentNote(id, `s${id}`));
		const state = { notes, nextId: 25 };
		const view = buildNotesCard(state, theme, 40);
		assert.equal(view.bodyRows.length, 18);
		// Auto-collapsed sent notes show summary with expand control
		assert.equal(view.bodyRows[0], `<muted>3 sent</muted>  <accent>▸ Expand</accent>  <muted>Delete All</muted>`);
		assert.equal(view.bodyRows[1], `<accent>✉</accent>  <text>${"p1".padEnd(31)}</text>  <muted>➤</muted>  <muted>×</muted>`);
		assert.equal(view.bodyRows[view.bodyRows.length - 1], `<muted>… 5 more</muted>`);
		assert.equal(view.hits.length, 16);
		assert.deepEqual(view.hits[0], { row: 1, id: 1 });
		assert.deepEqual(view.hits[15], { row: 16, id: 16 });
	});

	it("keeps the sent control on a short list", () => {
		const state = { notes: [pendingNote(1, "pendiente"), sentNote(2, "enviada a"), sentNote(3, "enviada b")], nextId: 4 };
		const view = buildNotesCard(state, theme, 40);
		const header = `<muted>2 sent</muted>  <accent>▾ Collapse</accent>  <muted>Delete All</muted>`;
		assert.equal(view.bodyRows[1], header, `header opens the sent section: ${JSON.stringify(view.bodyRows)}`);
		assert.deepEqual(view.sentHeader, { row: 1, control: "▾ Collapse", remove: "Delete All" }, "the control and the group delete are clickable");
		assert.equal(view.sentHits.length, 2, "the rows it labels are right below it");
	});

	it("keeps the control after a short list expands or collapses", () => {
		const state = { notes: [pendingNote(1, "pendiente"), sentNote(2, "enviada")], nextId: 3 };
		const collapsed = buildNotesCard(state, theme, 40, undefined, undefined, { sentCollapsed: true });
		assert.ok(collapsed.bodyRows[1]?.includes("▸ Expand"), `collapsed keeps the way back: ${JSON.stringify(collapsed.bodyRows)}`);
		const expanded = buildNotesCard(state, theme, 40, undefined, undefined, { sentCollapsed: false });
		assert.ok(expanded.bodyRows[1]?.includes("▾ Collapse"), `expanded keeps the way in: ${JSON.stringify(expanded.bodyRows)}`);
		assert.equal(expanded.sentHits.length, 1);
	});

	it("swaps the trailing glyph once a note has been sent", () => {
		const fresh = pendingNote(1, "nunca enviada");
		const recycled = pendingNote(2, "ya enviada alguna vez", true);
		const freshLine = pendingRowLines(fresh, theme, 40)[0] as string;
		const recycledLine = pendingRowLines(recycled, theme, 40)[0] as string;

		assert.equal(trailingGlyphColumn(freshLine), trailingGlyphColumn(recycledLine), "both keep the column, only the glyph changes");
		assert.ok(freshLine.includes(`<muted>×</muted>`), `a note that never travelled offers delete: ${freshLine}`);
		assert.equal(revertGlyphColumn(freshLine), undefined);
		assert.ok(recycledLine.includes(`<muted>${REVERT_GLYPH}</muted>`), `a note that came back offers sent again: ${recycledLine}`);
		assert.equal(deleteGlyphColumn(recycledLine), undefined, "no delete icon is painted");
		assert.equal(revertGlyphColumn(recycledLine), trailingGlyphColumn(freshLine), "the affordance lands where the × would have");
	});

	it("keeps the swap on a folded row and lights it on hover", () => {
		const recycled = pendingNote(1, "una nota ya enviada que se pliega a una sola fila", true);
		const folded = pendingRowLines(recycled, theme, 40, undefined, true, undefined)[0] as string;
		assert.ok(folded.includes(`<muted>${REVERT_GLYPH}</muted>`), `folded keeps the affordance: ${folded}`);
		assert.equal(revertGlyphColumn(folded), revertGlyphColumn(pendingRowLines(recycled, theme, 40)[0] as string));
		const hovered = pendingRowLines(recycled, theme, 40, undefined, false, recycled.id)[0] as string;
		assert.ok(hovered.includes(`<success>${REVERT_GLYPH}</success>`), `hover takes the sent role: ${hovered}`);
	});

	it("advances hit rows past wrapped lines", () => {
		const state = {
			notes: [pendingNote(1, "uno dos tres cuatro cinco seis siete"), pendingNote(2, "x")],
			nextId: 3,
		};
		const view = buildNotesCard(state, theme, 14);
		// The delete affordance spends three more columns (L27), so the wrap
		// width drops to five: the long note folds into eight lines and the
		// second note starts at row 8.
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 8, id: 2 }]);
		assert.equal(view.bodyRows.length, 9);
	});

	it("paints the send glyph accent on the hovered row only", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "aa", 1)).state;
		state = unwrap(addNote(state, "bb", 2)).state;
		const view = buildNotesCard(state, theme, 46, 2);
		assert.equal(view.bodyRows[0], `<accent>✉</accent>  <text>${"aa".padEnd(37)}</text>  <muted>➤</muted>  <muted>×</muted>`);
		assert.equal(view.bodyRows[1], `<accent>✉</accent>  <text>${"bb".padEnd(37)}</text>  <accent>➤</accent>  <muted>×</muted>`);
	});
});

describe("sendGlyphColumn", () => {
	it("locates the visible column of the send glyph, ignoring ANSI escapes", () => {
		const line = "\x1b[38;5;2m▎\x1b[0m \x1b[35m✉\x1b[0m texto padded\x1b[90m➤\x1b[0m";
		const column = sendGlyphColumn(line);
		assert.equal(column, 16);
	});

	it("returns undefined when the line has no send glyph", () => {
		assert.equal(sendGlyphColumn("sin glyph por acá"), undefined);
	});

	it("measures padding before the glyph as visible columns", () => {
		const line = "✉ " + "x".repeat(10) + " ➤";
		assert.equal(sendGlyphColumn(line), 13);
	});
});

describe("buildCompactNotesRow", () => {
	// Real zero-width ANSI escapes (like the harness): tag fakes inflate
	// visibleWidth and clip the header mid-style, so the compact geometry
	// needs escapes that measure honestly.
	const ROLES: Record<string, string> = { accent: "205", border: "238", muted: "242", text: "250", success: "114", dim: "243", warning: "214" };
	const floatTheme = {
		fg: (role: string, text: string) => `\x1b[38;5;${ROLES[role] ?? "250"}m${text}\x1b[0m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
		bg: (role: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m`,
	};
	const mixedState = () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "uno", 1)).state;
		state = unwrap(addNote(state, "dos", 2)).state;
		state = unwrap(markSent(state, 2, 3)).state;
		state = unwrap(addNote(state, "tres", 4)).state;
		return state;
	};

	it("renders nothing while the notepad is empty", () => {
		const view = buildCompactNotesRow(emptyNotes(), floatTheme, 60, { collapsed: true });
		assert.deepEqual(view.rows, []);
		assert.equal(view.control, undefined);
		assert.deepEqual(view.hits, []);
	});

	it("keeps one row of air below and none above, since pi spaces the widget group (L28)", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const collapsed = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: true });
		assert.ok(collapsed.rows[0]?.includes("Notes"), `the header sits on the first row: ${JSON.stringify(collapsed.rows)}`);
		assert.equal(collapsed.rows.at(-1), "", "one blank row below keeps it off the editor");
		assert.equal(collapsed.headerRow, 0, `the header row follows the dropped leading air: ${collapsed.headerRow}`);
		const expanded = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: false });
		// The float panel paints its own tone-filled padding row above the
		// header; that belongs to the card, not to the gap between widgets.
		assert.notEqual(expanded.rows[0], "", `the panel paints no bare blank row above: ${JSON.stringify(expanded.rows[0])}`);
		assert.equal(expanded.headerRow, 1, `the panel keeps its own padding row: ${expanded.headerRow}`);
		assert.ok(expanded.rows[expanded.headerRow]?.includes("Notes"), `the expanded header sits on its header row: ${JSON.stringify(expanded.rows.slice(0, 3))}`);
		assert.equal(expanded.rows.at(-1), "", "one blank row below keeps it off the editor");
	});

	it("collapsed paints one card-styled line: air around, control inline, preview trailing", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const view = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: true });
		assert.equal(view.rows.length, 2, `the header plus one blank row below: ${view.rows.length}`);
		assert.equal(view.rows[1], "");
		const row = view.rows[0]!;
		assert.ok(!row.includes("✉"), `the header drops the notes glyph: ${row}`);
		assert.ok(row.includes("Notes"), `title paints: ${row}`);
		assert.ok(row.includes("▸ Expand"), `control inline after the title: ${row}`);
		assert.ok(row.includes("3 total, 2 pend"), `summary trails: ${row}`);
		assert.ok(row.includes("— tres"), `the last note trails the counts: ${row}`);
		assert.ok(row.startsWith(" \x1b[48;5;22m"), `tone background behind the line: ${row}`);
		assert.deepEqual(view.control, { start: 11, end: 18 });
		assert.equal(view.headerRow, 0);
		assert.deepEqual(view.hits, []);
	});

	it("truncates the preview to the room the header leaves and never widens the row", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		let state = emptyNotes();
		state = unwrap(addNote(state, "corta", 1)).state;
		state = unwrap(addNote(state, "una nota larguisima que se extiende mucho mas alla de una sola fila visible del bloque", 2)).state;
		const view = buildCompactNotesRow(state, floatTheme, 60, { collapsed: true });
		const row = view.rows[0]!;
		assert.ok(row.includes("2 total, 2 pend"), `counts always paint: ${row}`);
		assert.ok(row.includes("— una nota"), `the preview opens with the note: ${row}`);
		assert.ok(row.includes("…"), `a clipped preview marks the cut: ${row}`);
		assert.ok(!row.includes("bloque"), "the preview never runs past the row");
		assert.ok(visibleWidth(row) <= 60, `the header fits the row: ${visibleWidth(row)}`);
	});

	it("grows the preview with the window", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		let state = emptyNotes();
		state = unwrap(addNote(state, "una nota larguisima que se extiende mucho mas alla de una sola fila visible", 1)).state;
		const narrow = buildCompactNotesRow(state, floatTheme, 46, { collapsed: true }).rows[0]!;
		const wide = buildCompactNotesRow(state, floatTheme, 80, { collapsed: true }).rows[0]!;
		assert.ok(wide.includes("larguisima"), `the wide window shows more words: ${wide}`);
		assert.ok(!narrow.includes("larguisima"), `the narrow window clips earlier: ${narrow}`);
		assert.ok(narrow.includes("— una"), `even the narrow window previews something: ${narrow}`);
	});

	it("collapses to the bare chevron on narrow rows and keeps it clickable", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const view = buildCompactNotesRow(mixedState(), floatTheme, 20, { collapsed: true });
		assert.equal(view.rows.length, 2);
		assert.ok(view.rows[0]?.includes("▸"), `chevron survives the clip: ${view.rows[0]}`);
		assert.ok(!view.rows[0]?.includes("Expand"), "the label drops when narrow");
		assert.deepEqual(view.control, { start: 11, end: 11 }, "the visible chevron stays hit-testable");
	});

	it("paints the control with the hover role while the pointer is on it", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const view = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: true, controlHovered: true });
		assert.ok(view.rows[0]?.includes("\x1b[38;5;214m▸ Expand\x1b[0m"), `hover role paints: ${view.rows[0]}`);
	});

	it("expanded grows into the bounded list with the collapse control and hits", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const view = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: false });
		assert.ok(view.rows.length > 1);
		assert.equal(view.rows.at(-1), "");
		assert.equal(view.headerRow, 1);
		assert.ok(view.rows[1]?.includes("▾ Collapse"), `header control flips: ${view.rows[1]}`);
		assert.deepEqual(view.control, { start: 11, end: 20 });
		assert.ok(view.rows[3]?.includes("uno"), `the list begins under the header: ${view.rows[3]}`);
		assert.deepEqual(view.hits, [{ row: 3, id: 1 }, { row: 4, id: 3 }]);
	});

	it("expanded windows the list at the row cap and reports it as a scroll range", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		let state = emptyNotes();
		for (let id = 1; id <= 10; id++) state = unwrap(addNote(state, `nota ${id}`, id)).state;
		const view = buildCompactNotesRow(state, floatTheme, 60, { collapsed: false });
		assert.equal(view.bodyTotal, 10);
		assert.equal(view.rows.filter((line) => line.includes("✉")).length, 8, `the window holds the cap: ${view.rows.join(" | ")}`);
		assert.ok(view.rows.some((line) => line.includes("↑↓ 1–8/10")), `the hint reports the window: ${view.rows.join(" | ")}`);
		assert.ok(!view.rows.some((line) => line.includes("… 2 more")), "the dead-end fold line is gone");
		assert.equal(view.hits.length, 8);
	});

	it("scrolls the window with scrollTop, clamps it and remaps the hits on screen", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		let state = emptyNotes();
		for (let id = 1; id <= 10; id++) state = unwrap(addNote(state, `nota ${id}`, id)).state;
		const view = buildCompactNotesRow(state, floatTheme, 60, { collapsed: false, scrollTop: 2 });
		assert.ok(view.rows.some((line) => line.includes("↑↓ 3–10/10")), `the hint follows the window: ${view.rows.join(" | ")}`);
		assert.equal(view.hits.length, 8);
		assert.deepEqual(view.hits[0], { row: 3, id: 3 });
		assert.deepEqual(view.hits[7], { row: 10, id: 10 });
		assert.ok(view.rows[3]?.includes("nota 3"), `the window starts at the scrolled note: ${view.rows[3]}`);
		const clamped = buildCompactNotesRow(state, floatTheme, 60, { collapsed: false, scrollTop: 99 });
		assert.ok(clamped.rows.some((line) => line.includes("↑↓ 3–10/10")), `scrollTop clamps to the last window: ${clamped.rows.join(" | ")}`);
	});

	it("exposes the sent section header of the expanded list, both controls (L45)", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const view = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: false });
		assert.deepEqual(view.sentHeader, { row: 5, control: "▾ Collapse", remove: "Delete All" }, "the compact maps the section header into rendered rows");
		const header = view.rows[5] as string;
		assert.ok(header.includes("1 sent"), `the header counts the sent notes: ${header}`);
		assert.ok(header.includes("Delete All"), `the group delete paints in the compact: ${header}`);
	});

	it("drops the section header from the compact when the window hides it (L45)", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		let state = emptyNotes();
		for (let id = 1; id <= 9; id++) state = unwrap(addNote(state, `nota ${id}`, id)).state;
		state = unwrap(markSent(state, 9, 99)).state;
		const view = buildCompactNotesRow(state, floatTheme, 60, { collapsed: false });
		assert.equal(view.sentHeader, undefined, `the header sits outside the window: ${view.rows.join(" | ")}`);
	});

	it("hit-tests the expand control in the outlined style too (P1.5)", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "neon";
		const collapsed = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: true });
		assert.equal(collapsed.rows.length, 3);
		assert.ok(collapsed.rows[0]?.includes("Notes"), `title paints in the frame: ${collapsed.rows[0]}`);
		// The outlined frame paints the same control inside its title, so it
		// needs the same hit span the float panel gives it: without one the
		// control renders and nothing can ever open the list under NEON.
		assert.deepEqual(collapsed.control, { start: 11, end: 18 }, "the outlined control is clickable");
		const expanded = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: false });
		assert.ok(expanded.rows.length > 2, "the list paints inside the frame");
		assert.deepEqual(expanded.hits, [{ row: 1, id: 1 }, { row: 2, id: 3 }]);
		assert.deepEqual(expanded.control, { start: 11, end: 20 }, "the expanded outlined control stays clickable");
	});
});
