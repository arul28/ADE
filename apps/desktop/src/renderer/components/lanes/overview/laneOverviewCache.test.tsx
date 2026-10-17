/* @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommitSummary, LaneSummary, OpenProjectBinding } from "../../../../shared/types";
import { __resetLaneGitListCacheForTests, invalidateLaneGitListCache } from "../laneGitListCache";
import {
  clearTrailerProviderCacheForTest,
  useLaneCommits,
  useLaneOperations,
  useLaneSessions,
  useLaneUpstream,
} from "./useLaneOverviewData";

const REMOTE_PIN = { key: "remote:studio" } as unknown as OpenProjectBinding;

function lane(overrides: Partial<LaneSummary> & { branchRef?: string; headBranchRef?: string } = {}): LaneSummary {
  const { headBranchRef = "ade/lane-one", ...rest } = overrides;
  return {
    id: "lane-1",
    name: "Lane one",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/ade/lane-one",
    worktreePath: "/tmp/lane-one",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false, changedFileCount: 0, headBranchRef },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-10-17T10:00:00.000Z",
    ...rest,
  } as LaneSummary;
}

function commit(sha: string, subject: string): GitCommitSummary {
  return {
    sha: sha.repeat(40),
    shortSha: sha.repeat(7),
    parents: [],
    authorName: "Ada",
    authoredAt: "2026-10-17T10:00:00.000Z",
    subject,
    pushed: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SYNC = { hasUpstream: true, upstreamState: "tracking", upstreamRef: "origin/ade/lane-one", ahead: 2, behind: 0, diverged: false, recommendedAction: "push" };

function installAde() {
  const ade = {
    git: {
      listRecentCommits: vi.fn(async () => [commit("a", "first")]),
      getCommitMessage: vi.fn(async () => ""),
      getSyncStatus: vi.fn(async () => SYNC),
    },
    agentChat: { list: vi.fn(async () => []) },
    sessions: { list: vi.fn(async () => []) },
    history: { listOperations: vi.fn(async () => []) },
  };
  (window as any).ade = ade;
  return ade;
}

/** Renders a read and records what the first commit and every later render returned. */
function probe<T>(read: () => T, pick: (value: T) => unknown) {
  const seen: unknown[] = [];
  const hook = renderHook(() => {
    const value = read();
    seen.push(pick(value));
    return value;
  });
  return { hook, seen };
}

describe("lane overview cache (dashboard reads)", () => {
  beforeEach(() => {
    __resetLaneGitListCacheForTests();
    clearTrailerProviderCacheForTest();
  });

  afterEach(() => {
    delete (window as any).ade;
    vi.restoreAllMocks();
  });

  describe("useLaneCommits", () => {
    it("paints the last commits after the mount commit, before a revisit's read lands", async () => {
      const ade = installAde();
      const first = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.map((c) => c.subject));
      await waitFor(() => expect(first.hook.result.current.commits).toHaveLength(1));
      first.hook.unmount();

      const pending = deferred<GitCommitSummary[]>();
      ade.git.listRecentCommits.mockReturnValueOnce(pending.promise);
      const revisit = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.map((c) => c.subject));

      // The mount commit has no rows; the cached rows land in a later render, while the read is still out.
      expect(revisit.seen[0]).toEqual([]);
      expect(revisit.hook.result.current.commits.map((c) => c.subject)).toEqual(["first"]);
      expect(revisit.hook.result.current.loaded).toBe(true);

      pending.resolve([commit("b", "second"), commit("a", "first")]);
      await waitFor(() => expect(revisit.hook.result.current.commits).toHaveLength(2));
    });

    it("never paints one lane's, one machine's, or one branch's commits under another", async () => {
      installAde();
      const seed = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.length);
      await waitFor(() => expect(seed.hook.result.current.commits).toHaveLength(1));
      seed.hook.unmount();

      // Checked on the renders made inside the mount's act, before the read can land.
      const otherLane = probe(() => useLaneCommits(lane({ id: "lane-2" }), 100, null), (v) => v.commits.length);
      expect(otherLane.seen.every((n) => n === 0)).toBe(true);
      otherLane.hook.unmount();

      const otherMachine = probe(() => useLaneCommits(lane(), 100, REMOTE_PIN), (v) => v.commits.length);
      expect(otherMachine.seen.every((n) => n === 0)).toBe(true);
      otherMachine.hook.unmount();

      const movedBranch = probe(
        () => useLaneCommits(lane({ branchRef: "refs/heads/ade/renamed" }), 100, null),
        (v) => v.commits.length,
      );
      expect(movedBranch.seen.every((n) => n === 0)).toBe(true);
    });

    it("drops its rows when a git mutation invalidates the lane", async () => {
      installAde();
      const seed = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.length);
      await waitFor(() => expect(seed.hook.result.current.commits).toHaveLength(1));
      seed.hook.unmount();

      invalidateLaneGitListCache("/repo", "lane-1");

      const after = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.length);
      expect(after.seen.every((n) => n === 0)).toBe(true);
    });

    it("clears its rows when a fresh read fails, so no cache-only rows stay beside an empty list", async () => {
      const ade = installAde();
      const seed = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.length);
      await waitFor(() => expect(seed.hook.result.current.commits).toHaveLength(1));
      seed.hook.unmount();

      ade.git.listRecentCommits.mockRejectedValueOnce(new Error("git failed"));
      const failed = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.length);
      await waitFor(() => expect(failed.hook.result.current.loaded).toBe(true));
      expect(failed.hook.result.current.commits).toEqual([]);
      failed.hook.unmount();

      const next = probe(() => useLaneCommits(lane(), 100, null), (v) => v.commits.length);
      expect(next.hook.result.current.commits).toEqual([]);
    });
  });

  describe("useLaneUpstream", () => {
    it("paints the last sync status after the mount commit and replaces it when the read lands", async () => {
      const ade = installAde();
      const seed = probe(() => useLaneUpstream(lane(), true, null), (v) => v?.ahead ?? null);
      await waitFor(() => expect(seed.hook.result.current?.ahead).toBe(2));
      seed.hook.unmount();

      const pending = deferred<typeof SYNC>();
      ade.git.getSyncStatus.mockReturnValueOnce(pending.promise);
      const revisit = probe(() => useLaneUpstream(lane(), true, null), (v) => v?.ahead ?? null);
      expect(revisit.seen[0]).toBeNull();
      expect(revisit.hook.result.current?.ahead).toBe(2);

      pending.resolve({ ...SYNC, ahead: 3 });
      await waitFor(() => expect(revisit.hook.result.current?.ahead).toBe(3));
    });

    it("is not shown for another machine, and is dropped by a git mutation", async () => {
      installAde();
      const seed = probe(() => useLaneUpstream(lane(), true, null), (v) => v?.ahead ?? null);
      await waitFor(() => expect(seed.hook.result.current?.ahead).toBe(2));
      seed.hook.unmount();

      const otherMachine = probe(() => useLaneUpstream(lane(), true, REMOTE_PIN), (v) => v?.ahead ?? null);
      expect(otherMachine.seen.every((n) => n === null)).toBe(true);
      otherMachine.hook.unmount();

      invalidateLaneGitListCache("/repo", "lane-1");
      const after = probe(() => useLaneUpstream(lane(), true, null), (v) => v?.ahead ?? null);
      expect(after.seen.every((n) => n === null)).toBe(true);
    });
  });

  describe("useLaneOperations and useLaneSessions", () => {
    it("paints the last operations and sessions after the mount commit", async () => {
      const ade = installAde();
      ade.history.listOperations.mockResolvedValueOnce([{ id: "op-1", laneId: "lane-1" }] as any);
      ade.agentChat.list.mockResolvedValueOnce([{ sessionId: "chat-1", laneId: "lane-1" }] as any);
      const seedOps = probe(() => useLaneOperations("lane-1", "k", null), (v) => v.length);
      const seedSessions = probe(() => useLaneSessions("lane-1", "k", null), (v) => v.chats.length);
      await waitFor(() => expect(seedOps.hook.result.current).toHaveLength(1));
      await waitFor(() => expect(seedSessions.hook.result.current.chats).toHaveLength(1));
      seedOps.hook.unmount();
      seedSessions.hook.unmount();

      const pendingOps = deferred<unknown[]>();
      const pendingChats = deferred<unknown[]>();
      ade.history.listOperations.mockReturnValueOnce(pendingOps.promise as any);
      ade.agentChat.list.mockReturnValueOnce(pendingChats.promise as any);
      const ops = probe(() => useLaneOperations("lane-1", "k", null), (v) => v.length);
      const sessions = probe(() => useLaneSessions("lane-1", "k", null), (v) => v.chats.length);
      expect(ops.seen[0]).toBe(0);
      expect(sessions.seen[0]).toBe(0);
      expect(ops.hook.result.current).toHaveLength(1);
      expect(sessions.hook.result.current.chats).toHaveLength(1);
      expect(sessions.hook.result.current.loaded).toBe(true);
      pendingOps.resolve([]);
      pendingChats.resolve([]);
      await waitFor(() => expect(ops.hook.result.current).toHaveLength(0));
      await waitFor(() => expect(sessions.hook.result.current.chats).toHaveLength(0));
    });
  });
});
