import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NOTE_STATUS, addNote, emptyNotes, markSent, type NoteTask } from "../src/notes-state.ts";
import {
	NOTES_ROW_CAP,
	NOTE_GLYPH,
	SEND_GLYPH,
	buildNotesCard,
	buildCompactNotesRow,
	collapsedNoteRow,
	controlSpan,
	railControlText,
	pendingRowLines,
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

function pendingNote(id: number, text: string): NoteTask {
	return { id, text, status: NOTE_STATUS.PENDING, createdAt: id };
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
		const folded = buildNotesCard(state, theme, inner, undefined, undefined, { folded: true });
		assert.equal(folded.bodyRows.length, plain.bodyRows.length, "one-row notes fold to the same rows");
		const long = { notes: [pendingNote(1, "una nota larguisima que se extiende mucho mas alla de una sola fila")], nextId: 2 };
		assert.ok(buildNotesCard(long, theme, inner).bodyRows.length > 1);
		assert.equal(buildNotesCard(long, theme, inner, undefined, undefined, { folded: true }).bodyRows.length, 1);
		assert.deepEqual(buildNotesCard(long, theme, inner, undefined, undefined, { folded: true }).hits, [{ row: 0, id: 1 }]);
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
		const line = "\x1b[38;5;238m▎ \x1b[0m\x1b[38;5;114m✿ Notes \x1b[0m\x1b[38;5;114m▾ Collapse\x1b[0m \x1b[38;5;114m▾ Fold\x1b[0m";
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
		assert.equal(NOTES_ROW_CAP, 12);
	});
});

describe("sanitizeNoteText", () => {
	it("strips control characters", () => {
		assert.equal(sanitizeNoteText("ho\u0001la\u007f"), "hola");
	});

	it("keeps regular text untouched", () => {
		assert.equal(sanitizeNoteText("números ácéntòs ✓"), "números ácéntòs ✓");
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
			`<accent>✉</accent>  <text>${"hola".padEnd(40)}</text>  <muted>➤</muted>`,
		]);
	});

	it("wraps long notes and puts the send glyph only on the first line", () => {
		const lines = pendingRowLines(pendingNote(1, "uno dos tres cuatro cinco seis siete"), theme, 14);
		assert.deepEqual(lines, [
			`<accent>✉</accent>  <text>${"uno dos".padEnd(8)}</text>  <muted>➤</muted>`,
			`   <text>tres</text>`,
			`   <text>cuatro</text>`,
			`   <text>cinco</text>`,
			`   <text>seis</text>`,
			`   <text>siete</text>`,
		]);
	});
});

describe("sentRowLines", () => {
	it("renders the sent glyph with strikethrough dim text", () => {
		const lines = sentRowLines(sentNote(1, "hola"), theme, 46);
		assert.deepEqual(lines, [`<success>✓</success>  <dim>~~hola~~</dim>`]);
	});

	it("applies strikethrough per physical wrapped line", () => {
		const lines = sentRowLines(sentNote(1, "uno dos tres"), theme, 12);
		assert.deepEqual(lines, [
			`<success>✓</success>  <dim>~~uno~~</dim>`,
			`   <dim>~~dos~~</dim>`,
			`   <dim>~~tres~~</dim>`,
		]);
	});
});

describe("buildNotesCard (body rows, no chrome)", () => {
	it("returns no body rows and no hits for an empty state", () => {
		assert.deepEqual(buildNotesCard(emptyNotes(), theme, 46), {
			bodyRows: [],
			hits: [],
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
			`<accent>✉</accent>  <text>${"aa".padEnd(40)}</text>  <muted>➤</muted>`,
			`<accent>✉</accent>  <text>${"cc".padEnd(40)}</text>  <muted>➤</muted>`,
			`<success>✓</success>  <dim>~~bb~~</dim>`,
		]);
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 1, id: 3 }]);
		assert.deepEqual(view.summary, { pending: 2, sent: 1, total: 3 });
	});

	it("folds long lists: sent summary first, capped pendings, overflow line", () => {
		const notes: NoteTask[] = [];
		for (let id = 1; id <= 15; id++) notes.push(pendingNote(id, `p${id}`));
		for (let id = 16; id <= 18; id++) notes.push(sentNote(id, `s${id}`));
		const state = { notes, nextId: 19 };
		const view = buildNotesCard(state, theme, 40);
		assert.equal(view.bodyRows.length, 12);
		assert.equal(view.bodyRows[0], `<success>✓</success>  <muted>3 sent</muted>`);
		assert.equal(view.bodyRows[1], `<accent>✉</accent>  <text>${"p1".padEnd(34)}</text>  <muted>➤</muted>`);
		assert.equal(view.bodyRows[view.bodyRows.length - 1], `<muted>… 5 more</muted>`);
		assert.equal(view.hits.length, 10);
		assert.deepEqual(view.hits[0], { row: 1, id: 1 });
		assert.deepEqual(view.hits[9], { row: 10, id: 10 });
	});

	it("advances hit rows past wrapped lines", () => {
		const state = {
			notes: [pendingNote(1, "uno dos tres cuatro cinco seis siete"), pendingNote(2, "x")],
			nextId: 3,
		};
		const view = buildNotesCard(state, theme, 14);
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 6, id: 2 }]);
		assert.equal(view.bodyRows.length, 7);
	});

	it("paints the send glyph accent on the hovered row only", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "aa", 1)).state;
		state = unwrap(addNote(state, "bb", 2)).state;
		const view = buildNotesCard(state, theme, 46, 2);
		assert.equal(view.bodyRows[0], `<accent>✉</accent>  <text>${"aa".padEnd(40)}</text>  <muted>➤</muted>`);
		assert.equal(view.bodyRows[1], `<accent>✉</accent>  <text>${"bb".padEnd(40)}</text>  <accent>➤</accent>`);
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

	it("collapsed paints one card-styled line: air, control inline, background", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const view = buildCompactNotesRow(mixedState(), floatTheme, 60, { collapsed: true });
		assert.equal(view.rows.length, 1);
		const row = view.rows[0]!;
		assert.ok(row.includes("✉  Notes"), `glyph carries its air: ${row}`);
		assert.ok(row.includes("▸ Expand"), `control inline after the title: ${row}`);
		assert.ok(row.includes("2 pend · 1 sent"), `summary trails: ${row}`);
		assert.ok(row.startsWith(" \x1b[48;5;22m"), `tone background behind the line: ${row}`);
		assert.deepEqual(view.control, { start: 12, end: 19 });
		assert.equal(view.headerRow, 0);
		assert.deepEqual(view.hits, []);
	});

	it("collapses to the bare chevron on narrow rows without a hit span", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		const view = buildCompactNotesRow(mixedState(), floatTheme, 20, { collapsed: true });
		assert.equal(view.rows.length, 1);
		assert.ok(view.rows[0]?.includes("▸"), `chevron survives the clip: ${view.rows[0]}`);
		assert.ok(!view.rows[0]?.includes("Expand"), "the label drops when narrow");
		assert.equal(view.control, undefined, "no hit span while the header clips");
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
		assert.equal(view.headerRow, 1);
		assert.ok(view.rows[1]?.includes("▾ Collapse"), `header control flips: ${view.rows[1]}`);
		assert.deepEqual(view.control, { start: 12, end: 21 });
		assert.ok(view.rows[3]?.includes("uno"), `the list begins under the header: ${view.rows[3]}`);
		assert.deepEqual(view.hits, [{ row: 3, id: 1 }, { row: 4, id: 3 }]);
	});

	it("expanded folds the list at the row cap", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "float";
		let state = emptyNotes();
		for (let id = 1; id <= 10; id++) state = unwrap(addNote(state, `nota ${id}`, id)).state;
		const view = buildCompactNotesRow(state, floatTheme, 60, { collapsed: false });
		assert.equal(view.hits.length, 8);
		assert.ok(view.rows.some((line) => line.includes("… 2 more")), `fold count paints: ${view.rows.join(" | ")}`);
	});

	it("outlined styles fall back to the collapsed panel without a hit span", () => {
		(globalThis as Record<symbol, unknown>)[STYLE_SLOT] = "neon";
		const collapsed = buildCompactNotesRow(mixedState(), theme, 60, { collapsed: true });
		assert.equal(collapsed.rows.length, 2);
		assert.ok(collapsed.rows[0]?.includes("Notes"), `title paints in the frame: ${collapsed.rows[0]}`);
		assert.equal(collapsed.control, undefined);
		const expanded = buildCompactNotesRow(mixedState(), theme, 60, { collapsed: false });
		assert.ok(expanded.rows.length > 3, "the list paints inside the frame");
		assert.deepEqual(expanded.hits, [{ row: 1, id: 1 }, { row: 2, id: 3 }]);
	});
});
