# The `notes` rail patch

`notes-rail.patch` is the one upstream change this extension needs: gentle-shell
has to know that a `notes` section exists in its sidebar, or the rail card is
registered but never painted.

## What it changes

Three files, 18 added lines:

- `lib/shell-sidebar-layout.ts` — adds `notes` to the rail's section list, after
  `todo`, and hides it when `visibility.notes === false` (the same rule
  `visibility.todo` already follows).
- `lib/shell-sidebar.ts` — adds `notes?: boolean` to the sidebar state's
  `visibility` type.
- `tests/shell-sidebar-layout.test.ts` — one new test: the notes section paints
  after the TODO and disappears through `visibility.notes`.

Nothing else: the extension registers its part through the shared
`Symbol.for` state, so no other host change is needed.

## How to apply it

From a gentle-shell checkout, on the base branch the patch was generated
against:

```bash
git apply /path/to/gentle-notes/proposal/rail-patch/notes-rail.patch
```

`git apply --check` verifies it applies before touching the tree. A rejected
hunk means the base moved: the change is small enough to redo by hand — the
section array in `lib/shell-sidebar-layout.ts` and the `visibility` type in
`lib/shell-sidebar.ts`.

## Where it came from

Generated from a local shallow clone of `Gentleman-Programming/gentle-shell`:

- branch: `notes-rail-section`
- commit: `b2d428b` (`feat(sidebar): add notes rail section for extensions`)

It is a plain `git diff` of that branch against `main`, with no commit metadata
and no author information — only the change itself.

## Status: stopgap

This patch is a stopgap until the section lands upstream. The permanent path is
the feature request in `proposal/feature-request.md`: it goes in as an issue
first, waits for `status:approved`, and only then becomes a pull request
against gentle-shell. Until that happens, keep applying this file by hand.
