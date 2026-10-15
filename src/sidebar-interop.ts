// Interop with gentle-shell's experimental sidebar. The rail state lives on the
// terminal object under well-known Symbols so modules isolated by the
// extension loader still share it (mirrors gentle-pi lib/shell-sidebar.ts,
// re-implemented locally so this extension never depends on where the
// gentle-pi package is physically installed).
import type { Component, TUI } from "@earendil-works/pi-tui";

const STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
const CACHE = Symbol.for("gentle-pi.experimental-sidebar.cache");

export interface NotesSidebarState {
	active: boolean;
	visibility?: { todo?: boolean; notes?: boolean };
	ownsHost?: () => boolean;
	parts: Map<string, Component>;
}

export function sidebarState(tui: TUI): NotesSidebarState {
	const terminal = tui.terminal as unknown as Record<symbol, NotesSidebarState>;
	return (terminal[STATE] ??= { active: false, parts: new Map() });
}

/** Bump the shared rail revision so an installed gentle-shell re-renders. */
export function invalidateSidebar(tui: TUI): void {
	if (!tui.terminal) return;
	const terminal = tui.terminal as unknown as Record<symbol, { revision: number }>;
	(terminal[CACHE] ??= { revision: 0 }).revision++;
}

/**
 * Register a rail section plus its editor-side counterpart. The returned
 * wrapper suppresses the bottom paint while the fullscreen rail owns the host
 * and while visibility.notes is false, exactly like gentle-pi's own parts.
 * Without gentle-shell the shared state exists but nothing paints the rail;
 * the bottom component still renders on its own.
 */
export function sidebarPart<T extends Component & { dispose?(): void }>(tui: TUI, key: string, bottom: T, rail: Component = bottom): T {
	if (!tui.terminal) return bottom;
	const state = sidebarState(tui);
	state.parts.set(key, rail);
	return {
		...bottom,
		render: (width: number) =>
			(key === "notes" && state.visibility?.notes === false) || (state.active && state.ownsHost?.())
				? []
				: bottom.render(width),
		dispose() {
			if (state.parts.get(key) === rail) state.parts.delete(key);
			bottom.dispose?.();
		},
	};
}
