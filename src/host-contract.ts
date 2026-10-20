/**
 * The slice of the Pi / gentle-shell host contract this extension depends on,
 * typed here on purpose.
 *
 * Why not import the real types? Two measured facts about the published
 * packages this extension runs against:
 *
 *   1. `@earendil-works/pi-tui` does not export `Theme` at all — it exports the
 *      component-scoped `EditorTheme`, `MarkdownTheme`, `SelectListTheme`, … but
 *      no general theme type.
 *   2. `@earendil-works/pi-coding-agent@1.3.0` declares
 *      `"types": "./dist/index.d.ts"` in its manifest and ships only
 *      `dist/index.d.ts.map`.
 *
 * Both imports were type-only, so they were erased at runtime and nothing ever
 * failed — which is exactly why nothing was checked. Naming the shape here makes
 * the contract reviewable in one file and lets `npm run typecheck` verify every
 * member we touch, including the ones reached through runtime guards
 * (`ui.pasteToEditor`, `rail.blur`, `component.dispose`).
 *
 * The day upstream publishes those declarations, delete this module and import
 * theirs; nothing else in the code has to change.
 */
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/** A theme role name, as passed to `theme.fg` / `theme.bg` (`"accent"`, `"muted"`, …). */
export type ThemeRole = string;

/** The theme object the host hands to widget factories and command handlers. */
export interface Theme {
	fg(role: ThemeRole, text: string): string;
	bg(role: ThemeRole, text: string): string;
	strikethrough(text: string): string;
}

/** A component that also answers the lifecycle calls the host makes on widgets.
 * `render`, `handleInput`, `handleMouse` and `invalidate` come from pi-tui's
 * `Component`; the rest are called defensively (`?.(…)`) because they are not
 * part of that published interface. */
export interface HostComponent extends Component {
	/** Called when the host unmounts the widget. */
	dispose?(): void;
	/** Called when keyboard focus leaves the component. */
	blur?(): void;
	/** A cheap fingerprint of everything that affects the rendered output. */
	digest?(): string;
	/** Whether the host currently considers this component focused. */
	focused?: boolean;
}

/** The interactive surface of `ctx.ui` used by this extension. */
export interface HostUI {
	notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	/** Passing no factory unmounts the widget. */
	setWidget(key: string, factory: ((tui: TUI, theme: Theme) => Component) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	/** Inserts text at the chat editor's caret, keeping whatever is typed there.
	 * Present in current Pi builds; the extension falls back to sending the note
	 * straight to the chat when it is missing. */
	pasteToEditor?(text: string): void;
}

/** The context handed to lifecycle handlers and command handlers. */
export interface ExtensionContext {
	cwd: string;
	/** False in headless runs (`--print`), where no dialog or widget can appear. */
	hasUI?: boolean;
	ui: HostUI;
}

/** The extension API surface registered at load time. */
export interface ExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }): void;
	registerShortcut(key: string, options: { description?: string; handler: (ctx: ExtensionContext) => void | Promise<void> }): void;
	sendUserMessage(text: string, options?: { deliverAs?: "followUp" }): void;
}

/** Re-exported so call sites need a single import for host types. */
export type { TuiMouseEvent, TuiMouseEventResult };
