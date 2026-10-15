// Gentle Notes: persistent per-project notepad for Pi/gentle-shell. Capture
// tasks you want the AI to do later, then send any of them to the chat as a
// prompt when you are ready. Paints a "notes" rail section in gentle-shell's
// fullscreen sidebar (with a clickable send glyph per pending row) and a
// compact summary row above the editor in regular mode. All interactions have
// a keyboard path: the /notes command and the alt+n manager dialog.
import type { Component, KeyId, TUI, Theme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTE_STATUS, addNote, clearNotes, emptyNotes, markSent, notesSummary, type NotesState } from "./notes-state.ts";
import { loadNotes, mutateNotes } from "./storage.ts";
import { buildNotesCard, notesSummaryRow, type NotesCardTheme } from "./notes-card.ts";
import { invalidateSidebar, sidebarPart } from "./sidebar-interop.ts";

const WIDGET_KEY = "gentle-notes";
const COMMAND_NAME = "notes";
const SHORTCUT = "alt+n" as KeyId;
const MANAGER_ADD = "＋ Add a note…";
const MANAGER_CLEAR = "✕ Clear all notes";
const MANAGER_CLOSE = "Close";
/** How many pending notes the manager dialog lists. */
const MANAGER_LIMIT = 20;
/** Columns from the right edge of a pending row that count as a send hit. */
const SEND_HIT_COLUMNS = 4;

const HELP = [
	"Usage: /notes [add <text> | send [<id>] | list | clear]",
	"alt+n opens the notes manager; click ➤ on a rail row to send it to the chat.",
].join("\n");

export interface NotesArgs {
	action: "manage" | "add" | "send" | "list" | "clear" | "help";
	rest: string;
	id?: number;
}

/** Pure argument parser for the /notes command. */
export function parseNotesArgs(args: string): NotesArgs {
	const trimmed = args.trim();
	if (!trimmed) return { action: "manage", rest: "" };
	const [head, ...rest] = trimmed.split(/\s+/);
	const payload = rest.join(" ");
	switch (head?.toLowerCase()) {
		case "add":
			return { action: "add", rest: payload };
		case "send": {
			const first = rest[0];
			const id = first !== undefined && /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
			return { action: "send", rest: payload, id };
		}
		case "list":
			return { action: "list", rest: payload };
		case "clear":
			return { action: "clear", rest: payload };
		case "help":
			return { action: "help", rest: payload };
		default:
			return { action: "help", rest: trimmed };
	}
}

export default function gentleNotes(pi: ExtensionAPI): void {
	let busy = false;
	let projectCwd: string | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let current: NotesState = emptyNotes();
	let widgetTui: TUI | undefined;

	pi.on("agent_start", () => {
		busy = true;
	});
	pi.on("agent_end", () => {
		busy = false;
	});

	const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
		if (sessionCtx?.hasUI) sessionCtx.ui.notify(message, type);
	};

	const refresh = (): void => {
		if (!widgetTui) return;
		invalidateSidebar(widgetTui);
		widgetTui.requestRender();
	};

	/** Read-modify-write through the storage queue, refreshing the UI after. */
	const apply = async (
		mutator: (state: NotesState) => { state: NotesState } | string,
		successMessage?: string,
	): Promise<boolean> => {
		if (!projectCwd) return false;
		try {
			current = await mutateNotes(projectCwd, mutator);
			if (successMessage) notify(successMessage);
			refresh();
			return true;
		} catch (error) {
			notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	};

	/** Send a pending note to the chat, then mark it sent. While the agent is
	 * running the message is queued as a follow-up instead of interrupting. */
	const sendNote = async (id: number): Promise<void> => {
		const note = current.notes.find((candidate) => candidate.id === id);
		if (!note || note.status !== NOTE_STATUS.PENDING) return;
		try {
			await pi.sendUserMessage(note.text, busy ? { deliverAs: "followUp" } : undefined);
		} catch (error) {
			notify(`Failed to send note #${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const suffix = busy ? " (queued while the agent runs)" : "";
		await apply((state) => markSent(state, id, Date.now()), `Note #${id} sent to the chat${suffix}`);
	};

	const saveNote = async (text: string): Promise<void> => {
		await apply((state) => addNote(state, text, Date.now()), "Note saved");
	};

	const clearAll = async (): Promise<void> => {
		await apply(clearNotes, "Notes cleared");
	};

	/** The interactive rail card: hover highlights the send glyph, a click on
	 * it sends the note. Digest covers the snapshot plus hover so the rail memo
	 * re-renders exactly when something visible changed. */
	const makeRailCard = (theme: Theme): Component & { digest?(): string } => {
		const cardTheme = theme as unknown as NotesCardTheme;
		let hoveredId: number | undefined;
		return {
			render(width: number): string[] {
				return buildNotesCard(current, cardTheme, width, hoveredId).lines;
			},
			digest(): string {
				return JSON.stringify([current, hoveredId]);
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
				const { x, y, width } = event;
				const sendFrom = Math.max(0, width - SEND_HIT_COLUMNS);
				if (event.type === "move" || event.type === "drag") {
					const hit = buildNotesCard(current, cardTheme, width, hoveredId).hits.find((candidate) => candidate.row === y);
					const next = hit && x >= sendFrom ? hit.id : undefined;
					if (next === hoveredId) return { handled: true, render: false };
					hoveredId = next;
					return { handled: true, render: true };
				}
				if (event.type === "click") {
					const hit = buildNotesCard(current, cardTheme, width, hoveredId).hits.find((candidate) => candidate.row === y);
					if (hit && x >= sendFrom) {
						void sendNote(hit.id);
						return { handled: true, render: true };
					}
				}
				return {};
			},
			invalidate(): void {},
			dispose(): void {},
		};
	};

	/** Compact one-row widget for regular mode; paints nothing while empty. */
	const makeCompactRow = (theme: Theme): Component => {
		const cardTheme = theme as unknown as NotesCardTheme;
		return {
			render(width: number): string[] {
				if (current.notes.length === 0) return [];
				return [notesSummaryRow(current, cardTheme, width)];
			},
			invalidate(): void {},
		};
	};

	const widgetFactory = (tui: TUI, theme: Theme): Component & { dispose?(): void } => {
		widgetTui = tui;
		return sidebarPart(tui, "notes", makeCompactRow(theme), makeRailCard(theme));
	};

	pi.on("session_start", (_event, ctx) => {
		projectCwd = ctx.cwd;
		sessionCtx = ctx;
		current = loadNotes(ctx.cwd);
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, widgetFactory, { placement: "aboveEditor" });
	});

	pi.on("session_shutdown", () => {
		if (sessionCtx?.hasUI) sessionCtx.ui.setWidget(WIDGET_KEY, undefined);
		widgetTui = undefined;
	});

	const listNotes = (): void => {
		if (current.notes.length === 0) {
			notify("No notes yet — alt+n adds one");
			return;
		}
		const summary = notesSummary(current);
		const rows = current.notes.map((note) =>
			note.status === NOTE_STATUS.SENT ? `  ✓ #${note.id} ${note.text}` : `  ✉ #${note.id} ${note.text}`,
		);
		notify([`Notes · ${summary.pending} pending · ${summary.sent} sent`, ...rows].join("\n"));
	};

	/** Keyboard path for everything the rail does with the mouse. */
	const openManager = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			notify("The notes manager needs an interactive session", "warning");
			return;
		}
		const summary = notesSummary(current);
		const pending = current.notes.filter((note) => note.status === NOTE_STATUS.PENDING).slice(0, MANAGER_LIMIT);
		const options = [
			MANAGER_ADD,
			...pending.map((note) => `➤ #${note.id} ${note.text}`),
			MANAGER_CLEAR,
			MANAGER_CLOSE,
		];
		const choice = await ctx.ui.select(`Notes · ${summary.pending} pending · ${summary.sent} sent`, options);
		if (choice === undefined || choice === MANAGER_CLOSE) return;
		if (choice === MANAGER_ADD) {
			const text = await ctx.ui.input("New note", "Write the task you want the AI to do later…");
			if (text && text.trim()) await saveNote(text);
			return;
		}
		if (choice === MANAGER_CLEAR) {
			if (await ctx.ui.confirm("Clear all notes", "Remove every note, pending and sent?")) await clearAll();
			return;
		}
		const match = /^➤ #(\d+)/.exec(choice);
		if (match) await sendNote(Number.parseInt(match[1] as string, 10));
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Gentle Notes: capture tasks now and send them to the chat later",
		handler: async (args, ctx) => {
			sessionCtx = ctx;
			const parsed = parseNotesArgs(args);
			switch (parsed.action) {
				case "manage":
					await openManager(ctx);
					return;
				case "add":
					if (parsed.rest) {
						await saveNote(parsed.rest);
						return;
					}
					if (ctx.hasUI) {
						const text = await ctx.ui.input("New note", "Write the task you want the AI to do later…");
						if (text && text.trim()) await saveNote(text);
					}
					return;
				case "send":
					if (parsed.id !== undefined) await sendNote(parsed.id);
					else await openManager(ctx);
					return;
				case "list":
					listNotes();
					return;
				case "clear":
					if (!ctx.hasUI || (await ctx.ui.confirm("Clear all notes", "Remove every note, pending and sent?"))) await clearAll();
					return;
				case "help":
					notify(HELP);
					return;
			}
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the Gentle Notes manager",
		handler: async (ctx) => {
			sessionCtx = ctx;
			await openManager(ctx);
		},
	});
}
