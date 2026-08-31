/**
 * The ADE home is always a fresh temp directory — for the demo app as much as
 * for the tests. The developer's real `~/.ade`, its socket and its database are
 * never opened.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway ADE home under the OS temp dir. Never `~/.ade`: the guard below
 * is a hard stop, because a mistake here writes into the developer's live brain.
 */
export function makeIsolatedHome(label = "demo") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ade-${label}-`));
  const real = fs.realpathSync(home);
  const forbidden = path.join(os.homedir(), ".ade");
  if (real === forbidden || real.startsWith(`${forbidden}${path.sep}`)) {
    throw new Error(`refusing to use ${real} as an isolated home`);
  }
  return real;
}
