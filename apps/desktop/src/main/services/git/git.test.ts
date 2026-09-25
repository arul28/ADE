import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitOwnershipMessage } from "../../../../../ade-cli/src/services/projects/gitOwnership";
import {
  formatGitExecutionError,
  gitSafeDirectorySpec,
  parseGitOwnershipError,
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

  // Git for Windows output cannot be produced on a macOS/Linux runner, so the
  // parser is pinned against the real message shapes here.
  it.each([
    {
      name: "POSIX git (no owner in the message)",
      raw: "fatal: detected dubious ownership in repository at '/srv/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /srv/repo\n",
      expected: { path: "/srv/repo" },
    },
    {
      name: "Git for Windows with a named owner",
      raw: "fatal: detected dubious ownership in repository at 'C:/Users/arul2/proj'\r\n'C:/Users/arul2/proj' is owned by:\r\n\tBUILTIN/Administrators (S-1-5-32-544)\r\nbut the current user is:\r\n\tarul/arul2 (S-1-5-21-1-2-3-1001)\r\nTo add an exception for this directory, call:\r\n\r\n\tgit config --global --add safe.directory C:/Users/arul2/proj\r\n",
      expected: { path: "C:/Users/arul2/proj", owner: "BUILTIN\\Administrators" },
    },
    {
      name: "Git for Windows with only a SID",
      raw: "fatal: detected dubious ownership in repository at 'D:/work'\n'D:/work' is owned by:\n\t'S-1-5-32-544'\nbut the current user is:\n\t'S-1-5-21-9'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory D:/work\n",
      expected: { path: "D:/work", owner: "BUILTIN\\Administrators" },
    },
    {
      name: "a UNC share, using git's own suggested spelling",
      raw: "fatal: detected dubious ownership in repository at '//server/share/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '%(prefix)///server/share/repo'\n",
      expected: { path: "%(prefix)///server/share/repo" },
    },
    {
      name: "a path with a space, which git shell-quotes",
      raw: "fatal: detected dubious ownership in repository at '/Users/a b/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '/Users/a b/repo'\n",
      expected: { path: "/Users/a b/repo" },
    },
    {
      name: "git 2.35.2's wording",
      raw: "fatal: unsafe repository ('/home/other/repo' is owned by someone else)\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /home/other/repo",
      expected: { path: "/home/other/repo" },
    },
    { name: "an unrelated git failure", raw: "fatal: not a git repository (or any of the parent directories): .git", expected: null },
  ])("recognizes git's ownership refusal: $name", ({ raw, expected }) => {
    expect(parseGitOwnershipError(raw)).toEqual(expected);
    const message = formatGitExecutionError(raw);
    if (expected) {
      expect(message).not.toMatch(/fatal:/);
      expect(message).toContain("Git does not trust");
    } else {
      expect(message).toBe(raw);
    }
  });

  it.each([
    ["C:\\Users\\arul2\\proj\\", "C:/Users/arul2/proj"],
    ["/C:/Users/arul2/proj", "C:/Users/arul2/proj"],
    ["C:\\", "C:/"],
    ["/srv/repo/", "/srv/repo"],
    ["/", "/"],
  ])("normalizes %s to the safe.directory value %s", (input, expected) => {
    expect(gitSafeDirectorySpec(input)).toBe(expected);
  });

  it.each([
    ["darwin" as const, "/Users/a b/repo", "'/Users/a b/repo'"],
    ["linux" as const, "/home/o'brien/repo", "'/home/o'\\''brien/repo'"],
    ["win32" as const, "C:\\Users\\a b\\proj", '"C:/Users/a b/proj"'],
  ])("quotes the safe.directory path for a %s paste", (platform, repoPath, quoted) => {
    const message = gitOwnershipMessage({ path: repoPath }, platform);
    expect(message).toContain(`safe.directory ${quoted}`);
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

describe("runGit cancellation", () => {
  it("never spawns git when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    // A cwd that does not exist: a spawned git would fail differently.
    const result = await runGit(["status"], { cwd: path.join(os.tmpdir(), "ade-no-such-dir-for-abort-test"), signal: abort.signal });
    expect(result).toEqual({ exitCode: 130, stdout: "", stderr: "git was cancelled" });
  });
});
