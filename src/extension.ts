// Gentle Notes: persistent per-project notepad for Pi/gentle-shell. Capture
// tasks you want the AI to do later, then send any of them to the chat as a
// prompt when you are ready. Paints a "notes" rail section in gentle-shell's
// fullscreen sidebar (with a clickable send glyph per pending row) and a
// compact summary row above the editor in regular mode. All interactions have
// a keyboard path: the /notes command and the alt+n manager dialog.
import type { Component, EditorTheme, KeyId, TUI, Theme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Editor, ScrollView, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTE_STATUS, addNote, clearNotes, emptyNotes, markSent, notesSummary, updateNoteText, type NotesState } from "./notes-state.ts";
import { loadNotes, mutateNotes } from "./storage.ts";
import { buildCompactNotesRow, buildNotesCard, collapsedNoteRow, controlSpan, railControlText, sendGlyphColumn, type NotesCardHit, type NotesCardTheme } from "./notes-card.ts";
import { CARD_GLYPH, CARD_TONE, paintPanelRows, panelBodyLine, panelBodyWidth, panelContentColumn, panelFloatApplies, panelHeaderRow, panelInnerWidth, renderCardPanel, type CardChromeTheme } from "./card-chrome.ts";
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
	"Usage: /notes [add <text> | send [<id>] | list | clear | collapse | expand | fold | unfold]",
	"alt+n opens the notes manager; click ➤ on a rail row to send it to the chat.",
].join("\n");

export interface NotesArgs {
	action: "manage" | "add" | "send" | "list" | "clear" | "help" | "collapse" | "expand" | "fold" | "unfold";
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
		case "collapse":
			return { action: "collapse", rest: payload };
		case "expand":
			return { action: "expand", rest: payload };
		case "fold":
			return { action: "fold", rest: payload };
		case "unfold":
			return { action: "unfold", rest: payload };
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

	// The rail card's view: the block collapses to its header plus one row and
	// the notes fold to their first line. Session scoped, like the Todos card.
	const railView = { collapsed: false, folded: false, collapseHovered: false, foldHovered: false };

	/** Collapse or expand the rail block; a hidden field never keeps the keyboard. */
	const setRailCollapsed = (next: boolean): void => {
		railView.collapsed = next;
		if (next) widgetTui?.setFocus(null);
		refresh();
	};

	const setRailFolded = (next: boolean): void => {
		railView.folded = next;
		refresh();
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

	/** The rail notepad: gentle-shell's card chrome (Status/Todos look, byte-
	 * pinned by golden fixtures), always visible with its own wrapping editor.
	 * Clicking the field takes the TUI keyboard focus — imperative setFocus,
	 * because the rail's declarative focus path would focus its ScrollView —
	 * and the click position reaches the editor so the caret lands where the
	 * pointer is. Typing flows through handleInput into pi-tui's Editor: the
	 * text wraps to following lines like a paragraph while writing, with the
	 * editor's own frame and scroll indicator; Enter saves the note and keeps
	 * the field ready, and Escape hands the keyboard back to the chat editor.
	 * Clicking a pending note's text edits it inline in a second editor; the
	 * send glyph per row is hit-tested off the rendered line. Digest covers
	 * snapshot, hover, scroll, focus, both fields' text and a keystroke tick
	 * so cursor moves always re-render. */
	const makeRailCard = (theme: Theme): Component & { digest?(): string; focused: boolean; handleInput?(data: string): void } => {
		const cardTheme = theme as unknown as CardChromeTheme & NotesCardTheme;
		const editorTheme = { borderColor: (text: string) => cardTheme.fg("border", text), selectList: {} } as unknown as EditorTheme;
		let hoveredId: number | undefined;
		let editingId: number | undefined;
		const input = new Editor(widgetTui as TUI, editorTheme);
		const editInput = new Editor(widgetTui as TUI, editorTheme);
		input.onSubmit = (text) => {
			if (text.trim().length > 0) void saveNote(text);
			input.setText("");
		};
		editInput.onSubmit = (text) => {
			void commitEdit(text);
		};
		// Widgets are measured as leaves, so the note body needs its own
		// viewport, exactly like the Todos panel: the header, the editor and
		// the closing rule stay outside the scroll.
		const scroll = new ScrollView({ render: () => bodyCache, invalidate() {} }, { follow: "none", overscroll: "contain" });
		let bodyCache: string[] = [];
		let inputTick = 0;
		// First visible row of the field's own window (see the render path).
		let fieldScrollTop = 0;
		let lastRender: { output: string[]; headRows: number; headerRow: number; collapseSpan: { start: number; end: number } | undefined; foldSpan: { start: number; end: number } | undefined; fieldTop: number; editorRows: number; notesStart: number; contentColumn: number; editStart: number | undefined; editRows: number; visibleRows: number; scrollTop: number; hits: NotesCardHit[] } | undefined;

		const commitEdit = async (text: string): Promise<void> => {
			const id = editingId;
			editingId = undefined;
			widgetTui?.setFocus(null);
			if (id === undefined || text.trim().length === 0) {
				refresh();
				return;
			}
			await apply((state) => updateNoteText(state, id, text), `Note #${id} updated`);
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
				// field is active owns the cursor marker — and a collapsed block
				// shows no field at all.
				input.focused = self.focused && editingId === undefined && !railView.collapsed;
				editInput.focused = self.focused && editingId !== undefined && !railView.collapsed;
				const view = buildNotesCard(current, cardTheme, inner, hoveredId, editingId, { folded: railView.folded });
				const subtitle = `${view.summary.pending} pend · ${view.summary.sent} sent`;
				// Both control labels show while the header holds them and the
				// subtitle unclipped; below that the chevrons stand alone.
				const wide = railControlText({ collapsed: railView.collapsed, folded: railView.folded, labelFits: true });
				const measured = 2 + visibleWidth(`${CARD_GLYPH} Notes ${wide.collapse} ${wide.fold}`) + 2 + visibleWidth(subtitle);
				// The header has its own room, not the body's: the float panel
				// draws it with the accent lead and the margin the body rows
				// spend on their side rails, and the outlined frame spends five
				// columns on its rules before the title starts.
				const headerRoom = panelFloatApplies(cardTheme, width, tone) ? panelBodyWidth(cardTheme, width, tone) : panelBodyWidth(cardTheme, width, tone) - 5;
				const controls = measured <= headerRoom ? wide : railControlText({ collapsed: railView.collapsed, folded: railView.folded, labelFits: false });
				const paint = (text: string, controlHovered: boolean): string => cardTheme.fg(controlHovered ? "warning" : "accent", text);
				const title = `Notes ${paint(controls.collapse, railView.collapseHovered)} ${paint(controls.fold, railView.foldHovered)}`;
				// Collapsed the block is its header and one row: the first pending
				// note (or the first sent one). The field leaves with the list.
				const body = railView.collapsed ? collapsedNoteRow(current, cardTheme, inner) : view.bodyRows;
				// The panel frames only the note rows; both editors draw their
				// own frames, so their rows splice in raw around the scroll.
				const lines = renderCardPanel(
					{ title, subtitle, body, tone, glyph: CARD_GLYPH },
					cardTheme,
					width,
					{ expanded: true, hint: RAIL_HINT },
				);
				const headRows = headerRow === 1 ? 3 : 1;
				// Rows composed outside renderCardPanel render at the inner
				// body width: paintPanelRows' float margins must land on the
				// requested width exactly, or the rail turns itself off.
				const bodyWidth = panelBodyWidth(cardTheme, width, tone);
				bodyCache = lines.slice(headRows, lines.length - 1);
				let editBlock: string[] | undefined;
				if (!railView.collapsed && editingId !== undefined && view.editSlot !== undefined) {
					editBlock = paintPanelRows(editInput.render(inner).slice(1, -1).map((row) => panelBodyLine(row, tone, cardTheme, width)), cardTheme, width, tone);
					bodyCache.splice(view.editSlot, 0, ...editBlock);
				}
				// The card is the field's frame: the editor's own border rows
				// drop out and its content rows dress in the panel background,
				// so the wrapping field reads as part of the block.
				// Bounded like the Todos panel: at most one third of the screen,
				// with the header, the editor and the rule outside the scroll.
				const terminalRows = (widgetTui?.terminal as unknown as { rows?: number } | undefined)?.rows ?? 48;
				const height = Math.min(RAIL_BODY_CAP, Math.floor(terminalRows / 3));
				// The editor windows itself at 30% of the terminal — more rows
				// than this card can hold — so the field takes its own window
				// inside the budget and follows the cursor marker. Letting the
				// card grow past its budget is what puts the line being typed
				// below the visible edge, where no scroller follows it.
				const rendered = railView.collapsed ? [] : input.render(inner).slice(1, -1);
				const fieldRoom = Math.max(1, height - headRows - 3);
				const cursorRow = rendered.findIndex((row) => row.includes(CURSOR_MARKER));
				if (cursorRow >= 0) {
					if (cursorRow < fieldScrollTop) fieldScrollTop = cursorRow;
					else if (cursorRow >= fieldScrollTop + fieldRoom) fieldScrollTop = cursorRow - fieldRoom + 1;
				}
				fieldScrollTop = Math.max(0, Math.min(fieldScrollTop, Math.max(0, rendered.length - fieldRoom)));
				const fieldContent = rendered.slice(fieldScrollTop, fieldScrollTop + fieldRoom).map((row) => panelBodyLine(row, tone, cardTheme, width));
				if (input.getText().trim().length === 0 && !input.focused && fieldContent.length >= 1) {
					// An empty, unfocused field paints its affordance instead of a blank.
					fieldContent[0] = panelBodyLine(cardTheme.fg("muted", "＋ Write a note…"), tone, cardTheme, width);
				}
				const fieldRows = paintPanelRows(fieldContent, cardTheme, width, tone);
				const overflow = headRows + fieldRows.length + bodyCache.length + 1 > height;
				const room = Math.max(1, height - headRows - fieldRows.length - 1 - Number(overflow));
				scroll.updateLayout(bodyCache.length, room, () => widgetTui?.requestRender());
				const visible = scroll.render(width).slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
				const notesStart = headRows + fieldRows.length;
				const output = [...lines.slice(0, headRows), ...fieldRows, ...visible, ...lines.slice(lines.length - 1)];
				if (overflow) output.push(...paintPanelRows([cardTheme.fg("muted", truncateToWidth(`↑↓ ${scroll.scrollTop + 1}–${scroll.scrollTop + visible.length}/${bodyCache.length}`, bodyWidth))], cardTheme, width, tone));
				// The header row carries the two view controls: the click map
				// reads their columns off the rendered line, so the targets stay
				// right in every card style.
				const headerLine = lines[headerRow] ?? "";
				const collapseSpan = controlSpan(headerLine, controls.collapse);
				const foldSpan = controlSpan(headerLine, controls.fold, collapseSpan ? collapseSpan.end + 1 : 0);
				lastRender = {
					output,
					headRows,
					headerRow,
					collapseSpan,
					foldSpan,
					fieldTop: fieldScrollTop,
					editorRows: fieldRows.length,
					contentColumn: panelContentColumn(cardTheme, width, tone),
					notesStart,
					editStart: editBlock !== undefined && view.editSlot !== undefined && view.editSlot >= scroll.scrollTop
						? notesStart + (view.editSlot - scroll.scrollTop)
						: undefined,
					editRows: editBlock?.length ?? 0,
					visibleRows: visible.length,
					scrollTop: scroll.scrollTop,
					hits: railView.collapsed ? [] : view.hits,
				};
				return output;
			},
			handleInput(data: string): void {
				if (!self.focused) return;
				// Bare Escape hands the keyboard back to the chat editor and
				// cancels any inline edit; every other key flows into the field.
				if (data === "\x1b") {
					editingId = undefined;
					widgetTui?.setFocus(null);
					refresh();
					return;
				}
				// The tick re-renders even on non-mutating keys (arrows), so the
				// cursor marker always rides the last keystroke.
				inputTick++;
				if (editingId !== undefined) editInput.handleInput(data);
				else input.handleInput(data);
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
				const last = lastRender;
				const inside = (span: { start: number; end: number } | undefined, x: number): boolean => span !== undefined && x >= span.start && x <= span.end;
				if (event.type === "move" || event.type === "drag") {
					// The header row carries the two view controls: pointing at
					// one paints the shared hover role, and the rest of the card
					// keeps its own send-glyph hover.
					if (last && event.y === last.headerRow) {
						const onCollapse = inside(last.collapseSpan, event.x);
						const onFold = inside(last.foldSpan, event.x);
						if (onCollapse !== railView.collapseHovered || onFold !== railView.foldHovered) {
							railView.collapseHovered = onCollapse;
							railView.foldHovered = onFold;
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					if (railView.collapseHovered || railView.foldHovered) {
						railView.collapseHovered = false;
						railView.foldHovered = false;
						return { handled: true, render: true };
					}
					const found = rowHitAt(event.y);
					const next = found && found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE ? found.id : undefined;
					if (next === hoveredId) return { handled: true, render: false };
					hoveredId = next;
					return { handled: true, render: true };
				}
				if (event.type === "click") {
					if (!last) return {};
					// The header controls toggle the block and the notes' text
					// mode; the rest of the header is the card's own chrome.
					if (event.y === last.headerRow) {
						if (inside(last.collapseSpan, event.x)) {
							setRailCollapsed(!railView.collapsed);
							return { handled: true, render: true };
						}
						if (inside(last.foldSpan, event.x)) {
							setRailFolded(!railView.folded);
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					// The editor block owns the keyboard: clicking it takes
					// focus and positions the caret where the pointer is.
					if (event.y >= last.headRows && event.y < last.notesStart) {
						editingId = undefined;
						widgetTui?.setFocus(self);
						// Coordinates shift into the editor's own frame: the top
						// border row the card strips, the window's first visible
						// row, and the panel's side rail.
						input.handleMouse({ ...event, y: event.y - last.headRows + last.fieldTop + 1, x: Math.max(0, event.x - last.contentColumn) });
						return { handled: true, render: true };
					}
					if (last.editStart !== undefined && event.y >= last.editStart && event.y < last.editStart + last.editRows) {
						widgetTui?.setFocus(self);
						editInput.handleMouse({ ...event, y: event.y - last.editStart + 1, x: Math.max(0, event.x - last.contentColumn) });
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
					editInput.setText(found.text);
					editInput.handleInput("\x1b[F");
					widgetTui?.setFocus(self);
					return { handled: true, render: true };
				}
				if (event.type === "wheel") {
					// Own the wheel only while the body overflows; otherwise the
					// surrounding rail keeps scrolling its own viewport.
					if (last && last.visibleRows < bodyCache.length) {
						scroll.scrollBy(event.wheelDelta ?? 0);
						return { handled: true, render: true };
					}
				}
				return {};
			},
			digest(): string {
				return JSON.stringify([current, hoveredId, scroll.scrollTop, fieldScrollTop, railView, self.focused, editingId, inputTick, input.getText(), editInput.getText()]);
			},
			invalidate(): void {
				input.invalidate();
				editInput.invalidate();
			},
			dispose(): void {},
		};
		return self;
	};
	/** Compact widget for regular mode: one card-styled line — glyph, title,
	 * expand/collapse control inline, summary — with the panel background like
	 * the Todos header; expanded it grows into the bounded note list. Paints
	 * nothing while empty. */
	const makeCompactRow = (theme: Theme): Component & { digest?(): string } => {
		const cardTheme = theme as unknown as NotesCardTheme;
		let collapsed = true;
		let controlHovered = false;
		let hoveredId: number | undefined;
		let last: { rows: string[]; headerRow: number; control?: { start: number; end: number }; hits: NotesCardHit[] } | undefined;
		/** The pending note at a rendered row, with its send glyph column. */
		const rowHitAt = (y: number): { id: number; column: number | undefined } | undefined => {
			const view = last;
			if (!view) return undefined;
			const hit = view.hits.find((candidate) => candidate.row === y);
			if (!hit) return undefined;
			const line = view.rows[y];
			return line !== undefined ? { id: hit.id, column: sendGlyphColumn(line) } : undefined;
		};
		return {
			render(width: number): string[] {
				if (current.notes.length === 0) {
					last = undefined;
					return [];
				}
				last = buildCompactNotesRow(current, cardTheme, width, { collapsed, controlHovered, hoveredId });
				return last.rows;
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
				const view = last;
				if (!view) return {};
				const onControl = view.control !== undefined && event.y === view.headerRow && event.x >= view.control.start && event.x <= view.control.end;
				if (event.type === "move" || event.type === "drag") {
					const found = onControl ? undefined : rowHitAt(event.y);
					const nextGlyph = found && found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE ? found.id : undefined;
					if (onControl === controlHovered && nextGlyph === hoveredId) return { handled: true, render: false };
					controlHovered = onControl;
					hoveredId = nextGlyph;
					return { handled: true, render: true };
				}
				if (event.type === "click") {
					if (onControl) {
						collapsed = !collapsed;
						hoveredId = undefined;
						return { handled: true, render: true };
					}
					const found = rowHitAt(event.y);
					if (found && found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE) {
						void sendNote(found.id);
						return { handled: true, render: true };
					}
					return { handled: true, render: false };
				}
				return {};
			},
			digest(): string {
				return JSON.stringify([current, collapsed, controlHovered, hoveredId]);
			},
			invalidate(): void {},
		};
		return widget;
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
				case "collapse":
					setRailCollapsed(true);
					return;
				case "expand":
					setRailCollapsed(false);
					return;
				case "fold":
					setRailFolded(true);
					return;
				case "unfold":
					setRailFolded(false);
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
