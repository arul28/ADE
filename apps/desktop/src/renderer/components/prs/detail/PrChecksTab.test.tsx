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
import { PrChecksTab, type PrChecksPollGovernor } from "./PrChecksTab";
import { resetChecksGraphCacheForTests } from "./prChecksGraphCache";

/**
 * The real canvas pulls in `@xyflow/react`, which needs a measured viewport
 * jsdom does not have. It is exercised for its own sake in the layout unit
 * tests; what matters here is the CONTRACT `PrChecksTab` hands it — which graph,
 * which node is selected, and that activating a node toggles rather than only
 * opening. So the stub renders exactly those, as real buttons.
 */
vi.mock("./PrChecksGraphCanvas", () => ({
  default: ({ graph, selectedJobId, onToggleNode }: {
    graph: PrWorkflowGraph;
    selectedJobId: string | null;
    onToggleNode: (node: PrWorkflowGraph["nodes"][number]) => void;
  }) => (
    <div
      data-testid="pr-checks-graph"
      data-node-count={graph.nodes.length}
      data-edge-count={graph.edges.length}
    >
      {graph.nodes.map((node) => (
        <button
          key={node.jobId}
          type="button"
          data-testid="pr-checks-graph-node"
          data-job-id={node.jobId}
          data-state={node.state}
          aria-pressed={selectedJobId === node.jobId}
          onClick={() => onToggleNode(node)}
        >
          {node.displayName}
          {node.legs.map((leg, index) => (
            <i key={index} data-testid="pr-checks-node-leg" data-leg-state={leg.state} />
          ))}
        </button>
      ))}
    </div>
  ),
}));

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

/** A two-job DAG the tab will consider chartable. */
function chartedGraph(): PrWorkflowGraph {
  return graph({
    nodes: [
      {
        jobId: "install", displayName: "install", workflowName: "CI", state: "passed", tier: 0,
        durationMs: 48_000, startedAt: null, completedAt: null, legs: [], steps: [],
        checkRunId: null, runId: 4821, detailsUrl: null,
      },
      {
        jobId: "test-desktop", displayName: "test-desktop", workflowName: "CI", state: "failed", tier: 1,
        durationMs: 83_000, startedAt: null, completedAt: null, legs: [], steps: [],
        checkRunId: null, runId: 4821, detailsUrl: null,
      },
    ],
    edges: [{ from: "install", to: "test-desktop" }],
  });
}

function governorStub(overrides: Partial<PrChecksPollGovernor> = {}): PrChecksPollGovernor {
  return {
    isGithubPollStoodDown: vi.fn().mockReturnValue(false),
    noteGithubReadFailure: vi.fn(),
    noteGithubReadSuccess: vi.fn(),
    githubPollGeneration: 0,
    ...overrides,
  };
}

type TabProps = {
  pr?: typeof pr;
  checks?: PrCheck[];
  actionRuns?: PrActionRun[];
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
  onFixInChat?: (excerpt: PrCheckLogExcerpt) => void;
  pollGovernor?: PrChecksPollGovernor;
};

function tab(props: TabProps = {}) {
  return (
    <PrChecksTab
      pr={props.pr ?? pr}
      checks={props.checks ?? []}
      actionRuns={props.actionRuns ?? []}
      actionBusy={false}
      onRerunChecks={props.onRerunChecks}
      onFixInChat={props.onFixInChat}
      pollGovernor={props.pollGovernor}
    />
  );
}

async function renderTab(props: TabProps = {}) {
  const result = render(tab(props));
  // Flush the graph fetch effect and the lazy canvas import.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return result;
}

beforeEach(() => {
  window.localStorage.clear();
  resetChecksGraphCacheForTests();
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

    rerender(tab({
      actionRuns: [run({ jobs: [job({ id: 1, name: "build", conclusion: "failure" })] })],
      onRerunChecks,
    }));
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

describe("PrChecksTab — no list-then-snap", () => {
  it("shows a skeleton, never the flat list, while the graph is still resolving", async () => {
    // The defect: the flat fallback rendered immediately and was replaced 2–3s
    // later by a DAG. A layout you are about to replace must never be shown.
    let resolveGraph: (value: PrWorkflowGraph) => void = () => {};
    installAde({
      getWorkflowGraph: vi.fn().mockReturnValue(new Promise<PrWorkflowGraph>((resolve) => {
        resolveGraph = resolve;
      })),
    });
    render(tab({
      actionRuns: [run({ jobs: [job({ id: 1, name: "install" }), job({ id: 2, name: "test-desktop" })] })],
    }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId("pr-checks-graph-skeleton")).toBeTruthy();
    expect(screen.queryAllByTestId("pr-checks-row")).toHaveLength(0);
    expect(screen.queryByTestId("pr-checks-swimlanes")).toBeNull();

    await act(async () => {
      resolveGraph(chartedGraph());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("pr-checks-graph")).toBeTruthy();
    expect(screen.queryByTestId("pr-checks-graph-skeleton")).toBeNull();
  });

  it("treats a graph-less answer as a final state, not a transition", async () => {
    // `source: "none"` IS the answer. It gets the flat list plus the honest
    // reason — and no skeleton, because nothing further is coming.
    installAde({
      getWorkflowGraph: vi.fn().mockResolvedValue(graph({
        source: "none",
        unavailableReason: "reusable-workflow",
      })),
    });
    await renderTab({ actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })] });

    expect(screen.queryByTestId("pr-checks-graph-skeleton")).toBeNull();
    expect(screen.queryByTestId("pr-checks-graph")).toBeNull();
    expect(screen.getByTestId("pr-checks-graph-unavailable-note").textContent)
      .toContain("calls another workflow");
    expect(screen.getAllByTestId("pr-checks-row").length).toBeGreaterThan(0);
  });
});

describe("PrChecksTab — GitHub request budget", () => {
  it("re-opening the tab costs no GitHub read — the graph shape is cached across mounts", async () => {
    const getWorkflowGraph = vi.fn().mockResolvedValue(chartedGraph());
    installAde({ getWorkflowGraph });
    await renderTab();
    expect(getWorkflowGraph).toHaveBeenCalledTimes(1);

    cleanup();
    await renderTab();
    // Same PR, same head SHA: the pipeline's edges cannot have changed, and
    // re-asking would re-run the Actions/jobs/checks reads the detail pane
    // already made.
    expect(getWorkflowGraph).toHaveBeenCalledTimes(1);
    // …and it is on screen immediately, with no skeleton in between.
    expect(screen.getByTestId("pr-checks-graph")).toBeTruthy();
  });

  it("stands down with the shared poll governor instead of reading GitHub", async () => {
    const getWorkflowGraph = vi.fn().mockResolvedValue(chartedGraph());
    installAde({ getWorkflowGraph });
    await renderTab({
      actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })],
      pollGovernor: governorStub({ isGithubPollStoodDown: vi.fn().mockReturnValue(true) }),
    });

    expect(getWorkflowGraph).not.toHaveBeenCalled();
    expect(screen.getByTestId("pr-checks-graph-unavailable-note").textContent)
      .toContain("couldn't reach GitHub");
  });


  it("stops asking after two failed automatic reads, however often the governor changes", async () => {
    // The fetch effect depends on `githubPollGeneration` so a recovered GitHub
    // is picked up without a timer. That makes the governor's own recovery
    // signal a RETRY TRIGGER: a PR whose Actions read always fails (Actions
    // disabled, a token that cannot read them, a deleted head SHA) would issue
    // a fresh ~14-request graph read every time the ladder flipped, for as long
    // as the tab stayed open.
    const getWorkflowGraph = vi.fn().mockRejectedValue(new Error("403 Forbidden"));
    installAde({ getWorkflowGraph });
    const { rerender } = await renderTab({
      actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })],
      pollGovernor: governorStub({ githubPollGeneration: 0 }),
    });
    expect(getWorkflowGraph).toHaveBeenCalledTimes(1);

    for (const generation of [1, 2, 3, 4, 5]) {
      rerender(tab({
        actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })],
        pollGovernor: governorStub({ githubPollGeneration: generation }),
      }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }

    expect(getWorkflowGraph).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("pr-checks-graph-unavailable-note").textContent)
      .toContain("couldn't reach GitHub");

    // The user pressing Retry is exempt from the cap and resets it.
    await act(async () => {
      screen.getByTestId("pr-checks-graph-retry").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getWorkflowGraph).toHaveBeenCalledTimes(3);
  });

  it("reports a failed read to the governor, never caches it, and offers a retry", async () => {
    // A rejection stored as "there is no graph here" is the failed-read-that-
    // looks-empty bug that let a 5s loop burn an hourly quota.
    const getWorkflowGraph = vi.fn()
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValue(chartedGraph());
    installAde({ getWorkflowGraph });
    const governor = governorStub();
    await renderTab({
      actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })],
      pollGovernor: governor,
    });

    expect(governor.noteGithubReadFailure).toHaveBeenCalled();
    expect(screen.getByTestId("pr-checks-graph-unavailable-note").textContent)
      .toContain("couldn't reach GitHub");

    await act(async () => {
      screen.getByTestId("pr-checks-graph-retry").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getWorkflowGraph).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("pr-checks-graph")).toBeTruthy();
  });

  it("retries graph discovery once when the first Actions run appears, and not again", async () => {
    const getWorkflowGraph = vi.fn().mockResolvedValue(graph());
    installAde({ getWorkflowGraph });
    const { rerender } = await renderTab();
    expect(getWorkflowGraph).toHaveBeenCalledTimes(1);

    rerender(tab({ actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })] }));
    await waitFor(() => expect(getWorkflowGraph).toHaveBeenCalledTimes(2));

    // The second answer is still uncharted. One bounded retry per head SHA —
    // not a loop that re-asks every time the uncharted answer lands.
    rerender(tab({ actionRuns: [run({ jobs: [job({ id: 1, name: "build" }), job({ id: 2, name: "test" })] })] }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(getWorkflowGraph).toHaveBeenCalledTimes(2);
  });

  it("fetches the graph for a PR with no local row, addressed by its synthetic id", async () => {
    // The graph endpoint resolves GitHub coordinates, so a PR with no ADE lane
    // is not a reason to skip it.
    const getWorkflowGraph = vi.fn().mockResolvedValue(graph());
    installAde({ getWorkflowGraph, getCheckLog: vi.fn().mockResolvedValue(null) });
    await renderTab({
      pr: { ...pr, id: "gh:acme/ade#42" },
      actionRuns: [run({ jobs: [job({ id: 2, name: "test", conclusion: "failure" })] })],
    });

    await waitFor(() => expect(getWorkflowGraph).toHaveBeenCalled());
    expect(getWorkflowGraph.mock.calls[0]?.[0]).toMatchObject({ prId: "gh:acme/ade#42" });
  });
});

describe("PrChecksTab — graph", () => {
  it("collapses matrix legs onto one node instead of one node per leg", async () => {
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

    const nodes = screen.getAllByTestId("pr-checks-graph-node");
    expect(nodes).toHaveLength(2);
    const matrix = nodes.find((node) => node.getAttribute("data-job-id") === "test-desktop")!;
    expect(within(matrix).getAllByTestId("pr-checks-node-leg")).toHaveLength(4);
  });

  it("groups the flat fallback by workflow and keeps external checks in their own section", async () => {
    await renderTab({
      checks: [{
        name: "CodeRabbit", status: "in_progress", conclusion: null,
        detailsUrl: "https://coderabbit.ai/x", startedAt: null, completedAt: null,
      }],
      actionRuns: [run({ jobs: [job({ id: 1, name: "build" })] })],
    });
    const sections = screen.getAllByTestId("pr-checks-list-section");
    const titles = sections.map((section) => section.textContent ?? "");
    expect(titles.some((title) => title.startsWith("CI"))).toBe(true);
    const other = sections.find((section) => (section.textContent ?? "").startsWith("Other checks"))!;
    expect(within(other).getByText("CodeRabbit")).toBeTruthy();
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

  it("closes the drawer when the same graph node is activated twice", async () => {
    // Defect 3: a click that can only ever open is a dead end — the drawer has
    // no other relationship to the node the user just clicked.
    installAde({
      getWorkflowGraph: vi.fn().mockResolvedValue(chartedGraph()),
      getCheckLog: vi.fn().mockResolvedValue(excerpt),
    });
    await renderTab({ actionRuns: [run({ jobs: [job({ id: 1, name: "install" })] })] });

    const install = screen.getAllByTestId("pr-checks-graph-node")
      .find((node) => node.getAttribute("data-job-id") === "install")!;

    await act(async () => { install.click(); });
    expect(screen.getByTestId("pr-checks-log-drawer")).toBeTruthy();

    await act(async () => {
      screen.getAllByTestId("pr-checks-graph-node")
        .find((node) => node.getAttribute("data-job-id") === "install")!
        .click();
    });
    expect(screen.queryByTestId("pr-checks-log-drawer")).toBeNull();
  });

  it("closes the drawer when the same list row is activated twice", async () => {
    installAde({ getCheckLog: vi.fn().mockResolvedValue(excerpt) });
    await renderTab({
      actionRuns: [run({ conclusion: "success", jobs: [job({ id: 1, name: "build" })] })],
    });

    const rowFor = () => screen.getAllByTestId("pr-checks-row")
      .find((row) => row.getAttribute("data-check-name") === "CI / build")!;

    await act(async () => { rowFor().click(); });
    expect(screen.getByTestId("pr-checks-log-drawer")).toBeTruthy();
    await act(async () => { rowFor().click(); });
    expect(screen.queryByTestId("pr-checks-log-drawer")).toBeNull();
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
    const names = within(flat).getAllByTestId("pr-checks-row")
      .map((row) => row.getAttribute("data-check-name"));
    expect(names).toContain("CI / failed-job");
    expect(names).not.toContain("CI / running-job");
  });

  it("strips the workflow prefix the section header already carries", async () => {
    await renderTab({
      actionRuns: [run({ conclusion: "success", jobs: [job({ id: 1, name: "build" })] })],
    });
    await act(async () => { screen.getByTestId("pr-checks-view-list").click(); });

    const row = screen.getAllByTestId("pr-checks-row")
      .find((entry) => entry.getAttribute("data-check-name") === "CI / build")!;
    // Identity stays fully qualified; the label does not repeat its section.
    expect(within(row).getByText("build")).toBeTruthy();
    expect(within(row).queryByText("CI / build")).toBeNull();
  });
});
