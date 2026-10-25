import fs from "node:fs";
import path from "node:path";
import type { GitConflictState } from "../../../shared/types";

export function detectConflictKind(gitDir: string): GitConflictState["kind"] {
  try {
    if (fs.existsSync(path.join(gitDir, "rebase-apply")) || fs.existsSync(path.join(gitDir, "rebase-merge"))) {
      return "rebase";
    }
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
      return "merge";
    }
  } catch {
    // ignore
  }
  return null;
}
