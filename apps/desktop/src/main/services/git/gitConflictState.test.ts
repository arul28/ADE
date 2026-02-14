import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectConflictKind, parseNameOnly } from "./gitConflictState";

describe("gitConflictState helpers", () => {
  it("detects merge in progress from MERGE_HEAD", () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-"));
    try {
      fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), "deadbeef", "utf8");
      expect(detectConflictKind(gitDir)).toBe("merge");
    } finally {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it("detects rebase in progress from rebase-apply/rebase-merge", () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-"));
    try {
      fs.mkdirSync(path.join(gitDir, "rebase-apply"));
      expect(detectConflictKind(gitDir)).toBe("rebase");
    } finally {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    const gitDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-"));
    try {
      fs.mkdirSync(path.join(gitDir2, "rebase-merge"));
      expect(detectConflictKind(gitDir2)).toBe("rebase");
    } finally {
      fs.rmSync(gitDir2, { recursive: true, force: true });
    }
  });

  it("parses and sorts unmerged file name output", () => {
    expect(parseNameOnly("b.txt\na.txt\n\nb.txt\n")).toEqual(["a.txt", "b.txt"]);
  });
});

