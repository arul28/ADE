/**
 * "Does this path exist, and is it the kind of thing I expect?"
 *
 * One copy, because `binary.ts` and `bundledRuntime.ts` both ask it on every
 * resolution and had grown a byte-identical pair each. Missing, unreadable and
 * wrong-kind are all simply "no": a resolution step that cannot see a candidate
 * falls through to the next one rather than throwing at a caller who has other
 * routes left to try.
 */

import fs from "node:fs";

export function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
