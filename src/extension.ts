// Gentle Notes: persistent per-project notepad for Pi/gentle-shell. Capture
// tasks you want the AI to do later, then send any of them to the chat as a
// prompt when you are ready. Paints a "notes" rail section in gentle-shell's
// fullscreen sidebar (with a clickable send glyph per pending row) and a
// compact summary row above the editor in regular mode. All interactions have
// a keyboard path: the /notes command and the alt+n manager dialog.
import type { Component, KeyId, TUI, Theme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ScrollView, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTE_STATUS, addNote, clearNotes, emptyNotes, markSent, notesSummary, type NotesState } from "./notes-state.ts";
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

	/** The interactive rail panel: gentle-shell's card chrome (Status/Todos
	 * look, byte-pinned by golden fixtures) with a bounded body viewport and
	 * a clickable send glyph per pending row, hit-tested off the rendered line
	 * so the target is exact in every card style. Digest covers the snapshot,
	 * hover and scroll so the rail memo re-renders on visible change. */
	const makeRailCard = (theme: Theme): Component & { digest?(): string } => {
		const cardTheme = theme as unknown as CardChromeTheme & NotesCardTheme;
		let hoveredId: number | undefined;
		// Widgets are measured as leaves, so the body needs its own viewport,
		// exactly like the Todos panel: header and closing rule stay outside.
		const scroll = new ScrollView({ render: () => bodyCache, invalidate() {} }, { follow: "none", overscroll: "contain" });
		let bodyCache: string[] = [];
		let lastRender: { output: string[]; bodyStart: number; visibleRows: number; scrollTop: number; hits: NotesCardHit[] } | undefined;

		/** The pending note under the send glyph at (x, y), if any. */
		const pendingHitAt = (x: number, y: number): number | undefined => {
			const last = lastRender;
			if (!last) return undefined;
			if (y < last.bodyStart || y >= last.bodyStart + last.visibleRows) return undefined;
			const hit = last.hits.find((candidate) => candidate.row === y - last.bodyStart + last.scrollTop);
			if (!hit) return undefined;
			const line = last.output[y];
			const column = line !== undefined ? sendGlyphColumn(line) : undefined;
			if (column === undefined) return undefined;
			return Math.abs(x - column) <= SEND_HIT_TOLERANCE ? hit.id : undefined;
		};

		return {
			render(width: number): string[] {
				const tone = CARD_TONE.INFO;
				const headerRow = panelHeaderRow(cardTheme, width, tone);
				const inner = panelInnerWidth(cardTheme, width, tone);
				const view = buildNotesCard(current, cardTheme, inner, hoveredId);
				const lines = renderCardPanel(
					{ title: "Notes", subtitle: `${view.summary.pending} pend · ${view.summary.sent} sent`, body: view.bodyRows, tone, glyph: CARD_GLYPH },
					cardTheme,
					width,
					{ expanded: true, hint: RAIL_HINT },
				);
				// The body starts after the header (plus the float padding rows)
				// and ends before the closing rule.
				const bodyStart = headerRow === 1 ? 3 : 1;
				const bodyEnd = lines.length - 1;
				bodyCache = lines.slice(bodyStart, bodyEnd);
				// Bounded like the Todos panel: at most one third of the screen.
				const terminalRows = (widgetTui?.terminal as unknown as { rows?: number } | undefined)?.rows ?? 48;
				const height = Math.min(RAIL_BODY_CAP, Math.floor(terminalRows / 3));
				const overflow = bodyCache.length + bodyStart + 1 > height;
				const room = Math.max(1, height - bodyStart - 1 - Number(overflow));
				scroll.updateLayout(bodyCache.length, room, () => widgetTui?.requestRender());
				const visible = scroll.render(width).slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
				const output = [...lines.slice(0, bodyStart), ...visible, ...lines.slice(bodyEnd)];
				if (overflow) output.push(cardTheme.fg("muted", truncateToWidth(`↑↓ ${scroll.scrollTop + 1}–${scroll.scrollTop + visible.length}/${bodyCache.length}`, width)));
				lastRender = { output, bodyStart, visibleRows: visible.length, scrollTop: scroll.scrollTop, hits: view.hits };
				return output;
			},
			digest(): string {
				return JSON.stringify([current, hoveredId, scroll.scrollTop]);
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
				if (event.type === "move" || event.type === "drag") {
					const next = pendingHitAt(event.x, event.y);
					if (next === hoveredId) return { handled: true, render: false };
					hoveredId = next;
					return { handled: true, render: true };
				}
				if (event.type === "click") {
					const hit = pendingHitAt(event.x, event.y);
					if (hit !== undefined) {
						void sendNote(hit);
						return { handled: true, render: true };
					}
					return {};
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
