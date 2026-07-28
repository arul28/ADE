// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PrActionRun,
  PrCheck,
  PrCheckLogExcerpt,
  PrRerunChecksTarget,
  PrWorkflowGraph,
} from "../../../../shared/types";
import { PrChecksTab } from "./PrChecksTab";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const pr = {
  id: "pr-1",
  projectId: "proj-1",
  repoOwner: "ade-dev",
  repoName: "ade",
  githubPrNumber: 910,
  headSha: "d1de0c9abcdef",
};

type AdeStub = {
  getWorkflowGraph?: ReturnType<typeof vi.fn>;
  getCheckLog?: ReturnType<typeof vi.fn>;
};

function installAde(stub: AdeStub = {}) {
  Object.assign(window, {
    ade: {
      prs: { ...stub },
      app: { openExternal: vi.fn() },
    },
  });
}

function run(overrides: Partial<PrActionRun> = {}): PrActionRun {
  return {
    id: 4821,
    name: "CI",
    status: "completed",
    conclusion: "failure",
    headSha: "d1de0c9",
    htmlUrl: "https://github.com/ade-dev/ade/actions/runs/4821",
    createdAt: "2026-07-27T11:55:00.000Z",
    updatedAt: "2026-07-27T11:59:00.000Z",
    runAttempt: 1,
    jobs: [],
    ...overrides,
  };
}

function job(overrides: Partial<PrActionRun["jobs"][number]> & { id: number; name: string }) {
  return {
    status: "completed" as const,
    conclusion: "success" as const,
    startedAt: "2026-07-27T11:55:00.000Z",
    completedAt: "2026-07-27T11:56:00.000Z",
    steps: [],
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

async function renderTab(props: {
  checks?: PrCheck[];
  actionRuns?: PrActionRun[];
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
  onFixInChat?: (excerpt: PrCheckLogExcerpt) => void;
  unmapped?: boolean;
} = {}) {
  const result = render(
    <PrChecksTab
      pr={pr}
      checks={props.checks ?? []}
      actionRuns={props.actionRuns ?? []}
      actionBusy={false}
      unmapped={props.unmapped}
      onRerunChecks={props.onRerunChecks}
      onFixInChat={props.onFixInChat}
    />,
  );
  // Flush the graph fetch effect.
  await act(async () => { await Promise.resolve(); });
  return result;
}

beforeEach(() => {
  window.localStorage.clear();
  installAde();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PrChecksTab — header", () => {
  it("hides Re-run failed while nothing has failed and shows it once something does", async () => {
    const onRerunChecks = vi.fn();
    const { rerender } = await renderTab({
      actionRuns: [run({ conclusion: "success", jobs: [job({ id: 1, name: "build" })] })],
      onRerunChecks,
    });
    expect(screen.queryByTestId("pr-checks-rerun-failed")).toBeNull();

    rerender(
      <PrChecksTab
        pr={pr}
        checks={[]}
        actionRuns={[run({ jobs: [job({ id: 1, name: "build", conclusion: "failure" })] })]}
        actionBusy={false}
        onRerunChecks={onRerunChecks}
      />,
    );
    expect(screen.getByTestId("pr-checks-rerun-failed")).toBeTruthy();
  });

  it("fills the progress bar with every bucket, so the segments account for all checks", async () => {
    await renderTab({
      actionRuns: [run({
        jobs: [
          job({ id: 1, name: "build" }),
          job({ id: 2, name: "test", conclusion: "failure" }),
          job({ id: 3, name: "docs", conclusion: "skipped" }),
          job({ id: 4, name: "slow", status: "in_progress", conclusion: null, completedAt: null }),
        ],
      })],
    });
    const bar = screen.getByTestId("pr-checks-progress-bar");
    const flexTotal = Array.from(bar.children)
      .map((child) => Number((child as HTMLElement).style.flex))
      .reduce((a, b) => a + b, 0);
    // 4 jobs → 4 units of flex, i.e. the bar fills completely.
    expect(flexTotal).toBe(4);
    expect(within(screen.getByTestId("pr-checks-header")).getByText("/4")).toBeTruthy();
  });
});

describe("PrChecksTab — graph", () => {
  it("collapses matrix legs to pips with a caption instead of one row per leg", async () => {
    installAde({
      getWorkflowGraph: vi.fn().mockResolvedValue(graph({
        nodes: [
          {
            jobId: "install", displayName: "install", workflowName: "CI", state: "passed", tier: 0,
            durationMs: 48_000, startedAt: null, completedAt: null, legs: [], steps: [],
            checkRunId: null, runId: 4821, detailsUrl: null,
          },
          {
            jobId: "test-desktop", displayName: "test-desktop", workflowName: "CI", state: "failed", tier: 1,
            durationMs: 83_000, startedAt: null, completedAt: null, steps: [],
            legs: [
              { name: "test-desktop (shard 1)", jobId: 1, state: "passed", durationMs: null, detailsUrl: null },
              { name: "test-desktop (shard 2)", jobId: 2, state: "failed", durationMs: null, detailsUrl: null },
              { name: "test-desktop (shard 3)", jobId: 3, state: "passed", durationMs: null, detailsUrl: null },
              { name: "test-desktop (shard 4)", jobId: 4, state: "passed", durationMs: null, detailsUrl: null },
            ],
            checkRunId: null, runId: 4821, detailsUrl: null,
          },
        ],
        edges: [{ from: "install", to: "test-desktop" }],
      })),
    });
    await renderTab();

    // One node for the whole matrix, four pips under it.
    const nodes = screen.getAllByTestId("pr-checks-graph-node");
    expect(nodes).toHaveLength(2);
    const matrix = nodes.find((n) => n.getAttribute("data-job-id") === "test-desktop")!;
    expect(within(matrix).getAllByTestId("pr-checks-node-leg")).toHaveLength(4);
    expect(within(matrix).getByTestId("pr-checks-node-leg-caption").textContent)
      .toBe("4 legs · shard 2 failed");
  });

  it("falls back to swimlanes with an honest reason when the graph has no source", async () => {
    installAde({
      getWorkflowGraph: vi.fn().mockResolvedValue(graph({
        source: "none",
        unavailableReason: "reusable-workflow",
        nodes: [
          {
            jobId: "job-1", displayName: "build", workflowName: "CI", state: "passed", tier: 0,
            durationMs: null, startedAt: null, completedAt: null, legs: [], steps: [],
            checkRunId: null, runId: null, detailsUrl: null,
          },
          {
            jobId: "job-2", displayName: "spellcheck", workflowName: "Docs", state: "passed", tier: 0,
            durationMs: null, startedAt: null, completedAt: null, legs: [], steps: [],
            checkRunId: null, runId: null, detailsUrl: null,
          },
        ],
      })),
    });
    await renderTab();

    expect(screen.queryByTestId("pr-checks-graph")).toBeNull();
    expect(screen.getByTestId("pr-checks-graph-unavailable-note").textContent)
      .toContain("calls another workflow");
    const lanes = screen.getAllByTestId("pr-checks-swimlane");
    expect(lanes.map((l) => l.getAttribute("data-workflow"))).toEqual(["CI", "Docs"]);
  });

  it("puts non-Actions checks in their own not-graphable lane", async () => {
    await renderTab({
      checks: [{
        name: "CodeRabbit", status: "in_progress", conclusion: null,
        detailsUrl: "https://coderabbit.ai/x", startedAt: null, completedAt: null,
      }],
      actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })],
    });
    const lane = screen.getByTestId("pr-checks-external-lane");
    expect(within(lane).getByText("CodeRabbit")).toBeTruthy();
    expect(lane.textContent).toContain("not graphable");
  });

  it("does not call row-only graph or log endpoints for an unmapped GitHub PR", async () => {
    const getWorkflowGraph = vi.fn();
    const getCheckLog = vi.fn();
    installAde({ getWorkflowGraph, getCheckLog });
    await renderTab({
      unmapped: true,
      actionRuns: [run({ jobs: [job({ id: 2, name: "test", conclusion: "failure" })] })],
    });

    expect(getWorkflowGraph).not.toHaveBeenCalled();
    expect(getCheckLog).not.toHaveBeenCalled();
    expect(screen.getByTestId("pr-checks-log-body").textContent).toContain("Map this PR to a lane");
  });

  it("retries graph discovery when the first Actions run appears", async () => {
    const getWorkflowGraph = vi.fn().mockResolvedValue(graph());
    installAde({ getWorkflowGraph });
    const { rerender } = await renderTab();
    expect(getWorkflowGraph).toHaveBeenCalledTimes(1);

    rerender(
      <PrChecksTab
        pr={pr}
        checks={[]}
        actionRuns={[run({ jobs: [job({ id: 1, name: "build" })] })]}
        actionBusy={false}
      />,
    );
    await waitFor(() => expect(getWorkflowGraph).toHaveBeenCalledTimes(2));
  });
});

describe("PrChecksTab — live elapsed", () => {
  it("keeps counting a job that has started but not finished", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(NOW);
    await renderTab({
      actionRuns: [run({
        status: "in_progress",
        conclusion: null,
        jobs: [job({
          id: 7,
          name: "build-runtime-binaries",
          status: "in_progress",
          conclusion: null,
          startedAt: "2026-07-27T11:58:30.000Z",
          completedAt: null,
        })],
      })],
    });

    const durationOf = () => screen.getAllByTestId("pr-checks-row")
      .find((row) => row.getAttribute("data-check-name")?.includes("build-runtime-binaries"))!
      .textContent;

    expect(durationOf()).toContain("1m 30s");
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(durationOf()).toContain("2m 30s");
  });
});

describe("PrChecksTab — log drawer", () => {
  const excerpt: PrCheckLogExcerpt = {
    jobId: 2,
    jobName: "test-desktop",
    failingStepName: "Run vitest",
    failingStepNumber: 6,
    stepTotal: 9,
    headline: "Tests  1 failed | 412 passed (413)",
    lines: ["✗ updateService.test.ts", "AssertionError: expected 'held' to be 'released'"],
    truncated: false,
    htmlUrl: "https://github.com/ade-dev/ade/actions/runs/4821/job/2",
  };

  it("auto-opens on the first failing job and shows the headline above the tail", async () => {
    const getCheckLog = vi.fn().mockResolvedValue(excerpt);
    installAde({ getCheckLog });
    await renderTab({
      actionRuns: [run({
        jobs: [
          job({ id: 1, name: "build" }),
          job({ id: 2, name: "test-desktop", conclusion: "failure" }),
        ],
      })],
    });

    await waitFor(() => expect(getCheckLog).toHaveBeenCalledWith({ prId: "pr-1", jobId: 2 }));
    const drawer = await screen.findByTestId("pr-checks-log-drawer");
    expect(drawer.getAttribute("data-job-id")).toBe("2");
    expect(within(drawer).getByTestId("pr-checks-log-headline").textContent)
      .toBe("Tests  1 failed | 412 passed (413)");
    expect(within(drawer).getByTestId("pr-checks-log-body").textContent)
      .toContain("AssertionError");
  });

  it("stays closed when nothing failed", async () => {
    installAde({ getCheckLog: vi.fn() });
    await renderTab({ actionRuns: [run({ conclusion: "success", jobs: [job({ id: 1, name: "build" })] })] });
    expect(screen.queryByTestId("pr-checks-log-drawer")).toBeNull();
  });

  it("says so plainly when the runtime has no log API", async () => {
    installAde();
    await renderTab({
      actionRuns: [run({ jobs: [job({ id: 2, name: "test-desktop", conclusion: "failure" })] })],
    });
    const drawer = await screen.findByTestId("pr-checks-log-drawer");
    expect(within(drawer).getByTestId("pr-checks-log-body").textContent)
      .toContain("can't fetch CI logs yet");
  });

  it("hands the loaded failing excerpt to Fix in chat", async () => {
    const onFixInChat = vi.fn();
    installAde({ getCheckLog: vi.fn().mockResolvedValue(excerpt) });
    await renderTab({
      actionRuns: [run({ jobs: [job({ id: 2, name: "test-desktop", conclusion: "failure" })] })],
      onFixInChat,
    });

    await screen.findByTestId("pr-checks-log-headline");
    screen.getByTestId("pr-checks-drawer-fix-in-chat").click();
    expect(onFixInChat).toHaveBeenCalledWith(excerpt);
  });
});

describe("PrChecksTab — views", () => {
  it("remembers the chosen view per project", async () => {
    await renderTab({ actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })] });
    await act(async () => { screen.getByTestId("pr-checks-view-failures").click(); });
    expect(window.localStorage.getItem("ade:prs:checksView:v1")).toContain("failures");

    cleanup();
    await renderTab({ actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })] });
    expect(screen.getByTestId("pr-checks-view-failures").getAttribute("aria-pressed")).toBe("true");
    // A passing job is neither failing nor in flight, so Failures is empty.
    expect(screen.getByTestId("pr-checks-flat-view").textContent).toContain("No failed or indeterminate checks");
  });

  it("shows external checks only once outside graph view", async () => {
    await renderTab({
      checks: [{
        name: "CodeRabbit",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://coderabbit.ai/x",
        startedAt: null,
        completedAt: null,
      }],
      actionRuns: [run({ conclusion: "success", jobs: [job({ id: 1, name: "build" })] })],
    });
    await act(async () => { screen.getByTestId("pr-checks-view-list").click(); });

    const flat = screen.getByTestId("pr-checks-flat-view");
    expect(within(flat).getAllByText("CodeRabbit")).toHaveLength(1);
    expect(screen.queryByTestId("pr-checks-external-lane")).toBeNull();
  });

  it("keeps running jobs out of the failures-only view", async () => {
    await renderTab({
      actionRuns: [run({
        jobs: [
          job({ id: 1, name: "failed-job", conclusion: "failure" }),
          job({ id: 2, name: "running-job", status: "in_progress", conclusion: null, completedAt: null }),
        ],
      })],
    });
    await act(async () => { screen.getByTestId("pr-checks-view-failures").click(); });

    const flat = screen.getByTestId("pr-checks-flat-view");
    expect(within(flat).getByText("CI / failed-job")).toBeTruthy();
    expect(within(flat).queryByText("CI / running-job")).toBeNull();
  });
});
