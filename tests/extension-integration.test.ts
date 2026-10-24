// Integration tests for the gentle-notes extension wiring: registration,
// session lifecycle, widget installation, the compact row, and the rail panel
// as a live notepad — the card paints by default with its own input row,
// clicking it takes keyboard focus, Enter saves, Escape returns the keyboard
// to the chat, and clicking a pending note's text edits it inline. Everything
// runs against mocks with a faithful setFocus; persistence goes through the
// real storage queue under a temp config home. The fake theme emits real ANSI
// escapes, like Pi's themes, so the card measures rows exactly as live.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "../src/host-contract.ts";
import gentleNotes from "../src/extension.ts";
import { SEND_DESTINATION, readSettings, writeSettings } from "../src/settings.ts";
import { sidebarState } from "../src/sidebar-interop.ts";
import { loadNotes, saveNotes } from "../src/storage.ts";
import { MAX_NOTE_LENGTH, NOTE_STATUS } from "../src/notes-state.ts";
import { controlSpan, deleteGlyphColumn, restoreGlyphColumn, revertGlyphColumn } from "../src/notes-card.ts";
import { sendGlyphColumn } from "../src/notes-card.ts";

const MANAGER_ADD = "＋ Add a note…";
const MANAGER_CLEAR = "×  Clear all notes";
const MANAGER_CLEAR_PENDING = "×  Clear all pending notes";
const ACCENT = "\x1b[38;5;205m";
const WARNING = "\x1b[38;5;214m";
const MUTED = "\x1b[38;5;242m";
const FLUSH = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

interface WidgetCall {
	key: string;
	content: unknown;
}

interface Harness {
	sent: Array<{ content: unknown; options?: { deliverAs?: string } }>;
	/** Text pushed into the chat's editor instead of sent straight away. */
	pasted: string[];
	notifies: Array<{ message: string; type?: string }>;
	selectCalls: Array<{ title: string; options: string[] }>;
	widgetCalls: WidgetCall[];
	fakeTui: TUI;
	getFocus: () => unknown;
	/** Hand the keyboard to a stand-in component, like the chat editor holding
	 * it before the card is clicked. */
	setFocus: (component: unknown) => void;
	setInput: (value: string | undefined) => void;
	setSelect: (value: string | undefined) => void;
	setConfirm: (value: boolean) => void;
	buildWidget: () => Component & { dispose?(): void };
	rail: () => Component & {
		focused?: boolean;
		digest?(): string;
		handleInput?(data: string): void;
		handleMouse?(event: TuiMouseEvent): TuiMouseEventResult;
	};
	sessionStart: (cwd: string) => Promise<void>;
	sessionShutdown: () => Promise<void>;
	agentStart: () => void;
	agentEnd: () => void;
	runCommand: (args: string, cwd: string) => Promise<void>;
	runNoteAlias: (args: string, cwd: string) => Promise<void>;
	/** Feed raw terminal input through the terminal callback, exactly like the
	 * real terminal does. `duringDispatch` runs inside the callback, emulating
	 * the TUI routing the event to a component before the callback returns. */
	feedInput: (data: string, duringDispatch?: () => void) => void;
	runShortcut: (cwd: string) => Promise<void>;
}

function makeHarness(): Harness {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }>();
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => void | Promise<void>>>();
	const sent: Harness["sent"] = [];
	const pasted: Harness["pasted"] = [];
	const notifies: Harness["notifies"] = [];
	const selectCalls: Harness["selectCalls"] = [];
	const widgetCalls: WidgetCall[] = [];
	let inputResult: string | undefined;
	let selectResult: string | undefined;
	let confirmResult = true;

	// Roles map to distinct 256-color codes so tests can assert styling; bg
	// arms the float panel painter, exactly like a real Pi theme.
	const ROLE_CODES: Record<string, string> = {
		accent: "205",
		muted: "242",
		success: "46",
		dim: "240",
		text: "252",
		border: "238",
		warning: "214",
		error: "196",
	};
	const fakeTheme = {
		fg: (role: string, text: string) => `\x1b[38;5;${ROLE_CODES[role] ?? "255"}m${text}\x1b[0m`,
		bg: (role: string, text: string) => `\x1b[48;5;${role === "toolSuccessBg" ? "22" : "52"}m${text}\x1b[49m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
	} as unknown as Theme;

	// Faithful fake of the TUI focus contract: Focusable components get their
	// `focused` flag flipped on transitions, like setFocusInternal does.
	let focusedComponent: Component | null = null;
	const applyFocus = (component: Component | null, next: boolean): void => {
		if (component && "focused" in component) (component as unknown as { focused: boolean }).focused = next;
	};
	// The real terminal hands every input chunk to a single callback; the TUI
	// routes it from there. Tests install their own to stand in for the TUI.
	let pendingDispatch: (() => void) | undefined;
	const fakeTerminal: { rows: number; columns: number; inputHandler?: (data: string) => void } = {
		rows: 48,
		columns: 160,
		inputHandler: () => {
			pendingDispatch?.();
		},
	};
	const fakeTui = {
		terminal: fakeTerminal,
		requestRender() {},
		setFocus(component: Component | null) {
			applyFocus(focusedComponent, false);
			focusedComponent = component;
			applyFocus(component, true);
		},
		getFocusedComponent: () => focusedComponent,
	} as unknown as TUI;

	const makeCtx = (cwd: string): ExtensionContext =>
		({
			cwd,
			hasUI: true,
			ui: {
				setWidget: (key: string, content: unknown) => {
					widgetCalls.push({ key, content });
				},
				notify: (message: string, type?: string) => {
					notifies.push({ message, type });
				},
				input: async () => inputResult,
				select: async (title: string, options: string[]) => {
					selectCalls.push({ title, options });
					return selectResult;
				},
				confirm: async () => confirmResult,
				pasteToEditor: (text: string) => {
					pasted.push(text);
				},
			},
		}) as unknown as ExtensionContext;

	const pi = {
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, options);
		},
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) => {
			shortcuts.set(key, options);
		},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => void | Promise<void>) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		sendUserMessage: async (content: unknown, options?: { deliverAs?: string }) => {
			sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	gentleNotes(pi);

	const fire = (event: string, eventArg: unknown, ctx?: unknown): Promise<void> =>
		Promise.all((handlers.get(event) ?? []).map((handler) => handler(eventArg, ctx))).then(() => {});

	const latestWidgetFactory = (): ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined => {
		const call = widgetCalls[widgetCalls.length - 1];
		return call && typeof call.content === "function"
			? (call.content as (tui: TUI, theme: Theme) => Component & { dispose?(): void })
			: undefined;
	};

	return {
		sent,
		pasted,
		notifies,
		selectCalls,
		widgetCalls,
		fakeTui,
		getFocus: () => focusedComponent,
		setFocus: (component: unknown) => {
			fakeTui.setFocus(component as Component | null);
		},
		setInput: (value) => {
			inputResult = value;
		},
		setSelect: (value) => {
			selectResult = value;
		},
		setConfirm: (value) => {
			confirmResult = value;
		},
		buildWidget: () => {
			const factory = latestWidgetFactory();
			assert.ok(factory, "no widget factory registered");
			return factory(fakeTui, fakeTheme);
		},
		rail: () => {
			const rail = sidebarState(fakeTui).parts.get("notes");
			assert.ok(rail, "notes rail part not registered");
			return rail as Harness["rail"] extends () => infer R ? R : never;
		},
		sessionStart: (cwd: string) => fire("session_start", {}, makeCtx(cwd)),
		sessionShutdown: () => fire("session_shutdown", {}),
		agentStart: () => {
			for (const handler of handlers.get("agent_start") ?? []) void handler({});
		},
		agentEnd: () => {
			for (const handler of handlers.get("agent_end") ?? []) void handler({});
		},
		runCommand: async (args: string, cwd: string) => {
			const command = commands.get("notes");
			assert.ok(command, "notes command not registered");
			await command.handler(args, makeCtx(cwd));
		},
		runNoteAlias: async (args: string, cwd: string) => {
			const command = commands.get("notes");
			assert.ok(command, "notes command not registered");
			await command.handler("note " + args, makeCtx(cwd));
		},
		feedInput: (data: string, duringDispatch?: () => void) => {
			pendingDispatch = duringDispatch;
			fakeTerminal.inputHandler?.(data);
			pendingDispatch = undefined;
		},
		runShortcut: async (cwd: string) => {
			const shortcut = shortcuts.get("alt+n");
			assert.ok(shortcut, "alt+n shortcut not registered");
			await shortcut.handler(makeCtx(cwd));
		},
	};
}

function mouse(type: string, x: number, y: number, width: number, wheelDelta?: number, clickCount?: number): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		width,
		height: 20,
		screenX: 100 + x,
		screenY: 100 + y,
		shift: false,
		alt: false,
		ctrl: false,
		...(wheelDelta !== undefined ? { wheelDelta } : {}),
		...(clickCount !== undefined ? { clickCount } : {}),
	} as TuiMouseEvent;
}

/** Every visible column a glyph appears at on a rendered row, ANSI skipped. */
function glyphColumnsAt(line: string, glyph: string): number[] {
	const columns: number[] = [];
	let column = 0;
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\x1b") {
			const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(index));
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		const character = String.fromCodePoint(line.codePointAt(index) as number);
		if (character === glyph) columns.push(column);
		column += visibleWidth(character);
		index += character.length;
	}
	return columns;
}

/** The rendered row that carries the clickable send glyph. */
function glyphRow(lines: string[]): { row: number; column: number } {
	const row = lines.findIndex((line) => line.includes("➤"));
	assert.ok(row >= 0, `no row carries the send glyph: ${JSON.stringify(lines)}`);
	const column = sendGlyphColumn(lines[row] as string);
	assert.ok(column !== undefined);
	return { row, column: column as number };
}

/** Visible columns a manager entry spends on its glyph and its air: with a
 * fixed label column every entry starts its text at the same place. */
function managerGlyphColumns(option: string): number {
	const prefix = /^[^\p{L}#]+/u.exec(option)?.[0] ?? "";
	return visibleWidth(prefix);
}

describe("gentle-notes extension wiring", () => {
	let configHome: string;
	let project: string;
	let previousConfigHome: string | undefined;
	let harness: Harness;

	beforeEach(() => {
		configHome = mkdtempSync(join(tmpdir(), "gentle-notes-cfg-"));
		project = mkdtempSync(join(tmpdir(), "gentle-notes-proj-"));
		previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
		process.env.GENTLE_PI_CONFIG_HOME = configHome;
		harness = makeHarness();
	});

	afterEach(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		rmSync(configHome, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	});

	it("registers the notes command, the alt+n shortcut and the lifecycle handlers", async () => {
		harness.agentStart();
		harness.agentEnd();
		await harness.sessionStart(project);
		const last = harness.widgetCalls[harness.widgetCalls.length - 1];
		assert.ok(last, "session_start installs a widget");
		assert.equal(last.key, "gentle-notes");
		assert.equal(typeof last.content, "function");
	});

	it("adds a note straight from the chat with /notes note <text>", async () => {
		await harness.sessionStart(project);
		await harness.runNoteAlias("llamar al dentista mañana", project);
		const stored = loadNotes(project);
		assert.equal(stored.notes.length, 1);
		assert.equal(stored.notes[0]?.text, "llamar al dentista mañana");
		assert.equal(stored.notes[0]?.status, "pending");
		assert.equal(harness.notifies[harness.notifies.length - 1]?.message, "Note saved");
	});

	it("collapses whitespace and rejects an empty /notes note argument", async () => {
		await harness.sessionStart(project);
		await harness.runNoteAlias("   ", project);
		assert.equal(loadNotes(project).notes.length, 0, "a blank argument stores nothing");
		await harness.runNoteAlias("dos    espacios   aqui", project);
		assert.equal(loadNotes(project).notes[0]?.text, "dos espacios aqui");
	});

	it("refuses a note over the length limit and leaves the store untouched", async () => {
		await harness.sessionStart(project);
		const before = loadNotes(project);
		await harness.runNoteAlias("x".repeat(MAX_NOTE_LENGTH + 1), project);
		const after = loadNotes(project);
		assert.equal(after.notes.length, 0, "nothing is stored");
		assert.equal(after.nextId, before.nextId, "the id counter does not advance");
		const message = harness.notifies[harness.notifies.length - 1];
		assert.match(message?.message ?? "", /too long/);
		assert.match(message?.message ?? "", new RegExp(`max ${MAX_NOTE_LENGTH}`));
	});

	it("prompts for the note text when /notes note arrives without an argument", async () => {
		await harness.sessionStart(project);
		harness.setInput("escrita desde el dialogo");
		await harness.runNoteAlias("", project);
		assert.equal(loadNotes(project).notes[0]?.text, "escrita desde el dialogo");
	});

	it("loads persisted notes at session start and hides the empty compact row", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add yapersistida", project);
		assert.equal(loadNotes(project).notes[0]?.text, "yapersistida");

		// A fresh session over the same project sees the stored note.
		const second = makeHarness();
		process.env.GENTLE_PI_CONFIG_HOME = configHome;
		await second.sessionStart(project);
		const widget = second.buildWidget();
		const lines = widget.render(80);
		assert.equal(lines.length, 2, `the header plus one blank row below: ${lines.length}`);
		assert.equal(lines[1], "");
		const header = lines[0] ?? "";
		assert.ok(header.includes("Notes"), `compact line keeps the title: ${header}`);
		assert.ok(!header.includes("✉"), `the compact header drops the glyph: ${header}`);
		assert.ok(header.includes("1 pend"), `summary paints: ${header}`);
		assert.ok(header.includes("▸ Expand"), `control paints inline: ${header}`);
		assert.ok(header.includes("— yapersistida"), `the last note previews after the counts: ${header}`);
		assert.ok(header.includes("\x1b[48;5;22m"), "the compact line carries the panel background");
	});

	it("starts the session when the notes directory cannot be created (P1.2)", async () => {
		// The store's parent path exists but is a regular file, so the watcher's
		// mkdirSync fails (ENOTDIR here, EACCES on an unwritable home): the same
		// shape as an unwritable config home, without needing root.
		const blocked = join(configHome, "blocked");
		writeFileSync(blocked, "not a directory", "utf8");
		process.env.GENTLE_PI_CONFIG_HOME = blocked;

		// session_start must survive it: no throw out of the handler, the widget
		// still installs, and the wiring keeps answering — without live sync.
		await harness.sessionStart(project);
		const widget = harness.buildWidget();
		assert.doesNotThrow(() => widget.render(80), "the compact row still renders");
		await harness.runCommand("add todavia responde", project);
		const error = harness.notifies.find((entry) => entry.type === "error");
		assert.ok(error, `the unwritable store is reported once, as an error: ${JSON.stringify(harness.notifies)}`);
		await harness.sessionShutdown();
	});

	it("renders nothing in the compact row while the project has no notes", async () => {
		await harness.sessionStart(project);
		const widget = harness.buildWidget();
		assert.deepEqual(widget.render(80), []);
	});

	it("expands the compact row from its inline control and collapses it back", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add compactable", project);
		const widget = harness.buildWidget();
		assert.equal(widget.render(80).length, 2);
		const toggle = widget.handleMouse?.(mouse("click", 10, 0, 80));
		assert.equal(toggle?.handled, true);
		const expanded = widget.render(80);
		assert.ok(expanded.length > 2, "the compact row grows into the list");
		assert.equal(expanded.at(-1), "");
		assert.ok(expanded[1]?.includes("▾ Collapse"), `header carries the collapse control: ${expanded[1]}`);
		assert.ok(expanded.join("\n").includes("compactable"), "the expanded list shows the note");
		widget.handleMouse?.(mouse("click", 10, 1, 80));
		assert.equal(widget.render(80).length, 2, "collapsing returns the one-line summary with its air");
	});

	it("expands the compact row from its control in the outlined style (P1.5)", async () => {
		const slot = Symbol.for("gentle-pi.card-style");
		const previous = (globalThis as Record<symbol, unknown>)[slot];
		(globalThis as Record<symbol, unknown>)[slot] = "neon";
		try {
			await harness.sessionStart(project);
			await harness.runCommand("add visible en neon", project);
			const widget = harness.buildWidget();
			const collapsed = widget.render(80);
			assert.equal(collapsed.length, 3, `the outlined frame plus its air row: ${JSON.stringify(collapsed)}`);
			const control = controlSpan(collapsed[0] ?? "", "▸ Expand");
			assert.ok(control, `the outlined header paints the control: ${JSON.stringify(collapsed[0])}`);

			const click = widget.handleMouse?.(mouse("click", control.start, 0, 80));
			assert.equal(click?.handled, true, "the control owns the click");
			const expanded = widget.render(80);
			assert.ok(expanded.length > collapsed.length, "the compact row grows into the list");
			assert.ok(expanded.join("\n").includes("visible en neon"), `the list paints the note: ${expanded.join(" | ")}`);
		} finally {
			if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[slot];
			else (globalThis as Record<symbol, unknown>)[slot] = previous;
		}
	});

	it("previews the last written note on the compact line (L23)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add primera de las notas", project);
		const widget = harness.buildWidget();
		assert.ok(widget.render(80)[0]?.includes("— primera de las notas"), "the preview shows the only note");
		await harness.runCommand("add segunda y ultima escrita", project);
		const line = widget.render(80)[0] ?? "";
		assert.ok(line.includes("— segunda y ultima escrita"), `the preview follows the last note: ${line}`);
		assert.ok(!line.includes("primera de las notas"), "the older note leaves the preview");
	});

	it("sends a note straight from the expanded compact list", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add desde el compacto", project);
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 10, 0, 80));
		const { row, column } = glyphRow(widget.render(80));
		widget.handleMouse?.(mouse("click", column, row, 80));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "desde el compacto", options: undefined }]);
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.SENT);
	});

	it("deletes a note from the compact list's delete glyph (D15)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add del compacto", project);
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 10, 0, 80));
		const lines = widget.render(80);
		// The expanded header also previews the last note, so the note's own
		// row is the one that carries the send glyph with the text.
		const row = lines.findIndex((line) => line.includes("del compacto") && line.includes("➤"));
		assert.ok(row >= 0, `the expanded compact lists the note: ${JSON.stringify(lines)}`);
		const column = deleteGlyphColumn(lines[row] as string);
		assert.ok(column !== undefined, "the compact row carries the delete glyph");

		widget.handleMouse?.(mouse("click", column, row, 80));
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes, [], "the compact delete removes the note");
	});

	it("restores a sent note from the compact list's restore glyph", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add del compacto enviada", project);
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 10, 0, 80));
		const expanded = widget.render(80);
		const row = expanded.findIndex((line) => line.includes("del compacto enviada") && line.includes("➤"));
		assert.ok(row >= 0, `the expanded compact lists the note: ${JSON.stringify(expanded)}`);
		const sendColumn = sendGlyphColumn(expanded[row] as string) as number;
		widget.handleMouse?.(mouse("click", sendColumn, row, 80));
		await FLUSH();

		// The row moves to the sent section, where the ↶ puts it back.
		const sent = widget.render(80);
		// The compact header previews the last note too, so the note's own row
		// is the one carrying the sent glyph.
		const sentRow = sent.findIndex((line) => line.includes("del compacto enviada") && line.includes("✓"));
		const restoreColumn = restoreGlyphColumn(sent[sentRow] as string);
		assert.ok(restoreColumn !== undefined, "the compact sent row carries the restore glyph");
		widget.handleMouse?.(mouse("click", restoreColumn as number, sentRow, 80));
		await FLUSH();
		const state = loadNotes(project);
		assert.equal(state.notes[0]?.status, NOTE_STATUS.PENDING, "the compact restore puts the note back");
		assert.equal(state.notes[0]?.sentAt, undefined);
	});

	it("scrolls the expanded compact list with the wheel (L26)", async () => {
		await harness.sessionStart(project);
		for (let id = 1; id <= 12; id++) await harness.runCommand(`add nota compacta numero ${id}`, project);
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 10, 0, 80));
		const expanded = widget.render(80);
		assert.ok(expanded.some((line) => line.includes("↑↓ 1–8/12")), `the hint reports the window: ${expanded.join(" | ")}`);

		const wheel = widget.handleMouse?.(mouse("wheel", 30, 4, 80, 3));
		assert.equal(wheel?.handled, true, "the wheel belongs to the overflowing list");
		const scrolled = widget.render(80);
		assert.ok(scrolled.some((line) => line.includes("↑↓ 4–11/12")), `the wheel advances the window: ${scrolled.join(" | ")}`);

		const { row, column } = glyphRow(scrolled);
		widget.handleMouse?.(mouse("click", column, row, 80));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "nota compacta numero 4", options: undefined }], "the rows on screen still send");

		const wheelBack = widget.handleMouse?.(mouse("wheel", 30, 4, 80, -99));
		assert.equal(wheelBack?.handled, true);
		// Sending one note grows the list: eleven pendings plus the sent
		// section's own header row and its row.
		assert.ok(
			widget.render(80).some((line) => line.includes("↑↓ 1–8/13")),
			`the wheel clamps at the top: ${widget.render(80).join(" | ")}`,
		);
	});

	it("compact expanded list shows the scroll hint with keyboard suffix (S13)", async () => {
		await harness.sessionStart(project);
		for (let id = 1; id <= 12; id++) await harness.runCommand(`add nota compacta numero ${id}`, project);
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 10, 0, 80));
		const expanded = widget.render(80);
		// The hint carries the keyboard suffix "· alt+pgup/pgdn"
		assert.ok(expanded.some((line) => line.includes("↑↓ 1–8/12 · alt+pgup/pgdn")), `compact hint has keyboard suffix: ${expanded.join(" | ")}`);
	});

	it("rail card shows the scroll hint with keyboard suffix when overflowing (S13)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		// Add enough notes to overflow the rail body (RAIL_BODY_CAP = 24)
		for (let id = 1; id <= 30; id++) await harness.runCommand(`add nota rail numero ${id}`, project);
		const rail = harness.rail();
		const lines = rail.render(46);
		// The rail hint also carries "· alt+pgup/pgdn"
		assert.ok(lines.some((line) => line.includes("↑↓ 1–") && line.includes("· alt+pgup/pgdn")), `rail hint has keyboard suffix: ${lines.join(" | ")}`);
	});

	it("rail scroll hint is hidden when the list fits (S13)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		for (let id = 1; id <= 5; id++) await harness.runCommand(`add nota corta ${id}`, project);
		const rail = harness.rail();
		const lines = rail.render(46);
		// No overflow = no hint row
		assert.ok(!lines.some((line) => line.includes("↑↓")), `no hint when it fits: ${lines.join(" | ")}`);
	});





	it("compact hint is hidden when collapsed (S13)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		for (let id = 1; id <= 12; id++) await harness.runCommand(`add nota compacta ${id}`, project);
		const widget = harness.buildWidget();
		widget.render(80);
		// Collapsed: no expanded list, no hint
		const collapsed = widget.render(80);
		assert.ok(!collapsed.some((line) => line.includes("↑↓")), `no hint when collapsed: ${collapsed.join(" | ")}`);
	});

	it("paints the rail card by default, with the input row, even with no notes", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const lines = harness.rail().render(46);
		// Float chrome: padding, header, padding, the field row, closing padding.
		assert.equal(lines.length, 5);
		assert.ok(lines[1]?.includes("✎ Notes"), `header carries the card glyph and title: ${lines[1]}`);
		assert.ok(lines[1]?.includes("0 total, 0 pend"), "header carries the empty summary");
		assert.ok(lines[3]?.includes("＋ Write a note…"), `the field paints its placeholder: ${lines[3]}`);
		assert.ok(lines[3]?.includes("\x1b[48;5;22m"), "the field row carries the panel background");
		assert.ok(lines[3]?.includes("▎"), "the field row carries the float rail");
		assert.ok(!lines[3]?.includes("│"), `the field row adds no outline edges: ${JSON.stringify(lines[3])}`);
		assert.ok(lines[4]?.includes("\x1b[48;5;22m"), "the panel paints the tone background");
	});

	it("focuses the input row on click and captures notes with Enter", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);

		const click = rail.handleMouse?.(mouse("click", 5, 3, 46));
		assert.equal(click?.handled, true);
		assert.equal(harness.getFocus(), rail, "the click focuses the rail card");
		assert.equal(rail.focused, true);

		rail.handleInput?.("una nota rapida");
		rail.handleInput?.("\r");
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes.map((note) => note.text), ["una nota rapida"]);

		// The field clears itself — the note moves to the list — and keeps
		// the focus for the next one: the caret stays, the placeholder does
		// not return until the field blurs.
		const after = rail.render(46).join("\n");
		assert.ok(after.includes("una nota rapida"), "the saved note paints in the list");
		assert.ok(!after.includes("＋ Write a note…"), "the placeholder waits for the blur");
		assert.equal(rail.focused, true, "focus stays for rapid capture");
	});

	it("wraps a long capture into following field rows before saving", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		rail.handleInput?.("una nota larguisima que se extiende mucho mas alla de una sola fila visible");
		const mid = rail.render(46);
		assert.equal(mid.length, 6, `the card grows with the wrap: ${mid.length}`);
		for (const [index, line] of mid.entries()) {
			assert.ok(!line.includes("│"), `wrapped row ${index} adds no outline edges: ${JSON.stringify(line)}`);
		}
		rail.handleInput?.("\r");
		await FLUSH();
		assert.equal(loadNotes(project).notes[0]?.text, "una nota larguisima que se extiende mucho mas alla de una sola fila visible");
	});

	it("scrolls the field so the cursor stays visible while a long capture grows", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		// A capture wrapping far past the card's own budget: the field windows
		// itself around the cursor instead of pushing the card past the edge.
		rail.handleInput?.(`PRINCIPIO ${"charla ".repeat(120)}MARCAFINAL`);
		const output = rail.render(46);
		const budget = Math.min(24, Math.floor(48 / 2));
		assert.ok(output.length <= budget, `the card holds its own budget: ${output.length} > ${budget}`);
		const markerRow = output.findIndex((line) => line.includes(CURSOR_MARKER));
		assert.ok(markerRow >= 0, "the cursor marker stays in the card");
		assert.ok(markerRow < budget, `the cursor row stays inside the budget: row ${markerRow} of ${budget}`);
		const painted = output.join("\n");
		assert.ok(painted.includes("MARCAFINAL"), "the text being typed stays visible");
		assert.ok(!painted.includes("PRINCIPIO"), "the field scrolled past the head of the capture");
	});

	it("keeps the rejected draft in the field instead of clearing it (P1.1)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		// A capture over the limit is refused by the store, not truncated: the
		// field has to keep what the user wrote so they can edit it down.
		rail.handleInput?.(`PRINCIPIO ${"y".repeat(MAX_NOTE_LENGTH)}COLATAIL`);
		rail.handleInput?.("\r");
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes, [], "the rejected note is not stored");
		assert.ok(
			harness.notifies.some((entry) => entry.message.includes("too long")),
			`the rejection is reported: ${JSON.stringify(harness.notifies)}`,
		);
		const painted = rail.render(46).join("\n");
		assert.ok(painted.includes("COLATAIL"), "the rejected text stays in the field instead of vanishing");

		// The clear still happens where it belongs: a save the store accepted.
		rail.handleInput?.("\x15"); // ctrl+u clears the editor line
		rail.handleInput?.("nota corta aceptada");
		rail.handleInput?.("\r");
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes.map((note) => note.text), ["nota corta aceptada"]);
		// The note paints in the list; the field that carried it is empty again,
		// so the text appears exactly once.
		const occurrences = rail.render(46).join("\n").split("nota corta aceptada").length - 1;
		assert.equal(occurrences, 1, "an accepted save still clears the field");
	});

	it("does not repaint the draft when a post-write notify throws (D1)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		// A notify that throws *after* the store took the note must not travel
		// back as "the note was refused": the draft comes back, the next Enter
		// saves it again, and the user ends up with two identical notes.
		const realPush = harness.notifies.push.bind(harness.notifies);
		let armed = true;
		harness.notifies.push = (...entries: { message: string; type?: string }[]) => {
			if (armed && entries.some((entry) => entry.message === "Note saved")) {
				armed = false;
				throw new Error("notify blew up after the write landed");
			}
			return realPush(...entries);
		};
		rail.handleInput?.("una nota que si llega al store");
		rail.handleInput?.("\r");
		await FLUSH();
		assert.equal(loadNotes(project).notes.length, 1, "the store took the note exactly once");
		const painted = rail.render(46).join("\n");
		assert.equal(painted.split("una nota que si llega al store").length - 1, 1, "a notify failure does not put a saved draft back in the field");
	});

	it("carries both header controls with their actions (S8)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		const header = rail.render(46)[1] ?? "";
		assert.ok(header.includes("▾ Collapse"), `collapse control in the header: ${JSON.stringify(header)}`);
		assert.ok(header.includes("▾ Fold"), `fold control in the header: ${JSON.stringify(header)}`);
	});

	it("collapses the block from its header control and keeps the draft (S8)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		rail.handleInput?.("borrador en curso");
		const expanded = rail.render(46);
		assert.ok(expanded.some((line) => line.includes("borrador")), "the draft paints in the field");
		const span = controlSpan(expanded[1] ?? "", "▾ Collapse");
		assert.ok(span, "the collapse control has a span on the header row");
		rail.handleMouse?.(mouse("click", span.start, 1, 46));
		const collapsed = rail.render(46);
		assert.ok(collapsed[1]?.includes("▸ Expand"), `the control offers to expand: ${JSON.stringify(collapsed[1])}`);
		assert.ok(!collapsed.some((line) => line.includes("borrador")), "the field leaves the collapsed block");
		assert.equal(harness.getFocus(), null, "collapsing releases the keyboard");
		const back = controlSpan(collapsed[1] ?? "", "▸ Expand");
		assert.ok(back, "the expand control has a span");
		rail.handleMouse?.(mouse("click", back.start, 1, 46));
		const again = rail.render(46);
		assert.ok(again[1]?.includes("▾ Collapse"), "expanding restores the control");
		assert.ok(again.some((line) => line.includes("borrador")), "the draft survives the round trip");
	});

	it("folds every note to one line from its header control (S8)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		rail.handleInput?.("una nota larguisima que se extiende mucho mas alla de una sola fila visible del bloque");
		rail.handleInput?.("\r");
		await FLUSH();
		const unfolded = rail.render(46);
		assert.ok(unfolded.length > 6, `the card grows with the wrap: ${unfolded.length}`);
		const span = controlSpan(unfolded[1] ?? "", "▾ Fold");
		assert.ok(span, "the fold control has a span");
		rail.handleMouse?.(mouse("click", span.start, 1, 46));
		const folded = rail.render(46);
		assert.ok(folded[1]?.includes("▸ Full"), `the control offers the full text back: ${JSON.stringify(folded[1])}`);
		assert.ok(folded.length < unfolded.length, `folding shortens the card: ${folded.length} < ${unfolded.length}`);
		assert.ok(folded.some((line) => line.includes("…")), "the folded note marks the hidden text");
		assert.ok(folded.some((line) => line.includes("➤")), "the send glyph stays on the folded row");
	});

	it("paints the control under the pointer with the hover role (S8)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		const span = controlSpan(rail.render(46)[1] ?? "", "▾ Fold");
		assert.ok(span, "the fold control has a span");
		rail.handleMouse?.(mouse("move", span.start, 1, 46));
		const hovered = rail.render(46)[1] ?? "";
		assert.ok(hovered.includes(`${WARNING}▾ Fold`), `hover paints the warning role: ${JSON.stringify(hovered)}`);
		assert.ok(!hovered.includes(`${WARNING}▾ Collapse`), "the other control keeps its idle role");
	});

	it("remembers the folded view across a session restart", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add una nota que se va a plegar", project);
		await harness.runCommand("fold", project);
		await FLUSH();
		assert.equal(loadNotes(project).ui?.foldAll, true, "the fold mode reaches the stored state");

		// A brand new session over the same project restores the folded view.
		const second = makeHarness();
		await second.sessionStart(project);
		second.buildWidget();
		const rail = second.rail();
		assert.ok(rail.render(46)[1]?.includes("▸ Full"), "the block starts folded");
		assert.ok(rail.render(46).some((line) => line.includes("…")), "the note is folded to one line");
	});

	it("remembers the collapsed block across a session restart", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("collapse", project);
		await FLUSH();
		assert.equal(loadNotes(project).ui?.railCollapsed, true);

		const second = makeHarness();
		await second.sessionStart(project);
		second.buildWidget();
		assert.ok(second.rail().render(46)[1]?.includes("▸ Expand"), "the block comes back collapsed");
	});

	it("remembers one note's fold exception across a session restart", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add primera nota larga que necesita varias filas para leerse entera", project);
		await harness.runCommand("add segunda nota que sigue plegada al volver", project);
		await harness.runCommand("fold", project);
		await FLUSH();
		const rail = harness.rail();
		// A click on a folded note's text unfolds it: that deviation from the
		// mode — not the mode itself — is what has to survive.
		// The folded note is the row that keeps its first words and marks the
		// rest with an ellipsis; the field placeholder carries one too, so the
		// search goes by the note's own text.
		const row = rail.render(46).findIndex((line) => line.includes("primera nota") && line.includes("…"));
		assert.ok(row >= 0, "the folded note marks the hidden text");
		rail.handleMouse?.(mouse("click", 6, row, 46));
		await FLUSH();
		assert.equal(loadNotes(project).ui?.foldAll, true, "the folded default survives");
		assert.deepEqual(loadNotes(project).ui?.foldOverrides, { 1: false }, "the unfolded note is the exception");

		const second = makeHarness();
		await second.sessionStart(project);
		second.buildWidget();
		const restored = second.rail().render(46);
		assert.ok(restored[1]?.includes("▸ Full"), "the folded default comes back");
		assert.ok(restored.some((line) => line.includes("leerse")), "the exception stays unfolded past the first row");
		assert.ok(restored.some((line) => line.includes("segunda nota") && line.includes("…")), "the other note stays folded");
	});

	it("collapses the sent section from its control and remembers it", async () => {
		// A long list is what paints the summary row by default: seed one sent
		// note among nineteen pendings, with the section expanded.
		const notes = [];
		for (let id = 1; id <= 19; id++) notes.push({ id, text: `pendiente ${id}`, status: "pending" as const, createdAt: id });
		notes.push({ id: 20, text: "una enviada", status: "sent" as const, createdAt: 20, sentAt: 21 });
		await saveNotes(project, { notes, nextId: 21, ui: { sentCollapsed: false } });
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		const sentRow = rail.render(46).findIndex((line) => line.includes("sent") && line.includes("Collapse"));
		assert.ok(sentRow >= 0, `the sent summary is painted: ${JSON.stringify(rail.render(46))}`);
		const span = controlSpan(rail.render(46)[sentRow] ?? "", "Collapse");
		assert.ok(span, "the sent summary carries a collapse control");

		rail.handleMouse?.(mouse("click", span.start, sentRow, 46));
		await FLUSH();
		const after = rail.render(46);
		assert.ok(after.some((line) => line.includes("sent") && line.includes("Expand")), "the control flips to Expand");
		assert.ok(!after.some((line) => line.includes("una enviada")), "the sent rows fold away");
		assert.equal(loadNotes(project).ui?.sentCollapsed, true, "the collapse reaches the stored state");

		// The next session opens with the sent section already folded, and the
		// same control brings it back.
		const second = makeHarness();
		await second.sessionStart(project);
		second.buildWidget();
		const secondRail = second.rail();
		const restoredRow = secondRail.render(46).findIndex((line) => line.includes("sent") && line.includes("Expand"));
		assert.ok(restoredRow >= 0, "the section comes back collapsed");
		const expand = controlSpan(secondRail.render(46)[restoredRow] ?? "", "Expand");
		assert.ok(expand);
		secondRail.handleMouse?.(mouse("click", expand.start, restoredRow, 46));
		await FLUSH();
		assert.ok(secondRail.render(46).some((line) => line.includes("una enviada")), "expanding brings the sent rows back");
	});

	it("keeps the sent control on a short list, both ways", async () => {
		// The trap this pins: with three notes instead of twenty the header used
		// to disappear, so a section that was collapsed (or expanded) could not
		// be toggled back at all.
		await harness.sessionStart(project);
		await harness.runCommand("add sigue pendiente", project);
		await harness.runCommand("add queda enviada", project);
		await harness.runCommand("send 2", project);
		await FLUSH();
		harness.buildWidget();
		const rail = harness.rail();
		/** The `N sent` header row: the only line naming the section and
		 * carrying its own control (L45 dropped the ✓ lead). */
		const headerRow = (lines: string[]): number =>
			lines.findIndex((line) => line.includes("sent") && (line.includes("Collapse") || line.includes("Expand")));

		const first = headerRow(rail.render(46));
		assert.ok(first >= 0, `a short list still paints the header: ${JSON.stringify(rail.render(46))}`);
		assert.ok(first > 0, "the header sits under the pending row, above the sent one");
		const collapse = controlSpan(rail.render(46)[first] as string, "Collapse");
		assert.ok(collapse, "a short list offers the collapse");

		rail.handleMouse?.(mouse("click", collapse.start, first, 46));
		await FLUSH();
		const folded = rail.render(46);
		const foldedRow = headerRow(folded);
		assert.ok(folded[foldedRow]?.includes("Expand"), `the control flips: ${folded.join(" | ")}`);
		assert.ok(!folded.some((line) => line.includes("queda enviada")), "the sent row folds away");

		const expand = controlSpan(rail.render(46)[foldedRow] as string, "Expand");
		assert.ok(expand, "the way back is still painted");
		rail.handleMouse?.(mouse("click", expand.start, foldedRow, 46));
		await FLUSH();
		const reopened = rail.render(46);
		assert.ok(reopened.some((line) => line.includes("queda enviada")), "expanding brings the row back");
		const reopenedRow = headerRow(reopened);
		assert.ok(reopened[reopenedRow]?.includes("Collapse"), `and the control stays reachable: ${reopened.join(" | ")}`);
	});

	it("keeps the restore target on the affordance when the note paints one itself (P1.4)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add repasar el ↶ del rail despues", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();

		const sent = rail.render(46);
		const sentRow = sent.findIndex((line) => line.includes("repasar el"));
		assert.ok(sentRow >= 0, `the sent row paints: ${JSON.stringify(sent)}`);
		const columns = glyphColumnsAt(sent[sentRow] as string, "↶");
		assert.equal(columns.length, 2, `the note's own glyph and the affordance: ${JSON.stringify(sent[sentRow])}`);
		const [inText, affordance] = columns as [number, number];

		// The glyph inside the note's text is content, not a button.
		rail.handleMouse?.(mouse("click", inText, sentRow, 46));
		await FLUSH();
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.SENT, "the text's own glyph does not restore the note");

		rail.handleMouse?.(mouse("click", affordance, sentRow, 46));
		await FLUSH();
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.PENDING, "the affordance at the row's end still restores");
	});

	it("restores a sent note from its row's restore glyph", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add revisar el footer", project);
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		// Send it first: the row moves to the sent section with its ↶ affordance.
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		const sentRow = rail.render(46).findIndex((line) => line.includes("revisar el footer"));
		assert.ok(sentRow >= 0, "the note is painted as a sent row");
		const restoreColumn = restoreGlyphColumn(rail.render(46)[sentRow] as string);
		assert.ok(restoreColumn !== undefined, "the sent row carries the restore glyph");

		rail.handleMouse?.(mouse("click", restoreColumn as number, sentRow, 46));
		await FLUSH();
		const state = loadNotes(project);
		assert.equal(state.notes[0]?.status, NOTE_STATUS.PENDING, "the note is pending again");
		assert.equal(state.notes[0]?.sentAt, undefined, "restoring clears the send instant");
		assert.ok(harness.notifies.some((entry) => entry.message.includes("restored to pending")));
	});

	it("puts a restored note back into sent without sending it again", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add volver a enviada", project);
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		// Take it back to pending from the sent row...
		const sentRow = rail.render(46).findIndex((line) => line.includes("volver a enviada"));
		const restoreColumn = restoreGlyphColumn(rail.render(46)[sentRow] as string) as number;
		rail.handleMouse?.(mouse("click", restoreColumn, sentRow, 46));
		await FLUSH();
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.PENDING);

		// ...and the row now offers the way back to sent, with no new message.
		const pendingRow = rail.render(46).findIndex((line) => line.includes("volver a enviada"));
		const backColumn = revertGlyphColumn(rail.render(46)[pendingRow] as string);
		assert.ok(backColumn !== undefined, `the row carries the sent-again glyph: ${rail.render(46)[pendingRow]}`);
		assert.equal(harness.sent.length, 1, "only the first send reached the chat");
		rail.handleMouse?.(mouse("click", backColumn as number, pendingRow, 46));
		await FLUSH();

		const state = loadNotes(project);
		assert.equal(state.notes[0]?.status, NOTE_STATUS.SENT, "the note is in the sent list again");
		assert.equal(state.notes[0]?.everSent, true);
		assert.equal(harness.sent.length, 1, "nothing else was submitted to the agent");
		assert.ok(
			harness.notifies.some((entry) => entry.message.includes("back in the sent list")),
			`the change is announced: ${JSON.stringify(harness.notifies)}`,
		);
	});

	it("paints the restore glyph with the hover role and drops it on exit", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add una nota que ya se mando", project);
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		const sentRow = rail.render(46).findIndex((line) => line.includes("una nota que ya se mando"));
		const restoreColumn = restoreGlyphColumn(rail.render(46)[sentRow] as string) as number;

		rail.handleMouse?.(mouse("move", restoreColumn, sentRow, 46));
		const hovered = rail.render(46)[sentRow] ?? "";
		assert.ok(hovered.includes(`${ACCENT}↶`), `hover paints the accent role: ${JSON.stringify(hovered)}`);
		rail.handleMouse?.(mouse("move", 6, sentRow, 46));
		const idle = rail.render(46)[sentRow] ?? "";
		assert.ok(idle.includes(`${MUTED}↶`), `leaving the glyph restores the muted role: ${JSON.stringify(idle)}`);
	});

	it("drives both view modes from the notes command (S8)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		await harness.runCommand("fold", project);
		assert.ok(rail.render(46)[1]?.includes("▸ Full"), "fold from the command");
		await harness.runCommand("unfold", project);
		assert.ok(rail.render(46)[1]?.includes("▾ Fold"), "unfold from the command");
		await harness.runCommand("collapse", project);
		assert.ok(rail.render(46)[1]?.includes("▸ Expand"), "collapse from the command");
		assert.ok(!rail.render(46).some((line) => line.includes("＋ Write a note…")), "the field leaves the collapsed block");
		await harness.runCommand("expand", project);
		assert.ok(rail.render(46)[1]?.includes("▾ Collapse"), "expand from the command");
	});

	it("returns the keyboard to the chat on Escape", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		assert.equal(harness.getFocus(), rail);
		rail.handleInput?.("escrita");
		rail.handleInput?.("\x1b");
		assert.equal(harness.getFocus(), null, "Escape blurs the card");
		assert.deepEqual(loadNotes(project).notes, [], "nothing was saved");
	});

	it("sends a clicked rail row to the chat and marks it sent", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add revisar el footer", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));

		const result = rail.handleMouse?.(mouse("click", column, row, 46));
		assert.equal(result?.handled, true);
		await FLUSH();

		assert.deepEqual(harness.sent, [{ content: "revisar el footer", options: undefined }]);
		const state = loadNotes(project);
		assert.equal(state.notes[0]?.status, NOTE_STATUS.SENT);
		assert.equal(typeof state.notes[0]?.sentAt, "number");
		assert.ok(harness.notifies.some((entry) => entry.message.includes("sent to the chat")));
		const after = rail.render(46).join("\n");
		assert.ok(after.includes("\x1b[9m"), "the sent row renders struck through");
	});

	it("queues the prompt as a follow-up while the agent is running", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add en cola", project);
		harness.buildWidget();
		harness.agentStart();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "en cola", options: { deliverAs: "followUp" } }]);
	});

	it("sends straight to the chat while the destination is the chat", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add derecho al chat", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "derecho al chat", options: undefined }]);
		assert.deepEqual(harness.pasted, [], "the chat editor is not touched");
	});

	it("loads the note into the chat input when the destination is the editor", async () => {
		writeSettings({ version: 1, sendDestination: SEND_DESTINATION.EDITOR });
		await harness.sessionStart(project);
		await harness.runCommand("add editar antes", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		assert.deepEqual(harness.pasted, ["editar antes"], "the text lands in the chat editor");
		assert.deepEqual(harness.sent, [], "nothing is submitted yet");
		assert.equal(loadNotes(project).notes[0]?.status, "sent", "the note leaves the pending list");
		assert.ok(
			harness.notifies.some((entry) => entry.message.includes("loaded into the chat input")),
			`the notification names the destination: ${JSON.stringify(harness.notifies)}`,
		);
	});

	it("offers both send targets and ticks the live one", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("settings", project);
		const picker = harness.selectCalls[harness.selectCalls.length - 1];
		assert.equal(picker?.title, "Send notes to");
		assert.deepEqual(
			picker?.options,
			["✓ Send to the chat now", "  Load into the chat input to edit first"],
			"the live target carries the tick",
		);
	});

	it("persists the send target for every project", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("settings editor", project);
		assert.equal(readSettings().sendDestination, SEND_DESTINATION.EDITOR, "the global file carries the choice");
		assert.ok(
			harness.notifies.some((entry) => entry.message.toLowerCase().includes("chat input")),
			`the change is announced: ${JSON.stringify(harness.notifies)}`,
		);
	});

	it("rejects an unknown target and keeps the stored one", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("settings telepathy", project);
		assert.equal(readSettings().sendDestination, SEND_DESTINATION.CHAT, "nothing was saved");
		const message = harness.notifies[harness.notifies.length - 1];
		assert.equal(message?.type, "error", `the rejection is an error: ${JSON.stringify(message)}`);
	});

	it("switches the send target from the manager menu", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add algo", project);
		// Choosing the entry opens the destination picker underneath it.
		harness.setSelect("✎  Send target: chat");
		await harness.runCommand("", project);
		const [menu, picker] = harness.selectCalls;
		assert.ok(
			menu?.options.includes("✎  Send target: chat"),
			`the manager entry names the live target: ${JSON.stringify(menu?.options)}`,
		);
		assert.equal(picker?.title, "Send notes to", "the entry opens the picker");

		harness.setSelect("✓ Load into the chat input to edit first");
		await harness.runCommand("settings", project);
		assert.equal(readSettings().sendDestination, SEND_DESTINATION.EDITOR);
	});

	it("highlights the send glyph on hover and restores it on exit", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add hoverme", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));

		const over = rail.handleMouse?.(mouse("move", column, row, 46));
		assert.equal(over?.handled, true);
		assert.equal(over?.render, true);
		assert.ok(rail.render(46)[row]?.includes(`${ACCENT}➤`), "hover paints the accent glyph");

		const out = rail.handleMouse?.(mouse("move", 10, row, 46));
		assert.equal(out?.render, true);
		assert.ok(rail.render(46)[row]?.includes(`${MUTED}➤`), "leaving restores the muted glyph");
	});

	it("sends from two columns beside the send glyph", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add objetivo amplio", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		// The glyph stays one cell — a terminal has no font sizes — so the
		// target grows instead: two columns to either side still send.
		rail.handleMouse?.(mouse("click", column - 2, row, 46));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "objetivo amplio", options: undefined }]);
	});

	it("leaves the third column to the row itself", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add todavia texto", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column - 3, row, 46));
		await FLUSH();
		assert.deepEqual(harness.sent, [], "three columns away is the note's text, not the button");
		assert.equal(loadNotes(project).notes[0]?.status, "pending", "the note stays pending");
	});

	it("deletes a note from its row's delete glyph (D15)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add borrar del rail", project);
		harness.buildWidget();
		const rail = harness.rail();
		const lines = rail.render(46);
		const row = lines.findIndex((line) => line.includes("borrar del rail"));
		assert.ok(row >= 0, `the note paints: ${JSON.stringify(lines)}`);
		const column = deleteGlyphColumn(lines[row] as string);
		assert.ok(column !== undefined, "the delete glyph paints");

		const result = rail.handleMouse?.(mouse("click", column, row, 46));
		assert.equal(result?.handled, true);
		await FLUSH();

		assert.deepEqual(loadNotes(project).notes, [], "the note leaves the store for good");
		const after = rail.render(46).join("\n");
		assert.ok(!after.includes("borrar del rail"), "the note leaves the card");
	});

	it("paints the delete glyph accent on hover and deletes through the command (D15)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add desde comando", project);
		harness.buildWidget();
		const rail = harness.rail();
		const lines = rail.render(46);
		const row = lines.findIndex((line) => line.includes("desde comando"));
		assert.ok(row >= 0);
		const column = deleteGlyphColumn(lines[row] as string);
		assert.ok(column !== undefined);

		rail.handleMouse?.(mouse("move", column, row, 46));
		assert.ok(rail.render(46)[row]?.includes(`${ACCENT}×`), "hover paints the accent glyph");
		const out = rail.handleMouse?.(mouse("move", 4, row, 46));
		assert.equal(out?.render, true);
		assert.ok(rail.render(46)[row]?.includes(`${MUTED}×`), "leaving restores the muted glyph");

		await harness.runCommand("delete 1", project);
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes, [], "delete from the command removes it");
		assert.ok(harness.notifies.some((entry) => entry.message.includes("deleted")), "the command reports the delete");
	});

	it("opens inline editing from a click on the note text and commits with Enter", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add corregir el typo", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row } = glyphRow(rail.render(46));

		const edit = rail.handleMouse?.(mouse("click", 10, row, 46));
		assert.equal(edit?.handled, true);
		assert.equal(harness.getFocus(), rail, "editing takes the keyboard focus");
		const editing = rail.render(46).join("\n");
		assert.ok(!editing.includes("➤"), "the edit row replaces the note row, glyph included");
		assert.ok(!editing.includes("│"), "the edit block paints in the card's chrome");

		rail.handleInput?.("s");
		rail.handleInput?.("\r");
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes.map((note) => note.text), ["corregir el typos"]);
		assert.equal(harness.getFocus(), null, "committing the edit returns the keyboard to the chat");
		assert.ok(rail.render(46).join("\n").includes("➤"), "the note row paints again");
	});

	it("unfolds and edits on a click, folds back on a double click (L21)", async () => {
		await harness.sessionStart(project);
		const long = "una nota larguisima que se extiende mucho mas alla de una sola fila visible del bloque";
		await harness.runCommand(`add ${long}`, project);
		harness.buildWidget();
		const rail = harness.rail();
		const unfolded = rail.render(46);
		const { row, column } = glyphRow(unfolded);
		const x = column - 6;

		rail.handleMouse?.(mouse("click", x, row, 46));
		assert.ok(rail.render(46).some((line) => line.includes(CURSOR_MARKER)), "the click unfolds the note into the inline editor");

		rail.handleMouse?.(mouse("click", x, row, 46, undefined, 2));
		const folded = rail.render(46);
		assert.equal(harness.getFocus(), null, "folding the note releases the keyboard");
		assert.ok(folded.length < unfolded.length, `folding shortens the card: ${folded.length} < ${unfolded.length}`);
		assert.ok(folded.some((line) => line.includes("…")), "the folded note marks the hidden text");
		assert.ok(folded.some((line) => line.includes("➤")), "the send glyph stays on the folded row");
		assert.deepEqual(loadNotes(project).notes.map((note) => note.text), [long], "an untouched fold writes nothing");

		rail.handleMouse?.(mouse("click", x, row, 46));
		assert.ok(rail.render(46).some((line) => line.includes(CURSOR_MARKER)), "a click unfolds it again into the editor");
	});

	it("folds only the double clicked note and keeps the rest open (L21)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add primera nota que ocupa bastante mas de una sola fila visible", project);
		await harness.runCommand("add segunda nota que tambien pasa de una sola fila visible del bloque", project);
		harness.buildWidget();
		const rail = harness.rail();
		const before = rail.render(46);
		const first = before.findIndex((line) => line.includes("primera nota"));
		assert.ok(first >= 0, "the first note paints");
		const column = sendGlyphColumn(before[first] as string);
		assert.ok(column !== undefined);

		rail.handleMouse?.(mouse("click", (column as number) - 6, first, 46));
		rail.handleMouse?.(mouse("click", (column as number) - 6, first, 46, undefined, 2));
		const after = rail.render(46);
		assert.ok(after[first]?.includes("…"), `the double clicked note folds: ${JSON.stringify(after[first])}`);
		assert.ok(after.some((line) => line.includes("segunda nota que tambien pasa")), "the other note keeps its full text");
	});

	it("owns press events so the TUI selection layer cannot select card text (L22)", async () => {
		await harness.sessionStart(project);
		const long = "una nota larguisima que se extiende mucho mas alla de una sola fila visible del bloque";
		await harness.runCommand(`add ${long}`, project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		// pi-tui's alt screen starts a text selection wherever a press goes
		// unhandled, and on the second press of a double click it selects the
		// word under the pointer and copy-on-selects it — the release then stops
		// being a click and the fold never fires. The card must consume presses.
		const press = rail.handleMouse?.(mouse("press", column - 6, row, 46));
		assert.deepEqual(press, { handled: true, render: false }, `the card consumes the press: ${JSON.stringify(press)}`);
	});

	it("cancels the inline edit with Escape and keeps the note unchanged", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add dejar igual", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row } = glyphRow(rail.render(46));

		rail.handleMouse?.(mouse("click", 10, row, 46));
		rail.handleInput?.("x");
		rail.handleInput?.("\x1b");
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes.map((note) => note.text), ["dejar igual"]);
		assert.equal(harness.getFocus(), null);
		assert.ok(rail.render(46).join("\n").includes("➤"), "the note paints again untouched");
	});

	it("ignores clicks on sent rows: no editing, no sending", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add ya enviada", project);
		harness.buildWidget();
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "ya enviada", options: undefined }]);

		const lines = rail.render(46);
		const sentRow = lines.findIndex((line) => line.includes("\x1b[9m"));
		assert.ok(sentRow >= 0, "the sent row renders struck through");
		const result = rail.handleMouse?.(mouse("click", 10, sentRow, 46));
		assert.notEqual(result?.handled, true);
		assert.equal(harness.getFocus(), null, "sent rows never take focus");
		await FLUSH();
		assert.equal(loadNotes(project).notes[0]?.text, "ya enviada");
	});

	it("renders every line within the requested width — the rail turns itself off on overflow", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add una nota para el chequeo de contraccion del rail", project);
		const compact = harness.buildWidget();
		const rail = harness.rail();
		// The wrapping field is the risk surface: typing grows its rows.
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		rail.handleInput?.("texto largo que envuelve el campo a varias filas seguidas");
		for (const width of [30, 40, 46, 80, 120]) {
			for (const [index, line] of rail.render(width).entries()) {
				assert.ok(visibleWidth(line) <= width, `rail row ${index} paints ${visibleWidth(line)} cols at width ${width}: ${JSON.stringify(line)}`);
			}
			for (const [index, line] of compact.render(width).entries()) {
				assert.ok(visibleWidth(line) <= width, `compact row ${index} paints ${visibleWidth(line)} cols at width ${width}: ${JSON.stringify(line)}`);
			}
		}
		// The expanded compact list obeys the same contract.
		compact.render(80);
		compact.handleMouse?.(mouse("click", 10, 1, 80));
		for (const [index, line] of compact.render(80).entries()) {
			assert.ok(visibleWidth(line) <= 80, `expanded compact row ${index} paints ${visibleWidth(line)} cols: ${JSON.stringify(line)}`);
		}
	});

	it("bounds the body viewport like the Todos panel and scrolls the overflow", async () => {
		await harness.sessionStart(project);
		for (let id = 1; id <= 6; id++) await harness.runCommand(`add nota numero ${id}`, project);
		harness.buildWidget();
		(harness.fakeTui.terminal as { rows?: number }).rows = 12;
		const rail = harness.rail();
		const first = rail.render(46);
		assert.equal(first.filter((line) => line.includes("nota numero")).length, 1, "only one note is visible");
		// Hint is now inside the panel body (before bottom rule), so check second-to-last line
		const hint = first[first.length - 2] ?? "";
		assert.ok(hint.includes("↑↓ 1–1/6"), `overflow hint reports the window: ${hint}`);

		const wheel = rail.handleMouse?.(mouse("wheel", 20, 4, 46, 1));
		assert.equal(wheel?.handled, true);
		const second = rail.render(46);
		const hintAfter = second[second.length - 2] ?? "";
		assert.ok(hintAfter.includes("↑↓ 2–2/6"), `scrolling advances the window: ${hintAfter}`);
	});

	it("grows the card down to half the terminal so more notes stay visible (L24)", async () => {
		await harness.sessionStart(project);
		for (let id = 1; id <= 15; id++) await harness.runCommand(`add nota visible ${id}`, project);
		harness.buildWidget();
		(harness.fakeTui.terminal as { rows?: number }).rows = 50;
		const rail = harness.rail();
		const lines = rail.render(46);
		const visible = lines.filter((line) => line.includes("nota visible")).length;
		assert.equal(visible, 15, `the taller card holds every note: ${visible} of 15`);
		assert.ok(!lines.some((line) => line.includes("↑↓")), `no overflow hint while the notes fit: ${JSON.stringify(lines[lines.length - 1])}`);
	});

	it("sends a pending note through the picker (S14)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add por picker", project);
		// /notes send without id opens the picker (alt+n no longer lists notes)
		// Test the picker directly via the command handler
		harness.setSelect("➤  #1 por picker");
		await harness.runCommand("send", project);
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "por picker", options: undefined }]);
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.SENT);
	});

	it("adds a note via /note command (S14: manager no longer captures)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add desde el comando", project);
		const state = loadNotes(project);
		assert.equal(state.notes[0]?.text, "desde el comando");
		assert.equal(state.notes[0]?.status, NOTE_STATUS.PENDING);
	});

	it("lists notes and shows help through the command", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add listar esto", project);
		harness.notifies.length = 0;
		await harness.runCommand("list", project);
		assert.ok(harness.notifies.some((entry) => entry.message.includes("#1 listar esto")));
		harness.notifies.length = 0;
		await harness.runCommand("help", project);
		assert.ok(harness.notifies.some((entry) => entry.message.includes("Usage: /notes")));
	});

	it("clears every note only after confirmation", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add sobrevivir", project);

		harness.setConfirm(false);
		await harness.runCommand("clear", project);
		assert.equal(loadNotes(project).notes.length, 1, "declining keeps the notes");

		harness.setConfirm(true);
		await harness.runCommand("clear", project);
		assert.deepEqual(loadNotes(project).notes, []);
		assert.deepEqual(harness.buildWidget().render(80), []);
	});

	it("offers the scoped clears in the manager and removes one group only", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add queda pendiente", project);
		await harness.runCommand("add se manda al chat", project);
		// Send the second one so the menu has both groups.
		await harness.runCommand("send 2", project);
		await FLUSH();

		harness.setSelect(MANAGER_CLEAR_PENDING);
		harness.setConfirm(true);
		await harness.runCommand("", project);
		const options = harness.selectCalls[harness.selectCalls.length - 1]?.options ?? [];
		assert.ok(!options.some((o) => o.includes("Clear all sent")), `sent clear removed: ${JSON.stringify(options)}`);
		assert.ok(options.includes(MANAGER_CLEAR_PENDING), "the menu offers the pending clear");
		assert.ok(options.includes(MANAGER_CLEAR), "the full clear stays");
		const afterSent = loadNotes(project);
		assert.deepEqual(afterSent.notes.map((note) => note.text), ["se manda al chat"], "only the pending group went");
		assert.ok(harness.notifies.some((entry) => entry.message.includes("Pending notes cleared (1)")));
	});

	it("clears only the pending notes from the manager", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add se queda enviada", project);
		await harness.runCommand("add esta se borra", project);
		harness.setSelect(`➤  #1 se queda enviada`);
		await harness.runCommand("send", project);
		await FLUSH();

		harness.setSelect(MANAGER_CLEAR_PENDING);
		harness.setConfirm(true);
		await harness.runCommand("", project);
		const state = loadNotes(project);
		assert.deepEqual(state.notes.map((note) => note.status), [NOTE_STATUS.SENT], "the sent note survives");
		assert.ok(harness.notifies.some((entry) => entry.message.includes("Pending notes cleared (1)")));
	});

	it("declining the scoped clear keeps the notes", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add se manda pero se queda", project);
		await harness.runCommand("send 1", project);
		await FLUSH();

		// harness.setSelect(MANAGER_CLEAR_SENT); // removed
		harness.setConfirm(false);
		await harness.runCommand("", project);
		assert.equal(loadNotes(project).notes.length, 1, "a declined confirm removes nothing");
	});

	it("hides a scoped clear while its group is empty", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add solo pendiente", project);
		harness.setSelect(MANAGER_CLEAR_PENDING);
		harness.setConfirm(true);
		await harness.runCommand("", project);
		assert.equal(loadNotes(project).notes.length, 0);
		// With no notes at all, neither scoped clear is offered.
		await harness.runCommand("", project);
		const options = harness.selectCalls[harness.selectCalls.length - 1]?.options ?? [];
		assert.ok(!options.some((o) => o.includes("Clear all sent")), "no sent clear without sent notes");
		assert.ok(!options.includes(MANAGER_CLEAR_PENDING), "no pending clear without pending notes");
	});

	it("releases the field when a click lands outside the card", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		// Click the capture field: the card takes the keyboard.
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		assert.ok(harness.getFocus(), "the card holds the keyboard");
		assert.equal((rail as unknown as { focused?: boolean }).focused, true);

		// A press somewhere else in the terminal reaches the input listeners
		// before any component, and the card is not the receiver: the keyboard
		// has to come back to the chat instead of trapping every keystroke.
		harness.feedInput("\x1b[<0;10;40M");
		await FLUSH();
		assert.equal(harness.getFocus(), null, "the card released the keyboard");
		assert.equal((rail as unknown as { focused?: boolean }).focused, false);
	});

	it("hands the keyboard back to the component it took it from", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		const chatEditor = { render: () => [], invalidate() {}, handleInput() {} };
		harness.setFocus(chatEditor);
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		assert.equal(harness.getFocus(), rail, "the card takes the keyboard");

		// pi-tui drops every keystroke while nothing is focused, so clearing
		// focus would leave the chat deaf: the card must return the keyboard to
		// whoever had it.
		harness.feedInput("\x1b[<0;10;40M");
		await FLUSH();
		assert.equal(harness.getFocus(), chatEditor, "the chat editor got the keyboard back");
	});

	it("keeps the keyboard when the press belongs to the card", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		const field = rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		// The TUI routes the press to the card inside the terminal callback, so
		// the card's tick is already bumped when the callback returns.
		harness.feedInput("\x1b[<0;5;3M", () => rail.handleMouse?.(mouse("press", 5, 3, 46)));
		await FLUSH();
		assert.ok(harness.getFocus(), `the card keeps the keyboard: rendered ${field.length} rows`);
	});

	it("ignores wheel and drag input when deciding to release the keyboard", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const rail = harness.rail();
		rail.render(46);
		rail.handleMouse?.(mouse("click", 5, 3, 46));
		harness.feedInput("\x1b[<64;10;40M"); // wheel up
		harness.feedInput("\x1b[<32;10;40M"); // pointer motion
		await FLUSH();
		assert.ok(harness.getFocus(), "scrolling the chat never steals focus");
	});

	it("commits an open inline edit instead of dropping it on a click-away", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add texto original", project);
		harness.buildWidget();
		const rail = harness.rail();
		const lines = rail.render(46);
		const row = lines.findIndex((line) => line.includes("texto original") && line.includes("➤"));
		rail.handleMouse?.(mouse("click", 6, row, 46));
		rail.handleInput?.("\x15"); // ctrl+u clears the editor line
		rail.handleInput?.("texto editado");
		harness.feedInput("\x1b[<0;10;40M");
		await FLUSH();
		assert.equal(harness.getFocus(), null, "the card released the keyboard");
		assert.equal(loadNotes(project).notes[0]?.text, "texto editado", "the draft was committed, not dropped");
	});

	it("suppresses the compact row while visibility.notes is false", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add oculta esto", project);
		const widget = harness.buildWidget();
		assert.equal(widget.render(80).length, 2);
		sidebarState(harness.fakeTui).visibility = { notes: false };
		assert.deepEqual(widget.render(80), []);
		sidebarState(harness.fakeTui).visibility = { notes: true };
		assert.equal(widget.render(80).length, 2);
	});

	it("counts total and pending in the header and sent in the section header (L45)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add queda pendiente", project);
		await harness.runCommand("add se manda", project);
		await harness.runCommand("send 2", project);
		await FLUSH();
		harness.buildWidget();
		const lines = harness.rail().render(46);
		assert.ok(lines[1]?.includes("2 total, 1 pend"), `the header counts total and pending: ${JSON.stringify(lines[1])}`);
		assert.ok(!lines[1]?.includes("sent"), "the header no longer repeats the sent count");
		const headerRow = lines.findIndex((line) => line.includes("sent"));
		assert.ok(headerRow > 0, `the section header paints: ${lines.join(" | ")}`);
		assert.ok(lines[headerRow]?.includes("1 sent"), `the section counts its own notes: ${lines[headerRow]}`);
	});

	it("deletes one sent note from its row's ✕ and keeps the others (L45)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add primera enviada", project);
		await harness.runCommand("add segunda enviada", project);
		await harness.runCommand("send 1", project);
		await harness.runCommand("send 2", project);
		await FLUSH();
		const rail = harness.rail();
		const lines = rail.render(46);
		const row = lines.findIndex((line) => line.includes("primera enviada"));
		assert.ok(row >= 0, `the sent row paints: ${lines.join(" | ")}`);
		const column = deleteGlyphColumn(lines[row] as string);
		assert.ok(column !== undefined, `the sent row carries its delete glyph: ${JSON.stringify(lines[row])}`);

		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		const state = loadNotes(project);
		assert.deepEqual(state.notes.map((note) => note.text), ["segunda enviada"], "only the clicked sent note is gone");
		assert.ok(harness.notifies.some((entry) => entry.message.includes("Note #1 deleted")), `the removal is announced: ${JSON.stringify(harness.notifies)}`);
	});

	it("clears every sent note from the section header's ✕ (L45)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add se queda pendiente", project);
		await harness.runCommand("add se borra uno", project);
		await harness.runCommand("add se borra dos", project);
		await harness.runCommand("send 2", project);
		await harness.runCommand("send 3", project);
		await FLUSH();
		const rail = harness.rail();
		const lines = rail.render(46);
		const headerRow = lines.findIndex((line) => line.includes("sent"));
		assert.ok(headerRow > 0, `the section header paints: ${lines.join(" | ")}`);
		const span = controlSpan(lines[headerRow] as string, "Delete All");
		assert.ok(span !== undefined, `the group delete paints: ${JSON.stringify(lines[headerRow])}`);

		rail.handleMouse?.(mouse("click", span.start, headerRow, 46));
		await FLUSH();
		const state = loadNotes(project);
		assert.deepEqual(state.notes.map((note) => note.text), ["se queda pendiente"], "the sent group went, the pending note stayed");
		assert.ok(
			harness.notifies.some((entry) => entry.message.includes("Sent notes cleared (2)")),
			`the group clear is announced: ${JSON.stringify(harness.notifies)}`,
		);
		// The empty group takes its header with it: nothing left to collapse.
		assert.ok(!rail.render(46).some((line) => line.includes("sent")), "the section header leaves with its notes");
	});

	it("paints the sent row's delete with the hover role and drops it on exit (L45)", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		await harness.runCommand("add una enviada con boton", project);
		const rail = harness.rail();
		const { row, column } = glyphRow(rail.render(46));
		rail.handleMouse?.(mouse("click", column, row, 46));
		await FLUSH();
		const sentRow = rail.render(46).findIndex((line) => line.includes("una enviada con boton"));
		assert.ok(sentRow >= 0, "the sent row paints");
		const deleteColumn = deleteGlyphColumn(rail.render(46)[sentRow] as string) as number;

		rail.handleMouse?.(mouse("move", deleteColumn, sentRow, 46));
		const hovered = rail.render(46)[sentRow] ?? "";
		assert.ok(hovered.includes(`${ACCENT}×`), `hover paints the accent role: ${JSON.stringify(hovered)}`);
		rail.handleMouse?.(mouse("move", 6, sentRow, 46));
		const idle = rail.render(46)[sentRow] ?? "";
		assert.ok(idle.includes(`${MUTED}×`), `leaving the glyph restores the muted role: ${JSON.stringify(idle)}`);
	});

	it("deletes a sent note and clears the rest from the expanded compact (L45)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add compacta uno", project);
		await harness.runCommand("add compacta dos", project);
		await harness.runCommand("send 1", project);
		await harness.runCommand("send 2", project);
		await FLUSH();
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 10, 0, 80));
		const lines = widget.render(80);
		const row = lines.findIndex((line) => line.includes("compacta uno") && line.includes("✓"));
		assert.ok(row >= 0, `the expanded compact lists the sent note: ${lines.join(" | ")}`);
		const column = deleteGlyphColumn(lines[row] as string);
		assert.ok(column !== undefined, `the compact sent row carries its delete glyph: ${JSON.stringify(lines[row])}`);

		widget.handleMouse?.(mouse("click", column, row, 80));
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes.map((note) => note.text), ["compacta dos"], "only that sent note went");

		const after = widget.render(80);
		const headerRow = after.findIndex((line) => line.includes("sent"));
		assert.ok(headerRow >= 0, `the compact section header paints: ${after.join(" | ")}`);
		const span = controlSpan(after[headerRow] as string, "Delete All");
		assert.ok(span !== undefined, `the compact group delete paints: ${JSON.stringify(after[headerRow])}`);
		widget.handleMouse?.(mouse("click", span.start, headerRow, 80));
		await FLUSH();
		assert.deepEqual(loadNotes(project).notes, [], "the compact header cleared the remaining sent note");
	});

	it("collapses the sent section from the compact list's own control (L45)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add compacta pendiente", project);
		await harness.runCommand("add compacta enviada", project);
		await harness.runCommand("send 2", project);
		await FLUSH();
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 10, 0, 80));
		const lines = widget.render(80);
		const headerRow = lines.findIndex((line) => line.includes("sent"));
		assert.ok(headerRow >= 0, `the compact section header paints: ${lines.join(" | ")}`);
		const span = controlSpan(lines[headerRow] as string, "Collapse");
		assert.ok(span !== undefined, `the compact section control paints: ${JSON.stringify(lines[headerRow])}`);

		widget.handleMouse?.(mouse("click", span.start, headerRow, 80));
		await FLUSH();
		const folded = widget.render(80);
		// The compact subtitle previews the newest note's first words, so the
		// folded assertion goes by the sent row's own ↶ instead of its text.
		assert.ok(!folded.some((line) => line.includes("↶")), `the sent row folds away: ${folded.join(" | ")}`);
		const foldedRow = folded.findIndex((line) => line.includes("sent"));
		assert.ok(folded[foldedRow]?.includes("Expand"), `the control flips inside the compact: ${folded[foldedRow]}`);
	});

	it("paints every manager entry with one glyph family and one label column (S11)", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add queda pendiente", project);
		await harness.runCommand("add se manda", project);
		await harness.runCommand("send 2", project);
		await FLUSH();
		harness.setSelect("Close");
		await harness.runCommand("", project);
		const options = harness.selectCalls[harness.selectCalls.length - 1]?.options ?? [];
		assert.ok(options.length > 1, `the manager opened: ${JSON.stringify(options)}`);
		const entries = options.filter((option) => option !== "Close");
		// S14: manager is settings-only — no add entry, no per-note entries
		assert.ok(!entries.some((option) => option.includes("⚙")), `the emoji-capable gear is gone: ${JSON.stringify(entries)}`);
		assert.ok(!entries.some((option) => option.startsWith("＋")), `no add entry in settings-only manager: ${JSON.stringify(entries)}`);
		assert.ok(!entries.some((option) => option.startsWith("➤")), `no per-note entries in settings-only manager: ${JSON.stringify(entries)}`);
		assert.ok(entries.some((option) => option.startsWith("✎")), `the send target keeps a glyph: ${JSON.stringify(entries)}`);
		assert.ok(entries.some((option) => option.startsWith("×")), `the clear entries keep their glyph: ${JSON.stringify(entries)}`);
		const columns = new Set(entries.map((option) => managerGlyphColumns(option)));
		assert.deepEqual([...columns], [3], `every label starts in the same column: ${JSON.stringify(entries)}`);
	});

	it("uninstalls the widget on session shutdown", async () => {
		await harness.sessionStart(project);
		await harness.sessionShutdown();
		const last = harness.widgetCalls[harness.widgetCalls.length - 1];
		assert.ok(last);
		assert.equal(last.key, "gentle-notes");
		assert.equal(last.content, undefined);
	});
});
