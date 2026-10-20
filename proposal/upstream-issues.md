# Two upstream issues worth filing (drafts)

Both were found while making this extension typecheck against the published
packages (`@earendil-works/pi-tui@1.3.0`,
`@earendil-works/pi-coding-agent@1.3.0`). They are independent of the notes
feature and belong to two different repositories, so they are two issues.

Neither was filed: filing needs the maintainer's repository and credentials.

---

## 1 · pi-tui: export the general `Theme` type

**Title**: `TypeScript: no general Theme type is exported, so widgets cannot type their theme`

**Body**:

`pi-tui` types every theme per component — `EditorTheme`, `MarkdownTheme`,
`SelectListTheme`, and so on — but the type those component themes are built
from is not exported. A component that receives a theme (which is how extension
widgets are written) has nothing to annotate the parameter with.

### Impact

Every extension author types the theme as `any`, or invents a local structural
interface and hopes it stays compatible. The compiler cannot help anyone here,
and a silent drift in the theme surface is invisible.

### Reproduction

```bash
printf 'import type { Theme } from "@earendil-works/pi-tui";\n' > /tmp/theme-probe.ts
npx tsc --noEmit /tmp/theme-probe.ts
# error TS2305: Module '"@earendil-works/pi-tui"' has no exported member 'Theme'.
```

Evidence from the published package:

```bash
grep -c 'Theme' node_modules/@earendil-works/pi-tui/dist/index.d.ts   # 5
grep -oE 'type Theme[ ,}]' node_modules/@earendil-works/pi-tui/dist/index.d.ts
# no match: the five hits are component-scoped names
```

### Proposal

Export the interface the component themes already extend, as `Theme` or
`ThemeLike`. No runtime change, no API break: it is a name for a shape that is
already public through `EditorTheme` and friends.

### Workaround today

A local structural interface covering only the members the widget calls
(`getFgAnsi`, `getMdFgAnsi`, ...). It works, but it is a copy of upstream
private knowledge that can drift without a warning.

---

## 2 · pi-coding-agent: the package declares types and ships none

**Title**: `Published package declares "types": "./dist/index.d.ts" but ships no declaration files`

**Body**:

`package.json` points TypeScript at `./dist/index.d.ts`. The published `dist/`
contains **zero** `.d.ts` files, so that path does not exist.

### Impact

This is the bigger of the two, because it fails silently by construction:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

- With `noImplicitAny` (or `strict`), TypeScript resolves the module and reports
  TS7016 ("could not find a declaration file"), so an author who *does* run a
  typecheck gets an error they cannot fix from their side.
- Because the import is `type`-only, it is erased at build time. Nothing fails at
  runtime, so an author without a typecheck never learns that none of the
  extension API is typed.

The practical consequence is that the extension API is untyped by default, which
is exactly the surface where a silent mistake costs the most.

### Reproduction

```bash
npm pack @earendil-works/pi-coding-agent@1.3.0 --dry-run --json \
  | grep -c 'index\.d\.ts'          # 0
ls node_modules/@earendil-works/pi-coding-agent/dist/ | grep -c '\.d\.ts$'   # 0
node -p "require('@earendil-works/pi-coding-agent/package.json').types"
# ./dist/index.d.ts  (declared, not shipped)
```

### Proposal

Emit declarations in the build (or, minimally, publish `dist/index.d.ts` for the
public entry) and keep `files` including `dist`. If declarations are not ready to
be published, dropping the `types` field is still better than pointing at a
missing file: consumers would get one honest TS7016 instead of an unresolved
path, and the gap would be visible in the package manifest.

---

## Side note for the CI (not an issue against the packages)

`npm pack --dry-run --json` changed shape in **npm 12**: it returns an object
keyed by package name (`{"<name>": {files: [{path, ...}]}}`) instead of an array.
A `verify-package-files` script that reads `JSON.parse(out)[0].files` silently
sees zero files and reports every required entry as missing. The current CI runs
Node 24 (npm 11), so it is unaffected today; it will bite on the first Node 26
bump.
