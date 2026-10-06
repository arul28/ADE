import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * `fs` without Electron's asar patch, for deleting user folders.
 *
 * ADE's brain and main process run inside Electron, whose `fs` reads every
 * `.asar` file as a folder. A lane worktree of an Electron app holds
 * `node_modules/electron/dist/resources/default_app.asar`, and a recursive
 * `fs.promises.rm` of that worktree tries to `rmdir` the archive and fails with
 * EBUSY on every attempt — the delete stops partway and leaves the folder
 * half-removed. Electron's `original-fs` is the unpatched module. Outside
 * Electron (tests, a plain Node CLI) this is plain `fs`.
 */
export const nonAsarFs: typeof fs = (() => {
  if (!process.versions.electron) return fs;
  try {
    // A builtin, so any require resolves it; a runtime require keeps bundlers
    // from trying to resolve a module that only exists inside Electron.
    const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
    return require("original-fs") as typeof fs;
  } catch {
    return fs;
  }
})();
