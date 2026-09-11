import { describe, expect, it } from "vitest";

import {
  detectLaneBranchDrift,
  laneNameAdvertisesBranch,
  parseWorktreeStatusPorcelainV2,
} from "./laneBranchDrift";

describe("parseWorktreeStatusPorcelainV2", () => {
  it("reads the live HEAD branch from the header and reports a clean tree", () => {
    const stdout = [
      "# branch.oid 0d1f9a3c",
      "# branch.head hotfix-auth",
      "# branch.upstream origin/hotfix-auth",
      "# branch.ab +0 -0",
      "",
    ].join("\n");

    expect(parseWorktreeStatusPorcelainV2(stdout)).toEqual({
      dirty: false,
      changedFileCount: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      headBranchRef: "hotfix-auth",
    });
  });

  it("treats any non-header line as dirty", () => {
    const stdout = [
      "# branch.oid 0d1f9a3c",
      "# branch.head ade/feature",
      "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
      "? notes.md",
      "",
    ].join("\n");

    expect(parseWorktreeStatusPorcelainV2(stdout)).toEqual({
      dirty: true,
      changedFileCount: 2,
      staged: 0,
      unstaged: 1,
      untracked: 1,
      headBranchRef: "ade/feature",
    });
  });

  it("reports a detached HEAD as unknown rather than a branch named '(detached)'", () => {
    const stdout = ["# branch.oid 0d1f9a3c", "# branch.head (detached)", ""].join("\n");

    expect(parseWorktreeStatusPorcelainV2(stdout)).toEqual({
      dirty: false,
      changedFileCount: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      headBranchRef: null,
    });
  });

  it("tolerates CRLF output and a missing branch header", () => {
    expect(parseWorktreeStatusPorcelainV2("# branch.head main\r\n")).toEqual({
      dirty: false,
      changedFileCount: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      headBranchRef: "main",
    });
    expect(parseWorktreeStatusPorcelainV2("? untracked.txt\n")).toEqual({
      dirty: true,
      changedFileCount: 1,
      staged: 0,
      unstaged: 0,
      untracked: 1,
      headBranchRef: null,
    });
    expect(parseWorktreeStatusPorcelainV2("")).toEqual({
      dirty: false,
      changedFileCount: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      headBranchRef: null,
    });
  });

  it("splits staged and unstaged changes while counting a file with both once", () => {
    const parsed = parseWorktreeStatusPorcelainV2([
      "1 MM N... 100644 100644 100644 aaa bbb src/both.ts",
      "1 M. N... 100644 100644 100644 aaa bbb src/staged.ts",
      "1 .M N... 100644 100644 100644 aaa bbb src/unstaged.ts",
      "? new.txt",
    ].join("\n"));

    expect(parsed).toMatchObject({
      dirty: true,
      changedFileCount: 4,
      staged: 2,
      unstaged: 2,
      untracked: 1,
    });
  });

  it("keeps newlines inside NUL-delimited filenames", () => {
    const parsed = parseWorktreeStatusPorcelainV2([
      "# branch.head feature/child",
      "1 .M N... 100644 100644 100644 aaa bbb src/with\nnewline.ts",
      "? untracked\npath/",
    ].join("\0") + "\0");

    expect(parsed).toMatchObject({
      dirty: true,
      changedFileCount: 2,
      staged: 0,
      unstaged: 1,
      untracked: 1,
      headBranchRef: "feature/child",
    });
  });

  it("counts a NUL-delimited rename record once and consumes its old path", () => {
    const parsed = parseWorktreeStatusPorcelainV2([
      "# branch.head feature/child",
      "2 R. N... 100644 100644 100644 aaa bbb src/new-name.ts",
      "src/old\nname.ts",
    ].join("\0") + "\0");

    expect(parsed).toMatchObject({
      dirty: true,
      changedFileCount: 1,
      staged: 1,
      unstaged: 0,
      untracked: 0,
    });
  });

  it("counts an untracked directory as one entry", () => {
    expect(parseWorktreeStatusPorcelainV2("? generated/\0")).toMatchObject({
      dirty: true,
      changedFileCount: 1,
      staged: 0,
      unstaged: 0,
      untracked: 1,
    });
  });

  it("keeps slashes in branch names and does not treat them as path separators", () => {
    const parsed = parseWorktreeStatusPorcelainV2("# branch.head ade/start-skill/read-tweet\n");
    expect(parsed.headBranchRef).toBe("ade/start-skill/read-tweet");
  });
});

describe("detectLaneBranchDrift", () => {
  it("returns null when HEAD matches the recorded branch", () => {
    expect(
      detectLaneBranchDrift({ expectedBranchRef: "ade/feature", headBranchRef: "ade/feature" }),
    ).toBeNull();
  });

  it("reports drift when HEAD is on a different branch", () => {
    expect(
      detectLaneBranchDrift({ expectedBranchRef: "ade/feature", headBranchRef: "hotfix-auth" }),
    ).toEqual({ expectedBranchRef: "ade/feature", headBranchRef: "hotfix-auth" });
  });

  it("normalizes refs/heads/ and origin/ prefixes on both sides before comparing", () => {
    expect(
      detectLaneBranchDrift({
        expectedBranchRef: "refs/heads/ade/feature",
        headBranchRef: "ade/feature",
      }),
    ).toBeNull();
    expect(
      detectLaneBranchDrift({ expectedBranchRef: "ade/feature", headBranchRef: "origin/ade/feature" }),
    ).toBeNull();
  });

  it("compares case-sensitively — git branch names are case-sensitive refs", () => {
    expect(
      detectLaneBranchDrift({ expectedBranchRef: "Feature", headBranchRef: "feature" }),
    ).toEqual({ expectedBranchRef: "Feature", headBranchRef: "feature" });
  });

  it("returns null when either side is unknown (detached HEAD, unavailable worktree)", () => {
    expect(detectLaneBranchDrift({ expectedBranchRef: "ade/feature", headBranchRef: null })).toBeNull();
    expect(detectLaneBranchDrift({ expectedBranchRef: "ade/feature", headBranchRef: "  " })).toBeNull();
    expect(detectLaneBranchDrift({ expectedBranchRef: null, headBranchRef: "hotfix-auth" })).toBeNull();
    expect(detectLaneBranchDrift({ expectedBranchRef: undefined, headBranchRef: undefined })).toBeNull();
  });
});

describe("laneNameAdvertisesBranch", () => {
  it("matches the full ref and its last segment", () => {
    expect(laneNameAdvertisesBranch("ade/fix-auth", "ade/fix-auth")).toBe(true);
    expect(laneNameAdvertisesBranch("fix-auth", "ade/fix-auth")).toBe(true);
    expect(laneNameAdvertisesBranch("Fix-Auth", "ade/fix-auth")).toBe(true);
  });

  it("leaves hand-written lane names alone", () => {
    expect(laneNameAdvertisesBranch("Auth work", "ade/fix-auth")).toBe(false);
    expect(laneNameAdvertisesBranch("", "ade/fix-auth")).toBe(false);
    expect(laneNameAdvertisesBranch("ade/fix-auth", "")).toBe(false);
  });
});
