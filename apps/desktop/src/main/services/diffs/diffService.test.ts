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
