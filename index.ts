/**
 * Entry point for Pi's extension loader.
 *
 * Pi loads a direct `.ts` file (`pi --extension ./src/extension.ts`) or a
 * directory that contains an `index.ts` / `index.js` entry. This file is what
 * makes the whole repository installable as a directory: copy or symlink the
 * repository into `<agent-dir>/extensions/gentle-notes/` (or `.pi/extensions/`
 * inside a project) and Pi finds it here, with the implementation living in
 * `src/` as a set of small, separately tested modules.
 *
 * No build step: Pi uses jiti and Node strips the types, so the same files run
 * in the terminal and in `node --test`.
 */
export { default } from "./src/extension.ts";
