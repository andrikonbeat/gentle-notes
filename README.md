# Gentle Notes — a persistent notepad sidebar for Pi and gentle-shell

[![CI](https://github.com/andrikonbeat/gentle-notes/actions/workflows/ci.yml/badge.svg)](https://github.com/andrikonbeat/gentle-notes/actions/workflows/ci.yml)

Capture the tasks you want the AI to do later before you forget them, keep them
glanceable in the sidebar, and send any note to the chat as a prompt when you
are ready — one click from the rail, or one pick from the manager dialog.

## Quick path

1. Load the extension in your project session:
   ```bash
   pi --extension ./src
   ```
   (or copy/symlink this directory into `~/.pi/agent/extensions/gentle-notes/`)
2. Press `alt+n` (or type `/notes`) and write your note. It survives restarts.
3. Send it when ready: click the `➤` glyph next to the note in the sidebar
   rail, or pick it from the manager. Sent notes render struck through with `✓`.

## Details

| Topic | Behavior |
|-------|----------|
| Storage | One JSON file per project under `~/.pi/gentle-ai/notes/`, honoring `GENTLE_PI_CONFIG_HOME`. Atomic writes, serialized per file inside one process (see *One writer per process* below). |
| Fullscreen sidebar | Paints as the `notes` rail section (below Todo) when gentle-shell supports it. Click the field to write (`Enter` saves, `Esc` — or a click anywhere else — returns the keyboard to the chat), click a note's text to edit it inline, double click to fold it back to its first line, click `➤` to send (its target is two columns wide on each side), and drive the block from the header controls (`▾ Collapse` / `▾ Fold`). |
| Regular mode | One summary line above the editor with a blank line of air on each side: `Notes ▸ Expand  N pend · M sent — <the last note's first words>`, the preview clipped to the window. Hidden while empty. |
| While the agent runs | The note is queued as a follow-up prompt (`deliverAs: "followUp"`), never interrupting the current turn. |
| Keyboard path | Everything works without a mouse: `/notes add <text>`, `/notes send [<id>]`, `/notes list`, `/notes clear`, `/notes collapse|expand|fold|unfold`, or `alt+n` to pick a note to send. |
| Send target | `/notes settings [chat\|editor]`, or the `⚙ Send target` entry in the `/notes` manager (and `alt+n`). `chat` hands the note to the agent immediately; `editor` loads it into the chat's input so it can be edited before pressing Enter. The choice is plugin-wide and lives in `settings.json` beside the per-project stores, so it survives projects and restarts. |
| Statuses | Pending `✉` (accent) → sent `✓` (success, dim, struck through, same grammar as gentle-shell's Todo). Long lists fold into `✓ N sent`. |
| Trailing glyph | A pending note the agent never saw carries `×` (delete). Once a note has been sent, that glyph becomes `✓`: one click puts it back in the sent list **without sending it again** — the way out of a mistaken restore. Same column, same grammar, so only the glyph says which action is armed. |
| Visibility | `visibility.notes` on the shared sidebar state hides the section, mirroring `visibility.todo`. |

## Install

Pi loads an extension from a file, or from a directory that has an `index.ts`
entry point — this repository offers both, and neither needs a build step (Pi
uses jiti, Node strips the types).

```bash
# Try it from a checkout, installing nothing:
pi --extension /path/to/gentle-notes

# Or make it permanent, for every project:
ln -s /path/to/gentle-notes ~/.pi/agent/extensions/gentle-notes
```

For one project only, put the same link inside `.pi/extensions/` in that
project (project extensions load after project trust is granted).

It runs with or without gentle-shell. On its own you get the `/notes` command,
the `/note <text>` alias, the `alt+n` manager and the compact row above the
editor. Inside gentle-shell's fullscreen rail you also get the `notes` card,
next to the Todos.

To uninstall: remove the link or directory, and delete
`~/.pi/gentle-ai/notes/` if you want the stored notes gone too.

## Requirements

- The rail section needs a gentle-shell that lists `notes` among its sidebar
  sections. Until that lands upstream, everything else works: the compact row,
  the `/notes` command and the `alt+n` manager.
- The ready stopgap patch is versioned in the repository, under
  `proposal/rail-patch/` (`notes-rail.patch`, plus a README with what it
  changes and how to apply it): three files, adding `notes` to the rail
  sections plus its visibility flag, with a new upstream test
  (`tests/shell-sidebar-layout.test.ts`, 47/47 green).

## How it works

| Module | Responsibility |
|--------|----------------|
| `src/notes-state.ts` | Pure model: statuses, add/markSent/clear/summary, validation. |
| `src/storage.ts` | Per-project JSON persistence: atomic tmp+rename, per-file mutation queue, owner-only modes, unreadable stores kept aside instead of overwritten. |
| `src/notes-card.ts` | Pure rendering: glyphs, strikethrough, folding, compact row, hit map. |
| `src/sidebar-interop.ts` | Symbol-based interop with gentle-shell's rail state; no runtime dependency on where gentle-pi is installed. |
| `src/extension.ts` | The Pi extension: command, shortcut, dialogs, send, interactive rail card. |
| `src/host-contract.ts` | The slice of the Pi/gentle-shell host API this extension uses, typed locally (see below). |

The extension never imports gentle-pi at runtime: it registers its rail part
through the shared terminal-owned state (`Symbol.for`), so it works no matter
where the gentle-pi package is installed, and stays harmless without
gentle-shell.

### Storage and hygiene

The store is the user's own writing, so it is treated that way:

- **Owner-only permissions.** The notes directory is created `0700` and the
  file written `0600`, the same pair every gentle-shell store uses. An existing
  directory keeps the permissions you gave it.
- **No silent loss.** If the file on disk is unreadable, it is renamed
  `*.corrupt-<timestamp>` before anything new is written. If that rename fails,
  the save is refused and the error is reported instead of overwriting your
  notes.
- **No terminal escapes.** Note text is stripped of C0/C1 controls, bidi
  overrides and zero-width padding before it is stored, so a note can neither
  emit an escape sequence nor reorder the row it is painted in. Zero-width
  joiners are kept, because emoji sequences and complex scripts need them.
- **Bounded input.** A note is capped at 2000 characters; longer text is
  rejected with an explicit message rather than silently truncated.
- **Watcher isolation.** The file watcher that keeps concurrent sessions in
  sync calls each subscriber inside its own try/catch: a repaint against a
  disposed TUI cannot take down the session.
- **One writer per process.** Mutations are queued per file inside a process,
  and the write is atomic, so a reader never sees a torn file. Two *processes*
  on the same project still resolve last-writer-wins: the file is never
  corrupted, but the slower of two simultaneous writes is the one that stays.

## Development

```bash
npm run check           # typecheck + tests — what CI runs
npm test                # node --test "tests/*.test.ts" (Node >= 22, native TS)
npm run typecheck       # tsc --noEmit
npm run verify:package  # pack, then assert the tarball carries what Pi loads
npm run check:card-parity # dev only: our card vs gentle-shell's own (needs the clone)
```

`.github/workflows/ci.yml` runs `npm run check` and `npm run verify:package` on
Node 22 and 24, on Linux and macOS, and installs the packed tarball into a
scratch project — the same three gates gentle-shell asks of its own pull
requests. macOS is in the matrix on purpose: the store relies on atomic rename
and on file modes, and both behave differently there.

225 tests over 38 suites: pure modules, rendering, and an integration harness
with mocked Pi surfaces that exercises the whole wiring (registration, session
lifecycle, click-to-send, busy queueing, restore, visibility, shutdown), plus
the storage rules above (permissions, corrupt store recovery, watcher
isolation).

`tsconfig.json` keeps `strict` and `erasableSyntaxOnly` on, so everything that
typechecks also runs under Node's native type stripping — no build step, no
loader.

### Why `src/host-contract.ts`

Two measured facts about the published packages:

- `@earendil-works/pi-tui` exports `EditorTheme`, `MarkdownTheme`, … but **no**
  general `Theme` type.
- `@earendil-works/pi-coding-agent` declares `"types": "./dist/index.d.ts"` in
  its manifest and ships only `dist/index.d.ts.map`.

Both imports were type-only, so they were erased at runtime and nothing ever
failed — which is exactly why nothing was checked. The shape lives in one
reviewable file instead, and `npm run typecheck` verifies every member the
extension touches, including the ones behind runtime guards
(`ui.pasteToEditor`, `rail.blur`, `component.dispose`). If upstream publishes
those declarations, delete the module and import theirs.

- Feature spec and task log: `odd/tasks/gentle-notes.md`
- Upstream patch: `proposal/rail-patch/` (stopgap, versioned; the clone it came
  from is gitignored)

## Next step

Open the feature request (`proposal/feature-request.md`) as an issue in
`Gentleman-Programming/gentle-shell` and wait for `status:approved` — this
repository does not open a PR without an approved issue. Only after that does
the rail section become a pull request; until then, apply
`proposal/rail-patch/notes-rail.patch` by hand and load the extension in your
daily gentle-shell session.
