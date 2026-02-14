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

export function parseNameOnly(stdout: string): string[] {
  return Array.from(
    new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

