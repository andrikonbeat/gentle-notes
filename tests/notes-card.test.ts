import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOTE_STATUS, addNote, emptyNotes, markSent, type NoteTask } from "../src/notes-state.ts";
import {
	NOTES_ROW_CAP,
	NOTE_GLYPH,
	SEND_GLYPH,
	buildNotesCard,
	notesSummaryRow,
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
			`<accent>✉</accent> <text>${"hola".padEnd(42)}</text><muted>➤</muted>`,
		]);
	});

	it("wraps long notes and puts the send glyph only on the first line", () => {
		const lines = pendingRowLines(pendingNote(1, "uno dos tres cuatro cinco seis siete"), theme, 14);
		assert.deepEqual(lines, [
			`<accent>✉</accent> <text>${"uno dos".padEnd(10)}</text><muted>➤</muted>`,
			`  <text>tres</text>`,
			`  <text>cuatro</text>`,
			`  <text>cinco seis</text>`,
			`  <text>siete</text>`,
		]);
	});
});

describe("sentRowLines", () => {
	it("renders the sent glyph with strikethrough dim text", () => {
		const lines = sentRowLines(sentNote(1, "hola"), theme, 46);
		assert.deepEqual(lines, [`<success>✓</success> <dim>~~hola~~</dim>`]);
	});

	it("applies strikethrough per physical wrapped line", () => {
		const lines = sentRowLines(sentNote(1, "uno dos tres"), theme, 12);
		assert.deepEqual(lines, [
			`<success>✓</success> <dim>~~uno dos~~</dim>`,
			`  <dim>~~tres~~</dim>`,
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
			`<accent>✉</accent> <text>${"aa".padEnd(42)}</text><muted>➤</muted>`,
			`<accent>✉</accent> <text>${"cc".padEnd(42)}</text><muted>➤</muted>`,
			`<success>✓</success> <dim>~~bb~~</dim>`,
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
		assert.equal(view.bodyRows[0], `<success>✓</success> <muted>3 sent</muted>`);
		assert.equal(view.bodyRows[1], `<accent>✉</accent> <text>${"p1".padEnd(36)}</text><muted>➤</muted>`);
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
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 5, id: 2 }]);
		assert.equal(view.bodyRows.length, 6);
	});

	it("paints the send glyph accent on the hovered row only", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "aa", 1)).state;
		state = unwrap(addNote(state, "bb", 2)).state;
		const view = buildNotesCard(state, theme, 46, 2);
		assert.equal(view.bodyRows[0], `<accent>✉</accent> <text>${"aa".padEnd(42)}</text><muted>➤</muted>`);
		assert.equal(view.bodyRows[1], `<accent>✉</accent> <text>${"bb".padEnd(42)}</text><accent>➤</accent>`);
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

describe("notesSummaryRow", () => {
	it("renders the compact header alone when there is nothing pending", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "a", 1)).state;
		state = unwrap(markSent(state, 1, 2)).state;
		state = unwrap(addNote(state, "b", 3)).state;
		state = unwrap(markSent(state, 2, 4)).state;
		assert.equal(
			notesSummaryRow(state, theme, 60),
			`<accent>✉</accent> <text>Notes</text> <muted>· 0 pend · 2 sent</muted>`,
		);
	});

	it("appends the last pending note by id in quotes", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "primera", 1)).state;
		state = unwrap(addNote(state, "segunda", 2)).state;
		assert.equal(
			notesSummaryRow(state, theme, 60),
			`<accent>✉</accent> <text>Notes</text> <muted>· 2 pend · 0 sent</muted><muted> — "segunda"</muted>`,
		);
	});

	it("truncates the quoted note to fit the row", () => {
		const state = unwrap(addNote(emptyNotes(), "revisar el padding del rail en narrow", 1)).state;
		assert.equal(
			notesSummaryRow(state, theme, 40),
			`<accent>✉</accent> <text>Notes</text> <muted>· 1 pend · 0 sent</muted><muted> — "revisar e…"</muted>`,
		);
	});

	it("drops the quote when the row is too narrow to be useful", () => {
		const state = unwrap(addNote(emptyNotes(), "hola", 1)).state;
		assert.equal(
			notesSummaryRow(state, theme, 26),
			`<accent>✉</accent> <text>Notes</text> <muted>· 1 pend · 0 sent</muted>`,
		);
	});

	it("renders the empty summary for an empty state", () => {
		assert.equal(
			notesSummaryRow(emptyNotes(), theme, 60),
			`<accent>✉</accent> <text>Notes</text> <muted>· 0 pend · 0 sent</muted>`,
		);
	});
});
