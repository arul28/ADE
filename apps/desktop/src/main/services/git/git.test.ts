import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runGit, runGitMergeTree, runGitOrThrow } from "./git";

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

describe("runGitOrThrow", () => {
  it("renames a stale linked-worktree index.lock and retries the git command", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-lock-"));
    const worktreeRoot = path.join(repoRoot, "lane-worktree");

    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "ade@test.local"]);
    git(repoRoot, ["config", "user.name", "ADE Test"]);
    fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n", "utf8");
    git(repoRoot, ["add", "base.txt"]);
    git(repoRoot, ["commit", "-m", "base"]);
    git(repoRoot, ["worktree", "add", "-b", "feature/test", worktreeRoot, "HEAD"]);

    fs.writeFileSync(path.join(worktreeRoot, "feature.txt"), "hello\n", "utf8");
    const gitDir = git(worktreeRoot, ["rev-parse", "--absolute-git-dir"]);
    const lockPath = path.join(gitDir, "index.lock");
    fs.writeFileSync(lockPath, "", "utf8");
    const staleDate = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    await runGitOrThrow(["add", "-A", "--", "."], { cwd: worktreeRoot, timeoutMs: 15_000 });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(gitDir).some((entry) => entry.startsWith("index.lock.stale-"))).toBe(true);
    expect(git(worktreeRoot, ["diff", "--cached", "--name-only"])).toContain("feature.txt");
  });
});

describe("runGit", () => {
  it("removes a stale index.lock and retries once", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-lock-"));
    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "ade@test.local"]);
    git(repoRoot, ["config", "user.name", "ADE Test"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "hello\n", "utf8");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "init"]);

    const gitDir = git(repoRoot, ["rev-parse", "--absolute-git-dir"]);
    const lockPath = path.join(gitDir, "index.lock");
    fs.writeFileSync(lockPath, "", "utf8");
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "updated\n", "utf8");
    const staleDate = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const result = await runGit(["add", "-A", "--", "."], { cwd: repoRoot, timeoutMs: 8_000 });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
