// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrActionStep, PrWorkflowGraph, PrWorkflowGraphNode } from "../../../../shared/types";
import {
  buildCheckDetailPlan,
  buildLogExcerptMarkdown,
  deriveFallbackGraph,
  graphBuckets,
  graphUnavailableCopy,
  hydrateWorkflowGraph,
  matrixLegCaption,
  nodeElapsedMs,
  readStoredChecksView,
  resolveLogJobId,
  stepProgress,
  writeStoredChecksView,
} from "./prChecksModel";
import type { UnifiedCheckItem } from "../shared/prUnifiedChecks";
import { fetchCheckLogForState, isCheckLogFetchWorthwhile } from "./prChecksApi";

function node(overrides: Partial<PrWorkflowGraphNode> & Pick<PrWorkflowGraphNode, "jobId">): PrWorkflowGraphNode {
  return {
    displayName: overrides.jobId,
    workflowName: "CI",
    state: "passed",
    tier: 0,
    durationMs: null,
    startedAt: null,
    completedAt: null,
    legs: [],
    steps: [],
    checkRunId: null,
    actionsJobId: null,
    runId: null,
    detailsUrl: null,
    ...overrides,
  };
}

function graph(overrides: Partial<PrWorkflowGraph> = {}): PrWorkflowGraph {
  return {
    source: "worktree",
    unavailableReason: null,
    headSha: "d1de0c9abcdef",
    attempt: 1,
    nodes: [],
    edges: [],
    criticalPath: [],
    externalChecks: [],
    stale: false,
    staleBehindBy: null,
    ...overrides,
  };
}

describe("prChecksModel — view persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips the selected view per project", () => {
    expect(readStoredChecksView("proj-a")).toBeNull();
    writeStoredChecksView("proj-a", "failures");
    writeStoredChecksView("proj-b", "list");
    expect(readStoredChecksView("proj-a")).toBe("failures");
    expect(readStoredChecksView("proj-b")).toBe("list");
  });

  it("ignores corrupt or unknown stored values", () => {
    window.localStorage.setItem("ade:prs:checksView:v1", JSON.stringify({ "proj-a": "swimlane" }));
    expect(readStoredChecksView("proj-a")).toBeNull();
    window.localStorage.setItem("ade:prs:checksView:v1", "not json");
    expect(readStoredChecksView("proj-a")).toBeNull();
  });
});

describe("prChecksModel — buckets", () => {
  it("counts every matrix leg and external check exactly once, summing to total", () => {
    const g = graph({
      nodes: [
        node({
          jobId: "test-desktop",
          state: "failed",
          legs: [
            { name: "test-desktop (1)", jobId: 1, state: "passed", durationMs: 10, detailsUrl: null },
            { name: "test-desktop (2)", jobId: 2, state: "failed", durationMs: 10, detailsUrl: null },
            { name: "test-desktop (3)", jobId: 3, state: "running", durationMs: null, detailsUrl: null },
            { name: "test-desktop (4)", jobId: 4, state: "queued", durationMs: null, detailsUrl: null },
          ],
        }),
        node({ jobId: "lint", state: "passed" }),
        node({ jobId: "docs", state: "skipped" }),
      ],
      externalChecks: [
        { name: "CodeRabbit", status: "in_progress", conclusion: null, detailsUrl: null, startedAt: null, completedAt: null },
        { name: "Vercel", status: "completed", conclusion: "cancelled", detailsUrl: null, startedAt: null, completedAt: null },
      ],
    });

    const buckets = graphBuckets(g);
    // 4 legs + lint + docs + 2 external = 8
    expect(buckets.total).toBe(8);
    expect(buckets.passed).toBe(2);
    // matrix leg 2 + the cancelled external check — cancelled is a failure, once.
    expect(buckets.failed).toBe(2);
    expect(buckets.running).toBe(2);
    expect(buckets.queued).toBe(1);
    expect(buckets.skipped).toBe(1);
    expect(buckets.unknown).toBe(0);
    const sum = buckets.passed + buckets.failed + buckets.running
      + buckets.queued + buckets.skipped + buckets.unknown;
    expect(sum).toBe(buckets.total);
  });
});

describe("prChecksModel — node presentation", () => {
  it("measures a running node against now and a finished one against its end", () => {
    const now = Date.parse("2026-07-27T12:00:00.000Z");
    const running = node({
      jobId: "build",
      state: "running",
      startedAt: "2026-07-27T11:58:00.000Z",
      completedAt: null,
    });
    expect(nodeElapsedMs(running, now)).toBe(120_000);

    const done = node({
      jobId: "lint",
      startedAt: "2026-07-27T11:58:00.000Z",
      completedAt: "2026-07-27T11:58:45.000Z",
      durationMs: 45_000,
    });
    expect(nodeElapsedMs(done, now)).toBe(45_000);
  });

  it("captions collapsed matrix legs with what actually broke", () => {
    const matrix = node({
      jobId: "test-desktop",
      state: "failed",
      legs: [
        { name: "test-desktop (shard 1)", jobId: 1, state: "passed", durationMs: null, detailsUrl: null },
        { name: "test-desktop (shard 2)", jobId: 2, state: "failed", durationMs: null, detailsUrl: null },
        { name: "test-desktop (shard 3)", jobId: 3, state: "running", durationMs: null, detailsUrl: null },
        { name: "test-desktop (shard 4)", jobId: 4, state: "passed", durationMs: null, detailsUrl: null },
      ],
    });
    expect(matrixLegCaption(matrix)).toBe("4 legs · shard 2 failed · shard 3 running");
    expect(matrixLegCaption(node({ jobId: "solo" }))).toBeNull();
  });

  it("reports step progress for the in-node bar", () => {
    const steps: PrActionStep[] = [
      { name: "checkout", number: 1, status: "completed", conclusion: "success", startedAt: null, completedAt: null },
      { name: "setup-node", number: 2, status: "completed", conclusion: "success", startedAt: null, completedAt: null },
      { name: "eslint", number: 3, status: "in_progress", conclusion: null, startedAt: null, completedAt: null },
      { name: "tsc", number: 4, status: "queued", conclusion: null, startedAt: null, completedAt: null },
    ];
    expect(stepProgress(node({ jobId: "lint", steps }))).toEqual({
      done: 2, total: 4, pct: 50, currentStepName: "eslint",
    });
    expect(stepProgress(node({ jobId: "lint" }))).toBeNull();
  });

  it("prefers the failing matrix leg when resolving a job id for the log", () => {
    expect(resolveLogJobId(node({
      jobId: "test",
      legs: [
        { name: "test (1)", jobId: 11, state: "passed", durationMs: null, detailsUrl: null },
        { name: "test (2)", jobId: 22, state: "failed", durationMs: null, detailsUrl: null },
      ],
    }))).toBe(22);
    expect(resolveLogJobId(node({ jobId: "solo", actionsJobId: 99 }))).toBe(99);
    expect(resolveLogJobId(node({ jobId: "check-run-only", checkRunId: 100 }))).toBeNull();
    expect(resolveLogJobId(node({
      jobId: "url-only",
      detailsUrl: "https://github.com/o/r/actions/runs/5/job/777",
    }))).toBe(777);
    expect(resolveLogJobId(node({ jobId: "nothing" }))).toBeNull();
  });
});

describe("prChecksModel — fallback graph", () => {
  const item = (o: Partial<UnifiedCheckItem> & Pick<UnifiedCheckItem, "id" | "name">): UnifiedCheckItem => ({
    displayName: o.name,
    status: "completed",
    conclusion: "success",
    duration: null,
    detailsUrl: null,
    source: "actions_job",
    startedAt: null,
    completedAt: null,
    jobId: null,
    runId: null,
    checkRunId: null,
    ...o,
  });

  it("explains a reusable workflow in plain language", () => {
    expect(graphUnavailableCopy("reusable-workflow")).toContain("calls another workflow");
    expect(graphUnavailableCopy("no-workflow-file")).toContain("couldn't find the workflow file");
    expect(graphUnavailableCopy(null)).toContain("grouped by workflow");
  });
});

describe("prChecksModel — live graph hydration", () => {
  it("refreshes node and matrix-leg state from the checks already polled by the pane", () => {
    const staleGraph = graph({
      nodes: [
        node({
          jobId: "test",
          displayName: "test",
          state: "queued",
          legs: [
            { name: "test (1)", jobId: 11, state: "queued", durationMs: null, detailsUrl: null },
            { name: "test (2)", jobId: 12, state: "queued", durationMs: null, detailsUrl: null },
          ],
        }),
      ],
    });
    const item = (
      id: number,
      name: string,
      conclusion: UnifiedCheckItem["conclusion"],
    ): UnifiedCheckItem => ({
      id: `job-${id}`,
      name: `CI / ${name}`,
      displayName: `CI / ${name}`,
      workflowName: "CI",
      status: "completed",
      conclusion,
      duration: 30,
      detailsUrl: `https://github.com/o/r/actions/runs/1/job/${id}`,
      source: "actions_job",
      startedAt: "2026-07-27T11:00:00.000Z",
      completedAt: "2026-07-27T11:00:30.000Z",
      jobId: id,
      runId: 1,
      checkRunId: id,
      steps: [],
    });

    const hydrated = hydrateWorkflowGraph(staleGraph, [
      item(11, "test (1)", "success"),
      item(12, "test (2)", "failure"),
    ]);
    expect(hydrated.nodes[0]).toMatchObject({
      state: "failed",
      checkRunId: 12,
      runId: 1,
    });
    expect(hydrated.nodes[0]!.legs.map((leg) => leg.state)).toEqual(["passed", "failed"]);
  });
});

describe("prChecksModel — job detail plan", () => {
  const step = (
    number: number,
    name: string,
    overrides: Partial<PrActionStep> = {},
  ): PrActionStep => ({
    name,
    number,
    status: "completed",
    conclusion: "success",
    startedAt: `2026-07-27T11:0${number}:00.000Z`,
    completedAt: `2026-07-27T11:0${number}:30.000Z`,
    ...overrides,
  });

  // The defect: clicking a green job produced failure copy and a log fetch that
  // returned the tail of `Post Run actions/checkout`. A passed job must narrate
  // no failure at all, and must not ask for a log excerpt.
  it("shows a passed job's step timings and never asks for a log", () => {
    const plan = buildCheckDetailPlan(
      node({
        jobId: "test-desktop",
        state: "passed",
        steps: [step(1, "Set up job"), step(2, "Run npm ci"), step(3, "Run vitest")],
      }),
      null,
    );

    expect(plan.wantsLogExcerpt).toBe(false);
    expect(plan.outcomeLabel).toBe("Passed");
    expect(plan.summary).toBe("3 steps, all passed");
    expect(plan.summary.toLowerCase()).not.toContain("fail");
    expect(plan.failedStep).toBeNull();
    expect(plan.steps.map((s) => [s.number, s.name, s.outcomeLabel, s.durationMs])).toEqual([
      [1, "Set up job", "Passed", 30_000],
      [2, "Run npm ci", "Passed", 30_000],
      [3, "Run vitest", "Passed", 30_000],
    ]);
    expect(plan.stepsTotalMs).toBe(90_000);
  });

  it("names the failing step and does want the log for a failed job", () => {
    const plan = buildCheckDetailPlan(
      node({
        jobId: "test-desktop",
        state: "failed",
        steps: [step(1, "Set up job"), step(2, "Run vitest", { conclusion: "failure" })],
      }),
      null,
    );
    expect(plan.wantsLogExcerpt).toBe(true);
    expect(plan.outcomeLabel).toBe("Failed");
    expect(plan.summary).toBe("Failed at step 2 of 2 · Run vitest");
    expect(plan.failedStep?.name).toBe("Run vitest");
  });

  it("names the step in flight for a running job and still wants no log", () => {
    const plan = buildCheckDetailPlan(
      node({
        jobId: "build",
        state: "running",
        steps: [
          step(1, "Set up job"),
          step(2, "Build", { status: "in_progress", conclusion: null, completedAt: null }),
          step(3, "Upload", { status: "queued", conclusion: null, startedAt: null, completedAt: null }),
        ],
      }),
      null,
      Date.parse("2026-07-27T11:02:45.000Z"),
    );
    expect(plan.wantsLogExcerpt).toBe(false);
    expect(plan.outcomeLabel).toBe("Running");
    expect(plan.summary).toBe("Running step 2 of 3 · Build");
    expect(plan.currentStep?.durationMs).toBe(45_000);
  });

  it("states a queued job plainly with no failure narrative", () => {
    const plan = buildCheckDetailPlan(node({ jobId: "gate", state: "queued", steps: [] }), null);
    expect(plan.wantsLogExcerpt).toBe(false);
    expect(plan.summary).toBe("Queued. GitHub hasn't started this job yet.");
    expect(plan.summary.toLowerCase()).not.toContain("fail");
  });

  // `pipelineStateOf` folds cancelled into `failed` so it counts as red. The
  // narration must not: telling a user a cancelled job "failed" sends them
  // hunting for a test failure that never happened.
  it("keeps cancelled and timed-out distinct from failed in the outcome word", () => {
    const cancelled = buildCheckDetailPlan(
      node({ jobId: "build", state: "failed" }),
      {
        jobId: 7, jobName: "build", failingStepName: null, failingStepNumber: null,
        stepTotal: null, headline: null, lines: [], truncated: false, htmlUrl: null,
        jobState: "failed", jobStatus: "completed", jobConclusion: "cancelled",
      },
    );
    expect(cancelled.outcomeLabel).toBe("Cancelled");
  });

  it("prefers the excerpt's steps once one has loaded", () => {
    const plan = buildCheckDetailPlan(
      node({ jobId: "build", state: "passed", steps: [] }),
      {
        jobId: 7, jobName: "build", failingStepName: null, failingStepNumber: null,
        stepTotal: 1, headline: null, lines: [], truncated: false, htmlUrl: null,
        jobState: "passed", jobStatus: "completed", jobConclusion: "success",
        steps: [step(1, "Run npm ci")], logStatus: "not-fetched",
      },
    );
    expect(plan.steps.map((s) => s.name)).toEqual(["Run npm ci"]);
  });
});

describe("prChecksModel — copy excerpt", () => {
  it("writes job, step, elapsed, a fenced excerpt and an ADE deeplink", () => {
    const markdown = buildLogExcerptMarkdown({
      excerpt: {
        jobId: 42,
        jobName: "test-desktop (2)",
        failingStepName: "Run vitest shard 2",
        failingStepNumber: 6,
        stepTotal: 9,
        headline: "Tests  1 failed | 412 passed",
        lines: ["✗ updateService.test.ts", "AssertionError"],
        truncated: true,
        htmlUrl: "https://github.com/o/r/actions/runs/1/job/42",
      },
      elapsedLabel: "1m 23s",
      pr: { repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 910 },
    });

    expect(markdown).toContain("**CI failure — test-desktop (2)**");
    expect(markdown).toContain("- Step: Run vitest shard 2 (step 6/9)");
    expect(markdown).toContain("- Elapsed: 1m 23s");
    expect(markdown).toContain("```\n✗ updateService.test.ts\nAssertionError\n… (truncated)\n```");
    expect(markdown).toContain("ade://pr/ade-dev/ade/910");
    expect(markdown).toContain("https://github.com/o/r/actions/runs/1/job/42");
  });

  it("uses a longer markdown fence when the log itself contains backticks", () => {
    const markdown = buildLogExcerptMarkdown({
      excerpt: {
        jobId: 42,
        jobName: "docs",
        failingStepName: null,
        failingStepNumber: null,
        stepTotal: null,
        headline: null,
        lines: ["generated ```markdown", "still inside the log"],
        truncated: false,
        htmlUrl: null,
      },
      elapsedLabel: null,
      pr: { repoOwner: "ade", repoName: "desktop", githubPrNumber: 7 },
    });
    expect(markdown).toContain("````\ngenerated ```markdown\nstill inside the log\n````");
  });

  // Pasting "CI failure — build" for a job that passed is the same lie the
  // drawer used to tell, and it is the one an agent reading the paste acts on.
  it("does not call a passed job a failure, and says the log was not fetched", () => {
    const markdown = buildLogExcerptMarkdown({
      excerpt: {
        jobId: 42,
        jobName: "build",
        failingStepName: null,
        failingStepNumber: null,
        stepTotal: 9,
        headline: null,
        lines: [],
        truncated: false,
        htmlUrl: "https://github.com/o/r/actions/runs/1/job/42",
        jobState: "passed",
        jobStatus: "completed",
        jobConclusion: "success",
        logStatus: "not-fetched",
      },
      elapsedLabel: "4m 2s",
      pr: { repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 910 },
    });

    expect(markdown).toContain("**CI job passed — build**");
    expect(markdown).not.toContain("CI failure");
    expect(markdown).not.toContain("unknown step");
    expect(markdown).toContain("- Steps: 9");
    expect(markdown).toContain("_No log excerpt was fetched");
    // An empty fenced block would claim the job produced no output.
    expect(markdown).not.toContain("```\n```");
  });

  it("distinguishes an unreadable log from an unfetched one", () => {
    const markdown = buildLogExcerptMarkdown({
      excerpt: {
        jobId: 42,
        jobName: "build",
        failingStepName: "Run vitest",
        failingStepNumber: 3,
        stepTotal: 9,
        headline: null,
        lines: [],
        truncated: false,
        htmlUrl: null,
        jobState: "failed",
        jobStatus: "completed",
        jobConclusion: "failure",
        logStatus: "unavailable",
        logUnavailableReason: "ADE couldn't download this job's log from GitHub.",
      },
      elapsedLabel: null,
      pr: { repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 910 },
    });
    expect(markdown).toContain("**CI failure — build**");
    expect(markdown).toContain("_ADE couldn't read this job's log: ADE couldn't download");
  });
});


/* -- Folded in from `prChecksApi.test.ts` --
   The fetch policy the model feeds; both decide what a check state is worth reading. */

function installGetCheckLog(getCheckLog?: ReturnType<typeof vi.fn>) {
  Object.assign(window, { ade: { prs: getCheckLog ? { getCheckLog } : {} } });
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(window, { ade: undefined });
});

describe("prChecksApi — the automatic log fetch budget", () => {
  /**
   * A job log is a redirect plus a multi-megabyte blob, and most jobs pass. The
   * drawer used to fetch one for every job it opened — including green ones,
   * where the service then returned the tail of `Post Run actions/checkout`. The
   * common case must now cost zero GitHub calls.
   */
  it.each(["passed", "running", "queued", "skipped"] as const)(
    "does not call GitHub for a %s job",
    async (state) => {
      const getCheckLog = vi.fn();
      installGetCheckLog(getCheckLog);

      const result = await fetchCheckLogForState({ prId: "pr-1", jobId: 42, state });

      expect(getCheckLog).not.toHaveBeenCalled();
      // "skipped" is not "the fetch came back empty" — the caller must be able
      // to tell a deliberate no-op from a failed read.
      expect(result).toEqual({ resolution: "skipped", excerpt: null });
      expect(isCheckLogFetchWorthwhile(state)).toBe(false);
    },
  );

  it("fetches for a failed job, which is the one state a log explains", async () => {
    const getCheckLog = vi.fn().mockResolvedValue(null);
    installGetCheckLog(getCheckLog);

    const result = await fetchCheckLogForState({ prId: "pr-1", jobId: 42, state: "failed" });

    expect(getCheckLog).toHaveBeenCalledWith({ prId: "pr-1", jobId: 42 });
    expect(result.resolution).toBe("fetched");
  });

  it("fetches for an unknown job, because there is nothing local to render", async () => {
    const getCheckLog = vi.fn().mockResolvedValue(null);
    installGetCheckLog(getCheckLog);
    await fetchCheckLogForState({ prId: "pr-1", jobId: 42, state: "unknown" });
    expect(getCheckLog).toHaveBeenCalledTimes(1);
  });

  // User-initiated reads are exempt from the automatic budget on purpose.
  it("fetches a passed job's log when the user forces it, and asks for the log explicitly", async () => {
    const getCheckLog = vi.fn().mockResolvedValue(null);
    installGetCheckLog(getCheckLog);

    await fetchCheckLogForState({ prId: "pr-1", jobId: 42, state: "passed", force: true });

    expect(getCheckLog).toHaveBeenCalledWith({ prId: "pr-1", jobId: 42, includeLog: true });
  });

  it("reports a runtime with no log API distinctly from a skipped fetch", async () => {
    installGetCheckLog();
    const result = await fetchCheckLogForState({ prId: "pr-1", jobId: 42, state: "failed" });
    expect(result).toEqual({ resolution: "no-api", excerpt: null });
  });
});
