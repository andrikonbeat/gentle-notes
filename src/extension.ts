// Gentle Notes: persistent per-project notepad for Pi/gentle-shell. Capture
// tasks you want the AI to do later, then send any of them to the chat as a
// prompt when you are ready. Paints a "notes" rail section in gentle-shell's
// fullscreen sidebar (with a clickable send glyph per pending row) and a
// compact summary row above the editor in regular mode. All interactions have
// a keyboard path: the /notes command and the alt+n manager dialog.
import type { Component, EditorTheme, KeyId, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Editor, ScrollView, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, HostComponent, Theme } from "./host-contract.ts";
import { NOTE_STATUS, addNote, clearByStatus, clearNotes, deleteNote, emptyNotes, isNotesState, markSent, notesSummary, restoreNote, setUIState, stripWrappingQuotes, updateNoteText, type NotesState, type NoteStatus, type NotesUIState } from "./notes-state.ts";
import { loadNotes, mutateNotes, reloadNotes, watchNotes } from "./storage.ts";
import { buildCompactNotesRow, buildNotesCard, collapsedNoteRow, COMPACT_ROW_CAP, controlSpan, deleteGlyphColumn, NOTES_ROW_CAP, railControlText, restoreGlyphColumn, sendGlyphColumn, trailingGlyphColumn, type NotesCardHit, type NotesCardTheme } from "./notes-card.ts";
import { CARD_GLYPH, CARD_TONE, paintPanelRows, panelBodyLine, panelBodyWidth, panelContentColumn, panelFloatApplies, panelHeaderRow, panelInnerWidth, renderCardPanel, type CardChromeTheme } from "./card-chrome.ts";
import { invalidateSidebar, sidebarPart, sidebarState } from "./sidebar-interop.ts";
import { DEFAULT_SETTINGS, SEND_DESTINATION, readSettings, writeSettings, type NotesSettings, type SendDestination } from "./settings.ts";


const WIDGET_KEY = "gentle-notes";
const COMMAND_NAME = "notes";
/** Shorthand: `/note <text>` captures straight from the chat input. */
const NOTE_ALIAS = "note";
const SHORTCUT = "alt+n" as KeyId;
/** Every manager line starts with one glyph and enough air to land its label
 * in the same column: `＋` is fullwidth and spends two columns, the rest spend
 * one (L45). Without it a two-column glyph shifted its own label one cell left
 * of the others, which read as a second icon size. */
const managerLine = (glyph: string, label: string): string =>
	`${glyph}${" ".repeat(Math.max(1, 3 - visibleWidth(glyph)))}${label}`;
const MANAGER_ADD = managerLine("＋", "Add a note…");
const MANAGER_CLEAR = managerLine("×", "Clear all notes");
/** The settings entry names the current target, so the menu state is readable
 * without opening the picker underneath it. `✎` replaced the gear `⚙` (U+2699),
 * an emoji-capable code point many terminals paint double width, coloured and
 * heavier than the × beside it (L45). */
const managerSettingsEntry = (destination: SendDestination): string =>
	managerLine("✎", `Send target: ${destination === SEND_DESTINATION.EDITOR ? "chat input" : "chat"}`);
// MANAGER_CLEAR_SENT removed per user request (L49)
const MANAGER_CLEAR_PENDING = managerLine("×", "Clear all pending notes");
const MANAGER_CLOSE = "Close";
/** How many leading rows the manager dialog lists. */
const MANAGER_LIMIT = 20;
/** Columns of tolerance around the send glyph for a click or hover hit. */
const SEND_HIT_TOLERANCE = 2;
/** Rail card hint shown in the header rule: the keyboard path. */
const RAIL_HINT = "alt+n";

/** An SGR mouse report: \x1b[<button;column;rowM (press) or ...m (release). */
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+M/g;

/** True when raw terminal input carries a button press — not a release, a
 * wheel turn or a drag. Only those can move the keyboard elsewhere. */
function hasButtonPress(data: string): boolean {
	for (const match of data.matchAll(SGR_MOUSE)) {
		const button = Number.parseInt(match[1] ?? "", 10);
		if (Number.isNaN(button)) continue;
		// 64 is the wheel bit, 32 the motion bit: neither changes focus.
		if ((button & 96) !== 0) continue;
		return true;
	}
	return false;
}

/** Releases the rail card's keyboard. pi-tui never blurs a focused component
 * on its own — focus only moves when a component explicitly asks for it, and
 * no component asks for it on a plain press — so a click anywhere else leaves
 * the note field swallowing every keystroke and the chat stops answering. The
 * card publishes this so the click-away wrapper can call it. */
let blurRailCard: (() => void) | undefined;

/** Presses the rail card itself has seen, used to tell "the click was mine"
 * from "the click was elsewhere" without owning the pointer geometry. */
let cardPressTick = 0;

/** The keyboard owner the card displaced, kept per TUI. pi-tui drops every
 * keystroke while nothing is focused — the chat is deaf, not merely unfocused —
 * so handing the keyboard back means restoring that component, not clearing
 * focus. */
let focusBeforeCard: { tui: TUI; component: Component } | undefined;

/** pi-tui keeps the focused component private in the TUI interface even though
 * the runtime exposes it (the host reads it the same way when it swaps
 * renderers). A missing accessor degrades to "nothing to hand back". */
function focusedComponentOf(tui: TUI | undefined): Component | null | undefined {
	const lookup = (tui as unknown as { getFocusedComponent?(): Component | null } | undefined)?.getFocusedComponent;
	return typeof lookup === "function" ? lookup.call(tui) : undefined;
}

/** The terminal keeps one input callback and the fullscreen viewport consumes
 * mouse presses inside its own input listener, before any extension listener
 * runs: a click-away has to observe the terminal's callback to see them. */
type TerminalInput = { inputHandler?: (data: string) => void };

let clickAwayTui: TUI | undefined;
let restoreTerminalInput: (() => void) | undefined;

/** Watch raw terminal input and release the rail's keyboard when a press never
 * reaches the card. The wrapped callback is synchronous end to end — pi-tui
 * dispatches the press inside `original(data)` — so the card's own tick is
 * already bumped by the time this returns. */
function installClickAway(tui: TUI): void {
	if (clickAwayTui === tui && restoreTerminalInput) return;
	restoreTerminalInput?.();
	clickAwayTui = undefined;
	const terminal = tui.terminal as unknown as TerminalInput | undefined;
	const original = terminal?.inputHandler;
	if (!terminal || typeof original !== "function") return;
	const wrapped = (data: string): void => {
		const seen = cardPressTick;
		original(data);
		if (hasButtonPress(data) && cardPressTick === seen) blurRailCard?.();
	};
	terminal.inputHandler = wrapped;
	clickAwayTui = tui;
	restoreTerminalInput = () => {
		if (terminal.inputHandler === wrapped) terminal.inputHandler = original;
		restoreTerminalInput = undefined;
	};
}

/** Body viewport ceiling: the card grows down to half the terminal (L24)
 * and never past this cap. */
const RAIL_BODY_CAP = 24;

const HELP = [
	"Usage: /notes [add <text> | send [<id>] | list | show | restore [<id>] | clear | clear sent | delete <id> | edit <id> | collapse | expand | collapse sent | expand sent | fold [<id>] | unfold [<id>] | settings [chat|editor] | help]",
	"Shorthand: /note <text> adds a note straight from the chat.",
	"alt+n opens the notes manager (settings only: send target, clear pending, clear all).",
	"Click ➤ on a rail row to send it; alt+pgup/pgdn scrolls the list; × deletes a pending note; ✓ marks a sent note; ↶ restores it; × deletes a sent note.",
	"The N sent control folds the section; Delete All beside it clears every sent note at once.",
	"Click a note's text to edit it inline; double click folds it back to its first line.",
	"Esc, or a click anywhere else, hands the keyboard back to the chat.",
	"Settings: /notes settings [chat|editor] decides whether ➤ sends now or loads the note into the chat input.",
	"Notes are capped at 2000 characters; anything the terminal could execute or reorder is stripped from the text before it is stored.",
].join("\n");

export interface NotesArgs {
	action: "manage" | "add" | "send" | "list" | "show" | "restore" | "clear" | "clearSent" | "help" | "collapse" | "expand" | "collapseSent" | "expandSent" | "fold" | "unfold" | "delete" | "edit" | "settings" | "note";
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
		case "note":
			return { action: "note", rest: payload };
		case "send": {
			const first = rest[0];
			const id = first !== undefined && /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
			return { action: "send", rest: payload, id };
		}
		case "list":
			return { action: "list", rest: payload };
		case "show":
			return { action: "show", rest: payload };
		case "clear":
			// "clear sent" -> action "clearSent", rest empty
			if (rest[0] === "sent") return { action: "clearSent", rest: "" };
			return { action: "clear", rest: payload };
		case "delete": {
			const first = rest[0];
			const id = first !== undefined && /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
			return { action: "delete", rest: payload, id };
		}
		case "restore": {
			const first = rest[0];
			const id = first !== undefined && /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
			return { action: "restore", rest: payload, id };
		}
		case "collapse": {
			if (rest[0] === "sent") return { action: "collapseSent", rest: "" };
			return { action: "collapse", rest: payload };
		}
		case "expand": {
			if (rest[0] === "sent") return { action: "expandSent", rest: "" };
			return { action: "expand", rest: payload };
		}
		case "fold": {
			const first = rest[0];
			const id = first !== undefined && /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
			return { action: "fold", rest: payload, id };
		}
		case "unfold": {
			const first = rest[0];
			const id = first !== undefined && /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
			return { action: "unfold", rest: payload, id };
		}
		case "settings":
			return { action: "settings", rest: payload };
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
	/** Plugin-wide preferences, read once per session from the settings file. */
	let settings: NotesSettings = DEFAULT_SETTINGS;
	let current: NotesState = emptyNotes();
	let widgetTui: TUI | undefined;
	/** Cleanup for the file watcher that keeps sibling sessions in sync. */
	let unwatchNotes: (() => void) | undefined;
	/** Pending edit request from command handler; rail card picks it up on render. */
	let requestEditId: number | undefined;

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

	// The rail card's view: the block collapses to its header plus one row, the
	// header's fold control sets the mode for the whole notepad, and a per-note
	// gesture records its exception (L21: a click unfolds the note, a double
	// click folds it). Session scoped, like the Todos card's collapsed flag.
	const railView = {
		collapsed: false,
		foldAll: false,
		foldOverrides: new Map<number, boolean>(),
		/** `undefined` means "decide from the list length": a long list starts
		 * collapsed, a short one starts expanded, exactly like before. */
		sentCollapsed: undefined as boolean | undefined,
		collapseHovered: false,
		foldHovered: false,
		sentCollapseHovered: false,
		/** Hovering the sent section's group delete (L45). */
		sentDeleteHovered: false,
		/** The rail card's ScrollView, set by makeRailCard after construction. */
		scroll: undefined as { scrollBy: (lines: number) => void; scrollTop: number } | undefined,
		/** The compact row's scrollTop state, set by makeCompactRow. */
		compactScrollTop: 0,
		/** The last known bodyTotal from the compact row render. */
		compactBodyTotal: 0,
	};

/** Scroll the notes list by ±3 rows (or given amount). Selects the rail
 * when the sidebar owns the host, otherwise the compact expanded list. */
const scrollNotes = (lines: number): void => {
	const state = widgetTui?.terminal ? sidebarState(widgetTui) : undefined;
	const ownsHost = state?.active && state.ownsHost?.();
	if (ownsHost && railView.scroll) {
		railView.scroll.scrollBy(lines);
		widgetTui?.requestRender();
	} else if (!ownsHost) {
		// Use the bodyTotal from the last compact render (stored in railView).
		const maxScroll = Math.max(0, (railView.compactBodyTotal ?? 0) - COMPACT_ROW_CAP);
		railView.compactScrollTop = Math.max(0, Math.min(railView.compactScrollTop + lines, maxScroll));
		widgetTui?.requestRender();
	}
};

	// The note whose delete glyph the pointer is on (D15): hover repaints
	// the accent role, the digest carries it, a click removes the note.
	let deleteHoveredId: number | undefined;

	// The sent note whose restore glyph the pointer is on: same grammar as the
	// delete glyph, and a click puts the note back in the pending list.
	let restoreHoveredId: number | undefined;

	/** The notes rendered as one line right now: the mode, plus its exceptions. */
	const foldedIdSet = (): Set<number> => new Set(current.notes.filter((note) => railView.foldOverrides.get(note.id) ?? railView.foldAll).map((note) => note.id));

	/** Apply the persisted view flags to the rail. Only the keys the stored
	 * state actually carries are touched, so a file written by an older version
	 * (or by a session that never opened the rail) never resets the layout. */
	const restoreRailView = (state: NotesState): void => {
		const ui = state.ui;
		if (!ui) return;
		if (ui.railCollapsed !== undefined) railView.collapsed = ui.railCollapsed;
		if (ui.foldAll !== undefined) railView.foldAll = ui.foldAll;
		if (ui.foldOverrides) {
			railView.foldOverrides = new Map(Object.entries(ui.foldOverrides).map(([id, folded]) => [Number(id), folded]));
		}
		if (ui.sentCollapsed !== undefined) railView.sentCollapsed = ui.sentCollapsed;
	};

	/** Record one note's exception to the fold mode; the mode itself wins when
	 * the two agree, so the map holds only real deviations. */
	const foldNote = (id: number, folded: boolean): void => {
		if (folded === railView.foldAll) railView.foldOverrides.delete(id);
		else railView.foldOverrides.set(id, folded);
		// Persist fold overrides
		const overrides: Record<string, boolean> = {};
		railView.foldOverrides.forEach((v, k) => { overrides[String(k)] = v; });
		void apply((state) => setUIState(state, { foldOverrides: overrides }));
	};

	/** Collapse or expand the rail block; a hidden field never keeps the keyboard. */
	const setRailCollapsed = (next: boolean): void => {
		railView.collapsed = next;
		if (next) widgetTui?.setFocus(focusBeforeCard?.tui === widgetTui ? focusBeforeCard.component : null);
		void apply((state) => setUIState(state, { railCollapsed: next }));
		refresh();
	};

	/** Fold or unfold every note; new notes follow the mode until a gesture
	 * makes one of them an exception. */
	const setRailFolded = (next: boolean): void => {
		railView.foldAll = next;
		railView.foldOverrides.clear();
		void apply((state) => setUIState(state, { foldAll: next, foldOverrides: {} }));
		refresh();
	};

	/** Collapse or expand the sent notes section. */
	const setRailSentCollapsed = (next: boolean): void => {
		railView.sentCollapsed = next;
		void apply((state) => setUIState(state, { sentCollapsed: next }));
		refresh();
	};

	/** Run a UI side effect whose failure must not reach the caller. Once the
	 * store has taken a change, a notify or a repaint the host cannot draw (a
	 * disposed widget, a closed transcript) must not report that change as
	 * refused: a caller that offers the draft again on `false` would then save
	 * the same note twice. The store stays the source of truth; the screen
	 * catches up on the next paint. */
	const quietly = (effect: () => void): void => {
		try {
			effect();
		} catch {
			// Nothing to do: the write already landed.
		}
	};

	/** Fold a single note to its first line. */
	const foldOne = async (id: number): Promise<void> => {
		const note = current.notes.find((n) => n.id === id);
		if (!note) return;
		railView.foldOverrides.set(id, true);
		refresh();
	};

	/** Unfold a single note to full text. */
	const unfoldOne = async (id: number): Promise<void> => {
		railView.foldOverrides.delete(id);
		refresh();
	};

	/** Start inline edit on a pending note (called from /notes edit <id>). */
	const startEdit = async (id: number): Promise<void> => {
		const note = current.notes.find((n) => n.id === id && n.status === NOTE_STATUS.PENDING);
		if (!note) return;
		requestEditId = id;
		refresh();
	};

	/** Read-modify-write through the storage queue, refreshing the UI after.
	 * Returns whether the *store* took the change, never whether the
	 * notification or the repaint worked. */
	const apply = async (
		mutator: (state: NotesState) => { state: NotesState } | string,
		successMessage?: string,
	): Promise<boolean> => {
		if (!projectCwd) return false;
		try {
			current = await mutateNotes(projectCwd, mutator);
		} catch (error) {
			quietly(() => notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error"));
			return false;
		}
		if (successMessage) quietly(() => notify(successMessage));
		quietly(() => refresh());
		return true;
	};

	/** Send a pending note where the settings point it: straight to the agent,
	 * or into the chat's editor so the user can still edit it before pressing
	 * Enter. Either way the note leaves the pending list — a note parked in the
	 * field is already in the user's hands, and leaving it pending would invite
	 * sending it twice. While the agent runs, a chat message is queued as a
	 * follow-up instead of interrupting. */
	const sendNote = async (id: number): Promise<void> => {
		const note = current.notes.find((candidate) => candidate.id === id);
		if (!note || note.status !== NOTE_STATUS.PENDING) return;
		// `pasteToEditor` is the non-destructive choice: it inserts at the caret
		// and keeps whatever the user had already typed, unlike setEditorText.
		// A build without it (or a headless session) falls back to the chat.
		// Capture the function once: `pasteToEditor` is optional in the host
		// contract, and the guard below has to be the same value we call.
		const pasteToEditor = settings.sendDestination === SEND_DESTINATION.EDITOR && sessionCtx?.hasUI === true ? sessionCtx.ui.pasteToEditor : undefined;
		if (pasteToEditor) {
			try {
				pasteToEditor.call(sessionCtx?.ui, note.text);
			} catch (error) {
				notify(`Failed to load note #${id} into the chat: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			await apply((state) => markSent(state, id, Date.now()), `Note #${id} loaded into the chat input`);
			return;
		}
		try {
			await pi.sendUserMessage(note.text, busy ? { deliverAs: "followUp" } : undefined);
		} catch (error) {
			notify(`Failed to send note #${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const suffix = busy ? " (queued while the agent runs)" : "";
		await apply((state) => markSent(state, id, Date.now()), `Note #${id} sent to the chat${suffix}`);
	};

	/** Remove one note for good — the only hard delete. Ids never rewind, so
	 * a note added later never reuses a deleted id. */
	const deleteOne = async (id: number): Promise<void> => {
		await apply((state) => deleteNote(state, id), `Note #${id} deleted`);
	};

	const restoreOne = async (id: number): Promise<void> => {
		await apply((state) => restoreNote(state, id), `Note #${id} restored to pending`);
	};

	/** What the trailing affordance of a pending row does: a note the agent
	 * already saw goes back to the sent list, one it never saw is deleted. */
	const trailingAction = (id: number): "revert" | "delete" =>
		current.notes.find((candidate) => candidate.id === id)?.everSent === true ? "revert" : "delete";

	/** Undo a restore without another trip to the chat: the note returns to the
	 * sent list exactly as it was, since the agent never needs to read it twice. */
	const markBackToSent = async (id: number): Promise<void> => {
		const note = current.notes.find((candidate) => candidate.id === id);
		if (!note || note.status !== NOTE_STATUS.PENDING || note.everSent !== true) return;
		await apply((state) => markSent(state, id, Date.now()), `Note #${id} back in the sent list`);
	};

	const saveNote = async (text: string): Promise<boolean> => {
		return apply((state) => addNote(state, stripWrappingQuotes(text), Date.now()), "Note saved");
	};

	const clearAll = async (): Promise<void> => {
		await apply(clearNotes, "Notes cleared");
	};

	/** Empty one group only: the other group, the id counter and the view
	 * flags stay exactly as they were. */
	const clearStatus = async (status: NoteStatus, removed: number): Promise<void> => {
		const label = status === NOTE_STATUS.SENT ? "Sent" : "Pending";
		await apply((state) => clearByStatus(state, status), `${label} notes cleared (${removed})`);
	};

	/** The destination lines the picker offers, with the live one ticked. */
	const destinationOptions = (currentValue: SendDestination): string[] => [
		`${currentValue === SEND_DESTINATION.CHAT ? "✓" : " "} Send to the chat now`,
		`${currentValue === SEND_DESTINATION.EDITOR ? "✓" : " "} Load into the chat input to edit first`,
	];

	/** The current preference plus the exact syntax that changes it. */
	const settingsSummary = (): string =>
		`Send target: ${settings.sendDestination === SEND_DESTINATION.EDITOR ? "the chat input (edit before sending)" : "the chat (send immediately)"}\nChange it with: /notes settings [chat|editor]`;

	/** Persist the send destination in the plugin-wide settings file. The in
	 * memory copy updates only after the write succeeded, so a failed write
	 * cannot leave this session at odds with the next one. */
	const setSendDestination = (destination: SendDestination): void => {
		const next: NotesSettings = { ...settings, sendDestination: destination };
		try {
			writeSettings(next);
		} catch (error) {
			notify(`Failed to save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		settings = next;
		notify(
			destination === SEND_DESTINATION.EDITOR
				? "Sent notes now load into the chat input for editing"
				: "Sent notes now go straight to the chat",
		);
	};

	/** Settings path for both the command and the manager: an explicit value
	 * from the command line, or the picker when there is a UI. */
	const openSettings = async (ctx: ExtensionContext, rest: string): Promise<void> => {
		const wanted = rest.trim().toLowerCase();
		if (wanted) {
			const destination = wanted === "editor" || wanted === "input" || wanted === "chat-input"
				? SEND_DESTINATION.EDITOR
				: wanted === "chat" || wanted === "direct"
					? SEND_DESTINATION.CHAT
					: undefined;
			if (!destination) {
				notify(`Unknown send destination "${rest.trim()}". Use: chat | editor`, "error");
				return;
			}
			setSendDestination(destination);
			return;
		}
		if (!ctx.hasUI) {
			notify(settingsSummary());
			return;
		}
		const choice = await ctx.ui.select("Send notes to", destinationOptions(settings.sendDestination));
		if (choice === undefined) return;
		setSendDestination(choice.includes("chat input") ? SEND_DESTINATION.EDITOR : SEND_DESTINATION.CHAT);
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
	const makeRailCard = (theme: Theme): HostComponent => {
		const cardTheme = theme as unknown as CardChromeTheme & NotesCardTheme;
		const editorTheme = { borderColor: (text: string) => cardTheme.fg("border", text), selectList: {} } as unknown as EditorTheme;
		let hoveredId: number | undefined;
		let editingId: number | undefined;
		const input = new Editor(widgetTui as TUI, editorTheme);
		const editInput = new Editor(widgetTui as TUI, editorTheme);
		input.onSubmit = (text): void => {
			if (text.trim().length === 0) return;
			// pi-tui's Editor empties itself inside submitValue, before it calls
			// onSubmit, so the draft is already gone by the time the store
			// answers. A refused save (a note over MAX_NOTE_LENGTH, an unwritable
			// store) puts the text back instead of leaving the error notify on
			// top of a blank field; a save that lands keeps the field clear for
			// the next note, and never touches text typed while it was in flight.
			const submitted = text;
			void saveNote(submitted).then((saved) => {
				if (saved || input.getText().length > 0) return;
				input.setText(submitted);
				refresh();
			});
		};
		editInput.onSubmit = (text): void => {
			void commitEdit(text);
		};
		// Widgets are measured as leaves, so the note body needs its own
		// viewport, exactly like the Todos panel: the header, the editor and
		// the closing rule stay outside the scroll.
		const scroll = new ScrollView({ render: () => bodyCache, invalidate() {} }, { follow: "none", overscroll: "contain" });
		railView.scroll = { scrollBy: (lines: number) => scroll.scrollBy(lines), get scrollTop() { return scroll.scrollTop; } };
		let bodyCache: string[] = [];
		let inputTick = 0;
		// First visible row of the field's own window (see the render path).
		let fieldScrollTop = 0;
		let lastRender: {
			output: string[];
			headRows: number;
			headerRow: number;
			collapseSpan: { start: number; end: number } | undefined;
			foldSpan: { start: number; end: number } | undefined;
			deleteSpan: { start: number; end: number } | undefined;
			/** The restore glyph column shared by every sent row, and the
			 * "✓ N sent ▾ Collapse" control with the row it paints on. */
			restoreSpan: { start: number; end: number } | undefined;
			sentCollapseSpan: { start: number; end: number; row: number } | undefined;
			/** The group delete beside it: one click removes every sent note. */
			sentDeleteSpan: { start: number; end: number; row: number } | undefined;
			fieldTop: number;
			editorRows: number;
			notesStart: number;
			contentColumn: number;
			editStart: number | undefined;
			editRows: number;
			visibleRows: number;
			scrollTop: number;
			hits: NotesCardHit[];
			sentHits: NotesCardHit[];
		} | undefined;

		/** Take the TUI keyboard, remembering who held it. */
		const takeFocus = (): void => {
			if (!widgetTui) return;
			const held = focusedComponentOf(widgetTui);
			if (held && held !== self) focusBeforeCard = { tui: widgetTui, component: held };
			widgetTui.setFocus(self);
		};

		/** Hand the keyboard back to whoever had it before the card took it. */
		const releaseFocus = (): void => {
			if (!widgetTui) return;
			const previous = focusBeforeCard?.tui === widgetTui ? focusBeforeCard.component : undefined;
			widgetTui.setFocus(previous ?? null);
		};

		const commitEdit = async (text: string): Promise<void> => {
			const id = editingId;
			editingId = undefined;
			releaseFocus();
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

		/** The sent note whose row starts at physical row y, if any. */
		const sentHitAt = (y: number): { id: number } | undefined => {
			const last = lastRender;
			if (!last) return undefined;
			if (y < last.notesStart || y >= last.notesStart + last.visibleRows) return undefined;
			return last.sentHits.find((candidate) => candidate.row === y - last.notesStart + last.scrollTop);
		};

		const self: HostComponent = {
			focused: false,
			/** Hand the keyboard back to the chat, keeping a draft: an open
			 * inline edit commits exactly as Enter would, so clicking away never
			 * throws away what the user just typed. Hover marks go with it —
			 * the pointer left, and no move event will clear them. */
			blur(): void {
				const hadHover = hoveredId !== undefined || deleteHoveredId !== undefined ||
					restoreHoveredId !== undefined || railView.collapseHovered || railView.foldHovered ||
					railView.sentCollapseHovered || railView.sentDeleteHovered;
				hoveredId = undefined;
				deleteHoveredId = undefined;
				restoreHoveredId = undefined;
				railView.collapseHovered = false;
				railView.foldHovered = false;
				railView.sentCollapseHovered = false;
				railView.sentDeleteHovered = false;
				if (!self.focused && editingId === undefined) {
					if (hadHover) refresh();
					return;
				}
				if (editingId !== undefined) {
					const id = editingId;
					const text = editInput.getText();
					const original = current.notes.find((note) => note.id === id)?.text;
					if (text.trim().length > 0 && text !== original) {
						void commitEdit(text);
						return;
					}
					editingId = undefined;
				}
				releaseFocus();
				refresh();
			},
			render(width: number): string[] {
				const tone = CARD_TONE.INFO;
				const headerRow = panelHeaderRow(cardTheme, width, tone);
				const inner = panelInnerWidth(cardTheme, width, tone);
				// Focusable propagation: the TUI focuses this card; whichever
				// field is active owns the cursor marker — and a collapsed block
				// shows no field at all.
				input.focused = self.focused === true && editingId === undefined && !railView.collapsed;
				editInput.focused = self.focused === true && editingId !== undefined && !railView.collapsed;
				// Handle pending edit request from /notes edit <id>
				if (requestEditId !== undefined) {
					const note = current.notes.find((n) => n.id === requestEditId && n.status === NOTE_STATUS.PENDING);
					if (note) {
						editingId = requestEditId;
						editInput.setText(note.text);
						// Take focus if the card is focused
						if (widgetTui && self.focused) {
							widgetTui.setFocus(self);
						}
					}
					requestEditId = undefined;
				}
				const view = buildNotesCard(current, cardTheme, inner, hoveredId, editingId, { foldedIds: foldedIdSet(), hoveredDeleteId: deleteHoveredId, hoveredRestoreId: restoreHoveredId, sentCollapsed: railView.sentCollapsed, sentCollapseHovered: railView.sentCollapseHovered, sentDeleteHovered: railView.sentDeleteHovered });
				// Total and pending only (L45): the sent count is the sent section's
				// own header one row below, so repeating it up here would spend the
				// narrowest line of the card on a number already on screen. The
				// comma is one column of budget: with the padded dot form the header
				// no longer fit both control labels at the rail's usual width.
				const subtitle = `${view.summary.total} total, ${view.summary.pending} pend`;
				// Both control labels show while the header holds them and the
				// subtitle unclipped; below that the chevrons stand alone.
				const wide = railControlText({ collapsed: railView.collapsed, folded: railView.foldAll, labelFits: true });
				const measured = 2 + visibleWidth(`${CARD_GLYPH} Notes ${wide.collapse} ${wide.fold}`) + 2 + visibleWidth(subtitle);
				// The header has its own room, not the body's: the float panel
				// draws it with the accent lead and the margin the body rows
				// spend on their side rails, and the outlined frame spends five
				// columns on its rules before the title starts.
				const headerRoom = panelFloatApplies(cardTheme, width, tone) ? panelBodyWidth(cardTheme, width, tone) : panelBodyWidth(cardTheme, width, tone) - 5;
				const controls = measured <= headerRoom ? wide : railControlText({ collapsed: railView.collapsed, folded: railView.foldAll, labelFits: false });
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
				// Bounded to half the screen (L24): the block grows down to read
				// the notes, with the header, the editor and the rule outside the
				// scroll; the smallest terminals keep the bounded behavior.
				const terminalRows = (widgetTui?.terminal as unknown as { rows?: number } | undefined)?.rows ?? 48;
				const height = Math.min(RAIL_BODY_CAP, Math.floor(terminalRows / 2));
				
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
				// Compute overflow based on the actual body rows that will be rendered
				// (view.bodyRows + field placeholder), not the stale bodyCache.
				const totalBodyRows = 1 + view.bodyRows.length; // field placeholder + notes
				// Use >= so content that exactly fills the available space still shows the hint
				// (the ScrollView will have overscroll when bodyCache.length > viewportHeight).
				const overflow = headRows + fieldRows.length + totalBodyRows + 1 >= height;
				const room = Math.max(1, height - headRows - fieldRows.length - 1 - Number(overflow));
				scroll.updateLayout(bodyCache.length, room, () => widgetTui?.requestRender());
				const visible = scroll.render(width).slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
				const notesStart = headRows + fieldRows.length;
				// Include scroll indicator as part of the panel body (before bottom rule)
				const visibleWithIndicator = [...visible];
				const output = [...lines.slice(0, headRows), ...fieldRows, ...visibleWithIndicator];
				if (overflow) {
					const hintText = `↑↓ ${scroll.scrollTop + 1}–${scroll.scrollTop + visible.length}/${bodyCache.length} · alt+pgup/pgdn`;
					const hintLine = theme.fg("muted", truncateToWidth(hintText, panelBodyWidth(theme, width)));
					const hintRows = paintPanelRows([hintLine], theme, width);
					output.push(...hintRows);
				}
				output.push(...lines.slice(lines.length - 1)); // bottom rule last
				// The header row carries the two view controls: the click map
				// reads their columns off the rendered line, so the targets stay
				// right in every card style.
				const headerLine = lines[headerRow] ?? "";
				const collapseSpan = controlSpan(headerLine, controls.collapse);
				const foldSpan = controlSpan(headerLine, controls.fold, collapseSpan ? collapseSpan.end + 1 : 0);
				// Every pending row pads its text to the same width, so the ×
				// sits at one column for all of them: one visible row tells the
				// click map where they all are, with the send glyph's tolerance.
				// The sent rows pad the same way, so their ↶ and × share those
				// columns too — the glyphs never collide, since a row is one or
				// the other and the row maps tell them apart.
				let deleteSpan: { start: number; end: number } | undefined;
				let restoreSpan: { start: number; end: number } | undefined;
				if (!railView.collapsed) {
					// Every pending row pads its text to the same width, so the × or
					// the ✓ of a note that came back sits at one column for all of
					// them: one row the hit map vouches for tells the click map where.
					const firstPending = view.hits.find((hit) => hit.row >= scroll.scrollTop && hit.row < scroll.scrollTop + visible.length);
					const pendingColumn = firstPending === undefined ? undefined : trailingGlyphColumn(visible[firstPending.row - scroll.scrollTop] ?? "");
					// A sent row closes with the same × at the same column (L45), so a
					// card with no pending row on screen still gets its delete target
					// from the first visible sent row.
					const firstSentRow = view.sentHits.find((hit) => hit.row >= scroll.scrollTop && hit.row < scroll.scrollTop + visible.length);
					const sentColumnEnd = firstSentRow === undefined ? undefined : deleteGlyphColumn(visible[firstSentRow.row - scroll.scrollTop] ?? "");
					const deleteColumn = pendingColumn ?? sentColumnEnd;
					if (deleteColumn !== undefined) deleteSpan = { start: deleteColumn - 1, end: deleteColumn + 1 };
					// The sent rows pad the same way, so their ↶ shares one column as
					// well. The row is taken from the sent hit map — a wrapped
					// continuation row carries no affordance, and the note's own text
					// may contain the glyph — and `restoreGlyphColumn` reads the last
					// match on it, so nothing inside the text can move the target.
					const firstSent = view.sentHits.find((hit) => hit.row >= scroll.scrollTop && hit.row < scroll.scrollTop + visible.length);
					const sentColumn = firstSent === undefined ? undefined : restoreGlyphColumn(visible[firstSent.row - scroll.scrollTop] ?? "");
					if (sentColumn !== undefined) restoreSpan = { start: sentColumn - 1, end: sentColumn + 1 };
				}
				// The sent section control lives in the body, not in the header:
				// its span comes from the painted row it landed on, which is only
				// clickable while the row is inside the scrolled window.
				let sentCollapseSpan: { start: number; end: number; row: number } | undefined;
				let sentDeleteSpan: { start: number; end: number; row: number } | undefined;
				if (!railView.collapsed && view.sentHeader !== undefined) {
					const offset = view.sentHeader.row - scroll.scrollTop;
					if (offset >= 0 && offset < visible.length) {
						const line = visible[offset] ?? "";
						const row = notesStart + offset;
						const span = controlSpan(line, view.sentHeader.control);
						if (span) sentCollapseSpan = { ...span, row };
						const remove = controlSpan(line, view.sentHeader.remove);
						if (remove) sentDeleteSpan = { ...remove, row };
					}
				}
				lastRender = {
					output,
					headRows,
					headerRow,
					collapseSpan,
					foldSpan,
					deleteSpan,
					restoreSpan,
					sentCollapseSpan,
					sentDeleteSpan,
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
					sentHits: railView.collapsed ? [] : view.sentHits,
				};
				return output;
			},
			handleInput(data: string): void {
				if (!self.focused) return;
				// Bare Escape hands the keyboard back to the chat editor and
				// cancels any inline edit; every other key flows into the field.
				if (data === "\x1b") {
					editingId = undefined;
					releaseFocus();
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
				// pi-tui's alt screen starts a text selection wherever a press goes
				// unhandled: the second press of a double click over a word selects
				// the word, copy-on-selects it, and the release stops being a click —
				// so the fold never fires and the clipboard walks away with the
				// word (L22). The card is an interactive surface, so it owns its
				// presses; the TUI still routes the release's click back here with
				// its consecutive-click count.
				if (event.type === "press") {
					// The press that lands on the card bumps the tick the click-away
					// listener watches, so an outside press never blurs this card.
					if (!last || event.y < 0 || event.y >= last.output.length) return {};
					cardPressTick++;
					// A press proves the TUI is live: retry the click-away install in
					// case the widget was mounted before the terminal had its callback.
					if (widgetTui) installClickAway(widgetTui);
					return { handled: true, render: false };
				}
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
					// The sent section's own controls live in the body: like the
					// header controls, they repaint under the pointer — the collapse
					// toggle and the group delete beside it (L45).
					const sectionRow = last?.sentCollapseSpan?.row;
					if (last && sectionRow !== undefined && event.y === sectionRow) {
						const onSentCollapse = inside(last.sentCollapseSpan, event.x);
						const onSentDelete = inside(last.sentDeleteSpan, event.x);
						if (onSentCollapse !== railView.sentCollapseHovered || onSentDelete !== railView.sentDeleteHovered) {
							railView.sentCollapseHovered = onSentCollapse;
							railView.sentDeleteHovered = onSentDelete;
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					if (railView.sentCollapseHovered || railView.sentDeleteHovered) {
						railView.sentCollapseHovered = false;
						railView.sentDeleteHovered = false;
						return { handled: true, render: true };
					}
					const found = rowHitAt(event.y);
					const sentFound = sentHitAt(event.y);
					const next = found && found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE ? found.id : undefined;
					// One × column serves both kinds of row, so the row map decides
					// which note the pointer is on (L45).
					const nextDelete = last?.deleteSpan !== undefined && inside(last.deleteSpan, event.x) ? (found?.id ?? sentFound?.id) : undefined;
					const nextRestore = sentFound && last?.restoreSpan !== undefined && inside(last.restoreSpan, event.x) ? sentFound.id : undefined;
					if (next === hoveredId && nextDelete === deleteHoveredId && nextRestore === restoreHoveredId) return { handled: true, render: false };
					hoveredId = next;
					deleteHoveredId = nextDelete;
					restoreHoveredId = nextRestore;
					return { handled: true, render: true };
				}
				if (event.type === "click") {
					if (!last) return {};
					// pi-tui counts consecutive clicks on the same cell: only the
					// first one toggles, so a double click never undoes what the
					// click just did.
					const firstClick = (event.clickCount ?? 1) <= 1;
					// The sent section control: one click folds the sent notes behind
					// their summary row, or brings them back. It resolves the
					// effective state the same way the renderer does, so an auto
					// collapsed long list opens on the first click.
					if (last.sentCollapseSpan !== undefined && event.y === last.sentCollapseSpan.row && inside(last.sentCollapseSpan, event.x)) {
						const autoCollapsed = current.notes.length > NOTES_ROW_CAP;
						setRailSentCollapsed(!(railView.sentCollapsed ?? autoCollapsed));
						return { handled: true, render: true };
					}
					// The group delete beside the sent count: one click empties the
					// sent list, and the pending notes stay (L45). It is tested before
					// the row affordances because it is a group action, not a row.
					if (last.sentDeleteSpan !== undefined && event.y === last.sentDeleteSpan.row && inside(last.sentDeleteSpan, event.x)) {
						const removed = notesSummary(current).sent;
						void clearStatus(NOTE_STATUS.SENT, removed);
						return { handled: true, render: true };
					}
					// A click on a sent row's ↶ puts that note back in the pending
					// list. It is tested before the delete glyph because both sit at
					// the right edge; the row map decides which note it belongs to.
					if (last.restoreSpan !== undefined && inside(last.restoreSpan, event.x)) {
						const sent = sentHitAt(event.y);
						if (sent) {
							void restoreOne(sent.id);
							return { handled: true, render: true };
						}
					}
					// The trailing affordance: a click on the × removes the note
					// outright — the sent row's own × included (L45) — and a click on
					// the ✓ of a note that already travelled puts it back in the sent
					// list, before any fold or edit can claim the row.
					if (last.deleteSpan !== undefined && inside(last.deleteSpan, event.x)) {
						const sent = sentHitAt(event.y);
						if (sent) {
							void deleteOne(sent.id);
							return { handled: true, render: true };
						}
						const found = rowHitAt(event.y);
						if (found) {
							if (trailingAction(found.id) === "revert") void markBackToSent(found.id);
							else void deleteOne(found.id);
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					// Double click on a pending note's text (when not editing)
					// toggles its individual folded state (F15).
					if (!firstClick && editingId === undefined && last.notesStart !== undefined && event.y >= last.notesStart && event.y < last.notesStart + last.visibleRows) {
						const noteHit = last.hits.find((h) => h.row === event.y - last.notesStart + last.scrollTop);
						if (noteHit) {
							// Toggle: if it's already folded, unfold it; if unfolded, fold it.
							const isFolded = railView.foldOverrides.get(noteHit.id) ?? railView.foldAll;
							foldNote(noteHit.id, !isFolded);
							refresh();
							return { handled: true, render: true };
						}
					}
					// The header controls toggle the block and the notes' text
					// mode; the rest of the header is the card's own chrome.
					if (event.y === last.headerRow) {
						if (firstClick && inside(last.collapseSpan, event.x)) {
							setRailCollapsed(!railView.collapsed);
							return { handled: true, render: true };
						}
						if (firstClick && inside(last.foldSpan, event.x)) {
							setRailFolded(!railView.foldAll);
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					// A double click on the note the first click unfolded into the
					// editor folds it back to its one line (L21). A draft typed in
					// between is committed rather than dropped; the keyboard leaves
					// with the editor, so no key lands in an invisible field.
					if (!firstClick && editingId !== undefined) {
						const id = editingId;
						const text = editInput.getText();
						foldNote(id, true);
						if (text.trim().length > 0 && text !== current.notes.find((note) => note.id === id)?.text) void commitEdit(text);
						else {
							editingId = undefined;
							releaseFocus();
							refresh();
						}
						return { handled: true, render: true };
					}
					// The editor block owns the keyboard: clicking it takes
					// focus and positions the caret where the pointer is.
					if (event.y >= last.headRows && event.y < last.notesStart) {
						editingId = undefined;
						takeFocus();
						// Coordinates shift into the editor's own frame: the top
						// border row the card strips, the window's first visible
						// row, and the panel's side rail.
						input.handleMouse({ ...event, y: event.y - last.headRows + last.fieldTop + 1, x: Math.max(0, event.x - last.contentColumn) });
						return { handled: true, render: true };
					}
					if (last.editStart !== undefined && event.y >= last.editStart && event.y < last.editStart + last.editRows) {
						takeFocus();
						editInput.handleMouse({ ...event, y: event.y - last.editStart + 1, x: Math.max(0, event.x - last.contentColumn) });
						return { handled: true, render: true };
					}
					const found = rowHitAt(event.y);
					if (!found) return {};
					if (found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE) {
						void sendNote(found.id);
						return { handled: true, render: true };
					}
					// A click on the text of a pending note unfolds it (a folded row
					// opens its full text, L21) and edits it inline; the cursor rides
					// to the end of the existing text for natural typing.
					foldNote(found.id, false);
					editingId = found.id;
					editInput.setText(found.text);
					editInput.handleInput("\x1b[F");
					takeFocus();
					return { handled: true, render: true };
				}
				if (event.type === "wheel") {
					// Always own the wheel while the pointer is over the notes rail card.
					// Scroll the notes body only when it overflows; otherwise consume
					// the event to prevent the surrounding sidebar from scrolling everything.
					if (last && last.visibleRows < bodyCache.length) {
						scroll.scrollBy(event.wheelDelta ?? 0);
						return { handled: true, render: true };
					}
					return { handled: true, render: false };
				}
				return {};
			},
			digest(): string {
				// A Map serializes as {}: the fold exceptions enter the digest as a
				// list, or a fold change would not re-render the card.
				const view = { ...railView, foldOverrides: [...railView.foldOverrides].sort((a, b) => a[0] - b[0]) };
				return JSON.stringify([current, hoveredId, deleteHoveredId, restoreHoveredId, scroll.scrollTop, fieldScrollTop, view, self.focused, editingId, inputTick, input.getText(), editInput.getText()]);
			},
			invalidate(): void {
				input.invalidate();
				editInput.invalidate();
			},
			dispose(): void {},
		};
		return self;
	};
	/** Compact widget for regular mode: one card-styled line — title, the
	 * expand/collapse control inline, counts and the last note's first words —
	 * with the panel background like the Todos header, and a blank row of air
	 * below so it reads apart from the chat input. No row above: pi already
	 * draws one spacer ahead of the above-editor widget group (L28). Expanded
	 * it grows into the bounded note list. Paints nothing while empty. */
	const makeCompactRow = (theme: Theme): Component & { digest?(): string } => {
		const cardTheme = theme as unknown as NotesCardTheme;
		let collapsed = true;
		let controlHovered = false;
		let hoveredId: number | undefined;
		// The note whose delete glyph the pointer is on (D15).
		let hoveredDeleteId: number | undefined;
		// The sent note whose restore glyph the pointer is on.
		let hoveredRestoreId: number | undefined;
		// First visible row of the expanded list's window (L26).
		let scrollTop = 0;
		// The sent section's own view state (L45): `undefined` keeps the list
		// length deciding, exactly like the rail.
		let sentCollapsed: boolean | undefined;
		let sentCollapseHovered = false;
		let sentDeleteHovered = false;
		let last: { rows: string[]; headerRow: number; control?: { start: number; end: number }; hits: NotesCardHit[]; sentHits: NotesCardHit[]; bodyTotal: number; sentHeader?: { row: number; control: string; remove: string } } | undefined;
		/** The pending note at a rendered row, with the columns of its send
		 * glyph and of its trailing affordance (delete or back-to-sent). */
		const rowHitAt = (y: number): { id: number; column: number | undefined; trailingColumn: number | undefined } | undefined => {
			const view = last;
			if (!view) return undefined;
			const hit = view.hits.find((candidate) => candidate.row === y);
			if (!hit) return undefined;
			const line = view.rows[y];
			return line !== undefined ? { id: hit.id, column: sendGlyphColumn(line), trailingColumn: trailingGlyphColumn(line) } : undefined;
		};
		/** The sent note at a rendered row, with the columns of its ↶ and ×. */
		const sentRowHitAt = (y: number): { id: number; column: number | undefined; trailingColumn: number | undefined } | undefined => {
			const view = last;
			if (!view) return undefined;
			const hit = view.sentHits.find((candidate) => candidate.row === y);
			if (!hit) return undefined;
			const line = view.rows[y];
			return line !== undefined ? { id: hit.id, column: restoreGlyphColumn(line), trailingColumn: deleteGlyphColumn(line) } : undefined;
		};
		/** The sent section's header with the spans of its two controls, while
		 * the window shows it (L45). */
		const sectionHeader = (): { row: number; collapse?: { start: number; end: number }; remove?: { start: number; end: number } } | undefined => {
			const view = last;
			if (!view?.sentHeader) return undefined;
			const line = view.rows[view.sentHeader.row] ?? "";
			const collapse = controlSpan(line, view.sentHeader.control);
			const remove = controlSpan(line, view.sentHeader.remove);
			return { row: view.sentHeader.row, ...(collapse ? { collapse } : {}), ...(remove ? { remove } : {}) };
		};
		return {
			render(width: number): string[] {
				if (current.notes.length === 0) {
					last = undefined;
					return [];
				}
				last = buildCompactNotesRow(current, cardTheme, width, { collapsed, controlHovered, hoveredId, hoveredDeleteId, hoveredRestoreId, scrollTop, sentCollapsed, sentCollapseHovered, sentDeleteHovered });
				// Keep the state where the render clamped it, so a shrunk backlog
				// cannot leave the window past its end.
				scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, last.bodyTotal - COMPACT_ROW_CAP)));
				railView.compactScrollTop = scrollTop;
			railView.compactBodyTotal = last.bodyTotal;
				return last.rows;
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
				const view = last;
				if (!view) return {};
				const onControl = view.control !== undefined && event.y === view.headerRow && event.x >= view.control.start && event.x <= view.control.end;
				if (event.type === "move" || event.type === "drag") {
					// The sent section's header carries the collapse toggle and the
					// group delete: both repaint under the pointer (L45).
					const section = sectionHeader();
					if (section !== undefined && event.y === section.row) {
						const onCollapse = section.collapse !== undefined && event.x >= section.collapse.start && event.x <= section.collapse.end;
						const onRemove = section.remove !== undefined && event.x >= section.remove.start && event.x <= section.remove.end;
						if (onCollapse === sentCollapseHovered && onRemove === sentDeleteHovered) return { handled: true, render: false };
						sentCollapseHovered = onCollapse;
						sentDeleteHovered = onRemove;
						return { handled: true, render: true };
					}
					if (sentCollapseHovered || sentDeleteHovered) {
						sentCollapseHovered = false;
						sentDeleteHovered = false;
						return { handled: true, render: true };
					}
					const found = onControl ? undefined : rowHitAt(event.y);
					const sentFound = onControl ? undefined : sentRowHitAt(event.y);
					const nextGlyph = found && found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE ? found.id : undefined;
					const nextDelete = found && found.trailingColumn !== undefined && Math.abs(event.x - found.trailingColumn) <= SEND_HIT_TOLERANCE
						? found.id
						: sentFound && sentFound.trailingColumn !== undefined && Math.abs(event.x - sentFound.trailingColumn) <= SEND_HIT_TOLERANCE ? sentFound.id : undefined;
					const nextRestore = sentFound && sentFound.column !== undefined && Math.abs(event.x - sentFound.column) <= SEND_HIT_TOLERANCE ? sentFound.id : undefined;
					if (onControl === controlHovered && nextGlyph === hoveredId && nextDelete === hoveredDeleteId && nextRestore === hoveredRestoreId) return { handled: true, render: false };
					controlHovered = onControl;
					hoveredId = nextGlyph;
					hoveredDeleteId = nextDelete;
					hoveredRestoreId = nextRestore;
					return { handled: true, render: true };
				}
				if (event.type === "click") {
					if (onControl) {
						collapsed = !collapsed;
						hoveredId = undefined;
						return { handled: true, render: true };
					}
					// The sent section's controls: the toggle folds its rows behind
					// the header, Delete All empties the sent list (L48). The
					// effective state resolves exactly as the renderer does, so an
					// auto-collapsed long list opens on the first click.
					const section = sectionHeader();
					if (section !== undefined && event.y === section.row) {
						if (section.collapse !== undefined && event.x >= section.collapse.start && event.x <= section.collapse.end) {
							const autoCollapsed = current.notes.length > NOTES_ROW_CAP;
							sentCollapsed = !(sentCollapsed ?? autoCollapsed);
							return { handled: true, render: true };
						}
						if (section.remove !== undefined && event.x >= section.remove.start && event.x <= section.remove.end) {
							void clearStatus(NOTE_STATUS.SENT, notesSummary(current).sent);
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					// A click on a sent row's ↶ sends it back to the pending list, and
					// the × beside it removes that one note (L45).
					const sentFound = sentRowHitAt(event.y);
					if (sentFound && sentFound.column !== undefined && Math.abs(event.x - sentFound.column) <= SEND_HIT_TOLERANCE) {
						void restoreOne(sentFound.id);
						return { handled: true, render: true };
					}
					if (sentFound && sentFound.trailingColumn !== undefined && Math.abs(event.x - sentFound.trailingColumn) <= SEND_HIT_TOLERANCE) {
						void deleteOne(sentFound.id);
						return { handled: true, render: true };
					}
					const found = rowHitAt(event.y);
					if (found && found.trailingColumn !== undefined && Math.abs(event.x - found.trailingColumn) <= SEND_HIT_TOLERANCE) {
						if (trailingAction(found.id) === "revert") void markBackToSent(found.id);
						else void deleteOne(found.id);
						return { handled: true, render: true };
					}
					if (found && found.column !== undefined && Math.abs(event.x - found.column) <= SEND_HIT_TOLERANCE) {
						void sendNote(found.id);
						return { handled: true, render: true };
					}
					return { handled: true, render: false };
				}
				if (event.type === "wheel") {
					// Always own the wheel while the pointer is over the notes widget.
					// Scroll the expanded list only when it overflows; otherwise consume
					// the event to prevent the surrounding layout from scrolling everything.
					if (!collapsed && view.bodyTotal > COMPACT_ROW_CAP) {
						scrollTop = Math.max(0, Math.min(scrollTop + (event.wheelDelta ?? 0), view.bodyTotal - COMPACT_ROW_CAP));
						return { handled: true, render: true };
					}
					return { handled: true, render: false };
				}
				return {};
			},
			digest(): string {
				return JSON.stringify([current, collapsed, controlHovered, hoveredId, hoveredDeleteId, hoveredRestoreId, scrollTop, sentCollapsed, sentCollapseHovered, sentDeleteHovered]);
			},
			invalidate(): void {},
		};
	};

	const widgetFactory = (tui: TUI, theme: Theme): HostComponent => {
		widgetTui = tui;
		installClickAway(tui);
		const rail = makeRailCard(theme);
		blurRailCard = () => rail.blur?.();
		return sidebarPart(tui, "notes", makeCompactRow(theme), rail);
	};

	pi.on("session_start", (_event, ctx) => {
		projectCwd = ctx.cwd;
		sessionCtx = ctx;
		settings = readSettings();
		current = loadNotes(ctx.cwd);
		restoreRailView(current);
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, widgetFactory, { placement: "aboveEditor" });
		// Sibling sessions of the same project share one JSON file: watch it so a
		// note added, sent, restored or deleted elsewhere shows up here too.
		unwatchNotes?.();
		unwatchNotes = watchNotes(ctx.cwd, (newState) => {
			if (!isNotesState(newState)) return;
			// A remote write already carries the full state; keep the local view
			// flags there too, so the layout never jumps under the pointer.
			current = newState;
			restoreRailView(newState);
			refresh();
		});
	});

	pi.on("session_shutdown", () => {
		unwatchNotes?.();
		unwatchNotes = undefined;
		restoreTerminalInput?.();
		clickAwayTui = undefined;
		blurRailCard = undefined;
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

	const showNotes = (): void => {
		const summary = notesSummary(current);
		const output = JSON.stringify({
			summary,
			notes: current.notes.map((note) => ({
				id: note.id,
				text: note.text,
				status: note.status,
				createdAt: note.createdAt,
				sentAt: note.sentAt,
			})),
		}, null, 2);
		notify(output);
	};

	/** Keyboard path for everything the rail does with the mouse. */
	const openManager = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			notify("The notes manager needs an interactive session", "warning");
			return;
		}
		const summary = notesSummary(current);
		// Settings-only manager: no add button, no per-note entries (S14).
		const options = [
			managerSettingsEntry(settings.sendDestination),
			...(summary.pending > 0 ? [MANAGER_CLEAR_PENDING] : []),
			MANAGER_CLEAR,
			MANAGER_CLOSE,
		];
		const choice = await ctx.ui.select(`Notes · ${summary.pending} pending · ${summary.sent} sent`, options);
		if (choice === undefined || choice === MANAGER_CLOSE) return;
		if (choice === managerSettingsEntry(settings.sendDestination)) {
			await openSettings(ctx, "");
			return;
		}
		if (choice === MANAGER_CLEAR) {
			if (await ctx.ui.confirm("Clear all notes", "Remove every note, pending and sent?")) await clearAll();
			return;
		}
		if (choice === MANAGER_CLEAR_PENDING) {
			if (await ctx.ui.confirm("Clear all pending notes", `Remove ${summary.pending} pending note${summary.pending === 1 ? "" : "s"}? Sent notes stay.`)) {
				await clearStatus(NOTE_STATUS.PENDING, summary.pending);
			}
			return;
		}
	};

	/** Picker for /notes send without id: selects from pending notes. */
	const pickPendingToSend = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		const pending = current.notes.filter((note) => note.status === NOTE_STATUS.PENDING);
		if (pending.length === 0) {
			notify("No pending notes to send");
			return;
		}
		const options = pending.map((note) => managerLine("➤", `#${note.id} ${note.text}`));
		const choice = await ctx.ui.select("Send which note?", options);
		if (choice === undefined) return;
		const match = /^➤\s+#(\d+)/.exec(choice);
		if (match) await sendNote(Number.parseInt(match[1] as string, 10));
	};

	/** Picker for /notes restore without id: selects from sent notes. */
	const pickSentToRestore = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		const sent = current.notes.filter((note) => note.status === NOTE_STATUS.SENT);
		if (sent.length === 0) {
			notify("No sent notes to restore");
			return;
		}
		const options = sent.map((note) => managerLine("↶", `#${note.id} ${note.text}`));
		const choice = await ctx.ui.select("Restore which note?", options);
		if (choice === undefined) return;
		const match = /^↶\s+#(\d+)/.exec(choice);
		if (match) await restoreOne(Number.parseInt(match[1] as string, 10));
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
				case "note":
					// /note <text> - direct capture from chat (alias, not shown in palette)
					const noteText = parsed.rest;
					if (noteText) {
						await saveNote(noteText);
						return;
					}
					if (!ctx.hasUI) {
						notify("Usage: /note <text>", "warning");
						return;
					}
					const typed = await ctx.ui.input("New note", "Write the task you want the AI to do later…");
					if (typed && typed.trim()) await saveNote(typed);
					return;
				case "send":
					if (parsed.id !== undefined) await sendNote(parsed.id);
					else await pickPendingToSend(ctx);
					return;
				case "list":
					listNotes();
					return;
				case "show":
					showNotes();
					return;
				case "clear":
					if (!ctx.hasUI || (await ctx.ui.confirm("Clear all notes", "Remove every note, pending and sent?"))) await clearAll();
					return;
				case "delete":
					if (parsed.id !== undefined) await deleteOne(parsed.id);
					else await pickPendingToSend(ctx); // or a delete picker? S15 says /notes delete <id>
					return;
				case "restore":
					if (parsed.id !== undefined) await restoreOne(parsed.id);
					else await pickSentToRestore(ctx);
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
				case "collapseSent":
					setRailSentCollapsed(true);
					return;
				case "expandSent":
					setRailSentCollapsed(false);
					return;
				case "clearSent":
					await clearStatus(NOTE_STATUS.SENT, current.notes.filter((n) => n.status === NOTE_STATUS.SENT).length);
					return;
				case "fold":
					if (parsed.id !== undefined) await foldOne(parsed.id);
					else await pickSentToRestore(ctx); // reuse picker pattern for foldable notes
					return;
				case "unfold":
					if (parsed.id !== undefined) await unfoldOne(parsed.id);
					else await pickSentToRestore(ctx);
					return;
				case "edit":
					if (parsed.id !== undefined) await startEdit(parsed.id);
					else await pickPendingToSend(ctx);
					return;
				case "settings":
					await openSettings(ctx, parsed.rest);
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

	// Scroll the notes list by ±3 rows (S13): alt+pgup/pgdn. These are the
	// keys the hint names — ctrl+shift+up/down is reserved by Pi for prompt
	// navigation, and alt+shift+up/down is taken by the Todos extension.
	for (const [key, lines] of [["alt+pageup", -3], ["alt+pagedown", 3]] as const) {
		pi.registerShortcut(key, {
			description: `Scroll the notes list ${lines < 0 ? "up" : "down"}`,
			handler: async (_ctx) => scrollNotes(lines),
		});
	}
}
