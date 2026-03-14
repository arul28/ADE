import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runGitMergeTree } from "./git";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

describe("runGitMergeTree", () => {
  it("returns real conflicting file paths instead of merge-tree usage text", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-merge-tree-"));
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "base\n", "utf8");
    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "ade@test.local"]);
    git(repoRoot, ["config", "user.name", "ADE Test"]);
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "base"]);

    git(repoRoot, ["checkout", "-b", "feature/a"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "lane-a\n", "utf8");
    git(repoRoot, ["add", "file.txt"]);
    git(repoRoot, ["commit", "-m", "lane a"]);
    const laneASha = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["checkout", "main"]);
    git(repoRoot, ["checkout", "-b", "feature/b"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "lane-b\n", "utf8");
    git(repoRoot, ["add", "file.txt"]);
    git(repoRoot, ["commit", "-m", "lane b"]);
    const laneBSha = git(repoRoot, ["rev-parse", "HEAD"]);

    const mergeBase = git(repoRoot, ["merge-base", laneASha, laneBSha]);
    const merge = await runGitMergeTree({
      cwd: repoRoot,
      mergeBase,
      branchA: laneASha,
      branchB: laneBSha,
    });

    expect(merge.conflicts.map((entry) => entry.path)).toEqual(["file.txt"]);
    expect(merge.conflicts.some((entry) => entry.path.includes("--messages"))).toBe(false);
    expect(merge.conflicts.some((entry) => entry.path.includes("--name-only"))).toBe(false);
  });
});
