import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  clampPollIntervalSeconds,
  createPathToMergeOrchestrator,
  type PathToMergeDeps,
} from "./pathToMergeOrchestrator";
import { LaneWorktreeLockedError, formatLaneWorktreeLockBlocker } from "../lanes/laneWorktreeLockService";
import type {
  ConvergenceRuntimeState,
  LaneWorktreeLockInfo,
  LaneWorktreeLockOwnerKind,
  PrState,
  PrSummary,
} from "../../../shared/types";
import { DEFAULT_CONVERGENCE_RUNTIME_STATE } from "../../../shared/types/prs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildPrSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 42,
    githubUrl: "https://github.com/arul28/ADE/pull/42",
    githubNodeId: null,
    title: "Test PR",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/x",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  } as PrSummary;
}

// A faithful-enough lane worktree lock service: one lock per worktree path,
// re-acquirable only by the same owner. Mirrors the real service's guard.
function makeLaneWorktreeLockService() {
  let counter = 0;
  const locksByWorktree = new Map<string, LaneWorktreeLockInfo & { token: string }>();

  const acquire = vi.fn((args: {
    laneId: string;
    worktreePath: string;
    ownerKind: LaneWorktreeLockOwnerKind;
    ownerLabel: string;
    ownerPrId?: string | null;
    ownerSessionId?: string | null;
    ownerProposalId?: string | null;
    token?: string | null;
  }) => {
    const worktreeKey = args.worktreePath;
    const existing = locksByWorktree.get(worktreeKey) ?? null;
    const ownerMatches = existing
      && existing.ownerKind === args.ownerKind
      && existing.ownerPrId === (args.ownerPrId ?? null)
      && (!args.token || existing.token === args.token);
    if (existing && !ownerMatches) {
      throw new LaneWorktreeLockedError(formatLaneWorktreeLockBlocker(existing));
    }
    const token = existing?.token ?? args.token?.trim() ?? `lock-${++counter}`;
    const lock = {
      worktreeKey,
      worktreePath: args.worktreePath,
      laneId: args.laneId,
      ownerKind: args.ownerKind,
      ownerPrId: args.ownerPrId ?? null,
      ownerSessionId: args.ownerSessionId ?? null,
      ownerProposalId: args.ownerProposalId ?? null,
      ownerLabel: args.ownerLabel,
      token,
      createdAt: "2026-05-01T00:00:00.000Z",
      heartbeatAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-01T00:45:00.000Z",
    };
    locksByWorktree.set(worktreeKey, lock);
    return { token, lock };
  });
  const heartbeat = vi.fn((token: string) =>
    [...locksByWorktree.values()].find((entry) => entry.token === token) ?? null,
  );
  const attachSession = vi.fn((token: string, sessionId: string) => {
    const lock = [...locksByWorktree.values()].find((entry) => entry.token === token) ?? null;
    if (lock) lock.ownerSessionId = sessionId;
    return lock;
  });
  const release = vi.fn((args: { token?: string | null; ownerKind?: LaneWorktreeLockOwnerKind; ownerPrId?: string | null }) => {
    for (const [key, lock] of locksByWorktree.entries()) {
      if (args.token?.trim() && lock.token === args.token.trim()) {
        locksByWorktree.delete(key);
      } else if (!args.token && (!args.ownerKind || lock.ownerKind === args.ownerKind) && (args.ownerPrId === undefined || lock.ownerPrId === (args.ownerPrId ?? null))) {
        locksByWorktree.delete(key);
      }
    }
    return 1;
  });
  return { acquire, heartbeat, attachSession, release, sweepExpired: vi.fn(() => 0), getActiveForLane: vi.fn(() => []), locksByWorktree };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(opts: {
  worktreePath: string;
  prs?: PrSummary[];
  onWatchTurn?: () => void;
  initialRuntime?: Partial<ConvergenceRuntimeState>;
  initialArgs?: Record<string, unknown> | null;
}) {
  const prs = opts.prs ?? [buildPrSummary()];
  // `state` is read fresh on each listAll() so a turn can "merge" the PR.
  const stateByPrId = new Map<string, PrState>(prs.map((pr) => [pr.id, pr.state]));
  const setPrState = (prId: string, state: PrState) => stateByPrId.set(prId, state);

  const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
  if (opts.initialRuntime) {
    runtimeByPrId.set(prs[0]!.id, { prId: prs[0]!.id, ...DEFAULT_CONVERGENCE_RUNTIME_STATE, ...opts.initialRuntime });
  }
  const argsByPrId = new Map<string, Record<string, unknown> | null>();
  if (opts.initialArgs !== undefined) argsByPrId.set(prs[0]!.id, opts.initialArgs);

  const getConvergenceRuntime = vi.fn((prId: string): ConvergenceRuntimeState =>
    runtimeByPrId.get(prId) ?? { prId, ...DEFAULT_CONVERGENCE_RUNTIME_STATE },
  );
  const saveConvergenceRuntime = vi.fn((prId: string, patch: Partial<ConvergenceRuntimeState>): ConvergenceRuntimeState => {
    const prev = runtimeByPrId.get(prId) ?? { prId, ...DEFAULT_CONVERGENCE_RUNTIME_STATE };
    const next = { ...prev, ...patch, prId, updatedAt: "2026-05-01T01:00:00.000Z" };
    runtimeByPrId.set(prId, next);
    return next;
  });

  const issueInventoryService = {
    getConvergenceRuntime,
    saveConvergenceRuntime,
    savePathToMergeArgs: vi.fn((prId: string, args: Record<string, unknown> | null) => argsByPrId.set(prId, args)),
    getPathToMergeArgs: vi.fn((prId: string) => argsByPrId.get(prId) ?? null),
  };

  const refresh = vi.fn(async () => {});
  const runPostMergeCleanup = vi.fn(async () => {});
  const prService = {
    listAll: vi.fn(() => prs.map((pr) => ({ ...pr, state: stateByPrId.get(pr.id) ?? pr.state }))),
    refresh,
    runPostMergeCleanup,
  };

  const laneService = {
    getLaneBaseAndBranch: vi.fn(() => ({ worktreePath: opts.worktreePath, baseRef: "main", branchRef: "feature/x" })),
  };

  const createSession = vi.fn(async () => ({ id: "sess-1" }));
  const sendMessage = vi.fn(async (_args: { sessionId: string; text: string; displayText?: string; reasoningEffort?: string }) => {});
  const runSessionTurn = vi.fn(async (_args: { sessionId: string; text: string; timeoutMs?: number; reasoningEffort?: string }) => {
    opts.onWatchTurn?.();
  });
  const interrupt = vi.fn(async (_args: { sessionId: string }) => {});
  const agentChatService = { createSession, sendMessage, runSessionTurn, interrupt };

  const sessionService = { updateMeta: vi.fn() };
  const laneWorktreeLockService = makeLaneWorktreeLockService();

  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps = {
    logger,
    prService,
    laneService,
    agentChatService,
    sessionService,
    issueInventoryService,
    laneWorktreeLockService,
    defaultModelId: "openai/gpt-5.4",
    defaultReasoningEffort: null,
  } as unknown as PathToMergeDeps;

  return {
    deps,
    orchestrator: createPathToMergeOrchestrator(deps),
    runtimeByPrId,
    argsByPrId,
    setPrState,
    createSession,
    sendMessage,
    runSessionTurn,
    interrupt,
    refresh,
    runPostMergeCleanup,
    sessionService,
    laneWorktreeLockService,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clampPollIntervalSeconds", () => {
  it("falls back to the default for missing or non-finite values", () => {
    expect(clampPollIntervalSeconds(null)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(clampPollIntervalSeconds(undefined)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(clampPollIntervalSeconds(Number.NaN)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
  });

  it("clamps to the [min, max] window", () => {
    expect(clampPollIntervalSeconds(1)).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollIntervalSeconds(10_000)).toBe(MAX_POLL_INTERVAL_SECONDS);
    expect(clampPollIntervalSeconds(120)).toBe(120);
  });
});

describe("createPathToMergeOrchestrator", () => {
  let worktreePath: string;
  let harness: Harness | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "ptm-test-"));
  });

  afterEach(() => {
    harness?.orchestrator.dispose();
    harness = null;
    vi.useRealTimers();
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  it("launches a visible workflow chat seeded with the standing contract and arms the watch timer", async () => {
    harness = makeHarness({ worktreePath });
    const result = await harness.orchestrator.startPathToMerge({
      prId: "pr-1",
      scope: "checks",
      additionalInstructions: "Be gentle",
      pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS,
    });

    expect(result.scheduled).toBe(true);
    expect(result.runtime.status).toBe("running");
    expect(result.runtime.autoConvergeEnabled).toBe(true);

    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "work", sessionProfile: "workflow", laneId: "lane-1" }),
    );
    expect(harness.sessionService.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", title: "Path to Merge #42" }),
    );

    const seedText = harness.sendMessage.mock.calls[0]?.[0]?.text as string;
    expect(seedText).toContain("Path to Merge watcher for pull request #42");
    expect(seedText).toContain("GATING = CI ONLY.");
    expect(seedText).toContain("Be gentle");

    // The persisted args let resumeFromPersistedState rebuild the watcher.
    expect(harness.argsByPrId.get("pr-1")).toMatchObject({ scope: "checks", pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS });
  });

  it("injects a fresh watch turn each interval and reschedules while the PR stays open", async () => {
    harness = makeHarness({ worktreePath });
    await harness.orchestrator.startPathToMerge({ prId: "pr-1", pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS });

    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(harness.runSessionTurn).toHaveBeenCalledTimes(1);
    const watchText = harness.runSessionTurn.mock.calls[0]?.[0]?.text as string;
    expect(watchText).toContain("Watch turn for PR #42");
    expect(harness.refresh).toHaveBeenCalled();

    // Still open → a new timer was armed; the next interval injects another turn.
    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(harness.runSessionTurn).toHaveBeenCalledTimes(2);
  });

  it("stops the loop on a ground-truth merge and runs post-merge cleanup", async () => {
    harness = makeHarness({
      worktreePath,
      // The agent merges the PR during its turn; ground truth then confirms it.
      onWatchTurn: () => harness!.setPrState("pr-1", "merged"),
    });
    await harness.orchestrator.startPathToMerge({ prId: "pr-1", pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS });

    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(harness.runSessionTurn).toHaveBeenCalledTimes(1);
    expect(harness.runPostMergeCleanup).toHaveBeenCalledTimes(1);
    expect(harness.runtimeByPrId.get("pr-1")?.status).toBe("merged");

    // No further turns: the timer was not rescheduled after merge.
    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(harness.runSessionTurn).toHaveBeenCalledTimes(1);
  });

  it("stops the loop when the PR is closed without merging", async () => {
    harness = makeHarness({
      worktreePath,
      onWatchTurn: () => harness!.setPrState("pr-1", "closed"),
    });
    await harness.orchestrator.startPathToMerge({ prId: "pr-1", pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS });

    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(harness.runPostMergeCleanup).not.toHaveBeenCalled();
    expect(harness.runtimeByPrId.get("pr-1")?.status).toBe("stopped");

    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(harness.runSessionTurn).toHaveBeenCalledTimes(1);
  });

  it("re-arms the watch timer for a live watcher on resumeFromPersistedState", async () => {
    harness = makeHarness({
      worktreePath,
      initialRuntime: {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
        activeSessionId: "sess-resumed",
        activeLaneId: "lane-1",
      },
      initialArgs: { modelId: "openai/gpt-5.4", scope: "both", pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS },
    });

    harness.orchestrator.resumeFromPersistedState();
    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);

    expect(harness.runSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-resumed" }),
    );
  });

  it("interrupts the chat and tears the watcher down on stop", async () => {
    harness = makeHarness({ worktreePath });
    await harness.orchestrator.startPathToMerge({ prId: "pr-1", pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS });

    const result = await harness.orchestrator.stopPathToMerge({ prId: "pr-1", reason: "manual stop" });
    expect(result.stopped).toBe(true);
    expect(result.runtime?.status).toBe("stopped");
    expect(harness.interrupt).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(harness.argsByPrId.get("pr-1")).toBeNull();

    // The timer is gone: advancing does not inject another turn.
    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(harness.runSessionTurn).not.toHaveBeenCalled();
  });

  it("blocks the launch when the lane worktree is already locked by another owner", async () => {
    harness = makeHarness({ worktreePath });
    // Some other owner holds the lane worktree lock.
    harness.laneWorktreeLockService.acquire({
      laneId: "lane-1",
      worktreePath,
      ownerKind: "path_to_merge",
      ownerPrId: "someone-else",
      ownerLabel: "Another holder",
    });

    const result = await harness.orchestrator.startPathToMerge({ prId: "pr-1", pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS });
    expect(result.scheduled).toBe(false);
    expect(result.blockedBy).toBeTruthy();
    expect(result.runtime.status).toBe("paused");
    expect(harness.createSession).not.toHaveBeenCalled();
  });
});
