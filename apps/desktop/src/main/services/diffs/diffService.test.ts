import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createDiffService } from "./diffService";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createLaneServiceStub(rootPath: string) {
  return {
    getLaneBaseAndBranch: () => ({
      worktreePath: rootPath,
    }),
  } as any;
}

function initRepo(prefix: string): string {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(rootPath, ["init"]);
  git(rootPath, ["config", "user.email", "ade@example.com"]);
  git(rootPath, ["config", "user.name", "ADE"]);
  git(rootPath, ["branch", "-M", "main"]);
  fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\n", "utf8");
  fs.writeFileSync(path.join(rootPath, "beta.txt"), "beta\n", "utf8");
  git(rootPath, ["add", "."]);
  git(rootPath, ["commit", "-m", "base"]);
  return rootPath;
}

function branchLane(rootPath: string, baseRef: string, branchRef: string) {
  return createDiffService({
    laneService: { getLaneBaseAndBranch: () => ({ baseRef, branchRef, worktreePath: rootPath }), list: vi.fn() } as any,
  });
}

describe("diffService branch scope", () => {
  it("lists commits, uncommitted edits and untracked files since the base, and leaves the index alone", async () => {
    const rootPath = initRepo("ade-diff-branch-");
    try {
      git(rootPath, ["checkout", "-b", "feature"]);
      fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\ntwo\n", "utf8");
      git(rootPath, ["commit", "-am", "committed edit"]);
      fs.writeFileSync(path.join(rootPath, "beta.txt"), "beta changed\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "staged.txt"), "staged\n", "utf8");
      git(rootPath, ["add", "staged.txt"]);
      fs.writeFileSync(path.join(rootPath, "untracked.txt"), "new\n", "utf8");
      fs.writeFileSync(path.join(rootPath, ".gitignore"), "ignored.log\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "ignored.log"), "noise\n", "utf8");
      const indexBefore = git(rootPath, ["diff", "--cached", "--name-status"]);

      const changes = await branchLane(rootPath, "main", "feature").getBranchChanges("lane-1");

      expect(changes.baseRef).toBe("main");
      expect(changes.files.map((file) => [file.path, file.kind]).sort()).toEqual([
        [".gitignore", "added"],
        ["alpha.txt", "modified"],
        ["beta.txt", "modified"],
        ["staged.txt", "added"],
        ["untracked.txt", "added"],
      ]);
      expect(git(rootPath, ["diff", "--cached", "--name-status"])).toBe(indexBefore);

      const patch = await branchLane(rootPath, "main", "feature").getFilePatch({ laneId: "lane-1", filePath: "untracked.txt", mode: "branch" });
      expect(patch.patch).toContain("new file mode");
      const diff = await branchLane(rootPath, "main", "feature").getFileDiff({ laneId: "lane-1", filePath: "alpha.txt", mode: "branch" });
      expect(diff.original.text).toBe("one\n");
      expect(diff.modified.text).toBe("one\ntwo\n");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("compares a branch that is its own base with its remote copy, so unpushed work shows", async () => {
    const rootPath = initRepo("ade-diff-branch-primary-");
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-branch-remote-"));
    try {
      git(remote, ["init", "--bare"]);
      git(rootPath, ["remote", "add", "origin", remote]);
      git(rootPath, ["push", "-u", "origin", "main"]);
      fs.writeFileSync(path.join(rootPath, "unpushed.txt"), "local\n", "utf8");
      git(rootPath, ["add", "."]);
      git(rootPath, ["commit", "-m", "not pushed"]);

      const changes = await branchLane(rootPath, "main", "main").getBranchChanges("primary");

      expect(changes.baseRef).toBe("origin/main");
      expect(changes.files.map((file) => file.path)).toEqual(["unpushed.txt"]);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "a base that does not exist", baseRef: "no-such-branch", branchRef: "feature", error: /base branch "no-such-branch" was not found/ },
    { name: "a branch that is its own base with no remote copy", baseRef: "main", branchRef: "main", error: /has no remote copy/ },
  ])("reports $name as an error, not an empty diff", async ({ baseRef, branchRef, error }) => {
    const rootPath = initRepo("ade-diff-branch-error-");
    try {
      await expect(branchLane(rootPath, baseRef, branchRef).getBranchChanges("lane-1")).rejects.toThrow(error);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

describe("diffService", () => {
  it("returns lane line stats against the lane base ref", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-line-stats-"));
    const service = createDiffService({
      laneService: {
        getLaneBaseAndBranch: () => ({
          baseRef: "main",
          worktreePath: rootPath,
        }),
        list: vi.fn(),
      } as any,
    });

    try {
      git(rootPath, ["init"]);
      git(rootPath, ["config", "user.email", "ade@example.com"]);
      git(rootPath, ["config", "user.name", "ADE"]);
      git(rootPath, ["branch", "-M", "main"]);
      fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\ntwo\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "beta.txt"), "same\n", "utf8");
      git(rootPath, ["add", "."]);
      git(rootPath, ["commit", "-m", "base"]);

      git(rootPath, ["checkout", "-b", "feature"]);
      fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\ntwo\nthree\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "beta.txt"), "changed\n", "utf8");
      git(rootPath, ["add", "."]);
      git(rootPath, ["commit", "-m", "feature"]);

      await expect(service.getLaneDiffStats("lane-1")).resolves.toEqual({
        additions: 2,
        deletions: 1,
        files: 2,
      });
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects missing lane id for line stats with a clear error", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-line-stats-missing-id-"));
    const service = createDiffService({
      laneService: {
        getLaneBaseAndBranch: vi.fn(),
        list: vi.fn(),
      } as any,
    });

    try {
      await expect(service.getLaneDiffStats(undefined)).rejects.toThrow("laneId is required");
      await expect(service.getLaneDiffStats({ laneId: "  " })).rejects.toThrow("laneId is required");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("lists line stats only from non-archived lanes returned by the lane service", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-line-stats-list-"));
    const list = vi.fn(async () => [
      { id: "lane-1" },
    ]);
    const service = createDiffService({
      laneService: {
        getLaneBaseAndBranch: () => ({
          baseRef: "main",
          worktreePath: rootPath,
        }),
        list,
      } as any,
    });

    try {
      git(rootPath, ["init"]);
      git(rootPath, ["config", "user.email", "ade@example.com"]);
      git(rootPath, ["config", "user.name", "ADE"]);
      git(rootPath, ["branch", "-M", "main"]);
      fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\n", "utf8");
      git(rootPath, ["add", "."]);
      git(rootPath, ["commit", "-m", "base"]);
      git(rootPath, ["checkout", "-b", "feature"]);
      fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\ntwo\n", "utf8");
      git(rootPath, ["add", "."]);
      git(rootPath, ["commit", "-m", "feature"]);

      const stats = await service.listLaneDiffStats();

      expect(list).toHaveBeenCalledWith({ includeArchived: false });
      expect(stats).toEqual({
        "lane-1": { additions: 1, deletions: 0, files: 1 },
      });
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("returns change stats and rename metadata for staged and unstaged files", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-status-"));
    const service = createDiffService({ laneService: createLaneServiceStub(rootPath) });

    try {
      git(rootPath, ["init"]);
      git(rootPath, ["config", "user.email", "ade@example.com"]);
      git(rootPath, ["config", "user.name", "ADE"]);
      fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "rename-me.txt"), "old\n", "utf8");
      git(rootPath, ["add", "."]);
      git(rootPath, ["commit", "-m", "base"]);

      git(rootPath, ["mv", "rename-me.txt", "renamed.txt"]);
      fs.writeFileSync(path.join(rootPath, "alpha.txt"), "one\ntwo\n", "utf8");

      const changes = await service.getChanges("lane-1");

      expect(changes.unstaged.find((change) => change.path === "alpha.txt")).toMatchObject({
        kind: "modified",
        additions: 1,
        deletions: 0,
      });
      expect(changes.staged.find((change) => change.path === "renamed.txt")).toMatchObject({
        kind: "renamed",
        oldPath: "rename-me.txt",
      });
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("preserves numstat for non-ASCII and tabbed paths", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-quoted-paths-"));
    const service = createDiffService({ laneService: createLaneServiceStub(rootPath) });
    const unicodePath = "caf\u00e9.txt";
    const tabbedPath = "tab\tname.txt";

    try {
      git(rootPath, ["init"]);
      git(rootPath, ["config", "user.email", "ade@example.com"]);
      git(rootPath, ["config", "user.name", "ADE"]);
      fs.writeFileSync(path.join(rootPath, unicodePath), "one\n", "utf8");
      fs.writeFileSync(path.join(rootPath, tabbedPath), "one\n", "utf8");
      git(rootPath, ["add", "."]);
      git(rootPath, ["commit", "-m", "base"]);

      fs.writeFileSync(path.join(rootPath, unicodePath), "one\ntwo\n", "utf8");
      fs.writeFileSync(path.join(rootPath, tabbedPath), "one\ntwo\n", "utf8");

      const changes = await service.getChanges("lane-1");

      expect(changes.unstaged.find((change) => change.path === unicodePath)).toMatchObject({
        kind: "modified",
        additions: 1,
        deletions: 0,
      });
      expect(changes.unstaged.find((change) => change.path === tabbedPath)).toMatchObject({
        kind: "modified",
        additions: 1,
        deletions: 0,
      });
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("returns a bounded read-only patch for a selected file", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-patch-"));
    const service = createDiffService({ laneService: createLaneServiceStub(rootPath) });

    try {
      git(rootPath, ["init"]);
      git(rootPath, ["config", "user.email", "ade@example.com"]);
      git(rootPath, ["config", "user.name", "ADE"]);
      fs.writeFileSync(path.join(rootPath, "sample.ts"), "const x = 1;\n", "utf8");
      git(rootPath, ["add", "sample.ts"]);
      git(rootPath, ["commit", "-m", "base"]);
      fs.writeFileSync(path.join(rootPath, "sample.ts"), "const x = 2;\n", "utf8");

      const patch = await service.getFilePatch({
        laneId: "lane-1",
        filePath: "sample.ts",
        mode: "unstaged",
      });

      expect(patch.path).toBe("sample.ts");
      expect(patch.patch).toContain("diff --git");
      expect(patch.patch).toContain("-const x = 1;");
      expect(patch.patch).toContain("+const x = 2;");
      expect(patch.additions).toBe(1);
      expect(patch.deletions).toBe(1);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects diff paths that escape the worktree", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-escape-"));
    const service = createDiffService({ laneService: createLaneServiceStub(rootPath) });

    try {
      git(rootPath, ["init"]);

      await expect(service.getFileDiff({
        laneId: "lane-1",
        filePath: "../outside.txt",
        mode: "unstaged",
      })).rejects.toThrow("Path escapes root");

      await expect(service.getFilePatch({
        laneId: "lane-1",
        filePath: "../outside.txt",
        mode: "unstaged",
      })).rejects.toThrow("Path escapes root");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects diff paths that contain null bytes", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-null-path-"));
    const service = createDiffService({ laneService: createLaneServiceStub(rootPath) });

    try {
      await expect(service.getFileDiff({
        laneId: "lane-1",
        filePath: "bad\0name.txt",
        mode: "unstaged",
      })).rejects.toThrow("File path contains an invalid null byte");

      await expect(service.getFilePatch({
        laneId: "lane-1",
        filePath: "bad\0name.txt",
        mode: "unstaged",
      })).rejects.toThrow("File path contains an invalid null byte");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects option-looking commit compare refs", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-compare-ref-"));
    const service = createDiffService({ laneService: createLaneServiceStub(rootPath) });

    try {
      await expect(service.getFileDiff({
        laneId: "lane-1",
        filePath: "sample.ts",
        mode: "commit",
        compareRef: "--help",
      })).rejects.toThrow("compareRef cannot start with '-'");

      await expect(service.getFilePatch({
        laneId: "lane-1",
        filePath: "sample.ts",
        mode: "commit",
        compareRef: "--help",
        compareTo: "parent",
      })).rejects.toThrow("compareRef cannot start with '-'");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("bounds large file diff sides before they reach Monaco", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-diff-service-large-"));
    const service = createDiffService({ laneService: createLaneServiceStub(rootPath) });

    try {
      git(rootPath, ["init"]);
      git(rootPath, ["config", "user.email", "ade@example.com"]);
      git(rootPath, ["config", "user.name", "ADE"]);
      fs.writeFileSync(path.join(rootPath, "large.ts"), `${"a".repeat(260 * 1024)}\n`, "utf8");
      git(rootPath, ["add", "large.ts"]);
      git(rootPath, ["commit", "-m", "base"]);
      fs.writeFileSync(path.join(rootPath, "large.ts"), `${"b".repeat(260 * 1024)}\n`, "utf8");

      const diff = await service.getFileDiff({
        laneId: "lane-1",
        filePath: "large.ts",
        mode: "unstaged",
      });

      expect(diff.original.isTruncated).toBe(true);
      expect(diff.modified.isTruncated).toBe(true);
      expect(diff.original.text.length).toBeLessThan(210 * 1024);
      expect(diff.modified.text.length).toBeLessThan(210 * 1024);
      expect(diff.modified.text).toContain("Preview truncated");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
