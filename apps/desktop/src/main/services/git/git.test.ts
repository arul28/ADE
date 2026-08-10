import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  formatGitExecutionError,
  getHeadSha,
  runGit,
  runGitMergeTree,
  runGitOrThrow,
  selectGitExecutable,
  shouldProbeLoginShellForGit,
} from "./git";

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
    const staleDate = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    await runGitOrThrow(["add", "-A", "--", "."], { cwd: worktreeRoot, timeoutMs: 15_000 });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(gitDir).some((entry) => entry.startsWith("index.lock.stale-"))).toBe(true);
    expect(git(worktreeRoot, ["diff", "--cached", "--name-only"])).toContain("feature.txt");
  });
});

describe("runGit", () => {
  it("reports a missing worktree path instead of blaming the git executable", async () => {
    const missingWorktree = path.join(os.tmpdir(), `ade-missing-worktree-${Date.now()}`);

    const result = await runGit(["status", "--short"], { cwd: missingWorktree, timeoutMs: 8_000 });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`git working directory not found: ${missingWorktree}`);
    expect(result.stderr).not.toContain("git executable not found");
  });

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

  it("does not rename a recent index.lock", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-lock-fresh-"));
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

    const result = await runGit(["add", "-A", "--", "."], { cwd: repoRoot, timeoutMs: 8_000 });

    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readdirSync(gitDir).some((entry) => entry.startsWith("index.lock.stale-"))).toBe(false);
  });
});

describe("macOS git selection", () => {
  it("prefers an independent Git installation over Apple's license-gated executable", () => {
    expect(selectGitExecutable([
      { path: "/usr/bin/git", source: "path" },
      { path: "/opt/homebrew/bin/git", source: "known-dir" },
    ], "darwin")).toBe("/opt/homebrew/bin/git");
  });

  it("uses Apple's Git when it is the only installation available", () => {
    expect(selectGitExecutable([
      { path: "/usr/bin/git", source: "path" },
    ], "darwin")).toBe("/usr/bin/git");
  });

  it("checks the login shell before accepting Apple's Git", () => {
    expect(shouldProbeLoginShellForGit("/usr/bin/git", "darwin")).toBe(true);
    expect(shouldProbeLoginShellForGit("/opt/homebrew/bin/git", "darwin")).toBe(false);
    expect(shouldProbeLoginShellForGit("/usr/bin/git", "linux")).toBe(false);
  });

  it("explains that an Xcode license failure comes from Git, not iOS features", () => {
    const message = formatGitExecutionError(
      "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'.",
    );

    expect(message).toContain("ADE needs Git");
    expect(message).toContain("not an ADE iOS Simulator or code-signing requirement");
    expect(message).toContain("sudo xcodebuild -license");
  });
});


describe("repo cache invalidation through runGit", () => {
  function scratchRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-repo-cache-"));
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "one\n", "utf8");
    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "ade@test.local"]);
    git(repoRoot, ["config", "user.name", "ADE Test"]);
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "one"]);
    return repoRoot;
  }

  // `getHeadSha` is cached for 1.5s, so without the invalidation hook a commit
  // made inside that window would keep reporting the pre-commit SHA — which is
  // what `runLaneOperation` records as an operation's postHeadSha, and what
  // Undo later refuses to act on.
  it("serves a fresh HEAD immediately after a commit made through runGit", async () => {
    const repoRoot = scratchRepo();
    const before = await getHeadSha(repoRoot);
    expect(before).toBeTruthy();
    // Warm the cache a second time so a stale read would be served from it.
    expect(await getHeadSha(repoRoot)).toBe(before);

    fs.writeFileSync(path.join(repoRoot, "file.txt"), "two\n", "utf8");
    await runGit(["add", "."], { cwd: repoRoot, timeoutMs: 20_000 });
    await runGit(["commit", "-m", "two"], { cwd: repoRoot, timeoutMs: 20_000 });

    expect(await getHeadSha(repoRoot)).not.toBe(before);
  });

  // The argv ADE actually uses for rebase/merge continuation. The verb sits
  // behind one of git's own options, and missing it means HEAD moves without
  // the cache noticing.
  it("still invalidates when the verb sits behind a git -c option", async () => {
    const repoRoot = scratchRepo();
    const before = await getHeadSha(repoRoot);
    expect(await getHeadSha(repoRoot)).toBe(before);

    fs.writeFileSync(path.join(repoRoot, "file.txt"), "three\n", "utf8");
    await runGit(["add", "."], { cwd: repoRoot, timeoutMs: 20_000 });
    await runGit(["-c", "core.editor=true", "commit", "-m", "three"], {
      cwd: repoRoot,
      timeoutMs: 20_000,
    });

    expect(await getHeadSha(repoRoot)).not.toBe(before);
  });

  it("bounds concurrent read fan-out without dropping any result", async () => {
    const repoRoot = scratchRepo();
    const head = await getHeadSha(repoRoot);
    // 40 distinct reads (distinct refs defeat the cache) all resolve under the
    // semaphore rather than deadlocking or losing a result.
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => runGit(
        ["rev-parse", index % 2 === 0 ? "HEAD" : "main"],
        { cwd: repoRoot, timeoutMs: 20_000 },
      )),
    );
    expect(results).toHaveLength(40);
    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(head);
    }
  });
});
