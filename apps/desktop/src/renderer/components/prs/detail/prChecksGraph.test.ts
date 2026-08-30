import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrWorkflowGraphNode } from "../../../../shared/types";
import {
  CHECKS_COLUMN_GAP,
  CHECKS_NODE_BASE_HEIGHT,
  CHECKS_NODE_LEGS_HEIGHT,
  CHECKS_NODE_PROGRESS_HEIGHT,
  CHECKS_NODE_WIDTH,
  CHECKS_ROW_GAP,
  assignChecksGraphLayers,
  checksCanvasHeight,
  checksNodeHeight,
  checksNodeShowsProgress,
  checksSkeletonShape,
  criticalPathEdgeKeys,
  layoutChecksGraph,
} from "./prChecksGraphLayout";
import type { PrWorkflowGraph } from "../../../../shared/types";
import {
  CHECKS_GRAPH_CACHE_MAX_ENTRIES,
  CHECKS_GRAPH_CHARTED_TTL_MS,
  CHECKS_GRAPH_UNCHARTED_TTL_MS,
  checksGraphCacheKey,
  fetchChecksGraphOnce,
  isChartedGraph,
  readChecksGraphCache,
  resetChecksGraphCacheForTests,
  shouldRefetchOnFirstActionRun,
  writeChecksGraphCache,
} from "./prChecksGraphCache";
import type { UnifiedCheckItem } from "../shared/prUnifiedChecks";
import {
  OTHER_CHECKS_SECTION,
  groupChecksForList,
  rowLabel,
  workflowOf,
} from "./prChecksListModel";

function node(overrides: Partial<PrWorkflowGraphNode> & { jobId: string }): PrWorkflowGraphNode {
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
    runId: null,
    detailsUrl: null,
    ...overrides,
  };
}

const columnX = (layer: number) => layer * (CHECKS_NODE_WIDTH + CHECKS_COLUMN_GAP);

describe("assignChecksGraphLayers", () => {
  it("uses the longest path, not the shortest, so a late dependency wins", () => {
    // install → lint → gate  and  install → gate. `gate` must sit in column 2,
    // behind `lint`; taking the short edge would draw a job on top of the job it
    // depends on.
    const layers = assignChecksGraphLayers(
      [node({ jobId: "install" }), node({ jobId: "lint" }), node({ jobId: "gate" })],
      [
        { from: "install", to: "lint" },
        { from: "install", to: "gate" },
        { from: "lint", to: "gate" },
      ],
    );
    expect(layers.get("install")).toBe(0);
    expect(layers.get("lint")).toBe(1);
    expect(layers.get("gate")).toBe(2);
  });

  it("ignores edges whose endpoints are not both present", () => {
    // The service can name a `needs:` target it could not resolve to a live job.
    // Honouring it would push a root out of column 0 for a node that is not
    // drawn at all.
    const layers = assignChecksGraphLayers(
      [node({ jobId: "build" })],
      [{ from: "ghost", to: "build" }, { from: "build", to: "build" }],
    );
    expect(layers.get("build")).toBe(0);
  });

  it("keeps every node on screen when the edges form a cycle", () => {
    // `needs:` cannot legally express a cycle, but a partially-resolved graph
    // can still hand us one. Looping forever or dropping the jobs are both
    // worse than falling back to the reported tier.
    const layers = assignChecksGraphLayers(
      [node({ jobId: "a", tier: 3 }), node({ jobId: "b", tier: 4 })],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    );
    expect(layers.get("a")).toBe(3);
    expect(layers.get("b")).toBe(4);
  });

  it("does not put two workflows' roots in different columns just because tiers repeat", () => {
    // Both workflows start at tier 0. Layering from edges is what keeps them
    // side by side instead of stacking one behind the other.
    const layers = assignChecksGraphLayers(
      [node({ jobId: "ci-build", tier: 0 }), node({ jobId: "docs-build", tier: 0 })],
      [],
    );
    expect(layers.get("ci-build")).toBe(0);
    expect(layers.get("docs-build")).toBe(0);
  });
});

describe("checksNodeHeight", () => {
  it("only reserves the matrix strip for a node that actually has legs", () => {
    expect(checksNodeHeight({ legs: [] })).toBe(CHECKS_NODE_BASE_HEIGHT);
    expect(checksNodeHeight({ legs: [{} as never, {} as never] }))
      .toBe(CHECKS_NODE_BASE_HEIGHT + CHECKS_NODE_LEGS_HEIGHT);
  });

  it("reserves the progress row on exactly the condition the node renders it", () => {
    // Layout and render must agree, or the bar overflows the card measured for
    // it. Both sides ask `checksNodeShowsProgress`.
    const steps = [{ name: "Run vitest", status: "completed", conclusion: "success", number: 1, startedAt: null, completedAt: null }] as never;
    expect(checksNodeShowsProgress({ state: "running", steps })).toBe(true);
    expect(checksNodeShowsProgress({ state: "running", steps: [] })).toBe(false);
    expect(checksNodeShowsProgress({ state: "passed", steps })).toBe(false);
    expect(checksNodeHeight({ legs: [], state: "running", steps }))
      .toBe(CHECKS_NODE_BASE_HEIGHT + CHECKS_NODE_PROGRESS_HEIGHT);
    expect(checksNodeHeight({ legs: [], state: "passed", steps })).toBe(CHECKS_NODE_BASE_HEIGHT);
  });
});

describe("layoutChecksGraph", () => {
  it("places one column per dependency depth", () => {
    const layout = layoutChecksGraph(
      [node({ jobId: "install" }), node({ jobId: "test", tier: 1 }), node({ jobId: "gate", tier: 2 })],
      [{ from: "install", to: "test" }, { from: "test", to: "gate" }],
    );
    const xOf = (id: string) => layout.nodes.find((entry) => entry.node.jobId === id)!.x;
    expect(xOf("install")).toBe(columnX(0));
    expect(xOf("test")).toBe(columnX(1));
    expect(xOf("gate")).toBe(columnX(2));
    expect(layout.layerCount).toBe(3);
  });

  it("centres a short column against the tallest one", () => {
    // A single `install` feeding three parallel jobs should sit level with the
    // middle of the fan, not level with its top.
    const layout = layoutChecksGraph(
      [
        node({ jobId: "install" }),
        node({ jobId: "a", tier: 1 }),
        node({ jobId: "b", tier: 1 }),
        node({ jobId: "c", tier: 1 }),
      ],
      [
        { from: "install", to: "a" },
        { from: "install", to: "b" },
        { from: "install", to: "c" },
      ],
    );
    const install = layout.nodes.find((entry) => entry.node.jobId === "install")!;
    const middle = layout.nodes.find((entry) => entry.node.jobId === "b")!;
    expect(install.y + install.height / 2).toBeCloseTo(middle.y + middle.height / 2, 5);
    expect(layout.height).toBe(3 * CHECKS_NODE_BASE_HEIGHT + 2 * CHECKS_ROW_GAP);
  });

  it("orders a column by its predecessors, so edges do not cross needlessly", () => {
    // Declaration order puts `a-child` after `b-child`; the barycentre sweep has
    // to reverse them to match their parents' order.
    const layout = layoutChecksGraph(
      [
        node({ jobId: "a", tier: 0 }),
        node({ jobId: "b", tier: 0 }),
        node({ jobId: "b-child", tier: 1 }),
        node({ jobId: "a-child", tier: 1 }),
      ],
      [{ from: "a", to: "a-child" }, { from: "b", to: "b-child" }],
    );
    const second = layout.nodes
      .filter((entry) => entry.layer === 1)
      .sort((left, right) => left.indexInLayer - right.indexInLayer)
      .map((entry) => entry.node.jobId);
    expect(second).toEqual(["a-child", "b-child"]);
  });

  it("is deterministic — the same input lays out identically twice", () => {
    // A graph that reshuffles between renders while CI runs is unreadable.
    const nodes = [
      node({ jobId: "install" }),
      node({ jobId: "x", tier: 1 }),
      node({ jobId: "y", tier: 1 }),
      node({ jobId: "gate", tier: 2 }),
    ];
    const edges = [
      { from: "install", to: "x" },
      { from: "install", to: "y" },
      { from: "x", to: "gate" },
      { from: "y", to: "gate" },
    ];
    expect(layoutChecksGraph(nodes, edges)).toEqual(layoutChecksGraph(nodes, edges));
  });

  it("marks only genuinely running downstream edges live, and de-duplicates edges", () => {
    const layout = layoutChecksGraph(
      [
        node({ jobId: "install" }),
        node({ jobId: "running", tier: 1, state: "running" }),
        node({ jobId: "queued", tier: 1, state: "queued" }),
      ],
      [
        { from: "install", to: "running" },
        { from: "install", to: "running" },
        { from: "install", to: "queued" },
      ],
    );
    expect(layout.edges).toHaveLength(2);
    const live = layout.edges.find((edge) => edge.to === "running")!;
    const pending = layout.edges.find((edge) => edge.to === "queued")!;
    expect(live).toMatchObject({ live: true, pending: false });
    expect(pending).toMatchObject({ live: false, pending: true });
  });

  it("marks the critical path on both the nodes and the edges between them", () => {
    const layout = layoutChecksGraph(
      [node({ jobId: "install" }), node({ jobId: "slow", tier: 1 }), node({ jobId: "fast", tier: 1 })],
      [{ from: "install", to: "slow" }, { from: "install", to: "fast" }],
      ["install", "slow"],
    );
    expect(layout.nodes.filter((entry) => entry.onCriticalPath).map((entry) => entry.node.jobId))
      .toEqual(expect.arrayContaining(["install", "slow"]));
    expect(layout.edges.find((edge) => edge.to === "slow")!.onCriticalPath).toBe(true);
    expect(layout.edges.find((edge) => edge.to === "fast")!.onCriticalPath).toBe(false);
  });

  it("returns an empty layout rather than NaN geometry for no nodes", () => {
    expect(layoutChecksGraph([], [])).toMatchObject({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

describe("criticalPathEdgeKeys", () => {
  it("keys consecutive pairs only", () => {
    expect(criticalPathEdgeKeys(["a", "b", "c"])).toEqual(new Set(["a\u0000b", "b\u0000c"]));
    expect(criticalPathEdgeKeys(["only"]).size).toBe(0);
  });
});

describe("checksCanvasHeight", () => {
  it("stays inside its bounds so the log drawer is never pushed off screen", () => {
    expect(checksCanvasHeight(0)).toBe(220);
    expect(checksCanvasHeight(5_000)).toBe(520);
    expect(checksCanvasHeight(300)).toBe(348);
  });
});

describe("checksSkeletonShape", () => {
  it("approximates a setup → fan-out → gate pipeline, bounded at both ends", () => {
    expect(checksSkeletonShape(0)).toEqual([1]);
    expect(checksSkeletonShape(2)).toEqual([2]);
    expect(checksSkeletonShape(4)).toEqual([1, 3]);
    expect(checksSkeletonShape(8)).toEqual([1, 5, 1]);
    // A 40-job monorepo run must not render 40 ghost cards.
    expect(checksSkeletonShape(400)).toEqual([1, 5, 1]);
  });
});


/* -- Folded in from `prChecksGraphCache.test.ts` --
   The cache in front of the graph read: same subsystem, same pure-node environment. */

function cachedGraph(overrides: Partial<PrWorkflowGraph> = {}): PrWorkflowGraph {
  return {
    source: "worktree",
    unavailableReason: null,
    headSha: "abc1234",
    attempt: 1,
    nodes: [{
      jobId: "build", displayName: "build", workflowName: "CI", state: "passed", tier: 0,
      durationMs: null, startedAt: null, completedAt: null, legs: [], steps: [],
      checkRunId: null, runId: null, detailsUrl: null,
    }, {
      jobId: "gate", displayName: "gate", workflowName: "CI", state: "passed", tier: 1,
      durationMs: null, startedAt: null, completedAt: null, legs: [], steps: [],
      checkRunId: null, runId: null, detailsUrl: null,
    }],
    edges: [{ from: "build", to: "gate" }],
    criticalPath: [],
    externalChecks: [],
    stale: false,
    staleBehindBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetChecksGraphCacheForTests();
});

describe("checksGraphCacheKey", () => {
  it("separates head SHAs, because a push is a different pipeline", () => {
    expect(checksGraphCacheKey("pr-1", "aaa")).not.toBe(checksGraphCacheKey("pr-1", "bbb"));
    expect(checksGraphCacheKey("pr-1", null)).toBe(checksGraphCacheKey("pr-1", undefined));
  });
});

describe("isChartedGraph", () => {
  it("requires an actual dependency structure, not just nodes", () => {
    expect(isChartedGraph(cachedGraph())).toBe(true);
    expect(isChartedGraph(cachedGraph({ edges: [] }))).toBe(false);
    expect(isChartedGraph(cachedGraph({ source: "none" }))).toBe(false);
    expect(isChartedGraph(cachedGraph({ nodes: [] }))).toBe(false);
    expect(isChartedGraph(null)).toBe(false);
  });
});

describe("checks graph cache TTL", () => {
  it("holds a charted graph for the long window — its edges cannot change under a fixed SHA", () => {
    writeChecksGraphCache("k", cachedGraph(), 0);
    expect(readChecksGraphCache("k", CHECKS_GRAPH_CHARTED_TTL_MS - 1)?.graph).not.toBeNull();
    expect(readChecksGraphCache("k", CHECKS_GRAPH_CHARTED_TTL_MS)).toBeNull();
  });

  it("expires an uncharted answer quickly, because it may be an unreachable GitHub in disguise", () => {
    // The service folds its own read failures into `source: "none"`. Holding
    // that for five minutes would hide a GitHub that came back thirty seconds
    // later.
    writeChecksGraphCache("k", cachedGraph({ source: "none", edges: [] }), 0);
    expect(readChecksGraphCache("k", CHECKS_GRAPH_UNCHARTED_TTL_MS - 1)).not.toBeNull();
    expect(readChecksGraphCache("k", CHECKS_GRAPH_UNCHARTED_TTL_MS)).toBeNull();
  });

  it("caches an explicit null — an old runtime with no graph endpoint should not be re-asked per mount", () => {
    writeChecksGraphCache("k", null, 0);
    expect(readChecksGraphCache("k", 1)).toMatchObject({ graph: null });
  });

  it("evicts the oldest write once it is full", () => {
    for (let index = 0; index <= CHECKS_GRAPH_CACHE_MAX_ENTRIES; index += 1) {
      writeChecksGraphCache(`k${index}`, cachedGraph(), index);
    }
    expect(readChecksGraphCache("k0", 1)).toBeNull();
    expect(readChecksGraphCache(`k${CHECKS_GRAPH_CACHE_MAX_ENTRIES}`, 1)).not.toBeNull();
  });
});

describe("fetchChecksGraphOnce", () => {
  it("collapses concurrent reads of the same key into one GitHub request", async () => {
    // Two mounts in the same tick — a tab bounce, or React's development
    // double-effect — must cost one request, not two.
    const fetcher = vi.fn().mockResolvedValue(cachedGraph());
    const [first, second] = await Promise.all([
      fetchChecksGraphOnce("k", fetcher),
      fetchChecksGraphOnce("k", fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("forgets a rejection, so the next attempt is a real attempt", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("502"));
    await expect(fetchChecksGraphOnce("k", failing)).rejects.toThrow("502");
    const succeeding = vi.fn().mockResolvedValue(cachedGraph());
    await expect(fetchChecksGraphOnce("k", succeeding)).resolves.not.toBeNull();
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});

describe("shouldRefetchOnFirstActionRun", () => {
  it("re-asks only when we charted nothing and CI has since reported", () => {
    expect(shouldRefetchOnFirstActionRun({ graph: null, hasActionRuns: true })).toBe(true);
    expect(shouldRefetchOnFirstActionRun({ graph: null, hasActionRuns: false })).toBe(false);
  });

  it("never re-asks for a charted graph — its edges are fixed by the head SHA", () => {
    // This is the guard that keeps a second full round of Actions/checks reads
    // off the hottest GitHub path in the app.
    expect(shouldRefetchOnFirstActionRun({ graph: cachedGraph(), hasActionRuns: true })).toBe(false);
  });
});


/* -- Folded in from `prChecksListModel.test.ts` --
   The List view is the same graph data grouped differently. */

function item(overrides: Partial<UnifiedCheckItem> & { name: string }): UnifiedCheckItem {
  return {
    id: overrides.name,
    displayName: overrides.name,
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
    ...overrides,
  };
}

describe("workflowOf", () => {
  it("prefers the declared workflow, falls back to the name's prefix", () => {
    expect(workflowOf(item({ name: "x", workflowName: "CI" }))).toBe("CI");
    expect(workflowOf(item({ name: "Docs / spellcheck" }))).toBe("Docs");
  });

  it("buckets a check that names no workflow, rather than inventing one", () => {
    expect(workflowOf(item({ name: "CodeRabbit", source: "check" }))).toBe(OTHER_CHECKS_SECTION);
  });
});

describe("rowLabel", () => {
  it("drops the prefix the section header already carries", () => {
    expect(rowLabel(item({ name: "CI / build", workflowName: "CI" }), "CI")).toBe("build");
  });

  it("leaves a name that does not carry the prefix untouched", () => {
    expect(rowLabel(item({ name: "Vercel", source: "check" }), OTHER_CHECKS_SECTION)).toBe("Vercel");
    // A workflow whose name merely starts the same way must not be truncated.
    expect(rowLabel(item({ name: "CI-nightly / build" }), "CI")).toBe("CI-nightly / build");
  });
});

describe("groupChecksForList", () => {
  it("puts the workflow with failures first, not the alphabetically first one", () => {
    // On a red PR the only question is "what broke". Alphabetical order makes
    // the user scan for it.
    const sections = groupChecksForList([
      item({ name: "Alpha / ok", workflowName: "Alpha" }),
      item({ name: "Zulu / broken", workflowName: "Zulu", conclusion: "failure" }),
    ]);
    expect(sections.map((section) => section.workflowName)).toEqual(["Zulu", "Alpha"]);
    expect(sections[0]).toMatchObject({ state: "failed", failedCount: 1 });
  });

  it("pins the leftovers bucket last even when it needs attention", () => {
    const sections = groupChecksForList([
      item({ name: "CodeRabbit", source: "check", conclusion: "failure" }),
      item({ name: "CI / ok", workflowName: "CI" }),
    ]);
    expect(sections.map((section) => section.workflowName)).toEqual(["CI", OTHER_CHECKS_SECTION]);
  });

  it("surfaces the broken rows first inside a section", () => {
    const sections = groupChecksForList([
      item({ name: "CI / a", workflowName: "CI" }),
      item({ name: "CI / b", workflowName: "CI", conclusion: "failure" }),
      item({ name: "CI / c", workflowName: "CI", status: "in_progress", conclusion: null }),
    ]);
    expect(sections[0]!.items.map((entry) => entry.name)).toEqual(["CI / b", "CI / c", "CI / a"]);
  });

  it("reports a section's worst state, so its header cannot read green over a failure", () => {
    const sections = groupChecksForList([
      item({ name: "CI / a", workflowName: "CI" }),
      item({ name: "CI / b", workflowName: "CI", conclusion: "failure" }),
    ]);
    expect(sections[0]!.state).toBe("failed");
  });

  it("returns nothing for no checks", () => {
    expect(groupChecksForList([])).toEqual([]);
  });
});
