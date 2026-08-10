import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedGitRepoValue,
  invalidateGitRepoCache,
  isRefAffectingGitCommand,
  resetGitRepoCacheForTests,
  GIT_REPO_CACHE_STABLE_TTL_MS,
  GIT_REPO_CACHE_VOLATILE_TTL_MS,
} from "./gitRepoCache";

const REPO = "/repo/.git";

describe("isRefAffectingGitCommand", () => {
  it("treats writes as invalidating", () => {
    for (const args of [
      ["commit", "-m", "x"],
      ["fetch", "--prune", "origin"],
      ["push", "--force-with-lease"],
      ["checkout", "-b", "feature"],
      ["rebase", "--continue"],
      ["reset", "--hard", "HEAD~1"],
      ["worktree", "add", "/tmp/wt"],
      ["remote", "add", "origin", "git@example.com:a/b.git"],
      ["config", "user.email", "a@b.c"],
      ["branch", "-D", "gone"],
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      ["init"],
    ]) {
      expect(isRefAffectingGitCommand(args), args.join(" ")).toBe(true);
    }
  });

  // ADE ships exactly these two argvs. Reading the first non-dash token as the
  // verb finds `core.editor=true`, calls the command harmless, and skips
  // invalidating after a rebase moved HEAD — which poisons the operation's
  // recorded postHeadSha and permanently breaks Undo for it.
  it("sees past git's own options to the verb", () => {
    expect(isRefAffectingGitCommand(["-c", "core.editor=true", "rebase", "--continue"])).toBe(true);
    expect(isRefAffectingGitCommand(["-c", "core.editor=true", "merge", "--continue"])).toBe(true);
    expect(isRefAffectingGitCommand(["-C", "/repo", "commit", "-m", "x"])).toBe(true);
    expect(isRefAffectingGitCommand(["--git-dir", "/repo/.git", "fetch"])).toBe(true);
    expect(isRefAffectingGitCommand(["--git-dir=/repo/.git", "push"])).toBe(true);
    expect(isRefAffectingGitCommand(["--no-pager", "log", "-n", "1"])).toBe(false);
    expect(isRefAffectingGitCommand(["-c", "x=y", "rev-parse", "HEAD"])).toBe(false);
  });

  // An argument's *value* must not be able to pass for a read-only mood.
  it("does not let an operand masquerade as a subcommand", () => {
    expect(isRefAffectingGitCommand(["stash", "push", "--keep-index", "-u", "-m", "list"])).toBe(true);
    expect(isRefAffectingGitCommand(["branch", "-m", "list"])).toBe(true);
    expect(isRefAffectingGitCommand(["tag", "show"])).toBe(true);
  });

  // These are the ones that matter: ADE calls them on hot paths, and treating a
  // read as a mutation would drop the cache on every lookup — strictly worse
  // than not caching, since the subprocess still runs and takes every other
  // entry down with it.
  it("does not invalidate for the read-only mood of a writing verb", () => {
    for (const args of [
      ["config", "--get", "user.email"],
      ["config", "--get-all", "remote.origin.fetch"],
      ["config", "--list"],
      ["remote", "get-url", "origin"],
      ["remote", "-v"],
      ["worktree", "list", "--porcelain"],
      ["branch", "--show-current"],
      ["branch", "--list", "ade/*"],
      ["tag", "--list"],
      ["stash", "list"],
    ]) {
      expect(isRefAffectingGitCommand(args), args.join(" ")).toBe(false);
    }
  });

  it("leaves ordinary read plumbing alone", () => {
    for (const args of [
      ["rev-parse", "HEAD"],
      ["status", "--porcelain=v2", "--branch"],
      ["for-each-ref", "--format=%(refname)", "refs/remotes/"],
      ["diff", "--numstat"],
      ["rev-list", "--count", "a..b"],
      ["merge-base", "a", "b"],
      ["log", "-n", "20"],
      ["ls-files", "-u"],
    ]) {
      expect(isRefAffectingGitCommand(args), args.join(" ")).toBe(false);
    }
  });

  it("treats an unrecognized command as a mutation only if its verb writes", () => {
    // Unknown verb: not in the writing set, so not invalidating.
    expect(isRefAffectingGitCommand(["some-future-plumbing"])).toBe(false);
    // Known writing verb in an unrecognized mood: invalidate rather than trust.
    expect(isRefAffectingGitCommand(["config", "--some-future-flag", "x"])).toBe(true);
    expect(isRefAffectingGitCommand([])).toBe(false);
  });
});

describe("cachedGitRepoValue", () => {
  beforeEach(() => {
    resetGitRepoCacheForTests();
  });

  it("collapses concurrent misses for one key into a single load", async () => {
    // The fan-out this exists for: 14 lanes ask for the same base ref's SHA at
    // the same instant. A plain TTL check lets all 14 through before the first
    // resolves, which is the 14 subprocesses we are removing.
    let resolveLoad!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => { resolveLoad = resolve; }));

    const reads = Array.from({ length: 14 }, () => cachedGitRepoValue({
      commonGitDir: REPO,
      key: "rev-parse:main",
      cacheClass: "volatile",
      load,
    }));
    resolveLoad("sha-main");

    expect(await Promise.all(reads)).toEqual(Array(14).fill("sha-main"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps repositories and keys separate", async () => {
    const load = vi.fn(async () => "value");
    await cachedGitRepoValue({ commonGitDir: REPO, key: "a", cacheClass: "stable", load });
    await cachedGitRepoValue({ commonGitDir: REPO, key: "a", cacheClass: "stable", load });
    expect(load).toHaveBeenCalledTimes(1);

    await cachedGitRepoValue({ commonGitDir: REPO, key: "b", cacheClass: "stable", load });
    await cachedGitRepoValue({ commonGitDir: "/other/.git", key: "a", cacheClass: "stable", load });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("expires each class on its own TTL", async () => {
    const load = vi.fn(async () => "value");
    const at = 1_000_000;

    await cachedGitRepoValue({ commonGitDir: REPO, key: "v", cacheClass: "volatile", load, nowMs: at });
    await cachedGitRepoValue({ commonGitDir: REPO, key: "s", cacheClass: "stable", load, nowMs: at });
    expect(load).toHaveBeenCalledTimes(2);

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      // Just inside the volatile window: both still cached.
      const stillFresh = at + GIT_REPO_CACHE_VOLATILE_TTL_MS - 1;
      await cachedGitRepoValue({ commonGitDir: REPO, key: "v", cacheClass: "volatile", load, nowMs: stillFresh });
      expect(load).toHaveBeenCalledTimes(2);

      // Past volatile but well inside stable: only the ref SHA re-reads.
      const pastVolatile = at + GIT_REPO_CACHE_VOLATILE_TTL_MS + 1;
      nowSpy.mockReturnValue(pastVolatile);
      await cachedGitRepoValue({ commonGitDir: REPO, key: "v", cacheClass: "volatile", load, nowMs: pastVolatile });
      await cachedGitRepoValue({ commonGitDir: REPO, key: "s", cacheClass: "stable", load, nowMs: pastVolatile });
      expect(load).toHaveBeenCalledTimes(3);

      const pastStable = at + GIT_REPO_CACHE_STABLE_TTL_MS + 1;
      nowSpy.mockReturnValue(pastStable);
      await cachedGitRepoValue({ commonGitDir: REPO, key: "s", cacheClass: "stable", load, nowMs: pastStable });
      expect(load).toHaveBeenCalledTimes(4);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("caches a non-throwing failure so a repo without an origin is asked once", async () => {
    const load = vi.fn(async () => ({ exitCode: 128, stdout: "", stderr: "No such remote 'origin'" }));
    await cachedGitRepoValue({ commonGitDir: REPO, key: "remote-url:origin", cacheClass: "stable", load });
    await cachedGitRepoValue({ commonGitDir: REPO, key: "remote-url:origin", cacheClass: "stable", load });
    expect(load).toHaveBeenCalledTimes(1);
  });

  // "This repo has no origin" is the answer most likely to change out of band —
  // the user runs `git remote add` in a terminal, which never goes through
  // runGit — so it must not inherit the five-minute window a success gets.
  it("holds a failure only for the short window even on the stable class", async () => {
    const load = vi.fn(async () => ({ exitCode: 128, stdout: "", stderr: "no origin" }));
    const at = 1_000_000;
    await cachedGitRepoValue({ commonGitDir: REPO, key: "remote-url:origin", cacheClass: "stable", load, nowMs: at });

    const pastVolatile = at + GIT_REPO_CACHE_VOLATILE_TTL_MS + 1;
    await cachedGitRepoValue({ commonGitDir: REPO, key: "remote-url:origin", cacheClass: "stable", load, nowMs: pastVolatile });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys repositories by path identity, not by spelling", async () => {
    const load = vi.fn(async () => "value");
    await cachedGitRepoValue({ commonGitDir: "/Repo/.git", key: "k", cacheClass: "stable", load });
    await cachedGitRepoValue({ commonGitDir: "/Repo/.git/", key: "k", cacheClass: "stable", load });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not pin a load that threw", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("git exploded"))
      .mockResolvedValue("recovered");
    await expect(cachedGitRepoValue({ commonGitDir: REPO, key: "k", cacheClass: "stable", load }))
      .rejects.toThrow("git exploded");
    await expect(cachedGitRepoValue({ commonGitDir: REPO, key: "k", cacheClass: "stable", load }))
      .resolves.toBe("recovered");
  });

  it("bypasses the cache entirely when the repo is unknown", async () => {
    const load = vi.fn(async () => "value");
    await cachedGitRepoValue({ commonGitDir: "", key: "k", cacheClass: "stable", load });
    await cachedGitRepoValue({ commonGitDir: "", key: "k", cacheClass: "stable", load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  describe("invalidation", () => {
    it("drops one repo, or every repo", async () => {
      const load = vi.fn(async () => "value");
      await cachedGitRepoValue({ commonGitDir: REPO, key: "k", cacheClass: "stable", load });
      await cachedGitRepoValue({ commonGitDir: "/other/.git", key: "k", cacheClass: "stable", load });
      expect(load).toHaveBeenCalledTimes(2);

      invalidateGitRepoCache(REPO);
      await cachedGitRepoValue({ commonGitDir: REPO, key: "k", cacheClass: "stable", load });
      await cachedGitRepoValue({ commonGitDir: "/other/.git", key: "k", cacheClass: "stable", load });
      expect(load).toHaveBeenCalledTimes(3);

      invalidateGitRepoCache();
      await cachedGitRepoValue({ commonGitDir: REPO, key: "k", cacheClass: "stable", load });
      await cachedGitRepoValue({ commonGitDir: "/other/.git", key: "k", cacheClass: "stable", load });
      expect(load).toHaveBeenCalledTimes(5);
    });

    // The staleness case the epoch exists for: a mutation lands while a read is
    // in flight. That read still answers its own caller, but it describes the
    // pre-mutation repo and must not become the answer for anyone after.
    it("does not hand an in-flight pre-mutation load to a caller arriving after", async () => {
      let resolveFirst!: (value: string) => void;
      const load = vi.fn()
        .mockImplementationOnce(() => new Promise<string>((r) => { resolveFirst = r; }))
        .mockResolvedValue("after-mutation");

      const inFlight = cachedGitRepoValue({
        commonGitDir: REPO, key: "rev-parse:HEAD", cacheClass: "volatile", load,
      });

      // Mutation lands while the read is still out. A caller arriving now must
      // start its own read rather than joining the one already in the air.
      invalidateGitRepoCache(REPO);
      const joiner = cachedGitRepoValue({
        commonGitDir: REPO, key: "rev-parse:HEAD", cacheClass: "volatile", load,
      });

      resolveFirst("before-mutation");
      await expect(inFlight).resolves.toBe("before-mutation");
      await expect(joiner).resolves.toBe("after-mutation");
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("does not let a load that started before a mutation publish afterwards", async () => {
      let resolveFirst!: (value: string) => void;
      const load = vi.fn()
        .mockImplementationOnce(() => new Promise<string>((r) => { resolveFirst = r; }))
        .mockResolvedValue("after-mutation");

      const inFlight = cachedGitRepoValue({
        commonGitDir: REPO, key: "rev-parse:HEAD", cacheClass: "volatile", load,
      });

      invalidateGitRepoCache(REPO);
      resolveFirst("before-mutation");
      await expect(inFlight).resolves.toBe("before-mutation");

      await expect(cachedGitRepoValue({
        commonGitDir: REPO, key: "rev-parse:HEAD", cacheClass: "volatile", load,
      })).resolves.toBe("after-mutation");
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
});
