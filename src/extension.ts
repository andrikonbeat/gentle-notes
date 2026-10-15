// Gentle Notes: persistent per-project notepad for Pi/gentle-shell. Capture
// tasks you want the AI to do later, then send any of them to the chat as a
// prompt when you are ready. Paints a "notes" rail section in gentle-shell's
// fullscreen sidebar (with a clickable send glyph per pending row) and a
// compact summary row above the editor in regular mode. All interactions have
// a keyboard path: the /notes command and the alt+n manager dialog.
import type { Component, KeyId, TUI, Theme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Input, ScrollView, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTE_STATUS, addNote, clearNotes, emptyNotes, markSent, notesSummary, updateNoteText, type NotesState } from "./notes-state.ts";
import { loadNotes, mutateNotes } from "./storage.ts";
import { buildNotesCard, notesSummaryRow, sendGlyphColumn, type NotesCardHit, type NotesCardTheme } from "./notes-card.ts";
import { CARD_GLYPH, CARD_TONE, panelHeaderRow, panelInnerWidth, renderCardPanel, type CardChromeTheme } from "./card-chrome.ts";
import { invalidateSidebar, sidebarPart } from "./sidebar-interop.ts";

const WIDGET_KEY = "gentle-notes";
const COMMAND_NAME = "notes";
const SHORTCUT = "alt+n" as KeyId;
const MANAGER_ADD = "＋ Add a note…";
const MANAGER_CLEAR = "✕ Clear all notes";
const MANAGER_CLOSE = "Close";
/** How many leading rows the manager dialog lists. */
const MANAGER_LIMIT = 20;
/** Columns of tolerance around the send glyph for a click or hover hit. */
const SEND_HIT_TOLERANCE = 1;
/** Rail card hint shown in the header rule: the keyboard path. */
const RAIL_HINT = "alt+n";
/** Bounded body viewport cap, mirroring the Todos panel budget. */
const RAIL_BODY_CAP = 16;

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

	/** The rail notepad: gentle-shell's card chrome (Status/Todos look,
	 * byte-pinned by golden fixtures), always visible with its own input row.
	 * Clicking the field takes the TUI keyboard focus — imperative setFocus,
	 * because the rail's declarative focus path would focus its ScrollView —
	 * typing flows through handleInput into pi-tui's Input, Enter saves the
	 * note and keeps the field ready for the next one, Escape returns the
	 * keyboard to the chat editor, clicking a pending note's text edits it
	 * inline, and the send glyph per row is hit-tested off the rendered line.
	 * Digest covers snapshot, hover, scroll, focus and both field values. */
	const makeRailCard = (theme: Theme): Component & { digest?(): string; focused: boolean; handleInput?(data: string): void } => {
		const cardTheme = theme as unknown as CardChromeTheme & NotesCardTheme;
		let hoveredId: number | undefined;
		let editingId: number | undefined;
		const input = new Input({
			prompt: "＋ ",
			placeholder: "Write a note…",
			placeholderStyle: (text: string) => cardTheme.fg("muted", text),
		});
		const editInput = new Input({
			prompt: "✎ ",
			placeholder: "Edit the note…",
			placeholderStyle: (text: string) => cardTheme.fg("muted", text),
		});
		input.onSubmit = (value) => {
			if (value.trim().length > 0) void saveNote(value);
			input.setValue("");
		};
		input.onEscape = () => {
			widgetTui?.setFocus(null);
			refresh();
		};
		editInput.onSubmit = (value) => {
			void commitEdit(value);
		};
		editInput.onEscape = () => {
			editingId = undefined;
			widgetTui?.setFocus(null);
			refresh();
		};
		// Widgets are measured as leaves, so the note body needs its own
		// viewport, exactly like the Todos panel: the header, the input row
		// and the closing rule stay outside the scroll.
		const scroll = new ScrollView({ render: () => bodyCache, invalidate() {} }, { follow: "none", overscroll: "contain" });
		let bodyCache: string[] = [];
		let inputTick = 0;
		let lastRender: { output: string[]; headRows: number; notesStart: number; visibleRows: number; scrollTop: number; hits: NotesCardHit[] } | undefined;

		const commitEdit = async (value: string): Promise<void> => {
			const id = editingId;
			editingId = undefined;
			widgetTui?.setFocus(null);
			if (id === undefined || value.trim().length === 0) {
				refresh();
				return;
			}
			await apply((state) => updateNoteText(state, id, value), `Note #${id} updated`);
		};

		/** The pending note shown at row y, with its rendered line and the
		 * visible column of its send glyph, if the row carries one. */
		const rowHitAt = (y: number): { id: number; text: string; column: number | undefined } | undefined => {
			const last = lastRender;
			if (!last) return undefined;
			if (y < last.notesStart || y >= last.notesStart + last.visibleRows) return undefined;
			const hit = last.hits.find((candidate) => candidate.row === y - last.notesStart + last.scrollTop);
			if (!hit) return undefined;
			const note = current.notes.find((candidate) => candidate.id === hit.id && candidate.status === NOTE_STATUS.PENDING);
			if (!note) return undefined;
			const line = last.output[y];
			const column = line !== undefined ? sendGlyphColumn(line) : undefined;
			return { id: note.id, text: note.text, column };
		};

		const self: Component & { digest?(): string; focused: boolean; handleInput?(data: string): void } = {
			focused: false,
			render(width: number): string[] {
				const tone = CARD_TONE.INFO;
				const headerRow = panelHeaderRow(cardTheme, width, tone);
				const inner = panelInnerWidth(cardTheme, width, tone);
				// Focusable propagation: the TUI focuses this card; whichever
				// field is active owns the cursor marker.
				input.focused = self.focused && editingId === undefined;
				editInput.focused = self.focused && editingId !== undefined;
				const view = buildNotesCard(current, cardTheme, inner, hoveredId, editingId);
				const noteRows = [...view.bodyRows];
				if (editingId !== undefined && view.editSlot !== undefined) noteRows.splice(view.editSlot, 0, editInput.render(inner)[0] ?? "");
				const lines = renderCardPanel(
					{ title: "Notes", subtitle: `${view.summary.pending} pend · ${view.summary.sent} sent`, body: [input.render(inner)[0] ?? "", ...noteRows], tone, glyph: CARD_GLYPH },
					cardTheme,
					width,
					{ expanded: true, hint: RAIL_HINT },
				);
				const headRows = headerRow === 1 ? 3 : 1;
				const notesStart = headRows + 1;
				const inputRow = lines[headRows] ?? "";
				bodyCache = lines.slice(notesStart, lines.length - 1);
				// Bounded like the Todos panel: at most one third of the screen,
				// with the header, the input row and the rule outside the scroll.
				const terminalRows = (widgetTui?.terminal as unknown as { rows?: number } | undefined)?.rows ?? 48;
				const height = Math.min(RAIL_BODY_CAP, Math.floor(terminalRows / 3));
				const overflow = headRows + 1 + bodyCache.length + 1 > height;
				const room = Math.max(1, height - headRows - 1 - 1 - Number(overflow));
				scroll.updateLayout(bodyCache.length, room, () => widgetTui?.requestRender());
				const visible = scroll.render(width).slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
				const output = [...lines.slice(0, headRows), inputRow, ...visible, ...lines.slice(lines.length - 1)];
				if (overflow) output.push(cardTheme.fg("muted", truncateToWidth(`↑↓ ${scroll.scrollTop + 1}–${scroll.scrollTop + visible.length}/${bodyCache.length}`, width)));
				lastRender = { output, headRows, notesStart, visibleRows: visible.length, scrollTop: scroll.scrollTop, hits: view.hits };
				return output;
			},
			handleInput(data: string): void {
				if (!self.focused) return;
				// The tick re-renders even on non-mutating keys (arrows), so the
				// cursor marker always rides the last keystroke.
				inputTick++;
				if (editingId !== undefined) editInput.handleInput(data);
				else input.handleInput(data);
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
				if (event.type === "move" || event.type === "drag") {
					const found = rowHitAt(event.y);
					const next = found && found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE ? found.id : undefined;
					if (next === hoveredId) return { handled: true, render: false };
					hoveredId = next;
					return { handled: true, render: true };
				}
				if (event.type === "click") {
					const last = lastRender;
					// The input row owns the keyboard: clicking it takes focus.
					if (last && event.y === last.headRows) {
						editingId = undefined;
						widgetTui?.setFocus(self);
						return { handled: true, render: true };
					}
					const found = rowHitAt(event.y);
					if (!found) return {};
					if (found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE) {
						void sendNote(found.id);
						return { handled: true, render: true };
					}
					// A click on the text of a pending note edits it inline; the
					// cursor rides to the end of the existing text for natural typing.
					editingId = found.id;
					editInput.setValue(found.text);
					editInput.handleInput("\x1b[F");
					widgetTui?.setFocus(self);
					return { handled: true, render: true };
				}
				if (event.type === "wheel") {
					// Own the wheel only while the body overflows; otherwise the
					// surrounding rail keeps scrolling its own viewport.
					const last = lastRender;
					if (last && last.visibleRows < bodyCache.length) {
						scroll.scrollBy(event.wheelDelta ?? 0);
						return { handled: true, render: true };
					}
				}
				return {};
			},
			digest(): string {
				return JSON.stringify([current, hoveredId, scroll.scrollTop, self.focused, editingId, inputTick, input.getValue(), editInput.getValue()]);
			},
			invalidate(): void {},
			dispose(): void {},
		};
		return self;
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
