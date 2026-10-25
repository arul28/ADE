import fs from "node:fs";
import path from "node:path";
import type { GitConflictState } from "../../../shared/types";
import { parseDiffNameOnly } from "../shared/utils";

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

/** Sorted, distinct paths from `git diff --name-only -z`. */
export function parseNameOnly(stdout: string): string[] {
  return Array.from(new Set(parseDiffNameOnly(stdout))).sort((a, b) => a.localeCompare(b));
}

