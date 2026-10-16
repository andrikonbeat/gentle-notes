// Integration tests for the gentle-notes extension wiring: registration,
// session lifecycle, widget installation, the compact row, and the rail panel
// as a live notepad — the card paints by default with its own input row,
// clicking it takes keyboard focus, Enter saves, Escape returns the keyboard
// to the chat, and clicking a pending note's text edits it inline. Everything
// runs against mocks with a faithful setFocus; persistence goes through the
// real storage queue under a temp config home. The fake theme emits real ANSI
// escapes, like Pi's themes, so the card measures rows exactly as live.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI, Theme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleNotes from "../src/extension.ts";
import { sidebarState } from "../src/sidebar-interop.ts";
import { loadNotes } from "../src/storage.ts";
import { NOTE_STATUS } from "../src/notes-state.ts";
import { sendGlyphColumn } from "../src/notes-card.ts";

const MANAGER_ADD = "＋ Add a note…";
const ACCENT = "\x1b[38;5;205m";
const MUTED = "\x1b[38;5;242m";
const FLUSH = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

interface WidgetCall {
	key: string;
	content: unknown;
}

interface Harness {
	sent: Array<{ content: unknown; options?: { deliverAs?: string } }>;
	notifies: Array<{ message: string; type?: string }>;
	selectCalls: Array<{ title: string; options: string[] }>;
	widgetCalls: WidgetCall[];
	fakeTui: TUI;
	getFocus: () => unknown;
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
	runShortcut: (cwd: string) => Promise<void>;
}

function makeHarness(): Harness {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }>();
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => void | Promise<void>>>();
	const sent: Harness["sent"] = [];
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
	const fakeTui = {
		terminal: { rows: 48 },
		requestRender() {},
		setFocus(component: Component | null) {
			applyFocus(focusedComponent, false);
			focusedComponent = component;
			applyFocus(component, true);
		},
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
		notifies,
		selectCalls,
		widgetCalls,
		fakeTui,
		getFocus: () => focusedComponent,
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
		runShortcut: async (cwd: string) => {
			const shortcut = shortcuts.get("alt+n");
			assert.ok(shortcut, "alt+n shortcut not registered");
			await shortcut.handler(makeCtx(cwd));
		},
	};
}

function mouse(type: string, x: number, y: number, width: number, wheelDelta?: number): TuiMouseEvent {
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
	} as TuiMouseEvent;
}

/** The rendered row that carries the clickable send glyph. */
function glyphRow(lines: string[]): { row: number; column: number } {
	const row = lines.findIndex((line) => line.includes("➤"));
	assert.ok(row >= 0, `no row carries the send glyph: ${JSON.stringify(lines)}`);
	const column = sendGlyphColumn(lines[row] as string);
	assert.ok(column !== undefined);
	return { row, column: column as number };
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
		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.includes("Notes"), `compact line keeps the title: ${lines[0]}`);
		assert.ok(lines[0]?.includes("1 pend"), `summary paints: ${lines[0]}`);
		assert.ok(lines[0]?.includes("▸ Expand"), `control paints inline: ${lines[0]}`);
		assert.ok(lines[0]?.includes("\x1b[48;5;22m"), "the compact line carries the panel background");
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
		assert.equal(widget.render(80).length, 1);
		const toggle = widget.handleMouse?.(mouse("click", 12, 0, 80));
		assert.equal(toggle?.handled, true);
		const expanded = widget.render(80);
		assert.ok(expanded.length > 1, "the compact row grows into the list");
		assert.ok(expanded[1]?.includes("▾ Collapse"), `header carries the collapse control: ${expanded[1]}`);
		assert.ok(expanded.join("\n").includes("compactable"), "the expanded list shows the note");
		widget.handleMouse?.(mouse("click", 12, 1, 80));
		assert.equal(widget.render(80).length, 1, "collapsing returns the single line");
	});

	it("sends a note straight from the expanded compact list", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add desde el compacto", project);
		const widget = harness.buildWidget();
		widget.render(80);
		widget.handleMouse?.(mouse("click", 12, 0, 80));
		const { row, column } = glyphRow(widget.render(80));
		widget.handleMouse?.(mouse("click", column, row, 80));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "desde el compacto", options: undefined }]);
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.SENT);
	});

	it("paints the rail card by default, with the input row, even with no notes", async () => {
		await harness.sessionStart(project);
		harness.buildWidget();
		const lines = harness.rail().render(46);
		// Float chrome: padding, header, padding, the field row, closing padding.
		assert.equal(lines.length, 5);
		assert.ok(lines[1]?.includes("✿ Notes"), `header carries the card glyph and title: ${lines[1]}`);
		assert.ok(lines[1]?.includes("0 pend · 0 sent"), "header carries the empty summary");
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
		compact.handleMouse?.(mouse("click", 12, 0, 80));
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
		const hint = first[first.length - 1] ?? "";
		assert.ok(hint.includes("↑↓ 1–1/6"), `overflow hint reports the window: ${hint}`);

		const wheel = rail.handleMouse?.(mouse("wheel", 20, 4, 46, 1));
		assert.equal(wheel?.handled, true);
		const second = rail.render(46);
		const hintAfter = second[second.length - 1] ?? "";
		assert.ok(hintAfter.includes("↑↓ 2–2/6"), `scrolling advances the window: ${hintAfter}`);
	});

	it("sends a pending note through the keyboard manager", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add por teclado", project);
		harness.setSelect("➤ #1 por teclado");
		await harness.runShortcut(project);
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "por teclado", options: undefined }]);
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.SENT);
	});

	it("adds a note through the manager dialog input", async () => {
		await harness.sessionStart(project);
		harness.setSelect(MANAGER_ADD);
		harness.setInput("desde el manager");
		await harness.runCommand("", project);
		assert.ok(harness.selectCalls[0]?.title.includes("0 pending"));
		const state = loadNotes(project);
		assert.equal(state.notes[0]?.text, "desde el manager");
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

	it("suppresses the compact row while visibility.notes is false", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add oculta esto", project);
		const widget = harness.buildWidget();
		assert.equal(widget.render(80).length, 1);
		sidebarState(harness.fakeTui).visibility = { notes: false };
		assert.deepEqual(widget.render(80), []);
		sidebarState(harness.fakeTui).visibility = { notes: true };
		assert.equal(widget.render(80).length, 1);
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
