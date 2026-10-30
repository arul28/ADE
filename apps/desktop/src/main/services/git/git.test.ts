import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitOwnershipMessage } from "../../../../../ade-cli/src/services/projects/gitOwnership";
import { isExpectedOutcome } from "../../../shared/sentry/expectedFailure";
import { describeUnsavedWorktreeWork, readWorktreeDirty, UNCOMMITTED_CHANGES_REASON } from "./worktreeState";
import {
  branchNameFromHeadRef,
  formatGitExecutionError,
  gitCommandError,
  gitSafeDirectorySpec,
  parseGitOwnershipError,
  getHeadSha,
  gitBranchRefsIdentity,
  gitWorktreeListIdentity,
  gitWorktreeRootCached,
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

  // Git for Windows refuses a file named for a device (an agent's `2>NUL` in
  // Git Bash makes one). The user must delete it, so the error names it and
  // is an answer, not an ADE bug; elsewhere the name is ordinary.
  it.each([
    { platform: "win32", file: "apps/apphost/NUL", explained: true },
    { platform: "win32", file: "apps/nul.txt", explained: true },
    { platform: "win32", file: "COM1", explained: true },
    { platform: "win32", file: "apps/NULL", explained: false },
    { platform: "darwin", file: "apps/apphost/NUL", explained: false },
  ])("explains a reserved Windows file name only where it is one: $platform $file", ({ platform, file, explained }) => {
    const raw = `error: open("${file}"): No such file or directory\nerror: unable to index file '${file}'\nfatal: adding files failed`;
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: platform });
    try {
      const error = gitCommandError(raw);
      expect(isExpectedOutcome(error)).toBe(explained);
      if (explained) {
        expect(error.message).toContain(`"${file}"`);
        expect(error.message).not.toContain("fatal:");
      } else {
        expect(error.message).toBe(raw);
      }
    } finally {
      Object.defineProperty(process, "platform", original);
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


describe("gitBranchRefsIdentity", () => {
  // listBranches keeps its answer while this key is unchanged, and the branch
  // list is what History and the branch switcher show. Every change below is
  // made with plain git, outside ADE, so no cache invalidation hook helps.
  it("changes on every kind of ref, HEAD or upstream change, and not on a status", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-refs-identity-"));
    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["-c", "user.email=ade@test.local", "-c", "user.name=ADE", "commit", "--allow-empty", "-m", "one"]);
    git(repoRoot, ["-c", "user.email=ade@test.local", "-c", "user.name=ADE", "commit", "--allow-empty", "-m", "two"]);
    let last = await gitBranchRefsIdentity(repoRoot);
    expect(last, "plain layout yields an identity").toBeTruthy();
    const changedAfter = async (args: string[]): Promise<boolean> => {
      git(repoRoot, args);
      const now = await gitBranchRefsIdentity(repoRoot);
      const changed = now !== last;
      last = now;
      return changed;
    };

    expect(await changedAfter(["status"])).toBe(false);
    const changes: Array<[string, string[]]> = [
      ["new branch", ["branch", "feature"]],
      ["existing branch moved", ["update-ref", "refs/heads/feature", "HEAD~1"]],
      ["nested branch", ["branch", "ade/nested/deep"]],
      ["nested branch moved", ["update-ref", "refs/heads/ade/nested/deep", "HEAD~1"]],
      ["remote-tracking ref", ["update-ref", "refs/remotes/origin/main", "HEAD"]],
      ["refs packed", ["pack-refs", "--all"]],
      ["packed ref moved", ["update-ref", "refs/heads/feature", "HEAD"]],
      ["checkout", ["checkout", "-q", "feature"]],
      ["upstream set", ["config", "branch.feature.remote", "origin"]],
      ["branch deleted", ["branch", "-D", "ade/nested/deep"]],
    ];
    const missed = [];
    for (const [label, args] of changes) if (!(await changedAfter(args))) missed.push(label);
    expect(missed).toEqual([]);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  // Git before 2.45 cannot make a reftable repository.
  const reftableProbe = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-reftable-probe-"));
  const gitHasReftable = spawnSync("git", ["init", "-q", "--ref-format=reftable", reftableProbe]).status === 0;
  fs.rmSync(reftableProbe, { recursive: true, force: true });

  it.skipIf(!gitHasReftable)("gives no key for a reftable repository, whose refs it cannot see", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-reftable-"));
    git(repoRoot, ["init", "-q", "--ref-format=reftable"]);
    git(repoRoot, ["-c", "user.email=ade@test.local", "-c", "user.name=ADE", "commit", "--allow-empty", "-m", "one"]);
    expect(fs.existsSync(path.join(repoRoot, ".git", "reftable"))).toBe(true);
    expect(await gitBranchRefsIdentity(repoRoot)).toBeNull();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("gitWorktreeListIdentity", () => {
  // The lane list keeps `git worktree list` while this key is unchanged, and
  // its reconcile adopts worktrees and drops lanes whose worktree is gone.
  // Every change below is made outside ADE.
  it("changes whenever the worktree listing can, and not on a status", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-worktree-identity-"));
    const linked = `${repoRoot}-linked`;
    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["-c", "user.email=ade@test.local", "-c", "user.name=ADE", "commit", "--allow-empty", "-m", "one"]);
    let last = await gitWorktreeListIdentity(repoRoot);
    expect(last, "plain layout yields an identity").toBeTruthy();
    const changedAfter = async (change: () => void): Promise<boolean> => {
      change();
      const now = await gitWorktreeListIdentity(repoRoot);
      const changed = now !== last;
      last = now;
      return changed;
    };

    expect(await changedAfter(() => git(repoRoot, ["status"]))).toBe(false);
    const changes: Array<[string, () => void]> = [
      ["worktree added", () => git(repoRoot, ["worktree", "add", "-q", "-b", "lane", linked])],
      ["branch switched in the worktree", () => git(linked, ["checkout", "-q", "-b", "lane-two"])],
      ["commit in the worktree", () => git(linked, ["-c", "user.email=ade@test.local", "-c", "user.name=ADE", "commit", "--allow-empty", "-m", "two"])],
      ["main checkout switched", () => git(repoRoot, ["checkout", "-q", "-b", "side"])],
      ["worktree locked", () => git(repoRoot, ["worktree", "lock", linked])],
      ["worktree unlocked", () => git(repoRoot, ["worktree", "unlock", linked])],
      ["worktree folder deleted outside git", () => fs.rmSync(linked, { recursive: true, force: true })],
      ["pruned", () => git(repoRoot, ["worktree", "prune"])],
    ];
    const missed = [];
    for (const [label, change] of changes) if (!(await changedAfter(change))) missed.push(label);
    expect(missed).toEqual([]);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("gitWorktreeRootCached", () => {
  it("asks git again only when the folder or its .git entry is replaced, and never keeps a no", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-root-cache-"));
    git(root, ["init", "-q"]);
    let checks = 0;
    const check = async () => { checks += 1; return fs.existsSync(path.join(root, ".git")); };

    expect(await gitWorktreeRootCached(root, check)).toBe(true);
    git(root, ["status"]); // moves the .git folder's mtime, which says nothing about the answer
    expect(await gitWorktreeRootCached(root, check)).toBe(true);
    expect(checks).toBe(1);

    fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
    expect(await gitWorktreeRootCached(root, check)).toBe(false);
    expect(await gitWorktreeRootCached(root, check)).toBe(false);
    git(root, ["init", "-q"]);
    expect(await gitWorktreeRootCached(root, check)).toBe(true);
    expect(checks).toBe(4);
    fs.rmSync(root, { recursive: true, force: true });
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
    expect(result).toEqual({ exitCode: 130, stdout: "", stderr: "git was cancelled", cancelled: true });
  });

  // Hooks are shell scripts; Windows runs the same timer code.
  it.skipIf(process.platform === "win32")("stops a git that prints nothing for idleTimeoutMs, while output keeps one running", async () => {
    const repo = initRepo("ade-git-idle-");
    const worktrees = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-idle-wt-"));
    try {
      git(repo, ["branch", "side"]);
      const hook = path.join(repo, ".git", "hooks", "post-checkout");
      // A silent hook stands in for a stuck checkout. Its output goes nowhere,
      // so stopping git closes git's pipes at once.
      fs.writeFileSync(hook, "#!/bin/sh\nexec sleep 5 >/dev/null 2>&1 </dev/null\n", { mode: 0o755 });
      const stalled = await runGit(["worktree", "add", path.join(worktrees, "stalled"), "side"], {
        cwd: repo,
        timeoutMs: 30_000,
        idleTimeoutMs: 300,
      });
      expect(stalled).toMatchObject({ exitCode: 124, timedOut: true, stalled: true });
      await expect(runGitOrThrow(["worktree", "add", "-b", "stalled-2", path.join(worktrees, "stalled-2"), "main"], {
        cwd: repo,
        timeoutMs: 30_000,
        idleTimeoutMs: 300,
      })).rejects.toMatchObject({ name: "GitTimeoutError", stalled: true });

      // Slow but talking: runs well past the limit, a line every 150 ms, a
      // tenth of the limit, so a loaded machine does not read as a stall.
      fs.writeFileSync(hook, "#!/bin/sh\nfor i in $(seq 1 16); do echo working >&2; sleep 0.15; done\n", { mode: 0o755 });
      const busy = await runGit(["worktree", "add", "-b", "busy", path.join(worktrees, "busy"), "main"], {
        cwd: repo,
        timeoutMs: 30_000,
        idleTimeoutMs: 1_500,
      });
      expect(busy.exitCode).toBe(0);
      expect(busy.timedOut).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(worktrees, { recursive: true, force: true });
    }
  }, 20_000);
});

function initRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ade@test.local"]);
  git(repo, ["config", "user.name", "ADE Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

// Settings people really use that change git's own output.
function setPersonalConfig(repo: string): void {
  git(repo, ["config", "status.showUntrackedFiles", "no"]);
  git(repo, ["config", "diff.noprefix", "true"]);
}

describe("runGit under a personal git config", () => {
  it("still sees new files, keeps a/ b/ patch prefixes, raw -z names, and a branch shadowed by a tag", async () => {
    const repo = initRepo("ade-git-personal-config-");
    setPersonalConfig(repo);
    // Windows cannot create a file name with `"` in it.
    const oddName = process.platform === "win32" ? "café q a.txt" : "café \"q\" a.txt";
    fs.writeFileSync(path.join(repo, oddName), "new\n", "utf8");
    fs.writeFileSync(path.join(repo, "README.md"), "hi\nmore\n", "utf8");

    const status = await runGit(["status", "--porcelain=v1", "-z"], { cwd: repo });
    expect(status.stdout.split("\0")).toContain(`?? ${oddName}`);

    const patch = await runGit(["diff", "--no-color", "--", "README.md"], { cwd: repo });
    expect(patch.stdout).toContain("--- a/README.md");
    expect(patch.stdout).toContain("+++ b/README.md");

    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "names"]);
    const names = await runGit(["show", "--pretty=format:", "--name-only", "-z", "HEAD", "--"], { cwd: repo });
    expect(names.stdout.split("\0").filter(Boolean).sort()).toEqual(["README.md", oddName]);

    git(repo, ["checkout", "-q", "-b", "release"]);
    git(repo, ["tag", "release"]);
    const head = await runGit(["rev-parse", "--symbolic-full-name", "HEAD"], { cwd: repo });
    expect(branchNameFromHeadRef(head.stdout)).toBe("release");
  });
});

describe("describeUnsavedWorktreeWork", () => {
  it("reports a lane that holds only a new file, even when git config hides new files", async () => {
    const repo = initRepo("ade-git-unsaved-untracked-");
    const lane = `${repo}-lane`;
    git(repo, ["worktree", "add", "-q", "-b", "lane", lane]);
    setPersonalConfig(repo);
    expect(await describeUnsavedWorktreeWork(lane)).toBeNull();

    fs.writeFileSync(path.join(lane, "notes.md"), "precious\n", "utf8");
    expect(git(lane, ["status", "--porcelain"])).toBe("");
    expect(await describeUnsavedWorktreeWork(lane)).toBe(UNCOMMITTED_CHANGES_REASON);
    expect(await readWorktreeDirty(lane)).toBe(true);
  });

  it("checks every submodule for commits no remote has, past an empty uninitialized one", async () => {
    const upstreamA = initRepo("ade-git-sub-a-");
    const upstreamB = initRepo("ade-git-sub-b-");
    const repo = initRepo("ade-git-unsaved-sub-");
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstreamA, "a"]);
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstreamB, "b"]);
    git(repo, ["commit", "-q", "-m", "submodules"]);
    const lane = `${repo}-lane`;
    git(repo, ["worktree", "add", "-q", "-b", "lane", lane]);
    // `a` stays uninitialized (an empty folder) and sorts first.
    git(lane, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "b"]);
    expect(await describeUnsavedWorktreeWork(lane)).toBeNull();

    const sub = path.join(lane, "b");
    git(sub, ["config", "user.email", "ade@test.local"]);
    git(sub, ["config", "user.name", "ADE Test"]);
    fs.writeFileSync(path.join(sub, "work.txt"), "work\n", "utf8");
    git(sub, ["add", "."]);
    git(sub, ["commit", "-q", "-m", "sub work"]);
    git(lane, ["add", "b"]);
    git(lane, ["commit", "-q", "-m", "bump b"]);
    expect(git(lane, ["status", "--porcelain", "--ignore-submodules=none"])).toBe("");
    expect(await describeUnsavedWorktreeWork(lane)).toBe("Submodule b has commits that no remote has.");
    // A tag that was never pushed does not save the commit.
    git(sub, ["tag", "local-only"]);
    expect(await describeUnsavedWorktreeWork(lane)).toBe("Submodule b has commits that no remote has.");

    git(sub, ["push", "-q", "origin", "HEAD:refs/heads/saved"]);
    expect(await describeUnsavedWorktreeWork(lane)).toBeNull();
  });
});
