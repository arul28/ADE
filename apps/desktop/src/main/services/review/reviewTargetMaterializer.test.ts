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
    try {
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
      mockGit.runGitOrThrow
        .mockResolvedValueOnce("diff --git a/src/staged.ts b/src/staged.ts\n@@ -1,1 +1,2 @@\n+staged change\n")
        .mockResolvedValueOnce("diff --git a/src/unstaged.ts b/src/unstaged.ts\n@@ -1,1 +1,2 @@\n+unstaged change\n")
        .mockResolvedValueOnce("M  src/staged.ts\n M src/unstaged.ts\n?? src/new-file.ts\n");

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
      expect(result.changedFiles).toContainEqual(expect.objectContaining({
        filePath: "src/new-file.ts",
        lineNumbers: [1],
      }));
      expect(result.changedFiles.find((file) => file.filePath === "src/new-file.ts")?.excerpt).toContain("new file mode 100644");
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("materializes a PR target and prepares GitHub publication metadata", async () => {
    const laneService = {
      getLaneBaseAndBranch: vi.fn().mockReturnValue({
        baseRef: "main",
        branchRef: "feature/pr-80",
        worktreePath: "/tmp/lane-review",
        laneType: "worktree",
      }),
      list: vi.fn(),
    } as any;
    const prService = {
      getReviewSnapshot: vi.fn(async () => ({
        id: "pr-80",
        laneId: "lane-review",
        projectId: "project-1",
        repoOwner: "ade-dev",
        repoName: "ade",
        githubPrNumber: 80,
        githubUrl: "https://github.com/ade-dev/ade/pull/80",
        githubNodeId: "PR_kwDOExample",
        title: "Review publication",
        state: "open",
        baseBranch: "main",
        headBranch: "feature/pr-80",
        checksStatus: "passing",
        reviewStatus: "commented",
        additions: 2,
        deletions: 0,
        lastSyncedAt: "2026-04-06T10:00:00.000Z",
        createdAt: "2026-04-06T09:55:00.000Z",
        updatedAt: "2026-04-06T10:00:00.000Z",
        baseSha: "abc123456789",
        headSha: "def456789012",
        files: [
          {
            filename: "src/review.ts",
            status: "modified",
            additions: 2,
            deletions: 0,
            patch: "@@ -10,1 +10,3 @@\n context\n+anchored\n+summary only\n",
            previousFilename: null,
          },
        ],
      })),
    } as any;
    mockGit.runGitOrThrow.mockResolvedValueOnce(
      "diff --git a/src/review.ts b/src/review.ts\n@@ -10,1 +10,3 @@\n context\n+anchored\n+summary only\n",
    );

    const materializer = createReviewTargetMaterializer({ laneService, prService });
    const result = await materializer.materialize({
      target: { mode: "pr", laneId: "lane-review", prId: "pr-80" },
      config: makeConfig({ publishBehavior: "auto_publish" }),
    });

    expect(prService.getReviewSnapshot).toHaveBeenCalledWith("pr-80");
    expect(result.targetLabel).toBe("PR #80 feature/pr-80 -> main");
    expect(result.publicationTarget).toEqual({
      kind: "github_pr_review",
      prId: "pr-80",
      repoOwner: "ade-dev",
      repoName: "ade",
      prNumber: 80,
      githubUrl: "https://github.com/ade-dev/ade/pull/80",
    });
    expect(result.changedFiles[0]?.diffPositionsByLine).toEqual({ 10: 1, 11: 2, 12: 3 });
  });
});
