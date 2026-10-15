import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	NOTE_STATUS,
	addNote,
	clearNotes,
	emptyNotes,
	isNotesState,
	markSent,
	notesSummary,
	type NoteTask,
} from "../src/notes-state.ts";

/** Test helper: fail loudly when a pure function returned an error string. */
function unwrap<V>(result: V | string): V {
	if (typeof result === "string") throw new Error(result);
	return result;
}

describe("emptyNotes", () => {
	it("starts with no notes and nextId 1", () => {
		assert.deepEqual(emptyNotes(), { notes: [], nextId: 1 });
	});
});

describe("addNote", () => {
	it("creates a pending note with id, trimmed text and creation instant", () => {
		const result = unwrap(addNote(emptyNotes(), "  revisar padding del rail  ", 1000));
		assert.equal(result.note.id, 1);
		assert.equal(result.note.text, "revisar padding del rail");
		assert.equal(result.note.status, NOTE_STATUS.PENDING);
		assert.equal(result.note.createdAt, 1000);
		assert.equal(result.note.sentAt, undefined);
		assert.deepEqual(result.state.notes, [result.note]);
		assert.equal(result.state.nextId, 2);
	});

	it("rejects empty text with an error and leaves the input state unchanged", () => {
		const state = emptyNotes();
		const before = JSON.stringify(state);
		const result = addNote(state, "   \t ", 1000);
		assert.equal(typeof result, "string");
		assert.equal(JSON.stringify(state), before);
	});

	it("collapses inner whitespace to single spaces", () => {
		const result = unwrap(addNote(emptyNotes(), "a\t\tb   c", 1));
		assert.equal(result.note.text, "a b c");
	});

	it("rejects non-string text", () => {
		assert.equal(typeof addNote(emptyNotes(), 42, 1), "string");
	});

	it("appends in order and increments ids", () => {
		let state = emptyNotes();
		for (const text of ["uno", "dos", "tres"]) state = unwrap(addNote(state, text, 1)).state;
		const rows = state.notes.map((note) => [note.id, note.text]);
		assert.deepEqual(rows, [[1, "uno"], [2, "dos"], [3, "tres"]]);
		assert.equal(state.nextId, 4);
	});

	it("does not mutate the input state", () => {
		const state = emptyNotes();
		const before = JSON.stringify(state);
		unwrap(addNote(state, "x", 1));
		assert.equal(JSON.stringify(state), before);
	});
});

describe("markSent", () => {
	it("marks a pending note as sent with the send instant, preserving text and createdAt", () => {
		const state = unwrap(addNote(emptyNotes(), "mandar el PR", 10)).state;
		const result = unwrap(markSent(state, 1, 99));
		const sent = result.state.notes[0] as NoteTask;
		assert.equal(sent.status, NOTE_STATUS.SENT);
		assert.equal(sent.sentAt, 99);
		assert.equal(sent.text, "mandar el PR");
		assert.equal(sent.createdAt, 10);
		assert.equal(result.state.notes.length, 1);
	});

	it("errors on unknown id and leaves the state unchanged", () => {
		const state = unwrap(addNote(emptyNotes(), "x", 1)).state;
		const before = JSON.stringify(state);
		const result = markSent(state, 7, 1);
		assert.equal(typeof result, "string");
		assert.equal(JSON.stringify(state), before);
	});

	it("errors when the note was already sent", () => {
		let state = unwrap(addNote(emptyNotes(), "x", 1)).state;
		state = unwrap(markSent(state, 1, 10)).state;
		const result = markSent(state, 1, 20);
		assert.equal(typeof result, "string");
	});

	it("does not mutate the input state", () => {
		let state = unwrap(addNote(emptyNotes(), "x", 1)).state;
		const before = JSON.stringify(state);
		unwrap(markSent(state, 1, 2));
		assert.equal(JSON.stringify(state), before);
	});
});

describe("clearNotes", () => {
	it("resets to an empty state reporting how many notes were removed", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "a", 1)).state;
		state = unwrap(markSent(state, 1, 2)).state;
		state = unwrap(addNote(state, "b", 3)).state;
		const result = clearNotes(state);
		assert.deepEqual(result.state, emptyNotes());
		assert.equal(result.removed, 2);
	});
});

describe("notesSummary", () => {
	it("counts pending, sent and total", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "a", 1)).state;
		state = unwrap(addNote(state, "b", 2)).state;
		state = unwrap(markSent(state, 1, 3)).state;
		assert.deepEqual(notesSummary(state), { pending: 1, sent: 1, total: 2 });
	});

	it("reports an empty summary for an empty state", () => {
		assert.deepEqual(notesSummary(emptyNotes()), { pending: 0, sent: 0, total: 0 });
	});
});

describe("isNotesState", () => {
	it("accepts a valid state", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "a", 1)).state;
		state = unwrap(markSent(state, 1, 2)).state;
		assert.equal(isNotesState(state), true);
	});

	it("accepts the empty state", () => {
		assert.equal(isNotesState(emptyNotes()), true);
	});

	it("rejects null, non-objects and wrong shapes", () => {
		assert.equal(isNotesState(null), false);
		assert.equal(isNotesState("x"), false);
		assert.equal(isNotesState({}), false);
		assert.equal(isNotesState({ notes: [] }), false);
		assert.equal(isNotesState({ notes: "x", nextId: 1 }), false);
	});

	it("rejects notes with a bad id, empty text or unknown status", () => {
		const bad: unknown[] = [
			{ notes: [{ id: 1.5, text: "a", status: "pending", createdAt: 1 }], nextId: 2 },
			{ notes: [{ id: 0, text: "a", status: "pending", createdAt: 1 }], nextId: 2 },
			{ notes: [{ id: 1, text: "  ", status: "pending", createdAt: 1 }], nextId: 2 },
			{ notes: [{ id: 1, text: "a", status: "archived", createdAt: 1 }], nextId: 2 },
			{ notes: [{ id: 1, text: "a", status: "pending", createdAt: NaN }], nextId: 2 },
		];
		for (const value of bad) assert.equal(isNotesState(value), false);
	});

	it("requires sentAt for sent notes and rejects it for pending notes", () => {
		assert.equal(isNotesState({ notes: [{ id: 1, text: "a", status: "sent", createdAt: 1 }], nextId: 2 }), false);
		assert.equal(
			isNotesState({ notes: [{ id: 1, text: "a", status: "pending", createdAt: 1, sentAt: 5 }], nextId: 2 }),
			false,
		);
		assert.equal(
			isNotesState({ notes: [{ id: 1, text: "a", status: "sent", createdAt: 1, sentAt: 5 }], nextId: 2 }),
			true,
		);
	});
});
