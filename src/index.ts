// Gentle Notes — extension entry point. Pi loads this directory as an
// extension: `pi --extension ./src` (or drop it in ~/.pi/agent/extensions/).
export { default, parseNotesArgs, type NotesArgs } from "./extension.ts";
