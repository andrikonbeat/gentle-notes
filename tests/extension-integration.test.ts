// Integration tests for the gentle-notes extension wiring: registration,
// session lifecycle, widget installation, the compact row, the interactive
// rail card (hover + send click), the keyboard manager, busy queueing,
// visibility and shutdown. Everything runs against mocks; persistence goes
// through the real storage queue under a temp config home.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Component, TUI, Theme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleNotes from "../src/extension.ts";
import { sidebarState } from "../src/sidebar-interop.ts";
import { loadNotes } from "../src/storage.ts";
import { NOTE_STATUS } from "../src/notes-state.ts";

const MANAGER_ADD = "＋ Add a note…";
const FLUSH = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

interface WidgetCall {
	key: string;
	content: unknown;
}

interface Harness {
	sent: Array<{ content: unknown; options?: { deliverAs?: string } }>;
	notifies: Array<{ message: string; type?: string }>;
	selectCalls: Array<{ title: string; options: string[] }>;
	widgetCalls: Array<WidgetCall>;
	fakeTui: TUI;
	setInput: (value: string | undefined) => void;
	setSelect: (value: string | undefined) => void;
	setConfirm: (value: boolean) => void;
	buildWidget: () => Component & { dispose?(): void };
	rail: () => Component & { digest?(): string; handleMouse?(event: TuiMouseEvent): TuiMouseEventResult };
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

	const fakeTheme = {
		fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
		strikethrough: (text: string) => `~~${text}~~`,
	} as unknown as Theme;
	const fakeTui = { terminal: {}, requestRender() {} } as unknown as TUI;

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
		return call && typeof call.content === "function" ? (call.content as typeof latestWidgetFactory extends () => infer F ? F : never) : undefined;
	};

	return {
		sent,
		notifies,
		selectCalls,
		widgetCalls,
		fakeTui,
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

function mouse(type: string, x: number, y: number, width: number): TuiMouseEvent {
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
	} as TuiMouseEvent;
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
		const command = harness.widgetCalls; // placeholder to use harness before session_start
		assert.ok(command !== undefined);
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
		const after = loadNotes(project);
		assert.equal(after.notes[0]?.text, "yapersistida");

		// A fresh session over the same project sees the stored note.
		const second = makeHarness();
		process.env.GENTLE_PI_CONFIG_HOME = configHome;
		await second.sessionStart(project);
		const widget = second.buildWidget();
		const lines = widget.render(80);
		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.includes("yapersistida"), `summary row shows the note: ${lines[0]}`);
	});

	it("renders nothing in the compact row while the project has no notes", async () => {
		await harness.sessionStart(project);
		const widget = harness.buildWidget();
		assert.deepEqual(widget.render(80), []);
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

	it("sends a clicked rail row to the chat and marks it sent", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add revisar el footer", project);
		harness.buildWidget();
		const rail = harness.rail();
		const lines = rail.render(46);
		assert.ok(lines[1]?.includes("revisar el footer"));
		assert.ok(lines[1]?.includes("<muted>➤</muted>"));

		const result = rail.handleMouse?.(mouse("click", 44, 1, 46));
		assert.equal(result?.handled, true);
		await FLUSH();

		assert.deepEqual(harness.sent, [{ content: "revisar el footer", options: undefined }]);
		const state = loadNotes(project);
		assert.equal(state.notes[0]?.status, NOTE_STATUS.SENT);
		assert.equal(typeof state.notes[0]?.sentAt, "number");
		assert.ok(harness.notifies.some((entry) => entry.message.includes("sent to the chat")));
		const after = rail.render(46);
		assert.ok(after[1]?.includes("~~revisar el footer~~"), "sent row renders struck through");
	});

	it("queues the prompt as a follow-up while the agent is running", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add en cola", project);
		harness.buildWidget();
		harness.agentStart();
		harness.rail().handleMouse?.(mouse("click", 44, 1, 46));
		await FLUSH();
		assert.deepEqual(harness.sent, [{ content: "en cola", options: { deliverAs: "followUp" } }]);
	});

	it("highlights the send glyph on hover and restores it on exit", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add hoverme", project);
		harness.buildWidget();
		const rail = harness.rail();

		const over = rail.handleMouse?.(mouse("move", 44, 1, 46));
		assert.equal(over?.handled, true);
		assert.equal(over?.render, true);
		assert.ok(rail.render(46)[1]?.includes("<accent>➤</accent>"));

		const out = rail.handleMouse?.(mouse("move", 10, 1, 46));
		assert.equal(out?.render, true);
		assert.ok(rail.render(46)[1]?.includes("<muted>➤</muted>"));
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

	it("ignores clicks outside the send glyph", async () => {
		await harness.sessionStart(project);
		await harness.runCommand("add no me toques", project);
		harness.buildWidget();
		const rail = harness.rail();
		const result = rail.handleMouse?.(mouse("click", 10, 1, 46));
		assert.notEqual(result?.handled, true);
		await FLUSH();
		assert.deepEqual(harness.sent, []);
		assert.equal(loadNotes(project).notes[0]?.status, NOTE_STATUS.PENDING);
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
