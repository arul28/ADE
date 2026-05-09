import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchPrIssueResolutionChat } from "./prIssueResolver";
import {
  PHASE_DELAY_SECONDS,
  createPathToMergeOrchestrator,
  decideAtCapAction,
  makeInProcessState,
  type InProcessState,
  type PathToMergeDeps,
} from "./pathToMergeOrchestrator";
import { LaneWorktreeLockedError, formatLaneWorktreeLockBlocker } from "../lanes/laneWorktreeLockService";
import type {
  AtCapPolicy,
  ConvergenceRuntimeState,
  LaneWorktreeLockInfo,
  LaneWorktreeLockOwnerKind,
  PipelineSettings,
  PrCheck,
  PrReview,
  PrReviewThread,
  PrSummary,
} from "../../../shared/types";
import { DEFAULT_CONVERGENCE_RUNTIME_STATE, DEFAULT_PIPELINE_SETTINGS } from "../../../shared/types/prs";

vi.mock("./prIssueResolver", () => ({
  launchPrIssueResolutionChat: vi.fn(async () => ({
    sessionId: "sess-launched",
    laneId: "lane-1",
    href: "/work?laneId=lane-1&sessionId=sess-launched",
  })),
}));

const launchPrIssueResolutionChatMock = vi.mocked(launchPrIssueResolutionChat);

// ---------------------------------------------------------------------------
// Test scaffolding — fake all deps. The orchestrator's public surface is just
// startPathToMerge / stopPathToMerge / resumeFromPersistedState / dispose, so
// almost every dep can be a no-op for these tests. Iterations are kicked off
// via setImmediate from startPathToMerge, but with prService.listAll() returning
// `[]` they abort at the "PR missing" branch before touching any other dep.
// ---------------------------------------------------------------------------

function buildRuntime(prId: string, overrides: Partial<ConvergenceRuntimeState> = {}): ConvergenceRuntimeState {
  return {
    prId,
    ...DEFAULT_CONVERGENCE_RUNTIME_STATE,
    ...overrides,
  };
}

function buildPrSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    githubPrNumber: 1,
    state: "open",
    title: "Test PR",
    headBranch: "feature/x",
    baseBranch: "main",
    headSha: null,
    htmlUrl: null,
    body: null,
    bodyMarkdown: null,
    bodyAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    isDraft: false,
    mergeable: null,
    mergeableState: null,
    mergeStateStatus: null,
    behindBaseBy: 0,
    aheadOfBaseBy: 0,
    checksStatus: "passing",
    reviewStatus: "approved",
    requestedReviewers: [],
    reviewers: [],
    assignees: [],
    labels: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    autoMergeEnabled: false,
    autoMergeMethod: null,
    autoMergeBy: null,
    ...overrides,
  } as PrSummary;
}

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "ci / unit",
    status: "completed",
    conclusion: "failure",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeReviewThread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/prs.ts",
    line: 1,
    originalLine: 1,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    url: null,
    createdAt: null,
    updatedAt: null,
    comments: [],
    ...overrides,
  };
}

function makeReview(overrides: Partial<PrReview> = {}): PrReview {
  return {
    reviewer: "coderabbitai",
    reviewerAvatarUrl: null,
    state: "commented",
    body: "Actionable comments posted: 1",
    submittedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

async function flushIteration(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await Promise.resolve();
}

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
      && existing.ownerProposalId === (args.ownerProposalId ?? null)
      && (!args.ownerSessionId || existing.ownerSessionId === args.ownerSessionId)
      && (!args.token || existing.token === args.token);
    if (existing && !ownerMatches) {
      throw new LaneWorktreeLockedError(formatLaneWorktreeLockBlocker(existing));
    }
    const token = existing?.token ?? args.token?.trim() ?? `lock-${++counter}`;
    const now = "2026-05-01T00:00:00.000Z";
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
      createdAt: existing?.createdAt ?? now,
      heartbeatAt: now,
      expiresAt: "2026-05-01T00:45:00.000Z",
    };
    locksByWorktree.set(worktreeKey, lock);
    return { token, lock };
  });
  const heartbeat = vi.fn((token: string) => {
    const lock = [...locksByWorktree.values()].find((entry) => entry.token === token) ?? null;
    return lock;
  });
  const attachSession = vi.fn((token: string, sessionId: string) => {
    const lock = [...locksByWorktree.values()].find((entry) => entry.token === token) ?? null;
    if (lock) lock.ownerSessionId = sessionId;
    return lock;
  });
  const release = vi.fn((args: {
    token?: string | null;
    ownerKind?: LaneWorktreeLockOwnerKind;
    ownerPrId?: string | null;
    ownerSessionId?: string | null;
    ownerProposalId?: string | null;
  }) => {
    for (const [key, lock] of locksByWorktree.entries()) {
      if (args.token?.trim() && lock.token === args.token.trim()) {
        locksByWorktree.delete(key);
      } else if (
        (!args.ownerKind || lock.ownerKind === args.ownerKind)
        && (args.ownerPrId === undefined || lock.ownerPrId === (args.ownerPrId ?? null))
        && (args.ownerSessionId === undefined || lock.ownerSessionId === (args.ownerSessionId ?? null))
        && (args.ownerProposalId === undefined || lock.ownerProposalId === (args.ownerProposalId ?? null))
      ) {
        locksByWorktree.delete(key);
      }
    }
    return 1;
  });
  return {
    acquire,
    heartbeat,
    attachSession,
    release,
    sweepExpired: vi.fn(() => 0),
    getActiveForLane: vi.fn((laneId: string) =>
      [...locksByWorktree.values()].filter((entry) => entry.laneId === laneId),
    ),
    locksByWorktree,
  };
}

function buildDeps(initial?: {
  runtimeByPrId?: Map<string, ConvergenceRuntimeState>;
  ptmArgsByPrId?: Map<string, Record<string, unknown> | null>;
  prs?: PrSummary[];
  pipelineSettings?: Partial<PipelineSettings>;
  convergenceStatus?: Partial<ReturnType<PathToMergeDeps["issueInventoryService"]["getConvergenceStatus"]>>;
  getSessionSummary?: PathToMergeDeps["agentChatService"]["getSessionSummary"];
  refresh?: PathToMergeDeps["prService"]["refresh"];
  getStatus?: PathToMergeDeps["prService"]["getStatus"];
  getChecks?: PathToMergeDeps["prService"]["getChecks"];
  getReviewThreads?: PathToMergeDeps["prService"]["getReviewThreads"];
  getReviews?: PathToMergeDeps["prService"]["getReviews"];
  getComments?: PathToMergeDeps["prService"]["getComments"];
  getCommits?: PathToMergeDeps["prService"]["getCommits"];
  getFiles?: PathToMergeDeps["prService"]["getFiles"];
  addComment?: PathToMergeDeps["prService"]["addComment"];
  land?: PathToMergeDeps["prService"]["land"];
  laneWorktreeLockService?: ReturnType<typeof makeLaneWorktreeLockService>;
}): {
  deps: PathToMergeDeps;
  runtimeByPrId: Map<string, ConvergenceRuntimeState>;
  ptmArgsByPrId: Map<string, Record<string, unknown> | null>;
  interrupt: ReturnType<typeof vi.fn>;
  resetSentToAgent: ReturnType<typeof vi.fn>;
  addComment: PathToMergeDeps["prService"]["addComment"];
  land: PathToMergeDeps["prService"]["land"];
  laneWorktreeLockService: ReturnType<typeof makeLaneWorktreeLockService>;
} {
  const runtimeByPrId = initial?.runtimeByPrId ?? new Map<string, ConvergenceRuntimeState>();
  const ptmArgsByPrId = initial?.ptmArgsByPrId ?? new Map<string, Record<string, unknown> | null>();
  const prs = initial?.prs ?? [];
  const prById = (prId: string) => prs.find((pr) => pr.id === prId) ?? prs[0] ?? null;
  let convergenceStatus = {
    currentRound: 0,
    maxRounds: 5,
    issuesPerRound: [],
    totalNew: 0,
    totalFixed: 0,
    totalDismissed: 0,
    totalEscalated: 0,
    totalSentToAgent: 0,
    isConverging: false,
    canAutoAdvance: false,
    ...initial?.convergenceStatus,
  } as ReturnType<PathToMergeDeps["issueInventoryService"]["getConvergenceStatus"]>;

  const interrupt = vi.fn(async (_args: { sessionId: string }) => undefined);
  const resetSentToAgent = vi.fn();
  const laneWorktreeLockService = initial?.laneWorktreeLockService ?? makeLaneWorktreeLockService();
  const land = initial?.land ?? vi.fn(async () => ({
    prId: "pr-1",
    prNumber: 1,
    success: false,
    mergeCommitSha: null,
    branchDeleted: false,
    laneArchived: false,
    error: "test",
  }));
  const addComment = initial?.addComment ?? vi.fn(async (args: { prId: string; body: string }) => ({
    id: `comment-${args.body}`,
    author: "ade",
    authorAvatarUrl: null,
    body: args.body,
    source: "issue" as const,
    url: null,
    path: null,
    line: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  }));

  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as PathToMergeDeps["logger"];

  const deps: PathToMergeDeps = {
    logger,
    prService: {
      listAll: () => prs,
      // Iterations call refresh/getStatus/getChecks/land/runPostMergeCleanup,
      // but with `prs = []` the iteration aborts before reaching them.
      refresh: initial?.refresh ?? (async () => undefined),
      getStatus: initial?.getStatus ?? (async () => ({ behindBaseBy: 0 })),
      getChecks: initial?.getChecks ?? (async (prId: string) => {
        const pr = prById(prId);
        if (pr?.checksStatus === "passing") return [makeCheck({ conclusion: "success" })];
        if (pr?.checksStatus === "pending") return [makeCheck({ status: "in_progress", conclusion: null })];
        if (pr?.checksStatus === "failing") return [makeCheck()];
        return [];
      }),
      getReviewThreads: initial?.getReviewThreads ?? (async (prId: string) => {
        const pr = prById(prId);
        return pr?.reviewStatus === "changes_requested" ? [makeReviewThread()] : [];
      }),
      getReviews: initial?.getReviews ?? (async (prId: string) => {
        const pr = prById(prId);
        return pr?.reviewStatus === "changes_requested" ? [makeReview({ state: "changes_requested", body: "Please fix this." })] : [];
      }),
      getComments: initial?.getComments ?? (async () => []),
      getCommits: initial?.getCommits ?? (async () => []),
      getFiles: initial?.getFiles ?? (async () => []),
      addComment,
      land,
      runPostMergeCleanup: async () => undefined,
    } as unknown as PathToMergeDeps["prService"],
    laneService: {
      list: async () => [],
      getLaneBaseAndBranch: () => ({ worktreePath: "/tmp/lane", baseRef: "main", branchRef: "feature/x" }),
    } as unknown as PathToMergeDeps["laneService"],
    agentChatService: {
      createSession: async () => ({ id: "sess" }),
      sendMessage: async () => undefined,
      previewSessionToolNames: async () => [],
      interrupt,
      getSessionSummary: initial?.getSessionSummary ?? (async () => null),
    } as unknown as PathToMergeDeps["agentChatService"],
    sessionService: {
      updateMeta: async () => undefined,
    } as unknown as PathToMergeDeps["sessionService"],
    issueInventoryService: {
      saveConvergenceRuntime: (prId: string, patch: Partial<ConvergenceRuntimeState>) => {
        const prev = runtimeByPrId.get(prId) ?? buildRuntime(prId);
        const next: ConvergenceRuntimeState = {
          ...prev,
          ...patch,
          prId,
          pathToMergeActive: ptmArgsByPrId.get(prId) != null,
        };
        runtimeByPrId.set(prId, next);
        return next;
      },
      getConvergenceRuntime: (prId: string) => ({
        ...(runtimeByPrId.get(prId) ?? buildRuntime(prId)),
        pathToMergeActive: ptmArgsByPrId.get(prId) != null,
      }),
      savePathToMergeArgs: (prId: string, args: Record<string, unknown> | null) => {
        ptmArgsByPrId.set(prId, args);
      },
      getPathToMergeArgs: (prId: string) => ptmArgsByPrId.get(prId) ?? null,
      resetSentToAgent,
      getPipelineSettings: () => ({ ...DEFAULT_PIPELINE_SETTINGS, ...initial?.pipelineSettings }),
      getConvergenceStatus: () => convergenceStatus,
      syncFromPrData: (_prId: string, checks: PrCheck[], reviewThreads: PrReviewThread[], comments: PrComment[]) => {
        const totalNew = checks.filter((check) => check.conclusion === "failure").length
          + reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated).length
          + comments.length;
        convergenceStatus = {
          ...convergenceStatus,
          totalNew,
        };
        return {
          prId: _prId,
          items: [],
          convergence: convergenceStatus,
          runtime: runtimeByPrId.get(_prId) ?? buildRuntime(_prId),
        };
      },
    } as unknown as PathToMergeDeps["issueInventoryService"],
    conflictService: {
      runExternalResolver: async () => ({ status: "completed" }),
    } as unknown as PathToMergeDeps["conflictService"],
    laneWorktreeLockService: laneWorktreeLockService as unknown as PathToMergeDeps["laneWorktreeLockService"],
    defaultModelId: null,
    defaultReasoningEffort: null,
  };

  return { deps, runtimeByPrId, ptmArgsByPrId, interrupt, resetSentToAgent, addComment, land, laneWorktreeLockService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  launchPrIssueResolutionChatMock.mockClear();
  launchPrIssueResolutionChatMock.mockResolvedValue({
    sessionId: "sess-launched",
    laneId: "lane-1",
    href: "/work?laneId=lane-1&sessionId=sess-launched",
  });
});

describe("PHASE_DELAY_SECONDS", () => {
  it("matches the shipLane.md §5.3 phase-delay contract exactly", () => {
    // These values are part of the public contract — the orchestrator JSDoc
    // pins them to 270/720/1800 from shipLane.md. Drift here changes operator
    // expectations and must be a deliberate doc-update commit.
    expect(PHASE_DELAY_SECONDS.justPushed).toBe(270);
    expect(PHASE_DELAY_SECONDS.warming).toBe(720);
    expect(PHASE_DELAY_SECONDS.waitingOnReview).toBe(1800);
  });
});

describe("createPathToMergeOrchestrator.startPathToMerge", () => {
  it("rejects an empty prId so callers can't accidentally arm a global loop", async () => {
    const { deps } = buildDeps();
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await expect(orchestrator.startPathToMerge({ prId: "" })).rejects.toThrow(/prId is required/);
      await expect(orchestrator.startPathToMerge({ prId: "   " })).rejects.toThrow(/prId is required/);
    } finally {
      orchestrator.dispose();
    }
  });

  it("persists the launching runtime state and original run args before scheduling", async () => {
    const { deps, runtimeByPrId, ptmArgsByPrId } = buildDeps();
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      const result = await orchestrator.startPathToMerge({
        prId: "pr-1",
        modelId: "claude-opus",
        reasoning: "high",
        permissionMode: "default",
        scope: "checks",
        additionalInstructions: "be thorough",
      });

      expect(result.scheduled).toBe(true);
      expect(result.prId).toBe("pr-1");
      expect(result.runtime.autoConvergeEnabled).toBe(true);
      expect(result.runtime.pathToMergeActive).toBe(true);
      expect(result.runtime.status).toBe("launching");
      expect(result.runtime.pollerStatus).toBe("scheduled");

      const persisted = runtimeByPrId.get("pr-1");
      expect(persisted?.autoConvergeEnabled).toBe(true);
      expect(persisted?.status).toBe("launching");
      expect(persisted?.lastStartedAt).toBeTruthy();

      // Run args are persisted so a desktop restart can resume with the same
      // model/reasoning/scope rather than pausing on "No modelId available".
      expect(ptmArgsByPrId.get("pr-1")).toEqual({
        modelId: "claude-opus",
        reasoning: "high",
        permissionMode: "default",
        scope: "checks",
        additionalInstructions: "be thorough",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("blocks a second PR that shares the same lane worktree until the first PtM lock is released", async () => {
    const sharedLockService = makeLaneWorktreeLockService();
    const prOne = buildPrSummary({ id: "pr-1", laneId: "lane-1", githubPrNumber: 1, title: "First" });
    const prTwo = buildPrSummary({ id: "pr-2", laneId: "lane-1", githubPrNumber: 2, title: "Second" });
    const { deps } = buildDeps({
      prs: [prOne, prTwo],
      laneWorktreeLockService: sharedLockService,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      const first = await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "model-a" });
      const second = await orchestrator.startPathToMerge({ prId: "pr-2", modelId: "model-a" });

      expect(first.scheduled).toBe(true);
      expect(second.scheduled).toBe(false);
      expect(second.blockedBy?.message).toContain("Path to Merge for PR #1");
      expect(second.runtime.status).toBe("paused");
      expect(second.runtime.autoConvergeEnabled).toBe(false);

      await orchestrator.stopPathToMerge({ prId: "pr-1", reason: "test release" });
      const retry = await orchestrator.startPathToMerge({ prId: "pr-2", modelId: "model-a" });
      expect(retry.scheduled).toBe(true);
    } finally {
      orchestrator.dispose();
    }
  });
});

describe("createPathToMergeOrchestrator.stopPathToMerge", () => {
  it("rejects an empty prId so a typo can't accidentally clear unrelated state", async () => {
    const { deps } = buildDeps();
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await expect(orchestrator.stopPathToMerge({ prId: "" })).rejects.toThrow(/prId is required/);
      await expect(orchestrator.stopPathToMerge({ prId: "  \t" })).rejects.toThrow(/prId is required/);
    } finally {
      orchestrator.dispose();
    }
  });

  it("interrupts the active fix-agent session and records the stop reason", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>([
      ["pr-1", buildRuntime("pr-1", {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
        activeSessionId: "sess-active",
      })],
    ]);
    const ptmArgsByPrId = new Map<string, Record<string, unknown> | null>([
      ["pr-1", { modelId: "claude-opus", reasoning: null, scope: "both", additionalInstructions: null }],
    ]);
    const { deps, interrupt, resetSentToAgent } = buildDeps({ runtimeByPrId, ptmArgsByPrId });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      const result = await orchestrator.stopPathToMerge({ prId: "pr-1", reason: "operator paused" });

      expect(result.stopped).toBe(true);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(interrupt).toHaveBeenCalledWith({ sessionId: "sess-active" });
      expect(resetSentToAgent).toHaveBeenCalledWith("pr-1", { sessionId: "sess-active" });

      const persisted = runtimeByPrId.get("pr-1");
      expect(persisted?.autoConvergeEnabled).toBe(false);
      expect(persisted?.status).toBe("stopped");
      expect(persisted?.activeSessionId).toBeNull();
      expect(persisted?.pauseReason).toBe("operator paused");
      expect(persisted?.lastStoppedAt).toBeTruthy();

      // Persisted run-args must be cleared so a future resume doesn't think
      // this PR is still in flight.
      expect(ptmArgsByPrId.get("pr-1")).toBeNull();
    } finally {
      orchestrator.dispose();
    }
  });

  it("does not call interrupt when no fix-agent session is recorded", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>([
      ["pr-1", buildRuntime("pr-1", {
        autoConvergeEnabled: true,
        status: "paused",
        pollerStatus: "paused",
        activeSessionId: null,
      })],
    ]);
    const { deps, interrupt } = buildDeps({ runtimeByPrId });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      const result = await orchestrator.stopPathToMerge({ prId: "pr-1" });

      expect(result.stopped).toBe(true);
      expect(interrupt).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")?.status).toBe("stopped");
    } finally {
      orchestrator.dispose();
    }
  });
});

describe("createPathToMergeOrchestrator.resumeFromPersistedState", () => {
  it("only rearms PRs whose runtime is still flagged as live", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>([
      // Live — should be rearmed.
      ["pr-live", buildRuntime("pr-live", {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
      })],
      // Already merged — should be skipped.
      ["pr-merged", buildRuntime("pr-merged", {
        autoConvergeEnabled: true,
        status: "merged",
        pollerStatus: "polling",
      })],
      // Operator-stopped — should be skipped.
      ["pr-stopped", buildRuntime("pr-stopped", {
        autoConvergeEnabled: true,
        status: "stopped",
        pollerStatus: "polling",
      })],
      // Disabled — should be skipped.
      ["pr-disabled", buildRuntime("pr-disabled", {
        autoConvergeEnabled: false,
        status: "running",
        pollerStatus: "polling",
      })],
      // Poller already stopped — should be skipped.
      ["pr-poller-stopped", buildRuntime("pr-poller-stopped", {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "stopped",
      })],
    ]);
    const ptmArgsByPrId = new Map<string, Record<string, unknown> | null>();
    const prs = [
      buildPrSummary({ id: "pr-live" }),
      buildPrSummary({ id: "pr-merged" }),
      buildPrSummary({ id: "pr-stopped" }),
      buildPrSummary({ id: "pr-disabled" }),
      buildPrSummary({ id: "pr-poller-stopped" }),
    ];
    const { deps, interrupt } = buildDeps({ runtimeByPrId, ptmArgsByPrId, prs });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      // resumeFromPersistedState walks every PR, filters by runtime, and
      // arms a `warming` timer for each survivor. We don't let the timer
      // fire (dispose tears it down), but the resume call itself must:
      //   - never throw on terminal/disabled rows;
      //   - never call interrupt (no session kill is implied by resume);
      //   - leave dispose able to clean up cleanly.
      expect(() => orchestrator.resumeFromPersistedState()).not.toThrow();
      expect(interrupt).not.toHaveBeenCalled();
      // Stopping a non-live PR must not call interrupt either — the
      // pre-resume row had no activeSessionId, and resume doesn't synthesize
      // one for filtered-out PRs.
      await orchestrator.stopPathToMerge({ prId: "pr-merged" });
      await orchestrator.stopPathToMerge({ prId: "pr-disabled" });
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      orchestrator.dispose();
    }
  });

  it("rehydrates persisted run args back onto the resumed PR", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>([
      ["pr-1", buildRuntime("pr-1", {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
      })],
    ]);
    const ptmArgsByPrId = new Map<string, Record<string, unknown> | null>([
      ["pr-1", { modelId: "claude-opus", reasoning: "high", permissionMode: "default", scope: "checks", additionalInstructions: "x" }],
    ]);
    const { deps } = buildDeps({
      runtimeByPrId,
      ptmArgsByPrId,
      prs: [buildPrSummary({ id: "pr-1" })],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      // Should not throw, regardless of whether the timer fires.
      orchestrator.resumeFromPersistedState();

      // Stop the resumed PR — its in-process runArgs were rehydrated, so
      // stopPathToMerge clears the state cleanly.
      const result = await orchestrator.stopPathToMerge({ prId: "pr-1" });
      expect(result.stopped).toBe(true);
      expect(runtimeByPrId.get("pr-1")?.status).toBe("stopped");
    } finally {
      orchestrator.dispose();
    }
  });
});

describe("createPathToMergeOrchestrator.runIteration", () => {
  it("parks a clean inventory without dispatching a fix agent when auto-merge is off", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "none" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: false },
      convergenceStatus: { totalNew: 0 },
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "converged",
        pollerStatus: "waiting_for_comments",
        pauseReason: "Inventory clean; nothing to dispatch.",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("runs the merge ladder for a merge-ready clean inventory when auto-merge is on", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "approved" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true },
      convergenceStatus: { totalNew: 0 },
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(land).toHaveBeenCalledWith({ prId: "pr-1", method: "squash", archiveLane: false });
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "merged",
        pollerStatus: "stopped",
        autoConvergeEnabled: false,
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("pauses instead of rescheduling when clean inventory cannot ever satisfy CI readiness", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "none", reviewStatus: "none" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true },
      convergenceStatus: { totalNew: 0 },
      getChecks: async () => [],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "paused",
        pollerStatus: "paused",
        autoConvergeEnabled: false,
        pauseReason: "Clean inventory cannot auto-merge.",
        errorMessage: "Auto-merge blocked because CI is none.",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("blocks auto-merge for clean inventory when commented reviews still need review", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "none" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true },
      convergenceStatus: { totalNew: 0 },
      getReviews: async () => [makeReview()],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "converged",
        pollerStatus: "waiting_for_comments",
        pauseReason: expect.stringContaining("commented review"),
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("ignores superseded commented reviews when the reviewer later approves", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "approved" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true },
      convergenceStatus: { totalNew: 0 },
      getReviews: async () => [
        makeReview({
          reviewer: "reviewer-1",
          state: "commented",
          body: "Looks good after one tweak.",
          submittedAt: "2026-05-01T00:00:00.000Z",
        }),
        makeReview({
          reviewer: "reviewer-1",
          state: "approved",
          body: null,
          submittedAt: "2026-05-01T01:00:00.000Z",
        }),
      ],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(land).toHaveBeenCalledWith({ prId: "pr-1", method: "squash", archiveLane: false });
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "merged",
        pollerStatus: "stopped",
        autoConvergeEnabled: false,
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("heartbeats the PtM lane lock before scheduling a long wait", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const laneWorktreeLockService = makeLaneWorktreeLockService();
    const { deps } = buildDeps({
      runtimeByPrId,
      laneWorktreeLockService,
      prs: [buildPrSummary({ checksStatus: "pending", reviewStatus: "none" })],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(laneWorktreeLockService.heartbeat).toHaveBeenCalledWith("lock-1");
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "running",
        pollerStatus: "waiting_for_checks",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("waits for pending review-bot checks before dispatching a fix iteration", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const pendingReviewCheckStartedAt = new Date().toISOString();
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "none" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: false },
      convergenceStatus: { totalNew: 1 },
      getChecks: async () => [
        makeCheck({ name: "ci / unit", status: "completed", conclusion: "success" }),
        makeCheck({ name: "Greptile Review", status: "in_progress", conclusion: null, startedAt: pendingReviewCheckStartedAt }),
      ],
      getReviewThreads: async () => [makeReviewThread()],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "running",
        pollerStatus: "waiting_for_comments",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("posts review-bot pings and waits after observing a fix-agent push", async () => {
    vi.useFakeTimers();
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>([
      ["pr-1", buildRuntime("pr-1", {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
        activeSessionId: "sess-1",
        lastDispatchHeadSha: "sha-before",
      })],
    ]);
    const ptmArgsByPrId = new Map<string, Record<string, unknown> | null>([
      ["pr-1", { modelId: "openai/gpt-5.4", reasoning: null, permissionMode: "default", scope: "both", additionalInstructions: null }],
    ]);
    const addComment = vi.fn(async (args: { prId: string; body: string }) => ({
      id: `comment-${args.body}`,
      author: "ade",
      authorAvatarUrl: null,
      body: args.body,
      source: "issue" as const,
      url: null,
      path: null,
      line: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      ptmArgsByPrId,
      prs: [buildPrSummary({ checksStatus: "failing", reviewStatus: "changes_requested" })],
      pipelineSettings: { earlyMergeOnGreen: false },
      convergenceStatus: { totalNew: 1 },
      getFiles: async () => Array.from({ length: 251 }, (_, index) => ({
        filename: `file-${index}.ts`,
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        patch: null,
        previousFilename: null,
      })),
      getCommits: async () => [{
        sha: "sha-after",
        shortSha: "sha-after",
        message: "fix",
        author: { login: null, name: "Test", email: null },
        committedDate: "2026-05-01T00:01:00.000Z",
      }],
      getSessionSummary: async () => ({ status: "idle", awaitingInput: false }) as Awaited<ReturnType<PathToMergeDeps["agentChatService"]["getSessionSummary"]>>,
      addComment: addComment as unknown as PathToMergeDeps["prService"]["addComment"],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      orchestrator.resumeFromPersistedState();
      await vi.advanceTimersByTimeAsync(PHASE_DELAY_SECONDS.warming * 1000);

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(addComment).toHaveBeenCalledTimes(3);
      expect(addComment.mock.calls.map((call) => call[0].body)).toEqual([
        "@copilot review but do not make fixes",
        "@greptile review",
        "@coderabbit review",
      ]);
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        activeSessionId: null,
        pollerStatus: "waiting_for_comments",
        lastDispatchHeadSha: null,
      });
    } finally {
      orchestrator.dispose();
      vi.useRealTimers();
    }
  });

  it("does not repost review-bot pings for a restored head SHA", async () => {
    vi.useFakeTimers();
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>([
      ["pr-1", buildRuntime("pr-1", {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
        activeSessionId: "sess-1",
        lastDispatchHeadSha: "sha-before",
        lastBotPingHeadSha: "sha-after",
        lastBotPingAt: "2026-05-01T00:02:00.000Z",
      })],
    ]);
    const ptmArgsByPrId = new Map<string, Record<string, unknown> | null>([
      ["pr-1", { modelId: "openai/gpt-5.4", reasoning: null, permissionMode: "default", scope: "both", additionalInstructions: null }],
    ]);
    const addComment = vi.fn();
    const { deps } = buildDeps({
      runtimeByPrId,
      ptmArgsByPrId,
      prs: [buildPrSummary({ checksStatus: "failing", reviewStatus: "changes_requested" })],
      pipelineSettings: { earlyMergeOnGreen: false },
      convergenceStatus: { totalNew: 1 },
      getCommits: async () => [{
        sha: "sha-after",
        shortSha: "sha-after",
        message: "fix",
        author: { login: null, name: "Test", email: null },
        committedDate: "2026-05-01T00:01:00.000Z",
      }],
      getSessionSummary: async () => ({ status: "idle", awaitingInput: false }) as Awaited<ReturnType<PathToMergeDeps["agentChatService"]["getSessionSummary"]>>,
      addComment: addComment as unknown as PathToMergeDeps["prService"]["addComment"],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      orchestrator.resumeFromPersistedState();
      await vi.advanceTimersByTimeAsync(PHASE_DELAY_SECONDS.warming * 1000);

      expect(addComment).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        activeSessionId: null,
        pollerStatus: "waiting_for_comments",
        lastDispatchHeadSha: null,
        lastBotPingHeadSha: "sha-after",
        lastBotPingAt: "2026-05-01T00:02:00.000Z",
      });
    } finally {
      orchestrator.dispose();
      vi.useRealTimers();
    }
  });

  it("does not wait forever on stale review-bot checks", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "requested" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true, atCapPolicy: "ci_retry_once" },
      convergenceStatus: { totalNew: 0 },
      getChecks: async () => [
        makeCheck({ name: "ci / unit", status: "completed", conclusion: "success" }),
        makeCheck({
          name: "Greptile Review",
          status: "in_progress",
          conclusion: null,
          startedAt: "2026-05-01T00:00:00.000Z",
        }),
      ],
      getReviewThreads: async () => [],
      getReviews: async () => [],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      runtimeByPrId.set("pr-1", {
        ...runtimeByPrId.get("pr-1")!,
        currentRound: 5,
      });
      await flushIteration();

      expect(land).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "failed",
        pollerStatus: "stopped",
        errorMessage: "At-cap merge ladder blocked: Auto-merge blocked because 1 CI check is still running.",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("narrows the default both scope to review comments when CI is already green", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "none" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: false },
      convergenceStatus: { totalNew: 1 },
      getChecks: async () => [
        {
          name: "ci / unit",
          status: "completed",
          conclusion: "success",
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
        },
      ],
      getReviewThreads: async () => [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          path: "src/prs.ts",
          line: 1,
          originalLine: 1,
          startLine: null,
          originalStartLine: null,
          diffSide: "RIGHT",
          url: null,
          createdAt: null,
          updatedAt: null,
          comments: [],
        } as Awaited<ReturnType<PathToMergeDeps["prService"]["getReviewThreads"]>>[number],
      ],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({
        prId: "pr-1",
        modelId: "openai/gpt-5.4",
        permissionMode: "config-toml",
      });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).toHaveBeenCalledTimes(1);
      expect(launchPrIssueResolutionChatMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        prId: "pr-1",
        scope: "comments",
        permissionMode: "config-toml",
      }));
    } finally {
      orchestrator.dispose();
    }
  });

  it("syncs inventory before deciding a failing-check PR has nothing to fix", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "failing", reviewStatus: "none" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true },
      convergenceStatus: { totalNew: 0 },
      getChecks: async () => [makeCheck({ name: "ci / unit", conclusion: "failure" })],
      getReviewThreads: async () => [],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).toHaveBeenCalledTimes(1);
      expect(launchPrIssueResolutionChatMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        prId: "pr-1",
        scope: "checks",
      }));
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "running",
        activeSessionId: "sess-launched",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("ignores review blockers at the cap while still requiring green CI", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "changes_requested" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true, atCapPolicy: "ci_retry_once" },
      convergenceStatus: { totalNew: 0 },
      getReviewThreads: async () => [makeReviewThread()],
      getReviews: async () => [makeReview({ state: "changes_requested", body: "Still needs work." })],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      runtimeByPrId.set("pr-1", {
        ...runtimeByPrId.get("pr-1")!,
        currentRound: 5,
      });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(land).toHaveBeenCalledWith({ prId: "pr-1", method: "squash", archiveLane: false });
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "merged",
        autoConvergeEnabled: false,
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("does not wait forever on requested human review at the cap when CI is green", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "requested" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true, atCapPolicy: "ci_retry_once" },
      convergenceStatus: { totalNew: 0 },
      getChecks: async () => [makeCheck({ name: "ci / unit", status: "completed", conclusion: "success" })],
      getReviewThreads: async () => [],
      getReviews: async () => [],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      runtimeByPrId.set("pr-1", {
        ...runtimeByPrId.get("pr-1")!,
        currentRound: 5,
      });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(land).toHaveBeenCalledWith({ prId: "pr-1", method: "squash", archiveLane: false });
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "merged",
        autoConvergeEnabled: false,
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("still verifies CI before merging at the cap while ignoring review blockers", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "requested" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true, atCapPolicy: "ci_retry_once" },
      convergenceStatus: { totalNew: 0 },
      getChecks: async () => [],
      getReviewThreads: async () => [],
      getReviews: async () => [],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      runtimeByPrId.set("pr-1", {
        ...runtimeByPrId.get("pr-1")!,
        currentRound: 5,
      });
      await flushIteration();

      expect(land).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "failed",
        pollerStatus: "stopped",
        errorMessage: "At-cap merge ladder blocked: Auto-merge blocked because no CI checks were found on the PR head.",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("still waits for pending review-bot checks before entering the at-cap action", async () => {
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const pendingReviewCheckStartedAt = new Date().toISOString();
    const land = vi.fn(async () => ({
      prId: "pr-1",
      prNumber: 1,
      success: true as const,
      mergeCommitSha: "merge-sha",
      branchDeleted: false,
      laneArchived: false,
      error: null,
    }));
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "requested" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true, atCapPolicy: "ci_retry_once" },
      convergenceStatus: { totalNew: 0 },
      getChecks: async () => [
        makeCheck({ name: "ci / unit", status: "completed", conclusion: "success" }),
        makeCheck({ name: "Greptile Review", status: "queued", conclusion: null, startedAt: pendingReviewCheckStartedAt }),
      ],
      getReviewThreads: async () => [],
      getReviews: async () => [],
      land,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      runtimeByPrId.set("pr-1", {
        ...runtimeByPrId.get("pr-1")!,
        currentRound: 5,
      });
      await flushIteration();

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "running",
        pollerStatus: "waiting_for_comments",
      });
    } finally {
      orchestrator.dispose();
    }
  });

  it("gives up on a missing active session after two polls and dispatches a fresh agent", async () => {
    vi.useFakeTimers();
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "failing", reviewStatus: "changes_requested" })],
      pipelineSettings: { earlyMergeOnGreen: false },
      convergenceStatus: { totalNew: 1 },
      getSessionSummary: async () => null,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      runtimeByPrId.set("pr-1", {
        ...runtimeByPrId.get("pr-1")!,
        activeSessionId: "missing-session",
        activeLaneId: "lane-1",
        activeHref: "/work?laneId=lane-1&sessionId=missing-session",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")?.activeSessionId).toBe("missing-session");

      await vi.advanceTimersByTimeAsync(PHASE_DELAY_SECONDS.warming * 1000);
      expect(launchPrIssueResolutionChatMock).toHaveBeenCalledTimes(1);
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        activeSessionId: "sess-launched",
        pollerStatus: "waiting_for_comments",
      });
    } finally {
      orchestrator.dispose();
      vi.useRealTimers();
    }
  });

  it("pauses when a completed fix agent did not push a new head SHA", async () => {
    vi.useFakeTimers();
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>([
      ["pr-1", buildRuntime("pr-1", {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
        activeSessionId: "sess-1",
        lastDispatchHeadSha: "sha-1",
      })],
    ]);
    const ptmArgsByPrId = new Map<string, Record<string, unknown> | null>([
      ["pr-1", { modelId: "openai/gpt-5.4", reasoning: null, permissionMode: "default", scope: "both", additionalInstructions: null }],
    ]);
    const { deps } = buildDeps({
      runtimeByPrId,
      ptmArgsByPrId,
      prs: [buildPrSummary({ checksStatus: "failing", reviewStatus: "changes_requested" })],
      pipelineSettings: { earlyMergeOnGreen: false },
      convergenceStatus: { totalNew: 1 },
      getCommits: async () => [{
        sha: "sha-1",
        shortSha: "sha-1",
        message: "before",
        author: { login: null, name: "Test", email: null },
        committedDate: "2026-05-01T00:00:00.000Z",
      }],
      getSessionSummary: async () => ({ status: "idle", awaitingInput: false }) as Awaited<ReturnType<PathToMergeDeps["agentChatService"]["getSessionSummary"]>>,
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      orchestrator.resumeFromPersistedState();
      await vi.advanceTimersByTimeAsync(PHASE_DELAY_SECONDS.warming * 1000);

      expect(launchPrIssueResolutionChatMock).not.toHaveBeenCalled();
      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "paused",
        autoConvergeEnabled: false,
        pauseReason: "Fix agent finished without pushing commits - manual intervention needed.",
      });
    } finally {
      orchestrator.dispose();
      vi.useRealTimers();
    }
  });

  it("does not overwrite a stopped runtime after fix-agent launch resolves", async () => {
    let resolveLaunch!: (value: Awaited<ReturnType<typeof launchPrIssueResolutionChat>>) => void;
    launchPrIssueResolutionChatMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveLaunch = resolve;
    }));
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const built = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "failing", reviewStatus: "changes_requested" })],
      pipelineSettings: { earlyMergeOnGreen: false },
      convergenceStatus: { totalNew: 1 },
    });
    const { deps, resetSentToAgent } = built;
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();
      expect(launchPrIssueResolutionChatMock).toHaveBeenCalledTimes(1);

      await orchestrator.stopPathToMerge({ prId: "pr-1", reason: "operator stop" });
      resolveLaunch({ sessionId: "sess-late", laneId: "lane-1", href: "/late" });
      await flushIteration();

      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "stopped",
        pollerStatus: "stopped",
        autoConvergeEnabled: false,
        activeSessionId: null,
        pauseReason: "operator stop",
      });
      expect(resetSentToAgent).toHaveBeenCalledWith("pr-1", { sessionId: "sess-late" });
    } finally {
      orchestrator.dispose();
    }
  });

  it("does not overwrite a stopped runtime after the merge ladder resolves", async () => {
    let resolveLand!: (value: Awaited<ReturnType<PathToMergeDeps["prService"]["land"]>>) => void;
    const land = vi.fn(() => new Promise<Awaited<ReturnType<PathToMergeDeps["prService"]["land"]>>>((resolve) => {
      resolveLand = resolve;
    }));
    const runtimeByPrId = new Map<string, ConvergenceRuntimeState>();
    const { deps } = buildDeps({
      runtimeByPrId,
      prs: [buildPrSummary({ checksStatus: "passing", reviewStatus: "approved" })],
      pipelineSettings: { earlyMergeOnGreen: false, autoMerge: true },
      convergenceStatus: { totalNew: 0 },
      land: land as unknown as PathToMergeDeps["prService"]["land"],
    });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      await orchestrator.startPathToMerge({ prId: "pr-1", modelId: "openai/gpt-5.4" });
      await flushIteration();
      expect(land).toHaveBeenCalledTimes(1);

      await orchestrator.stopPathToMerge({ prId: "pr-1", reason: "operator stop" });
      resolveLand({
        prId: "pr-1",
        prNumber: 1,
        success: true,
        mergeCommitSha: "merge-sha",
        branchDeleted: false,
        laneArchived: false,
        error: null,
      });
      await flushIteration();

      expect(runtimeByPrId.get("pr-1")).toMatchObject({
        status: "stopped",
        pollerStatus: "stopped",
        autoConvergeEnabled: false,
        pauseReason: "operator stop",
      });
    } finally {
      orchestrator.dispose();
    }
  });
});

describe("decideAtCapAction", () => {
  function buildCtx(
    policy: AtCapPolicy,
    pipelineOverrides: Partial<PipelineSettings> = {},
    prOverrides: Partial<PrSummary> = {},
  ) {
    return {
      pr: buildPrSummary(prOverrides),
      pipelineSettings: { ...DEFAULT_PIPELINE_SETTINGS, atCapPolicy: policy, ...pipelineOverrides },
      runtime: buildRuntime("pr-1", { currentRound: 5 }),
    };
  }
  function buildInProc(overrides: Partial<InProcessState> = {}): InProcessState {
    return { ...makeInProcessState({ prId: "pr-1", scope: "both" }), ...overrides };
  }

  it("policy=stop pauses immediately regardless of CI state", () => {
    const ctx = buildCtx("stop", {}, { checksStatus: "passing" });
    const decision = decideAtCapAction(ctx, [], buildInProc());
    expect(decision.kind).toBe("stop");
  });

  describe("policy=wait_for_ci", () => {
    it("schedules a wait when CI is still pending and stamps the wait-start timestamp", () => {
      const ctx = buildCtx("wait_for_ci", { atCapWaitMinutes: 30 }, { checksStatus: "pending" });
      const inProc = buildInProc();
      const decision = decideAtCapAction(ctx, [], inProc, () => 1_000_000);
      expect(decision.kind).toBe("wait");
      expect((decision as { kind: "wait"; phase: string }).phase).toBe("warming");
      expect(inProc.waitForCiStartedAt).toBeTruthy();
    });

    it("merges immediately when CI is passing", () => {
      const ctx = buildCtx("wait_for_ci", {}, { checksStatus: "passing" });
      const decision = decideAtCapAction(ctx, [], buildInProc());
      expect(decision.kind).toBe("merge_now");
    });

    it("stops when CI is failing", () => {
      const ctx = buildCtx("wait_for_ci", {}, { checksStatus: "failing" });
      const decision = decideAtCapAction(ctx, [], buildInProc());
      expect(decision.kind).toBe("stop");
    });

    it("stops once the wait window elapses past atCapWaitMinutes", () => {
      const start = 1_000_000;
      const ctx = buildCtx("wait_for_ci", { atCapWaitMinutes: 5 }, { checksStatus: "pending" });
      const inProc = buildInProc({ waitForCiStartedAt: new Date(start).toISOString() });
      // Advance the clock 6 minutes — past the 5-minute window.
      const now = () => start + 6 * 60_000;
      const decision = decideAtCapAction(ctx, [], inProc, now);
      expect(decision.kind).toBe("stop");
      expect((decision as { kind: "stop"; reason: string }).reason).toMatch(/timed out/);
    });
  });

  describe("policy=ci_retry_once", () => {
    it("merges immediately when CI is already green", () => {
      const ctx = buildCtx("ci_retry_once", {}, { checksStatus: "passing" });
      const decision = decideAtCapAction(ctx, [], buildInProc());
      expect(decision.kind).toBe("merge_now");
    });

    it("dispatches a bonus CI iteration the first time CI is failing", () => {
      const ctx = buildCtx("ci_retry_once", {}, { checksStatus: "failing" });
      const inProc = buildInProc();
      const decision = decideAtCapAction(ctx, [], inProc);
      expect(decision.kind).toBe("dispatch_ci");
      expect(inProc.ciRetryAttemptsUsed).toBe(1);
    });

    it("stops on the second visit if the bonus iteration didn't fix CI", () => {
      const ctx = buildCtx("ci_retry_once", {}, { checksStatus: "failing" });
      const inProc = buildInProc({ ciRetryAttemptsUsed: 1 });
      const decision = decideAtCapAction(ctx, [], inProc);
      expect(decision.kind).toBe("stop");
    });

    it("waits when CI is mid-run rather than dispatching a redundant retry", () => {
      const ctx = buildCtx("ci_retry_once", {}, { checksStatus: "pending" });
      const inProc = buildInProc();
      const decision = decideAtCapAction(ctx, [], inProc, () => 1_000_000);
      expect(decision.kind).toBe("wait");
      expect(inProc.waitForCiStartedAt).toBeTruthy();
    });

    it("stops when pending CI exceeds the shared wait window", () => {
      const start = 1_000_000;
      const ctx = buildCtx("ci_retry_once", { atCapWaitMinutes: 5 }, { checksStatus: "pending" });
      const inProc = buildInProc({ waitForCiStartedAt: new Date(start).toISOString() });
      const decision = decideAtCapAction(ctx, [], inProc, () => start + 6 * 60_000);
      expect(decision.kind).toBe("stop");
      expect((decision as { kind: "stop"; reason: string }).reason).toMatch(/ci_retry_once: timed out/);
    });
  });

  describe("policy=ci_retry_loop", () => {
    it("merges as soon as a retry round turns CI green", () => {
      const ctx = buildCtx("ci_retry_loop", { atCapCiRetryMax: 3 }, { checksStatus: "passing" });
      const inProc = buildInProc({ ciRetryAttemptsUsed: 1 });
      const decision = decideAtCapAction(ctx, [], inProc);
      expect(decision.kind).toBe("merge_now");
    });

    it("dispatches further CI iterations until the retry budget is hit", () => {
      const ctx = buildCtx("ci_retry_loop", { atCapCiRetryMax: 3 }, { checksStatus: "failing" });
      const inProc = buildInProc();
      // First two failures → dispatch (1, 2)
      expect(decideAtCapAction(ctx, [], inProc).kind).toBe("dispatch_ci");
      expect(inProc.ciRetryAttemptsUsed).toBe(1);
      expect(decideAtCapAction(ctx, [], inProc).kind).toBe("dispatch_ci");
      expect(inProc.ciRetryAttemptsUsed).toBe(2);
      // Third attempt → dispatch (3)
      expect(decideAtCapAction(ctx, [], inProc).kind).toBe("dispatch_ci");
      expect(inProc.ciRetryAttemptsUsed).toBe(3);
      // Budget exhausted → stop
      expect(decideAtCapAction(ctx, [], inProc).kind).toBe("stop");
    });

    it("clamps a non-positive atCapCiRetryMax up to 1 instead of immediately stopping", () => {
      const ctx = buildCtx("ci_retry_loop", { atCapCiRetryMax: 0 }, { checksStatus: "failing" });
      const inProc = buildInProc();
      // 0 → clamped to 1, so a single retry is allowed before stop.
      expect(decideAtCapAction(ctx, [], inProc).kind).toBe("dispatch_ci");
      expect(decideAtCapAction(ctx, [], inProc).kind).toBe("stop");
    });

    it("waits when CI is pending and stamps the shared wait window", () => {
      const ctx = buildCtx("ci_retry_loop", { atCapCiRetryMax: 3 }, { checksStatus: "pending" });
      const inProc = buildInProc();
      const decision = decideAtCapAction(ctx, [], inProc, () => 1_000_000);
      expect(decision.kind).toBe("wait");
      expect(inProc.waitForCiStartedAt).toBeTruthy();
    });

    it("stops when pending CI exceeds the shared wait window", () => {
      const start = 1_000_000;
      const ctx = buildCtx("ci_retry_loop", { atCapWaitMinutes: 5, atCapCiRetryMax: 3 }, { checksStatus: "pending" });
      const inProc = buildInProc({ waitForCiStartedAt: new Date(start).toISOString() });
      const decision = decideAtCapAction(ctx, [], inProc, () => start + 6 * 60_000);
      expect(decision.kind).toBe("stop");
      expect((decision as { kind: "stop"; reason: string }).reason).toMatch(/ci_retry_loop: timed out/);
    });
  });

  it("policy=force_merge skips retries and goes straight to merge_now", () => {
    const ctx = buildCtx("force_merge", {}, { checksStatus: "failing" });
    const decision = decideAtCapAction(ctx, [], buildInProc());
    expect(decision.kind).toBe("merge_now");
  });

  it("treats a passing pr.checksStatus with a failed individual check as failing", () => {
    const failedCheck: Partial<PrCheck> = { conclusion: "failure" };
    const ctx = buildCtx("ci_retry_once", {}, { checksStatus: "passing" });
    const decision = decideAtCapAction(ctx, [failedCheck as PrCheck], buildInProc());
    // pr.checksStatus says passing but a check is failed → dispatch a retry.
    expect(decision.kind).toBe("dispatch_ci");
  });
});

describe("createPathToMergeOrchestrator.dispose", () => {
  it("is idempotent and prevents subsequent schedule calls from arming timers", () => {
    const { deps } = buildDeps();
    const orchestrator = createPathToMergeOrchestrator(deps);
    orchestrator.dispose();
    // Calling dispose twice and resumeFromPersistedState after dispose must
    // not throw (the orchestrator marks itself disposed and short-circuits).
    expect(() => orchestrator.dispose()).not.toThrow();
    expect(() => orchestrator.resumeFromPersistedState()).not.toThrow();
  });
});
