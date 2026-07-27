// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { PrActionStep, PrWorkflowGraph, PrWorkflowGraphNode } from "../../../../shared/types";
import {
  buildGraphColumns,
  buildLogExcerptMarkdown,
  deriveFallbackGraph,
  graphBuckets,
  graphUnavailableCopy,
  groupByWorkflow,
  hydrateWorkflowGraph,
  isEdgeLive,
  matrixLegCaption,
  nodeElapsedMs,
  readStoredChecksView,
  resolveLogJobId,
  stepProgress,
  writeStoredChecksView,
} from "./prChecksModel";
import type { UnifiedCheckItem } from "../shared/prUnifiedChecks";

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

describe("prChecksModel — layout", () => {
  it("groups nodes into ordered tier columns and labels the ends", () => {
    const columns = buildGraphColumns([
      node({ jobId: "install", tier: 0 }),
      node({ jobId: "test", tier: 1 }),
      node({ jobId: "lint", tier: 1 }),
      node({ jobId: "ci-pass", tier: 2 }),
    ]);
    expect(columns.map((c) => c.label)).toEqual(["Setup", "Parallel · 2", "Gate"]);
    expect(columns[1]!.nodes.map((n) => n.jobId)).toEqual(["test", "lint"]);
  });

  it("marks a connector live only when it feeds a node that is actually running", () => {
    const columns = buildGraphColumns([
      node({ jobId: "install", tier: 0 }),
      node({ jobId: "test", tier: 1, state: "queued" }),
      node({ jobId: "ci-pass", tier: 2, state: "queued" }),
    ]);
    const queued = graph({
      nodes: columns.flatMap((c) => c.nodes),
      edges: [{ from: "install", to: "test" }, { from: "test", to: "ci-pass" }],
    });
    expect(isEdgeLive(queued, columns, 0)).toBe(false);

    const runningColumns = buildGraphColumns([
      node({ jobId: "install", tier: 0 }),
      node({ jobId: "test", tier: 1, state: "running" }),
      node({ jobId: "ci-pass", tier: 2, state: "queued" }),
    ]);
    const running = graph({
      nodes: runningColumns.flatMap((c) => c.nodes),
      edges: [{ from: "install", to: "test" }, { from: "test", to: "ci-pass" }],
    });
    // install → test feeds a running node; test → ci-pass feeds a queued one.
    expect(isEdgeLive(running, runningColumns, 0)).toBe(true);
    expect(isEdgeLive(running, runningColumns, 1)).toBe(false);
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

  it("splits Actions jobs into flat tier-0 nodes and non-Actions checks into the external lane", () => {
    const fallback = deriveFallbackGraph([
      item({ id: "job-1", name: "CI / build", workflowName: "CI" }),
      item({ id: "job-2", name: "Docs / lint", workflowName: "Docs" }),
      item({ id: "check-1", name: "CodeRabbit", source: "check", status: "in_progress", conclusion: null }),
    ], { headSha: "abc1234", reason: "reusable-workflow" });

    expect(fallback.source).toBe("none");
    expect(fallback.edges).toEqual([]);
    expect(fallback.nodes.map((n) => n.jobId)).toEqual(["job-1", "job-2"]);
    expect(fallback.nodes.every((n) => n.tier === 0)).toBe(true);
    expect(fallback.externalChecks.map((c) => c.name)).toEqual(["CodeRabbit"]);
    expect(groupByWorkflow(fallback.nodes).map((l) => l.workflowName)).toEqual(["CI", "Docs"]);
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
});
