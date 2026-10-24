// Faithful replica of gentle-shell's card system (gentle-pi lib/shell-card.ts),
// panel path only: the rail cards (Status, Agents, Todos — and now Notes) all
// draw through this shape. Byte parity with the real implementation is pinned
// by golden fixtures in tests/card-chrome.test.ts, generated from renderCard
// itself. The active style travels on the same process-shared symbol, so this
// renders exactly what gentle-shell would, without importing gentle-pi.
// Deviations from the original: panels only (no tool-row/preview paths), and
// nonpositive widths return no rows (the rail never renders there).
//
// Provenance, so the replica has an exact commit to be checked against:
//   upstream file: lib/shell-card.ts in Gentleman-Programming/gentle-shell
//   commit:        b2d428b5e76f0c03089c0b9e07a64298582466ab (branch
//                  `notes-rail-section`; `main` carries the same blob)
//   blob:          8282e1912f7f8008a189ca57447391f3f77b67bd
// This is a local fork, kept on purpose because the shell exposes no importable
// module for its card chrome or its pointer hit-testing. Re-check it against
// that upstream file whenever that file changes.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const CARD_TONE = {
	INFO: "info",
	SUCCESS: "success",
	WARNING: "warning",
	ERROR: "error",
} as const;

export type CardTone = (typeof CARD_TONE)[keyof typeof CARD_TONE];

export const CARD_STYLE = {
	NEON: "neon",
	FLOAT: "float",
} as const;

export type CardStyle = (typeof CARD_STYLE)[keyof typeof CARD_STYLE];

const CARD_STYLE_SLOT = Symbol.for("gentle-pi.card-style");

/** Active conversation card style, shared with gentle-shell per process. */
export function cardStyle(): CardStyle {
	return (globalThis as typeof globalThis & Record<symbol, unknown>)[CARD_STYLE_SLOT] === CARD_STYLE.NEON ? CARD_STYLE.NEON : CARD_STYLE.FLOAT;
}

export const CARD_GLYPH = "✎";

export interface PanelCard {
	title: string;
	subtitle?: string;
	body: string[];
	tone: CardTone;
	glyph?: string;
}

export interface CardChromeTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
}

export interface PanelRenderOptions {
	expanded: boolean;
	hint?: string;
}

const FRAME_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "border",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const TITLE_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "accent",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const HINT_ROLE = "dim";
const SUBTITLE_ROLE = "muted";
const BODY_ROLE = "text";
const SEPARATOR = "·";
const FRAME_COLUMNS = 4;

// The characters that draw a card around its content. The float style keeps
// every row the same width: the left edge becomes an accent bar and the rules
// and the right rail become spaces.
interface CardChrome {
	topLeft: string;
	topLead: string;
	topRight: string;
	rule: string;
	side: string;
	rail: string;
	bottomLeft: string;
	bottomRight: string;
}

const OUTLINE_CHROME: CardChrome = { topLeft: "╭", topLead: "─ ", topRight: "╮", rule: "─", side: "│", rail: "│", bottomLeft: "╰", bottomRight: "╯" };
// `▎ ` is one cell narrower than `╭─ `: the spare cell moves to the right end
// so the heading glyph starts in the same column as the body text.
const FLOAT_CHROME: CardChrome = { topLeft: "▎", topLead: " ", topRight: "  ", rule: " ", side: "▎", rail: " ", bottomLeft: "▎", bottomRight: " " };
let chrome = OUTLINE_CHROME;

function withChrome<T>(next: CardChrome, run: () => T): T {
	const previous = chrome;
	chrome = next;
	try {
		return run();
	} finally {
		chrome = previous;
	}
}

function rule(length: number): string {
	return chrome.rule.repeat(Math.max(0, length));
}

function frame(theme: CardChromeTheme, tone: CardTone, text: string): string {
	return theme.fg(FRAME_ROLE[tone], text);
}

function titleText(card: PanelCard, theme: CardChromeTheme): { styled: string; width: number } {
	const head = `${card.glyph ?? CARD_GLYPH} ${card.title}`;
	const styled = card.subtitle
		? `${theme.fg(TITLE_ROLE[card.tone], head)} ${theme.fg(SUBTITLE_ROLE, SEPARATOR)} ${theme.fg(SUBTITLE_ROLE, card.subtitle)}`
		: theme.fg(TITLE_ROLE[card.tone], head);
	return { styled, width: visibleWidth(head) + (card.subtitle ? visibleWidth(card.subtitle) + 3 : 0) };
}

function bodyLines(card: PanelCard, innerWidth: number): string[] {
	return card.body.flatMap((paragraph) => (paragraph === "" ? [""] : wrapTextWithAnsi(paragraph, innerWidth)));
}

export function cardTop(card: PanelCard, theme: CardChromeTheme, width: number, hint?: string): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	if (targetWidth < 5) {
		const left = theme.fg(FRAME_ROLE[card.tone], "╭");
		if (targetWidth === 1) return left;
		return left + frame(theme, card.tone, `${rule(targetWidth - 2)}╮`);
	}

	const title = titleText(card, theme);
	const fullHintWidth = hint ? visibleWidth(hint) + 2 : 0;
	const shownHint = hint && title.width + 5 + fullHintWidth <= targetWidth ? hint : undefined;
	const hintWidth = shownHint ? fullHintWidth : 0;
	const titleWidth = Math.max(0, targetWidth - 5 - hintWidth);
	const styledTitle = title.width <= titleWidth ? title.styled : truncateToWidth(title.styled, titleWidth, "");
	const styledTitleWidth = title.width <= titleWidth ? title.width : visibleWidth(styledTitle);
	const fill = rule(targetWidth - styledTitleWidth - 5 - hintWidth);
	const tail = shownHint ? ` ${theme.fg(HINT_ROLE, shownHint)} ` : "";
	return theme.fg(FRAME_ROLE[card.tone], chrome.topLeft) + frame(theme, card.tone, chrome.topLead) + styledTitle + frame(theme, card.tone, ` ${fill}`) + tail + frame(theme, card.tone, chrome.topRight);
}

export function cardLine(text: string, tone: CardTone, theme: CardChromeTheme, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = theme.fg(FRAME_ROLE[tone], chrome.side);
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, "│");
	if (targetWidth === 3) return `${left} ${frame(theme, tone, "│")}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? "" : truncateToWidth(text, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${left} ${clipped}${padding} ${frame(theme, tone, chrome.rail)}`;
}

export function cardBottom(tone: CardTone, theme: CardChromeTheme, width: number, content?: string): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = theme.fg(FRAME_ROLE[tone], chrome.bottomLeft);
	if (targetWidth === 1) return left;
	if (content === undefined || visibleWidth(content) === 0) return left + frame(theme, tone, `${rule(targetWidth - 2)}${chrome.bottomRight}`);
	const contentWidth = visibleWidth(content) + 2;
	if (targetWidth - 2 - contentWidth < 3) return left + frame(theme, tone, `${rule(targetWidth - 2)}${chrome.bottomRight}`);
	return left + frame(theme, tone, `${rule(targetWidth - 2 - contentWidth)} `) + theme.fg(HINT_ROLE, content) + frame(theme, tone, ` ${chrome.bottomRight}`);
}

export function cardInnerWidth(width: number): number {
	return Math.max(1, width - FRAME_COLUMNS);
}

/** Body text of a panel, wrapped to its content columns, before the side rails. */
function cardText(card: PanelCard, theme: CardChromeTheme, innerWidth: number, expanded: boolean): string[] {
	const lines = bodyLines(card, innerWidth);
	if (lines.length === 0) return [];
	if (!expanded) {
		const first = lines.find((line) => line !== "") ?? "";
		const clipped = lines.length > 1 ? truncateToWidth(first, Math.max(1, innerWidth - 1), "") + "…" : first;
		return [theme.fg(BODY_ROLE, clipped)];
	}
	return lines.map((line) => (line === "" ? "" : theme.fg(BODY_ROLE, line)));
}

const FLOAT_MARGIN = 1;
const FLOAT_MIN_WIDTH = 10;
const FLOAT_BG_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "toolSuccessBg",
	[CARD_TONE.SUCCESS]: "toolSuccessBg",
	[CARD_TONE.WARNING]: "toolPendingBg",
	[CARD_TONE.ERROR]: "toolErrorBg",
};
const BG_RESET = "\x1b[49m";
// Full resets (pi-tui truncation inserts one) and background resets.
const BG_CLEARING = /\x1b\[(?:0|49)?m/g;

function panelOpener(theme: CardChromeTheme, tone: CardTone): string {
	if (typeof theme.bg !== "function") return "";
	try {
		const painted = theme.bg(FLOAT_BG_ROLE[tone], "");
		return painted.endsWith(BG_RESET) ? painted.slice(0, -BG_RESET.length) : "";
	} catch {
		// A theme without the tool background keeps the outlined card.
		return "";
	}
}

/** The tone background opener when the float style applies at this width, or "" for the outlined card. */
function floatOpener(theme: CardChromeTheme, tone: CardTone, width: number): string {
	return cardStyle() === CARD_STYLE.FLOAT && Math.floor(width) >= FLOAT_MIN_WIDTH ? panelOpener(theme, tone) : "";
}

// Paints every row behind its tone background, re-armed after any reset the
// content carries, inside a transparent one-column margin on both sides.
function paintFloat(rows: readonly string[], open: string): string[] {
	const margin = " ".repeat(FLOAT_MARGIN);
	return rows.map((row) => `${margin}${open}${row.replace(BG_CLEARING, (reset) => reset + open)}${BG_RESET}${margin}`);
}

// Float panels: padding rows that keep the accent bar sit above the heading,
// between heading and body (only when a body exists) and in the bottom rule's
// place, centering the content: panelExtraRows taller than neon, with the
// heading on row 1 (see panelHeaderRow).
function floatPanel(card: PanelCard, theme: CardChromeTheme, width: number, options: PanelRenderOptions): string[] {
	const blank = cardBottom(card.tone, theme, width);
	const body = cardText(card, theme, cardInnerWidth(width), options.expanded).map((line) => cardLine(line, card.tone, theme, width));
	return [blank, panelHeader(card, theme, width, options.hint), ...(body.length > 0 ? [blank, ...body] : []), blank];
}

function fitRow(text: string, width: number): string {
	const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

// `▎ <glyph> <title>  <subtitle>` left and the hint right, ending in the same
// two columns the body rows keep for their right edge.
function panelHeader(card: PanelCard, theme: CardChromeTheme, width: number, hint?: string): string {
	const lead = theme.fg(FRAME_ROLE[card.tone], chrome.topLeft) + chrome.topLead;
	const subtitle = card.subtitle ? `  ${theme.fg(SUBTITLE_ROLE, card.subtitle)}` : "";
	const left = `${lead}${theme.fg(TITLE_ROLE[card.tone], `${card.glyph ?? CARD_GLYPH} ${card.title}`)}${subtitle}`;
	const right = hint ? `${theme.fg(SUBTITLE_ROLE, hint)}${chrome.topRight}` : "";
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return right && gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : fitRow(left, width);
}

/** Content columns of a panel body in the active style. Callers that pre-wrap
 * or pre-fit rows use it so a float panel, two columns narrower than the
 * outlined frame, never re-wraps or clips them. */
export function panelInnerWidth(theme: CardChromeTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? cardInnerWidth(Math.floor(width) - FLOAT_MARGIN * 2) : cardInnerWidth(width);
}

/** The row a panel draws its header on in the active style: 0 for the
 * outlined frame, 1 below the float panel's top padding row. Callers
 * hit-test their header control with it. */
export function panelHeaderRow(theme: CardChromeTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? 1 : 0;
}

/** Rows a float panel with a body adds over the outlined frame. */
export function panelExtraRows(theme: CardChromeTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? 2 : 0;
}

/** The rows a rail panel draws, in the active style — gentle-shell's renderCard
 * panel path, byte for byte. */
export function renderCardPanel(card: PanelCard, theme: CardChromeTheme, width: number, options: PanelRenderOptions): string[] {
	if (width <= 0) return [];
	const open = floatOpener(theme, card.tone, width);
	if (open) return paintFloat(withChrome(FLOAT_CHROME, () => floatPanel(card, theme, Math.floor(width) - FLOAT_MARGIN * 2, options)), open);
	const top = cardTop(card, theme, width, options.hint);
	const bottom = cardBottom(card.tone, theme, width);
	return [top, ...cardText(card, theme, cardInnerWidth(width), options.expanded).map((line) => cardLine(line, card.tone, theme, width)), bottom];
}

/** Whether the float style paints this width: callers that branch their
 * geometry on the active card style use it. */
export function panelFloatApplies(theme: CardChromeTheme, width: number, tone: CardTone = CARD_TONE.INFO): boolean {
	return floatOpener(theme, tone, width) !== "";
}

/** The visible column where panel body content starts, in component
 * coordinates: side rail plus its padding, plus the float margin when
 * active. Callers forward mouse clicks into pre-rendered rows with it. */
export function panelContentColumn(theme: CardChromeTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? FLOAT_MARGIN + 2 : 2;
}

/** The panel header as a standalone one-row block, in the active style: the
 * compact sections paint it above the editor, tone background and all. The
 * outlined frame cannot carry one bare row, so it falls back to the whole
 * collapsed panel. */
export function renderPanelHeaderLine(card: PanelCard, theme: CardChromeTheme, width: number, hint?: string): string[] {
	if (width <= 0) return [];
	const open = floatOpener(theme, card.tone, width);
	if (open) return paintFloat(withChrome(FLOAT_CHROME, () => [panelHeader(card, theme, Math.floor(width) - FLOAT_MARGIN * 2, hint)]), open);
	return renderCardPanel(card, theme, width, { expanded: false });
}

/** The width a caller must render spliced panel rows at (cardLine and
 * friends) so paintPanelRows' float margins bring them back to exactly the
 * requested width: the rail deactivates itself if any line overflows. */
export function panelBodyWidth(theme: CardChromeTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? Math.floor(width) - FLOAT_MARGIN * 2 : Math.floor(width);
}

/** A body row composed outside renderCardPanel, drawn in the active style's
 * own chrome — the float panel's ▎ rail with its invisible right edge, or
 * the outlined frame — so spliced rows (the wrapping field, the edit block)
 * match the card that hosts them. Takes the panel's requested width and
 * renders at the float body width; paintPanelRows completes the margins. */
export function panelBodyLine(text: string, tone: CardTone, theme: CardChromeTheme, width: number): string {
	const open = floatOpener(theme, tone, width);
	return withChrome(open ? FLOAT_CHROME : OUTLINE_CHROME, () => cardLine(text, tone, theme, open ? Math.floor(width) - FLOAT_MARGIN * 2 : Math.floor(width)));
}

/** Rows a caller composes outside renderCardPanel — the rail's field block
 * — painted with the panel's tone background and margins when float applies,
 * so spliced rows read as part of the block. */
export function paintPanelRows(rows: readonly string[], theme: CardChromeTheme, width: number, tone: CardTone = CARD_TONE.INFO): string[] {
	const open = floatOpener(theme, tone, width);
	// Copy when nothing is painted: callers append to the result (the rail's
	// overflow hint) and must never be handed the array they passed in.
	return open ? paintFloat(rows, open) : [...rows];
}
