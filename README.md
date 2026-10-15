# Gentle Notes — a persistent notepad sidebar for Pi and gentle-shell

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
| Storage | One JSON file per project under `~/.pi/gentle-ai/notes/`, honoring `GENTLE_PI_CONFIG_HOME`. Atomic writes, serialized per file across concurrent sessions. |
| Fullscreen sidebar | Paints as the `notes` rail section (below Todo) when gentle-shell supports it. Hovering `➤` highlights it; clicking sends. |
| Regular mode | A one-row summary above the editor (`✉ Notes · N pend · M sent — "last note…"`), hidden while empty. |
| While the agent runs | The note is queued as a follow-up prompt (`deliverAs: "followUp"`), never interrupting the current turn. |
| Keyboard path | Everything works without a mouse: `/notes add <text>`, `/notes send [<id>]`, `/notes list`, `/notes clear`, or `alt+n` to pick a note to send. |
| Statuses | Pending `✉` (accent) → sent `✓` (success, dim, struck through, same grammar as gentle-shell's Todo). Long lists fold into `✓ N sent`. |
| Visibility | `visibility.notes` on the shared sidebar state hides the section, mirroring `visibility.todo`. |

## Requirements

- The rail section needs a gentle-shell that lists `notes` among its sidebar
  sections. Until that lands upstream, everything else works: the compact row,
  the `/notes` command and the `alt+n` manager.
- The ready patch lives in `upstream/gentle-shell` (branch
  `notes-rail-section`, commit `b2d428b`): three files, adding `notes` to the
  rail sections plus its visibility flag, with a new upstream test
  (`tests/shell-sidebar-layout.test.ts`, 47/47 green).

## How it works

| Module | Responsibility |
|--------|----------------|
| `src/notes-state.ts` | Pure model: statuses, add/markSent/clear/summary, validation. |
| `src/storage.ts` | Per-project JSON persistence, atomic tmp+rename, per-file mutation queue. |
| `src/notes-card.ts` | Pure rendering: glyphs, strikethrough, folding, compact row, hit map. |
| `src/sidebar-interop.ts` | Symbol-based interop with gentle-shell's rail state; no runtime dependency on where gentle-pi is installed. |
| `src/extension.ts` | The Pi extension: command, shortcut, dialogs, send, interactive rail card. |

The extension never imports gentle-pi at runtime: it registers its rail part
through the shared terminal-owned state (`Symbol.for`), so it works no matter
where the gentle-pi package is installed, and stays harmless without
gentle-shell.

## Development

```bash
npm test          # or: node --test tests/   (Node >= 22, native TS)
```

79 tests: pure modules, rendering, and an integration harness with mocked Pi
surfaces that exercises the whole wiring (registration, session lifecycle,
click-to-send, busy queueing, visibility, shutdown).

- Feature spec and task log: `odd/tasks/gentle-notes.md`
- Upstream patch: `upstream/gentle-shell` (shallow clone, gitignored; branch
  `notes-rail-section`)

## Next step

Open the upstream PR for the `notes` rail section from the patch branch, then
load the extension in your daily gentle-shell session.
