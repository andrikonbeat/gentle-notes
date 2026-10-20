# Feature request: a persistent notes rail next to the Todos (`gentle-notes`)

This is a draft for `.github/ISSUE_TEMPLATE/feature_request.yml` in
`Gentleman-Programming/gentle-shell`, section by section and in the same order.
Nothing here is a PR: per `skills/branch-pr`, a PR only exists over an approved
issue (`status:approved`).

---

## Before submitting

- [ ] I searched open and closed issues and did not find a request for this
      feature. — **Not ticked by the author of this draft.** I have not searched
      the tracker; the submitter must do it before opening the issue.
- [x] I reviewed this request and removed credentials, tokens, private paths,
      hostnames, and other sensitive data. — Verified: a grep over every
      versioned file for absolute home/project paths, user names, mail
      addresses and the unrelated project slug it was developed next to returns
      nothing. One caveat the submitter must decide on: the git history carries
      the commit author's e-mail, as in any public repository.

---

## Problem or opportunity

gentle-shell owns the two ends of a working session well: it holds the plan
(`Todos`, with its card, its states and its `Select`/`Toggle`/`Done` grammar)
and it drives the model. It has no place for what happens in the middle — the
notes a person takes while working.

In practice that gap shows up as three small frictions, and each one of them
exists because the browser tab, the sticky note and the second terminal are not
the place where the work happens:

1. **The thought arrives mid-run.** A `Todos` entry is a commitment to do
   something in this session. Much of what a person writes down is not that: it
   is "ask about the migration ordering", "the flaky test is probably the
   fixture", "remind me to check the release notes". Today those either
   interrupt the model with a half-formed prompt, or they leave the terminal.
2. **The half-formed prompt is the useful artifact.** When a note *is* meant
   for the model, sending it immediately is often the wrong moment: the agent is
   mid-edit, or the text needs one more sentence. What is needed is a holding
   area where the text waits until the person decides.
3. **It has to be readable back.** Anything captured this way is only
   trustworthy if a later session can read it: the store must be per project,
   survive restarts, and be inspectable from the outside (by a person, or by the
   agent itself through a command).

Who benefits: anyone who runs long sessions with an agent and thinks in
sentences rather than in tickets.

## Proposed outcome

A `notes` section in the fullscreen rail, right below the Todos, that is a
capture-and-defer surface with the same visual grammar the rail already uses:

- **Capture without leaving the keyboard.** A field lives inside the card. Click
  it (or use the command), type, press Enter. The text wraps into a paragraph
  while it is being written and scrolls to keep the cursor visible.
- **Defer, then send.** Each pending row carries a `➤`. Clicking it sends that
  note to the chat as a prompt — or, per a plugin setting, inserts it into the
  chat input at the caret so it can be edited first. If the agent is busy the
  note is queued as a follow-up instead of interrupting the turn.
- **Sent notes stay, and explain themselves.** A sent note is struck through
  with a `✓`, exactly like a done `Todo`. It can be restored to pending
  (`↶`) — as a *draft* if it never travelled (`✓`), so restoring never sends
  anything behind the user's back — or deleted (`×`).
- **Progressive views, same grammar as the Todos.** Two independent controls in
  the card header: one collapses the whole block to a single row, the other
  folds every note to its first line so the list reads like a compact Todos.
  Each note can also be folded on its own by double-clicking it.
- **Degrades to a line.** Below the fullscreen breakpoint the section becomes one
  card-styled row above the editor — control, counts, and the first words of the
  last note — that expands into a bounded, wheel-scrollable list.
- **One store per project, shared live.** `~/.pi/gentle-ai/notes/<slug>--<hash8>.json`,
  atomic writes, and a watcher so two sessions on the same project see the same
  notes while both are open. View state (collapsed, folded, sent-section
  collapsed) rides in the same file, so a restart looks like the session never
  ended.
- **Every gesture has a keyboard path.** `/notes` (manager dialog), `/note <text>`
  (capture straight from the chat), `alt+n` (manager). Nothing is mouse-only.

## Alternatives considered

- **Extend `Todos` with a "not a task" flag.** Rejected: it overloads the
  meaning of a task and the row grammar that the Todos already pin, and the two
  lists have different lifecycles (a task is finished; a note is sent or
  deleted).
- **A standalone Pi extension, no rail section.** This is how it is built today
  and it works, but it is the weaker product: without the rail the surface is a
  compact row and a dialog, and the two panels do not share chrome.
- **Send every note as a prompt immediately.** It removes the friction that
  makes the feature worth having: an interruption is not a note.
- **Store notes in the session transcript.** Notes must outlive sessions; the
  transcript does not.
- **Rely on the chat input as the holding area.** That is what happens today,
  and it collides with whatever the user was already typing.

## Additional context

### What already exists, and what it costs upstream

The implementation is complete and tested in a separate repository
(`gentle-notes`: 7 source modules, 213 tests, `npm run check` green). It reaches
the rail through the same `Symbol.for` interop the other sections use
(`sidebarPart(tui, "notes", bottom, rail)`), so **it needs no fork of
gentle-shell**: it is harmless when gentle-shell is absent.

One additive patch is required for the card to appear in the rail's section
list — `notes` in the section array of `lib/sidebar-shell-layout.ts`, plus the
`visibility.notes` condition and its type. Everything else is client-side.

Three members it drives are internal to the host, and are reached through
runtime guards rather than assumed:

- `terminal.inputHandler`, wrapped to release focus on a click outside the card
  (the TUI dispatches the press synchronously, so no timer is needed);
- `getFocusedComponent()`, to hand the keyboard back to the chat;
- `ui.pasteToEditor`, when the send target is set to the chat input. It is
  optional by design: when the member is missing or the run is headless, the
  note goes to the chat instead.

Two facts found while adding a typecheck, which may be relevant to this
repository independently of this request:

1. `@earendil-works/pi-tui` exports `EditorTheme`, `MarkdownTheme`,
   `SelectListTheme`, … but no general `Theme` type.
2. `@earendil-works/pi-coding-agent` (1.3.0) declares
   `"types": "./dist/index.d.ts"` and ships only `dist/index.d.ts.map`.

Both imports are type-only in a normal extension, so they are erased at runtime
and nothing fails — which is exactly why nothing gets checked. The extension
names the shape it needs in one local module and typechecks against it.

### How it was validated

- Deterministic suite: `npm run check` → `tsc --noEmit` clean (73 errors found
  and fixed when the compiler was first added) and **213 tests / 38 suites**
  green. Byte-parity goldens pin the card against gentle-shell's own card
  rendering; a shrinking-width test pins the rail's "every line fits"
  contract, whose violation silently disables the whole rail layout.
- Real terminal, not only unit tests: pty repros at 180, 120 and 80 columns
  (rail visible with its own scroll indicator; compact row visible and the rail
  suppressed below the breakpoint), and a click on the send glyph verified
  against the on-disk store.
- Storage rules under test: owner-only permissions (`0700`/`0600`, the same
  pair as `lib/agents-runner.ts`), an unreadable store moved aside as
  `*.corrupt-<timestamp>` instead of being overwritten, one broken watcher
  subscriber isolated from the others, and note text stripped of C0/C1 controls
  and bidi overrides before it is stored (zero-width joiners are kept, because
  emoji and complex scripts need them).

### Open questions for the maintainer

- **Shape.** This lives in 7 small modules; `gentle-todo.ts` is a single 18K
  file. Fold it into one file, or accept a directory?
- **Ownership.** Should the card and the store live in gentle-shell (next to the
  Todos), or stay an independent extension that only asks for the rail section?
- **`ui.pasteToEditor`.** If an API for "put this in the composer" is planned,
  this is a consumer for it; if not, the current fallback (send to chat) is
  acceptable but a setting that silently downgrades is worse than one that says
  so.
