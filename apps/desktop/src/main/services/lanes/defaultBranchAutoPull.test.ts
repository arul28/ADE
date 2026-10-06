import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  createDefaultBranchAutoPullService,
  detectInProgressGitOperation,
  evaluateDefaultBranchAutoPull,
  isDefaultBranchMerge,
  type AutoPullEligibilityInput,
  type AutoPullSkipReason,
  type BranchSyncState,
  type DefaultBranchAutoPullDeps,
} from "./defaultBranchAutoPull";

function input(overrides: Partial<AutoPullEligibilityInput> = {}): AutoPullEligibilityInput {
  return {
    isPrimary: true,
    headBranchRef: "main",
    defaultBranchRef: "main",
    staged: 0,
    unstaged: 0,
    inProgressOperation: null,
    worktreeLocked: false,
    sync: { hasUpstream: true, ahead: 0, behind: 0 },
    phase: "post-fetch",
    ...overrides,
  };
}

function sync(overrides: Partial<BranchSyncState> = {}): BranchSyncState {
  return { hasUpstream: true, ahead: 0, behind: 0, ...overrides };
}

describe("evaluateDefaultBranchAutoPull", () => {
  it("pulls a clean, attached default branch that is behind after the fetch", () => {
    expect(evaluateDefaultBranchAutoPull(input({ sync: sync({ behind: 3 }) }))).toEqual({
      pull: true,
      reason: "eligible",
    });
  });

  it("is eligible pre-fetch even when the stale ref reads as up-to-date", () => {
    expect(evaluateDefaultBranchAutoPull(input({ phase: "pre-fetch", sync: sync({ behind: 0 }) }))).toEqual({
      pull: true,
      reason: "eligible",
    });
  });

  it("requests refresh only for the project's default merge base", () => {
    expect(isDefaultBranchMerge("main", "main")).toBe(true);
    expect(isDefaultBranchMerge("stack-parent", "main")).toBe(false);
    expect(isDefaultBranchMerge("refs/heads/main", "main")).toBe(true);
  });

  const skipCases: Array<[string, Partial<AutoPullEligibilityInput>, AutoPullSkipReason]> = [
    ["a staged tracked change", { staged: 1 }, "dirty-worktree"],
    ["an unstaged tracked change", { unstaged: 2 }, "dirty-worktree"],
    ["a rebase in progress", { inProgressOperation: "rebase" }, "git-operation-in-progress"],
    ["a merge in progress", { inProgressOperation: "merge" }, "git-operation-in-progress"],
    ["a detached HEAD", { headBranchRef: null }, "detached-head"],
    ["a non-default branch", { headBranchRef: "feature/x" }, "not-on-default-branch"],
    ["a branch differing only in case", { headBranchRef: "Main" }, "not-on-default-branch"],
    ["a held worktree lease", { worktreeLocked: true }, "worktree-locked"],
    ["a lane with no upstream", { sync: sync({ hasUpstream: false }) }, "no-upstream"],
    ["a branch that is ahead of the remote", { sync: sync({ ahead: 2 }) }, "up-to-date"],
    ["a diverged branch", { sync: sync({ ahead: 1, behind: 1 }) }, "diverged"],
    ["a non-primary lane", { isPrimary: false }, "no-primary-lane"],
  ];

  it.each(skipCases)("skips %s", (_label, overrides, reason) => {
    expect(evaluateDefaultBranchAutoPull(input(overrides))).toEqual({ pull: false, reason });
  });

  it("ignores a background bisect, which does not leave the worktree mid-operation", () => {
    expect(
      evaluateDefaultBranchAutoPull(input({ inProgressOperation: "bisect", sync: sync({ behind: 1 }) })),
    ).toEqual({ pull: true, reason: "eligible" });
  });
});

describe("detectInProgressGitOperation", () => {
  it("returns null for a directory with no markers", async () => {
    const dir = await fs.mkdtemp("/tmp/ade-autopull-");
    expect(detectInProgressGitOperation(dir)).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("names a rebase directory", async () => {
    const dir = await fs.mkdtemp("/tmp/ade-autopull-");
    await fs.mkdir(`${dir}/rebase-merge`);
    expect(detectInProgressGitOperation(dir)).toBe("rebase");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

type Harness = {
  deps: DefaultBranchAutoPullDeps;
  fetch: ReturnType<typeof vi.fn>;
  pullFastForward: ReturnType<typeof vi.fn>;
};

function harness(overrides: Partial<DefaultBranchAutoPullDeps> = {}): Harness {
  const fetch = vi.fn(async () => {});
  const pullFastForward = vi.fn(async () => {});
  const deps: DefaultBranchAutoPullDeps = {
    getPrimaryLane: () => ({ laneId: "lane-primary", worktreePath: "/repo", branchRef: "main" }),
    readWorktreeStatus: async () => ({ staged: 0, unstaged: 0, headBranchRef: "main" }),
    detectInProgressOperation: async () => null,
    isWorktreeLocked: () => false,
    readSyncStatus: async () => sync({ behind: 4 }),
    fetch,
    pullFastForward,
    ...overrides,
  };
  return { deps, fetch, pullFastForward };
}

describe("createDefaultBranchAutoPullService", () => {
  it("fetches then fast-forwards a clean default branch that is behind", async () => {
    const { deps, fetch, pullFastForward } = harness();
    const service = createDefaultBranchAutoPullService(deps);

    const result = await service.runOnce();

    expect(result).toEqual({ pulled: true, reason: "eligible", behind: 4 });
    expect(fetch).toHaveBeenCalledWith("lane-primary");
    expect(pullFastForward).toHaveBeenCalledWith("lane-primary");
  });

  it("centers the pull decision on the post-fetch read, not the stale pre-fetch one", async () => {
    let reads = 0;
    const { deps, fetch, pullFastForward } = harness({
      readSyncStatus: async () => {
        reads += 1;
        // The remote-tracking ref is stale before the fetch and current after.
        return reads === 1 ? sync({ behind: 0 }) : sync({ behind: 3 });
      },
    });
    const service = createDefaultBranchAutoPullService(deps);

    const result = await service.runOnce();

    expect(result).toEqual({ pulled: true, reason: "eligible", behind: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pullFastForward).toHaveBeenCalledWith("lane-primary");
  });

  it("does not fetch at all when the worktree is dirty", async () => {
    const { deps, fetch, pullFastForward } = harness({
      readWorktreeStatus: async () => ({ staged: 0, unstaged: 1, headBranchRef: "main" }),
    });
    const service = createDefaultBranchAutoPullService(deps);

    const result = await service.runOnce();

    expect(result).toEqual({ pulled: false, reason: "dirty-worktree" });
    expect(fetch).not.toHaveBeenCalled();
    expect(pullFastForward).not.toHaveBeenCalled();
  });

  it("skips without pulling when the branch has diverged after the fetch", async () => {
    const { deps, pullFastForward } = harness({
      readSyncStatus: async () => sync({ ahead: 1, behind: 2 }),
    });
    const service = createDefaultBranchAutoPullService(deps);

    const result = await service.runOnce();

    expect(result.pulled).toBe(false);
    expect(result.reason).toBe("diverged");
    expect(pullFastForward).not.toHaveBeenCalled();
  });

  it("skips a non-default HEAD even when it has an upstream and the primary lane is recorded on that branch", async () => {
    const { deps, fetch, pullFastForward } = harness({
      getPrimaryLane: () => ({ laneId: "lane-primary", worktreePath: "/repo", branchRef: "main" }),
      readWorktreeStatus: async () => ({ staged: 0, unstaged: 0, headBranchRef: "feature" }),
    });
    const service = createDefaultBranchAutoPullService(deps);

    expect(await service.runOnce()).toEqual({ pulled: false, reason: "not-on-default-branch" });
    expect(fetch).not.toHaveBeenCalled();
    expect(pullFastForward).not.toHaveBeenCalled();
  });

  it("treats an offline/failed fetch as a silent skip", async () => {
    const { deps, pullFastForward } = harness({
      fetch: async () => {
        throw new Error("Could not resolve host: github.com");
      },
    });
    const service = createDefaultBranchAutoPullService(deps);

    const result = await service.runOnce();

    expect(result).toEqual({ pulled: false, reason: "fetch-failed" });
    expect(pullFastForward).not.toHaveBeenCalled();
  });

  it("skips when another operation holds the worktree lease", async () => {
    const { deps, fetch } = harness({ isWorktreeLocked: () => true });
    const service = createDefaultBranchAutoPullService(deps);

    expect(await service.runOnce()).toEqual({ pulled: false, reason: "worktree-locked" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("coalesces calls during a pass into one serialized follow-up", async () => {
    const finishFetch: Array<() => void> = [];
    const finishPull: Array<() => void> = [];
    let activeFetches = 0;
    let maximumActiveFetches = 0;
    let activePulls = 0;
    let maximumActivePulls = 0;
    const fetch = vi.fn(async () => {
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      const fetchNumber = fetch.mock.calls.length;
      if (fetchNumber <= 2) {
        await new Promise<void>((resolve) => { finishFetch[fetchNumber - 1] = resolve; });
      }
      activeFetches -= 1;
    });
    const pullFastForward = vi.fn(async () => {
      activePulls += 1;
      maximumActivePulls = Math.max(maximumActivePulls, activePulls);
      const pullNumber = pullFastForward.mock.calls.length;
      if (pullNumber <= 2) {
        await new Promise<void>((resolve) => { finishPull[pullNumber - 1] = resolve; });
      }
      activePulls -= 1;
    });
    const { deps } = harness({ fetch, pullFastForward });
    const service = createDefaultBranchAutoPullService(deps);

    const first = service.runOnce();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const firstFollowUp = service.runOnce();
    const firstFollowUpCoalesced = service.runOnce();
    expect(firstFollowUpCoalesced).toBe(firstFollowUp);

    finishFetch[0]!();
    await vi.waitFor(() => expect(pullFastForward).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    finishPull[0]!();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const secondFollowUp = service.runOnce();
    const secondFollowUpCoalesced = service.runOnce();
    expect(secondFollowUpCoalesced).toBe(secondFollowUp);
    expect(secondFollowUp).not.toBe(firstFollowUp);

    finishFetch[1]!();
    await vi.waitFor(() => expect(pullFastForward).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    finishPull[1]!();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const results = await Promise.all([
      first,
      firstFollowUp,
      firstFollowUpCoalesced,
      secondFollowUp,
      secondFollowUpCoalesced,
    ]);

    expect(results.every((result) => result.pulled)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(pullFastForward).toHaveBeenCalledTimes(3);
    expect(maximumActiveFetches).toBe(1);
    expect(maximumActivePulls).toBe(1);
  });

  it("is a no-op when the project has no primary lane", async () => {
    const { deps, fetch } = harness({ getPrimaryLane: () => null });
    const service = createDefaultBranchAutoPullService(deps);

    expect(await service.runOnce()).toEqual({ pulled: false, reason: "no-primary-lane" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("polls on the injected timer while started and stops cleanly", async () => {
    const scheduled: Array<{ fire: () => void; handle: object }> = [];
    const clearTimer = vi.fn();
    const { deps, fetch } = harness({
      setTimer: ((fn: () => void) => {
        const handle = { unref: () => {} };
        scheduled.push({ fire: fn, handle });
        return handle as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: clearTimer as unknown as typeof clearTimeout,
    });
    const service = createDefaultBranchAutoPullService(deps);

    service.start();
    expect(service.isStarted()).toBe(true);
    expect(scheduled).toHaveLength(1);

    scheduled[0]!.fire();
    await vi.waitFor(() => expect(scheduled).toHaveLength(2));

    service.stop();
    expect(service.isStarted()).toBe(false);
    expect(clearTimer).toHaveBeenCalledWith(scheduled[1]!.handle);
  });
});
