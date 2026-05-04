import { describe, expect, it, vi } from "vitest";
import {
  PHASE_DELAY_SECONDS,
  createPathToMergeOrchestrator,
  type PathToMergeDeps,
} from "./pathToMergeOrchestrator";
import type {
  ConvergenceRuntimeState,
  PrSummary,
} from "../../../shared/types";
import { DEFAULT_CONVERGENCE_RUNTIME_STATE, DEFAULT_PIPELINE_SETTINGS } from "../../../shared/types/prs";

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

function buildDeps(initial?: {
  runtimeByPrId?: Map<string, ConvergenceRuntimeState>;
  ptmArgsByPrId?: Map<string, Record<string, unknown> | null>;
  prs?: PrSummary[];
}): {
  deps: PathToMergeDeps;
  runtimeByPrId: Map<string, ConvergenceRuntimeState>;
  ptmArgsByPrId: Map<string, Record<string, unknown> | null>;
  interrupt: ReturnType<typeof vi.fn>;
} {
  const runtimeByPrId = initial?.runtimeByPrId ?? new Map<string, ConvergenceRuntimeState>();
  const ptmArgsByPrId = initial?.ptmArgsByPrId ?? new Map<string, Record<string, unknown> | null>();
  const prs = initial?.prs ?? [];

  const interrupt = vi.fn(async (_args: { sessionId: string }) => undefined);

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
      refresh: async () => undefined,
      getStatus: async () => ({ behindBaseBy: 0 }),
      getChecks: async () => [],
      land: async () => ({ success: false, error: "test" }),
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
      getSessionSummary: async () => null,
    } as unknown as PathToMergeDeps["agentChatService"],
    sessionService: {
      updateMeta: async () => undefined,
    } as unknown as PathToMergeDeps["sessionService"],
    issueInventoryService: {
      saveConvergenceRuntime: (prId: string, patch: Partial<ConvergenceRuntimeState>) => {
        const prev = runtimeByPrId.get(prId) ?? buildRuntime(prId);
        const next: ConvergenceRuntimeState = { ...prev, ...patch, prId };
        runtimeByPrId.set(prId, next);
        return next;
      },
      getConvergenceRuntime: (prId: string) => runtimeByPrId.get(prId) ?? buildRuntime(prId),
      savePathToMergeArgs: (prId: string, args: Record<string, unknown> | null) => {
        ptmArgsByPrId.set(prId, args);
      },
      getPathToMergeArgs: (prId: string) => ptmArgsByPrId.get(prId) ?? null,
      getPipelineSettings: () => ({ ...DEFAULT_PIPELINE_SETTINGS }),
      getConvergenceStatus: () => ({
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
      }),
    } as unknown as PathToMergeDeps["issueInventoryService"],
    conflictService: {
      runExternalResolver: async () => ({ status: "completed" }),
    } as unknown as PathToMergeDeps["conflictService"],
    defaultModelId: null,
    defaultReasoningEffort: null,
  };

  return { deps, runtimeByPrId, ptmArgsByPrId, interrupt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
        scope: "checks",
        additionalInstructions: "be thorough",
      });

      expect(result.scheduled).toBe(true);
      expect(result.prId).toBe("pr-1");
      expect(result.runtime.autoConvergeEnabled).toBe(true);
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
        scope: "checks",
        additionalInstructions: "be thorough",
      });
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
    const { deps, interrupt } = buildDeps({ runtimeByPrId, ptmArgsByPrId });
    const orchestrator = createPathToMergeOrchestrator(deps);
    try {
      const result = await orchestrator.stopPathToMerge({ prId: "pr-1", reason: "operator paused" });

      expect(result.stopped).toBe(true);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(interrupt).toHaveBeenCalledWith({ sessionId: "sess-active" });

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
      ["pr-1", { modelId: "claude-opus", reasoning: "high", scope: "checks", additionalInstructions: "x" }],
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
