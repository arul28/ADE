import { describe, expect, it } from "vitest";

import {
  classifyMissingLaneBranchDriftKind,
  detectLaneBranchDrift,
  parseWorktreeStatusPorcelainV2,
} from "./laneBranchDrift";

describe("parseWorktreeStatusPorcelainV2", () => {
  it("reads the live HEAD branch, its commit and its upstream lag from the header and reports a clean tree", () => {
    const oid = "0d1f9a3c0d1f9a3c0d1f9a3c0d1f9a3c0d1f9a3c";
    const stdout = [
      `# branch.oid ${oid}`,
      "# branch.head hotfix-auth",
      "# branch.upstream origin/hotfix-auth",
      "# branch.ab +2 -3",
      "",
    ].join("\n");

    expect(parseWorktreeStatusPorcelainV2(stdout)).toEqual({
      dirty: false,
      changedFileCount: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      headBranchRef: "hotfix-auth",
      upstreamBehind: 3,
      headOid: oid,
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
      // An abbreviated oid is not a commit id, and no upstream means no lag.
      upstreamBehind: null,
      headOid: null,
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
      upstreamBehind: null,
      headOid: null,
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
      upstreamBehind: null,
      headOid: null,
    });
    expect(parseWorktreeStatusPorcelainV2("? untracked.txt\n")).toEqual({
      dirty: true,
      changedFileCount: 1,
      staged: 0,
      unstaged: 0,
      untracked: 1,
      headBranchRef: null,
      upstreamBehind: null,
      headOid: null,
    });
    expect(parseWorktreeStatusPorcelainV2("")).toEqual({
      dirty: false,
      changedFileCount: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      headBranchRef: null,
      upstreamBehind: null,
      headOid: null,
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

  it("carries a renamed/missing kind and leaves switched implicit for older readers", () => {
    expect(
      detectLaneBranchDrift({ expectedBranchRef: "ade/old", headBranchRef: "ade/new", kind: "renamed" }),
    ).toEqual({ expectedBranchRef: "ade/old", headBranchRef: "ade/new", kind: "renamed" });
    expect(
      detectLaneBranchDrift({ expectedBranchRef: "ade/old", headBranchRef: "ade/new", kind: "missing" }),
    ).toEqual({ expectedBranchRef: "ade/old", headBranchRef: "ade/new", kind: "missing" });
    expect(
      detectLaneBranchDrift({ expectedBranchRef: "ade/old", headBranchRef: "ade/new", kind: "switched" }),
    ).toEqual({ expectedBranchRef: "ade/old", headBranchRef: "ade/new" });
  });
});

describe("classifyMissingLaneBranchDriftKind", () => {
  it.each([
    {
      label: "a rename git recorded against a now-gone ref",
      subjects: ["Branch: renamed refs/heads/ade/old to refs/heads/ade/new"],
      expected: "renamed",
    },
    {
      label: "the same rename seen with a Windows CRLF terminator",
      subjects: ["Branch: renamed refs/heads/ade/old to refs/heads/ade/new\r"],
      expected: "renamed",
    },
    {
      label: "a chained rename via an intermediate name with HEAD on the survivor",
      subjects: [
        "Branch: renamed refs/heads/ade/mid to refs/heads/ade/new",
        "Branch: renamed refs/heads/ade/old to refs/heads/ade/mid",
      ],
      expected: "renamed",
    },
    {
      label: "a gone ref whose reflog holds only unrelated history",
      subjects: ["checkout: moving from ade/other to ade/new", "commit: fix the thing"],
      expected: "missing",
    },
    {
      label: "an unreadable reflog that yielded no subjects",
      subjects: [],
      expected: "missing",
    },
    {
      label: "a rename cycle that never touches the recorded branch",
      subjects: [
        "Branch: renamed refs/heads/ade/p to refs/heads/ade/q",
        "Branch: renamed refs/heads/ade/q to refs/heads/ade/p",
      ],
      expected: "missing",
    },
    {
      label: "a rename to an unrelated third branch",
      subjects: ["Branch: renamed refs/heads/ade/old to refs/heads/ade/something-else"],
      expected: "missing",
    },
  ])("reads $label as $expected", ({ subjects, expected }) => {
    expect(
      classifyMissingLaneBranchDriftKind({
        expectedBranchRef: "ade/old",
        headBranchRef: "ade/new",
        reflogSubjects: subjects,
      }),
    ).toBe(expected);
  });

  it("answers missing, never renamed, when either branch is unknown or unchanged", () => {
    const rename = ["Branch: renamed refs/heads/ade/old to refs/heads/ade/new"];
    expect(
      classifyMissingLaneBranchDriftKind({
        expectedBranchRef: "ade/new",
        headBranchRef: "ade/new",
        reflogSubjects: rename,
      }),
    ).toBe("missing");
    expect(
      classifyMissingLaneBranchDriftKind({
        expectedBranchRef: null,
        headBranchRef: "ade/new",
        reflogSubjects: rename,
      }),
    ).toBe("missing");
    expect(
      classifyMissingLaneBranchDriftKind({
        expectedBranchRef: "ade/old",
        headBranchRef: null,
        reflogSubjects: rename,
      }),
    ).toBe("missing");
  });
});
