import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOTE_STATUS, addNote, emptyNotes, markSent, type NoteTask } from "../src/notes-state.ts";
import { buildNotesCard } from "../src/notes-card.ts";
import { parseNotesArgs } from "../src/extension.ts";

/** Deterministic fake theme: roles become readable tags, strikethrough tildes. */
const theme = {
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	strikethrough: (text: string) => `~~${text}~~`,
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

describe("parseNotesArgs", () => {
	it("opens the manager for empty input", () => {
		assert.deepEqual(parseNotesArgs(""), { action: "manage", rest: "" });
		assert.deepEqual(parseNotesArgs("   "), { action: "manage", rest: "" });
	});

	it("parses add with collapsed whitespace and case-insensitive head", () => {
		assert.deepEqual(parseNotesArgs("add  fix   the   footer "), { action: "add", rest: "fix the footer" });
		assert.deepEqual(parseNotesArgs("ADD upper"), { action: "add", rest: "upper" });
	});

	it("parses send with an optional numeric id", () => {
		assert.deepEqual(parseNotesArgs("send"), { action: "send", rest: "", id: undefined });
		assert.deepEqual(parseNotesArgs("send 3"), { action: "send", rest: "3", id: 3 });
		assert.deepEqual(parseNotesArgs("send abc"), { action: "send", rest: "abc", id: undefined });
		assert.deepEqual(parseNotesArgs("send 3.5"), { action: "send", rest: "3.5", id: undefined });
		assert.deepEqual(parseNotesArgs("send -2"), { action: "send", rest: "-2", id: undefined });
	});

	it("parses list, clear and help", () => {
		assert.deepEqual(parseNotesArgs("list"), { action: "list", rest: "" });
		assert.deepEqual(parseNotesArgs("clear"), { action: "clear", rest: "" });
		assert.deepEqual(parseNotesArgs("help"), { action: "help", rest: "" });
	});

	it("falls back to help for unknown actions", () => {
		assert.deepEqual(parseNotesArgs("wat"), { action: "help", rest: "wat" });
	});
});

describe("buildNotesCard hits", () => {
	it("returns an empty body and no hits for an empty state", () => {
		assert.deepEqual(buildNotesCard(emptyNotes(), theme, 46), {
			bodyRows: [],
			hits: [],
			summary: { pending: 0, sent: 0, total: 0 },
		});
	});

	it("maps the first physical row of every pending note to its id", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "aa", 1)).state;
		state = unwrap(addNote(state, "bb", 2)).state;
		state = unwrap(markSent(state, 2, 100)).state;
		state = unwrap(addNote(state, "cc", 3)).state;
		const view = buildNotesCard(state, theme, 46);
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 1, id: 3 }]);
		assert.equal(view.bodyRows.length, 3);
	});

	it("advances the hit row past wrapped lines", () => {
		const state = {
			notes: [pendingNote(1, "uno dos tres cuatro cinco seis siete"), pendingNote(2, "x")],
			nextId: 3,
		};
		const view = buildNotesCard(state, theme, 14);
		assert.deepEqual(view.hits, [{ row: 0, id: 1 }, { row: 5, id: 2 }]);
		assert.equal(view.bodyRows.length, 6);
	});

	it("only maps the pending notes that survive folding", () => {
		const notes: NoteTask[] = [];
		for (let id = 1; id <= 15; id++) notes.push(pendingNote(id, `p${id}`));
		for (let id = 16; id <= 18; id++) notes.push(sentNote(id, `s${id}`));
		const view = buildNotesCard({ notes, nextId: 19 }, theme, 40);
		assert.equal(view.hits.length, 10);
		assert.deepEqual(view.hits[0], { row: 1, id: 1 });
		assert.deepEqual(view.hits[9], { row: 10, id: 10 });
	});
});

describe("buildNotesCard hover", () => {
	it("paints the send glyph accent on the hovered row only", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "aa", 1)).state;
		state = unwrap(addNote(state, "bb", 2)).state;
		const view = buildNotesCard(state, theme, 46, 2);
		assert.equal(view.bodyRows[0], `<accent>✉</accent> <text>${"aa".padEnd(42)}</text><muted>➤</muted>`);
		assert.equal(view.bodyRows[1], `<accent>✉</accent> <text>${"bb".padEnd(42)}</text><accent>➤</accent>`);
	});
});
