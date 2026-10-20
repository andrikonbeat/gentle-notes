# AI-assistance disclosure

The contribution policy in `Gentleman-Programming/gentle-ai` requires material
AI assistance to be disclosed in the pull request declaration: the tool or
model, the material scope, and the verification the contributor performed. Raw
prompts and private logs are not required.

This file keeps that statement ready so it is not reconstructed from memory at
issue or PR time, and so every claim below can be checked against the
repository.

---

## Statement

- **Tool and model**: Pi (`@earendil-works/pi-coding-agent`) driven by the
  `gentle-pi` harness, provider `opencode`, model `deepseek-v4.1-flash-free`.
  Verification ran as separate read-only agent instances; two of the passes
  were blind to the repository's history and to the author's notes.
- **Material scope**: the implementation under `src/`, the test suite under
  `tests/`, the documentation (`README.md` and `odd/tasks/gentle-notes.md`), the
  CI workflow with its packaging check, and the text of this proposal.
  Feature requests, scope boundaries, and the product decisions (the glyph set,
  the send destination, the collapse behaviour, the store's placement) came from
  the human contributor; implementation, tests and documentation were drafted
  with the assistant against those decisions.
- **Verification performed**:
  - `npm run check` — `tsc --noEmit` under `strict` and `erasableSyntaxOnly`,
    then the suite: 225 tests across 38 suites. Run locally on Node 22.23.3 and
    26.8.2; Node 24.x runs in CI.
  - `npm run verify:package` — the packed content is checked against the
    required entry points, with development files rejected (13 files).
  - `npm run check:card-parity` — the card chrome is a local replica of the
    shell's renderer, so this check runs the shell's own implementation from an
    upstream checkout and diffs both card styles against the replica. It reports
    byte equality today, and it was proved to detect drift by mutating a border
    on purpose.
  - CI — Node 22 and 24 on Linux and macOS, plus a job that installs the packed
    tarball into a scratch project and asserts the extension entry points are
    present and the tests are not.
  - Store-corruption paths reproduced with a negative control each: invalid
    UTF-8, valid JSON with an invalid shape, an empty file, truncated JSON,
    `null`, a store that exists but cannot be read (EACCES), and a forced rename
    failure (EISDIR) — plus, added after review, a store whose note ids collide
    and two preserves landing in the same millisecond. An unreadable store is
    preserved, never overwritten.
  - Two independent read-only verification passes over the diff. The first
    found one real gap — every `readFileSync` failure was treated as "no store
    yet", so an unreadable store would be overwritten — fixed with a failing
    test first. The second was run against those fixes and refuted two of them:
    a write that had landed could be reported as refused when a later UI call
    threw, which saved the same note twice; and a note carrying a double-width
    character pushed its own click target off the row. Both were fixed with a
    failing test first, along with three further defects the same pass found.
  - A blind external review of the published repository, which returned "not
    presentable" with three blockers and a list of bugs. Every blocker and bug
    it named is recorded in `odd/tasks/gentle-notes.md` and was fixed before the
    repository was announced anywhere.
- **Attribution**: no AI tool receives human attribution. `git log` in this
  repository contains zero `Co-Authored-By`, `Reviewed-by` or `Signed-off-by`
  trailers, as the policy requires.

## What the human contributor can defend in review

The store invariants (atomic write through a temporary file and rename, a store
that cannot be read is preserved instead of replaced, directory mode `0700` and
file mode `0600`), the sidebar grammar that matches the existing `Todos` card,
and the test strategy — one test per requested rule plus one per existing
behaviour the change touches.
