import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRunConfig } from "../../../shared/types";

const mockGit = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
  runGitOrThrow: (...args: unknown[]) => mockGit.runGitOrThrow(...args),
}));

import { createReviewTargetMaterializer } from "./reviewTargetMaterializer";

function makeConfig(overrides: Partial<ReviewRunConfig> = {}): ReviewRunConfig {
  return {
    compareAgainst: { kind: "default_branch" },
    selectionMode: "full_diff",
    dirtyOnly: false,
    modelId: "openai/gpt-5.4-codex",
    reasoningEffort: "medium",
    budgets: {
      maxFiles: 60,
      maxDiffChars: 180_000,
      maxPromptChars: 220_000,
      maxFindings: 12,
    },
    publishBehavior: "local_only",
    ...overrides,
  };
}

describe("reviewTargetMaterializer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("materializes lane vs default branch full diff", async () => {
    const laneService = {
      getLaneBaseAndBranch: vi.fn().mockImplementation((laneId: string) => ({
        baseRef: "main",
        branchRef: laneId === "lane-review" ? "feature/review-tab" : "bugfix/review-engine",
        worktreePath: "/tmp/lane-review",
        laneType: "worktree",
      })),
      list: vi.fn(),
    } as any;
    mockGit.runGitOrThrow
      .mockResolvedValueOnce("merge-base-sha\n")
      .mockResolvedValueOnce("diff --git a/src/review.ts b/src/review.ts\n@@ -10,2 +10,3 @@\n line\n+new line\n")
      .mockResolvedValueOnce("M\tsrc/review.ts\n");

    const materializer = createReviewTargetMaterializer({ laneService });
    const result = await materializer.materialize({
      target: { mode: "lane_diff", laneId: "lane-review" },
      config: makeConfig(),
    });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["merge-base", "main", "feature/review-tab"],
      expect.objectContaining({ cwd: "/tmp/lane-review" }),
    );
    expect(result.targetLabel).toBe("feature/review-tab vs main");
    expect(result.compareTarget).toEqual({
      kind: "default_branch",
      label: "main",
      ref: "main",
      laneId: null,
      branchRef: "main",
    });
    expect(result.changedFiles[0]?.filePath).toBe("src/review.ts");
  });

  it("materializes lane vs another lane", async () => {
    const laneService = {
      getLaneBaseAndBranch: vi.fn().mockImplementation((laneId: string) => ({
        baseRef: "main",
        branchRef: laneId === "lane-review" ? "feature/review-tab" : "bugfix/review-engine",
        worktreePath: "/tmp/lane-review",
        laneType: "worktree",
      })),
      list: vi.fn(),
    } as any;
    mockGit.runGitOrThrow
      .mockResolvedValueOnce("merge-base-sha\n")
      .mockResolvedValueOnce("diff --git a/src/engine.ts b/src/engine.ts\n@@ -20,2 +20,3 @@\n line\n+new line\n")
      .mockResolvedValueOnce("M\tsrc/engine.ts\n");

    const materializer = createReviewTargetMaterializer({ laneService });
    const result = await materializer.materialize({
      target: { mode: "lane_diff", laneId: "lane-review" },
      config: makeConfig({
        compareAgainst: { kind: "lane", laneId: "lane-bugfix" },
      }),
    });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["merge-base", "bugfix/review-engine", "feature/review-tab"],
      expect.objectContaining({ cwd: "/tmp/lane-review" }),
    );
    expect(result.compareTarget).toEqual({
      kind: "lane",
      label: "bugfix/review-engine",
      ref: "bugfix/review-engine",
      laneId: "lane-bugfix",
      branchRef: "bugfix/review-engine",
    });
  });

  it("materializes a selected commit range", async () => {
    const laneService = {
      getLaneBaseAndBranch: vi.fn().mockReturnValue({
        baseRef: "main",
        branchRef: "feature/review-tab",
        worktreePath: "/tmp/lane-review",
        laneType: "worktree",
      }),
      list: vi.fn(),
    } as any;
    mockGit.runGitOrThrow
      .mockResolvedValueOnce("diff --git a/src/commit.ts b/src/commit.ts\n@@ -1,1 +1,2 @@\n+change\n")
      .mockResolvedValueOnce("M\tsrc/commit.ts\n");

    const materializer = createReviewTargetMaterializer({ laneService });
    const result = await materializer.materialize({
      target: {
        mode: "commit_range",
        laneId: "lane-review",
        baseCommit: "abc123456789",
        headCommit: "def456789012",
      },
      config: makeConfig({
        selectionMode: "selected_commits",
      }),
    });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["diff", "--no-color", "--find-renames", "abc123456789..def456789012"],
      expect.objectContaining({ cwd: "/tmp/lane-review" }),
    );
    expect(result.targetLabel).toContain("abc1234..def4567");
  });

  it("materializes staged, unstaged, and untracked working tree changes", async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-review-working-tree-"));
    fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "src", "new-file.ts"), "export const untracked = true;\n", "utf8");

    const laneService = {
      getLaneBaseAndBranch: vi.fn().mockReturnValue({
        baseRef: "main",
        branchRef: "feature/review-tab",
        worktreePath,
        laneType: "worktree",
      }),
      list: vi.fn(),
    } as any;
    mockGit.runGit
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "diff --git a/src/staged.ts b/src/staged.ts\n@@ -1,1 +1,2 @@\n+staged change\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "diff --git a/src/unstaged.ts b/src/unstaged.ts\n@@ -1,1 +1,2 @@\n+unstaged change\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "M  src/staged.ts\n M src/unstaged.ts\n?? src/new-file.ts\n",
        stderr: "",
      });

    const materializer = createReviewTargetMaterializer({ laneService });
    const result = await materializer.materialize({
      target: { mode: "working_tree", laneId: "lane-review" },
      config: makeConfig({
        selectionMode: "dirty_only",
        dirtyOnly: true,
      }),
    });

    expect(result.fullPatchText).toContain("## Staged changes");
    expect(result.fullPatchText).toContain("## Unstaged changes");
    expect(result.fullPatchText).toContain("## Untracked files");
    expect(result.artifacts.some((artifact) => artifact.artifactType === "untracked_snapshot")).toBe(true);
    expect(result.changedFiles.some((file) => file.filePath === "src/new-file.ts")).toBe(true);
  });
});
