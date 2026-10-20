import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	NOTE_STATUS,
	addNote,
	clearByStatus,
	clearNotes,
	deleteNote,
	emptyNotes,
	isNotesState,
	markSent,
	MAX_NOTE_LENGTH,
	notesSummary,
	restoreNote,
	setUIState,
	stripWrappingQuotes,
	updateNoteText,
	type NoteTask,
	type NotesState,
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

describe("deleteNote", () => {
	it("removes the named note, pending or sent, and leaves the rest untouched", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "primera", 1)).state;
		state = unwrap(addNote(state, "segunda", 2)).state;
		state = unwrap(markSent(state, 2, 3)).state;
		const after = unwrap(deleteNote(state, 2));
		assert.deepEqual(after.state.notes.map((note) => note.id), [1], "the sent note deletes");
		assert.equal(after.state.nextId, 3, "ids never rewind");
		const alsoPending = unwrap(deleteNote(after.state, 1));
		assert.deepEqual(alsoPending.state.notes, [], "the pending note deletes too");
	});

	it("refuses an unknown id", () => {
		assert.equal(deleteNote(emptyNotes(), 99), "no note #99");
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

	it("validates the history flag without requiring it", () => {
	const history = { notes: [{ id: 1, text: "a", status: NOTE_STATUS.PENDING, createdAt: 1, everSent: true }], nextId: 2 };
	assert.equal(isNotesState(history), true);
	const legacy = { notes: [{ id: 1, text: "a", status: NOTE_STATUS.PENDING, createdAt: 1 }], nextId: 2 };
	assert.equal(isNotesState(legacy), true, "a store written before the flag stays readable");
	const malformed = { notes: [{ id: 1, text: "a", status: NOTE_STATUS.PENDING, createdAt: 1, everSent: "yes" }], nextId: 2 };
	assert.equal(isNotesState(malformed), false, "a non boolean history flag is rejected");
});

	it("keeps the persisted view state when a note is added (D4)", () => {
		// The collapsed/folded/sent flags ride in the same file as the notes; a
		// capture must not wipe what the session persisted, or every new note
		// reopens the rail and every restart starts from scratch.
		const withUi = setUIState(emptyNotes(), { railCollapsed: true, foldAll: true });
		assert.ok(typeof withUi !== "string", "the view state is accepted");
		const added = addNote((withUi as { state: Parameters<typeof addNote>[0] }).state, "una nota que llega", 1);
		assert.ok(typeof added !== "string", "the note is accepted");
		const ui = (added as { state: { ui?: { railCollapsed?: boolean; foldAll?: boolean } } }).state.ui;
		assert.equal(ui?.railCollapsed, true, "the collapsed rail survives the add");
		assert.equal(ui?.foldAll, true, "the folded view survives the add");
	});

	it("rejects duplicate ids and a nextId that does not beat every id (P1.3)", () => {
		const first = { id: 1, text: "primera", status: NOTE_STATUS.PENDING, createdAt: 1 };
		const duplicate = { id: 1, text: "segunda", status: NOTE_STATUS.PENDING, createdAt: 2 };
		assert.equal(
			isNotesState({ notes: [first, duplicate], nextId: 2 }),
			false,
			"two notes sharing an id would make deleteNote remove both",
		);
		assert.equal(
			isNotesState({ notes: [first], nextId: 1 }),
			false,
			"a rewound nextId would hand out an id that is already taken",
		);
		assert.equal(isNotesState({ notes: [first], nextId: 2 }), true, "the next id still beats every stored id");
		assert.equal(isNotesState({ notes: [{ ...first, id: 4 }], nextId: 5 }), true, "ids need not be contiguous");
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

describe("updateNoteText", () => {
	it("updates the text of a pending note preserving every other field", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "original", 10)).state;
		const result = unwrap(updateNoteText(state, 1, "  editado  "));
		const note = result.state.notes[0] as NoteTask;
		assert.equal(note.text, "editado");
		assert.equal(note.id, 1);
		assert.equal(note.status, NOTE_STATUS.PENDING);
		assert.equal(note.createdAt, 10);
		assert.equal(note.sentAt, undefined);
	});

	it("rejects empty text with an error and keeps the state unchanged", () => {
		const state = unwrap(addNote(emptyNotes(), "x", 1)).state;
		const before = JSON.stringify(state);
		const result = updateNoteText(state, 1, "   ");
		assert.equal(typeof result, "string");
		assert.equal(JSON.stringify(state), before);
	});

	it("errors on unknown ids", () => {
		assert.equal(typeof updateNoteText(emptyNotes(), 9, "nueva"), "string");
	});

	it("refuses to edit a note that was already sent", () => {
		let state = emptyNotes();
		state = unwrap(addNote(state, "mandada", 1)).state;
		state = unwrap(markSent(state, 1, 2)).state;
		const result = updateNoteText(state, 1, "cambio tarde");
		assert.equal(typeof result, "string");
		assert.equal(state.notes[0]?.text, "mandada");
	});

	it("does not mutate the input state", () => {
		const state = unwrap(addNote(emptyNotes(), "x", 1)).state;
		const before = JSON.stringify(state);
		unwrap(updateNoteText(state, 1, "y"));
		assert.equal(JSON.stringify(state), before);
	});
});

describe("stripWrappingQuotes", () => {
	it("unwraps one matched double-quote pair", () => {
		assert.equal(stripWrappingQuotes('"comprar leche"'), "comprar leche");
	});

	it("unwraps one matched single-quote pair and curly quotes", () => {
		assert.equal(stripWrappingQuotes("'revisar el footer'"), "revisar el footer");
		assert.equal(stripWrappingQuotes("\u201crevisar el header\u201d"), "revisar el header");
	});

	it("trims around the pair", () => {
		assert.equal(stripWrappingQuotes('   "con aire"   '), "con aire");
	});

	it("keeps a lone quote, an unbalanced pair and mixed marks", () => {
		assert.equal(stripWrappingQuotes('un "lone mark'), 'un "lone mark');
		assert.equal(stripWrappingQuotes('"abre sin cerrar'), '"abre sin cerrar');
		assert.equal(stripWrappingQuotes('"mixto\''), '"mixto\'');
	});

	it("leaves plain text and short input untouched", () => {
		assert.equal(stripWrappingQuotes("sin comillas"), "sin comillas");
		assert.equal(stripWrappingQuotes('"'), '"');
		assert.equal(stripWrappingQuotes(""), "");
	});
});

describe("restoreNote", () => {
	it("returns a sent note to pending and clears sentAt", () => {
		const sent = unwrap(markSent(unwrap(addNote(emptyNotes(), "pendiente", 10)).state, 1, 20)).state;
		const restored = unwrap(restoreNote(sent, 1)).state;
		assert.equal(restored.notes[0]?.status, NOTE_STATUS.PENDING);
		assert.equal(restored.notes[0]?.sentAt, undefined);
	});

	it("remembers that the note travelled once it is pending again", () => {
		const sent = unwrap(markSent(unwrap(addNote(emptyNotes(), "una tarea", 10)).state, 1, 20)).state;
		assert.equal(sent.notes[0]?.everSent, true, "sending records the history");
		const restored = unwrap(restoreNote(sent, 1)).state;
		assert.equal(restored.notes[0]?.status, NOTE_STATUS.PENDING);
		assert.equal(restored.notes[0]?.sentAt, undefined, "the send instant is still cleared");
		assert.equal(restored.notes[0]?.everSent, true, "the memory of having travelled survives");
	});

	it("refuses an unknown id and a note that is already pending", () => {
		assert.equal(restoreNote(emptyNotes(), 7), "no note #7");
		const pending = unwrap(addNote(emptyNotes(), "sigue pendiente", 10)).state;
		assert.equal(restoreNote(pending, 1), "note #1 is already pending");
	});
});

describe("setUIState", () => {
	it("merges a partial view state into the notes state", () => {
		const state = unwrap(setUIState(emptyNotes(), { foldAll: true })).state;
		assert.deepEqual(state.ui, { foldAll: true });
		const next = unwrap(setUIState(state, { sentCollapsed: true })).state;
		assert.deepEqual(next.ui, { foldAll: true, sentCollapsed: true });
	});

	it("keeps the notes untouched", () => {
		const withNote = unwrap(addNote(emptyNotes(), "intacta", 10)).state;
		const state = unwrap(setUIState(withNote, { railCollapsed: true })).state;
		assert.deepEqual(state.notes, withNote.notes);
	});
});

describe("isNotesState ui payload", () => {
	it("accepts a state carrying a valid ui block", () => {
		assert.ok(isNotesState({ notes: [], nextId: 1, ui: { railCollapsed: true, foldAll: false, foldOverrides: { 3: true }, sentCollapsed: true } }));
	});

	it("rejects wrong ui field types and bad override keys", () => {
		assert.equal(isNotesState({ notes: [], nextId: 1, ui: { railCollapsed: "yes" } }), false);
		assert.equal(isNotesState({ notes: [], nextId: 1, ui: { foldAll: 1 } }), false);
		assert.equal(isNotesState({ notes: [], nextId: 1, ui: { foldOverrides: { abc: true } } }), false);
		assert.equal(isNotesState({ notes: [], nextId: 1, ui: { foldOverrides: { 3: "si" } } }), false);
		assert.equal(isNotesState({ notes: [], nextId: 1, ui: null }), false);
	});
});

describe("clearByStatus", () => {
	const mixed = (): NotesState => {
		let state = unwrap(addNote(emptyNotes(), "queda pendiente", 1)).state;
		state = unwrap(addNote(state, "se manda", 2)).state;
		state = unwrap(markSent(state, 2, 3)).state;
		state = unwrap(addNote(state, "otra pendiente", 4)).state;
		return unwrap(setUIState(state, { foldAll: true })).state;
	};

	it("removes only the sent notes and reports how many went", () => {
		const result = clearByStatus(mixed(), NOTE_STATUS.SENT);
		assert.equal(result.removed, 1);
		assert.deepEqual(result.state.notes.map((note) => note.text), ["queda pendiente", "otra pendiente"]);
	});

	it("removes only the pending notes", () => {
		const result = clearByStatus(mixed(), NOTE_STATUS.PENDING);
		assert.equal(result.removed, 2);
		assert.deepEqual(result.state.notes.map((note) => note.text), ["se manda"]);
	});

	it("keeps the id counter and the view flags", () => {
		const state = mixed();
		const result = clearByStatus(state, NOTE_STATUS.SENT).state;
		assert.equal(result.nextId, state.nextId, "ids never rewind");
		assert.deepEqual(result.ui, { foldAll: true }, "the view flags survive a scoped clear");
	});

	it("returns the same state object when the group is empty", () => {
		const pendingOnly = unwrap(addNote(emptyNotes(), "solo pendiente", 1)).state;
		const result = clearByStatus(pendingOnly, NOTE_STATUS.SENT);
		assert.equal(result.removed, 0);
		assert.equal(result.state, pendingOnly, "an unchanged state skips the write");
	});

	it("does not mutate the input state", () => {
		const state = mixed();
		const before = JSON.stringify(state);
		clearByStatus(state, NOTE_STATUS.PENDING);
		assert.equal(JSON.stringify(state), before);
	});
	it("strips control and bidi characters before they reach the store", () => {
		const result = addNote(emptyNotes(), "hola\u009b2J\u202Eevil\u200Bworld", 1);
		assert.ok(typeof result !== "string", String(result));
		// C1 (the 8-bit form of ESC), the right-to-left override and a zero-width
		// space never reach the JSON, the render or the terminal.
		assert.equal(result.note.text, "hola2Jevilworld");
	});

	it("keeps the zero-width joiner so emoji and complex scripts survive", () => {
		const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
		const result = addNote(emptyNotes(), family, 1);
		assert.ok(typeof result !== "string", String(result));
		assert.equal(result.note.text, family, "ZWJ is content, not control");
	});

	it("rejects a note longer than the limit instead of storing it", () => {
		const state = emptyNotes();
		const tooLong = addNote(state, "x".repeat(MAX_NOTE_LENGTH + 1), 1);
		assert.equal(typeof tooLong, "string");
		assert.match(String(tooLong), /too long/);
		assert.match(String(tooLong), new RegExp(`max ${MAX_NOTE_LENGTH}`));
		const atLimit = addNote(state, "x".repeat(MAX_NOTE_LENGTH), 1);
		assert.ok(typeof atLimit !== "string", "exactly the limit is accepted");
	});

	it("refuses an edit that would exceed the limit and leaves the note untouched", () => {
		const built = addNote(emptyNotes(), "corta", 1);
		assert.ok(typeof built !== "string");
		const edited = updateNoteText(built.state, 1, "y".repeat(MAX_NOTE_LENGTH + 1));
		assert.equal(typeof edited, "string");
		assert.match(String(edited), /too long/);
		assert.equal(built.state.notes[0].text, "corta");
	});
});

