import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
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

describe("diffService", () => {
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
