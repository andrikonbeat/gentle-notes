import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOTE_STATUS, addNote, emptyNotes, markSent, type NoteTask } from "../src/notes-state.ts";
import {
	NOTES_ROW_CAP,
	NOTE_GLYPH,
	SEND_GLYPH,
	notesCardLines,
	notesSummaryRow,
	pendingRowLines,
	sanitizeNoteText,
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

describe("notesCardLines", () => {
	it("renders nothing for an empty state", () => {
		assert.deepEqual(notesCardLines(emptyNotes(), theme, 46), []);
	});

	it("renders header plus pending first, then sent, in id order per group", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "aa", 1)).state;
		state = unwrap(addNote(state, "bb", 2)).state;
		state = unwrap(markSent(state, 2, 100)).state;
		state = unwrap(addNote(state, "cc", 3)).state;
		const lines = notesCardLines(state, theme, 46);
		assert.deepEqual(lines, [
			`<accent>✉</accent> <text>Notes</text> <muted>· 2 pend · 1 sent</muted>`,
			`<accent>✉</accent> <text>${"aa".padEnd(42)}</text><muted>➤</muted>`,
			`<accent>✉</accent> <text>${"cc".padEnd(42)}</text><muted>➤</muted>`,
			`<success>✓</success> <dim>~~bb~~</dim>`,
		]);
	});

	it("folds long lists: sent summary first, capped pendings, overflow line", () => {
		const notes: NoteTask[] = [];
		for (let id = 1; id <= 15; id++) notes.push(pendingNote(id, `p${id}`));
		for (let id = 16; id <= 18; id++) notes.push(sentNote(id, `s${id}`));
		const state = { notes, nextId: 19 };
		const lines = notesCardLines(state, theme, 40);
		assert.equal(lines.length, 1 + 1 + 10 + 1);
		assert.equal(lines[0], `<accent>✉</accent> <text>Notes</text> <muted>· 15 pend · 3 sent</muted>`);
		assert.equal(lines[1], `<success>✓</success> <muted>3 sent</muted>`);
		assert.equal(lines[2], `<accent>✉</accent> <text>${"p1".padEnd(36)}</text><muted>➤</muted>`);
		assert.equal(lines[lines.length - 1], `<muted>… 5 more</muted>`);
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
