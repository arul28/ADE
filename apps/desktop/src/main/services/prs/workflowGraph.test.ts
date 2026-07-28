import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  computeCriticalPath,
  computeTiers,
  createWorkflowGraph,
  latestRunsByWorkflow,
  matrixLegMatches,
  parseWorkflowFile,
  pipelineStateForJob,
  worstPipelineState,
  type WorkflowFileSource,
  type WorkflowGraphDeps,
} from "./workflowGraph";
import type { PrActionJob, PrActionRun, PrCheck } from "../../../shared/types/prs";

/** ADE's own CI workflow — the real-world shape this service exists for. */
const ADE_CI_YAML_PATH = path.resolve(__dirname, "../../../../../../.github/workflows/ci.yml");

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

function job(over: Partial<PrActionJob> & { name: string }): PrActionJob {
  return {
    id: 0,
    status: "completed",
    conclusion: "success",
    startedAt: null,
    completedAt: null,
    steps: [],
    ...over,
  };
}

function run(over: Partial<PrActionRun> & { name: string; jobs: PrActionJob[] }): PrActionRun {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    headSha: "headsha",
    htmlUrl: "https://github.com/acme/repo/actions/runs/1",
    createdAt: "2026-07-27T11:00:00Z",
    updatedAt: "2026-07-27T11:30:00Z",
    ...over,
  };
}

function makeService(
  files: WorkflowFileSource[] | null,
  extra: Partial<WorkflowGraphDeps> = {},
) {
  return createWorkflowGraph({
    readWorktreeWorkflows: async () => files,
    readContentsApiWorkflows: async () => null,
    now: () => NOW,
    ...extra,
  });
}

const BASE_INPUT = {
  repoOwner: "acme",
  repoName: "repo",
  headSha: "headsha",
  worktreePath: "/tmp/lane",
  checks: [] as PrCheck[],
};

/* ────────────────────────────── YAML parsing ─────────────────────────────── */

describe("parseWorkflowFile", () => {
  it("parses only needs + matrix from ADE's real ci.yml", () => {
    const content = fs.readFileSync(ADE_CI_YAML_PATH, "utf8");
    const parsed = parseWorkflowFile({ path: ".github/workflows/ci.yml", content });

    expect(parsed.degraded).toBeNull();
    expect(parsed.name).toBe("CI");
    // ~21 jobs: install, secret-scan, ~18 parallel, ci-pass.
    expect(parsed.jobs.length).toBeGreaterThanOrEqual(20);

    const install = parsed.jobs.find((entry) => entry.id === "install");
    expect(install?.needs).toEqual([]);

    // `needs: install` given as a bare string, not a list.
    const typecheckDesktop = parsed.jobs.find((entry) => entry.id === "typecheck-desktop");
    expect(typecheckDesktop?.needs).toEqual(["install"]);

    // The gate depends on everything upstream.
    const gate = parsed.jobs.find((entry) => entry.id === "ci-pass");
    expect(gate?.needs.length).toBeGreaterThan(10);
    expect(gate?.needs).toContain("typecheck-desktop");
    expect(gate?.needs).toContain("test-desktop");

    // Two matrix jobs.
    const matrixJobs = parsed.jobs.filter((entry) => entry.isMatrix).map((entry) => entry.id);
    expect(matrixJobs).toContain("test-desktop");
    expect(matrixJobs).toContain("build-runtime-binaries");
  });

  it("degrades a reusable-workflow job", () => {
    const parsed = parseWorkflowFile({
      path: ".github/workflows/reuse.yml",
      content: ["name: Reuse", "jobs:", "  call:", "    uses: ./.github/workflows/inner.yml"].join("\n"),
    });
    expect(parsed.degraded).toBe("reusable-workflow");
  });

  it("degrades a dynamic job name", () => {
    const parsed = parseWorkflowFile({
      path: ".github/workflows/dyn.yml",
      content: [
        "name: Dyn",
        "jobs:",
        "  build:",
        "    name: build ${{ matrix.os }}",
        "    runs-on: ubuntu-latest",
      ].join("\n"),
    });
    expect(parsed.degraded).toBe("dynamic-job-name");
  });

  it("degrades unparseable YAML", () => {
    const parsed = parseWorkflowFile({
      path: ".github/workflows/bad.yml",
      content: "name: Bad\njobs:\n  a: [1,\n   unbalanced: {{{",
    });
    expect(parsed.degraded).toBe("unparseable");
    expect(parsed.jobs).toEqual([]);
  });
});

/* ─────────────────────────── pure graph helpers ──────────────────────────── */

describe("state rollup", () => {
  it("ranks failed worst and skipped best-ignorable", () => {
    expect(worstPipelineState(["passed", "failed", "running"])).toBe("failed");
    expect(worstPipelineState(["passed", "running"])).toBe("running");
    expect(worstPipelineState(["passed", "queued"])).toBe("queued");
    expect(worstPipelineState(["passed", "skipped"])).toBe("passed");
    expect(worstPipelineState(["passed", "unknown"])).toBe("unknown");
    expect(worstPipelineState([])).toBe("unknown");
  });

  it("maps live job status/conclusion onto pipeline state", () => {
    expect(pipelineStateForJob({ status: "in_progress", conclusion: null })).toBe("running");
    expect(pipelineStateForJob({ status: "queued", conclusion: null })).toBe("queued");
    expect(pipelineStateForJob({ status: "completed", conclusion: "success" })).toBe("passed");
    expect(pipelineStateForJob({ status: "completed", conclusion: "failure" })).toBe("failed");
    expect(pipelineStateForJob({ status: "completed", conclusion: "cancelled" })).toBe("failed");
    expect(pipelineStateForJob({ status: "completed", conclusion: "timed_out" })).toBe("failed");
    expect(pipelineStateForJob({ status: "completed", conclusion: "action_required" })).toBe("failed");
    expect(pipelineStateForJob({ status: "completed", conclusion: "skipped" })).toBe("skipped");
    expect(pipelineStateForJob({ status: "completed", conclusion: null })).toBe("unknown");
  });

  it("keeps only the newest run for each workflow on one head", () => {
    const older = run({
      id: 10,
      name: "CI",
      createdAt: "2026-07-27T10:00:00Z",
      updatedAt: "2026-07-27T10:05:00Z",
      jobs: [job({ id: 10, name: "old" })],
    });
    const newer = run({
      id: 11,
      name: "CI",
      createdAt: "2026-07-27T11:00:00Z",
      updatedAt: "2026-07-27T11:05:00Z",
      jobs: [job({ id: 11, name: "new" })],
    });
    const docs = run({ id: 12, name: "Docs", jobs: [job({ id: 12, name: "lint" })] });

    expect(latestRunsByWorkflow([older, docs, newer]).map((entry) => entry.id)).toEqual([11, 12]);
  });

  it("keeps same-named workflows separate when GitHub provides their paths", () => {
    const first = run({
      id: 21,
      name: "CI",
      workflowPath: ".github/workflows/ci.yml",
      jobs: [job({ id: 21, name: "build" })],
    });
    const second = run({
      id: 22,
      name: "CI",
      workflowPath: ".github/workflows/security.yml",
      jobs: [job({ id: 22, name: "scan" })],
    });

    expect(latestRunsByWorkflow([first, second]).map((entry) => entry.id)).toEqual([21, 22]);
  });
});

describe("matrixLegMatches", () => {
  it("matches GitHub's documented expanded-matrix naming", () => {
    expect(matrixLegMatches("test-desktop (main)", "test-desktop")).toBe(true);
    expect(matrixLegMatches("build-runtime-binaries (darwin-arm64, macos-15)", "build-runtime-binaries")).toBe(true);
    // Never a fuzzy contains — a sibling job must not be swallowed as a leg.
    expect(matrixLegMatches("test-desktop-extra", "test-desktop")).toBe(false);
    expect(matrixLegMatches("test-desktop", "test-desktop")).toBe(false);
  });
});

describe("computeTiers", () => {
  it("ranks by longest path over needs", () => {
    const tiers = computeTiers(
      ["a", "b", "c", "d"],
      [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    );
    expect(tiers.get("a")).toBe(0);
    expect(tiers.get("b")).toBe(1);
    expect(tiers.get("c")).toBe(1);
    expect(tiers.get("d")).toBe(2);
  });

  it("breaks a cycle instead of looping forever", () => {
    const tiers = computeTiers(
      ["root", "x", "y"],
      [
        { from: "root", to: "x" },
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ],
    );
    expect(tiers.get("root")).toBe(0);
    // x and y are unsettleable; they get parked past the DAG, not dropped.
    expect(tiers.get("x")).toBeGreaterThan(0);
    expect(tiers.get("y")).toBeGreaterThan(0);
  });
});

describe("computeCriticalPath", () => {
  it("returns the longest-duration chain, not the longest hop chain", () => {
    const nodes = [
      { jobId: "install", durationMs: 60_000, tier: 0 },
      { jobId: "fast", durationMs: 1_000, tier: 1 },
      { jobId: "slow", durationMs: 500_000, tier: 1 },
      { jobId: "gate", durationMs: 1_000, tier: 2 },
    ];
    const edges = [
      { from: "install", to: "fast" },
      { from: "install", to: "slow" },
      { from: "fast", to: "gate" },
      { from: "slow", to: "gate" },
    ];
    expect(computeCriticalPath(nodes, edges)).toEqual(["install", "slow", "gate"]);
  });
});

/* ────────────────────────────── graph building ───────────────────────────── */

describe("createWorkflowGraph.build", () => {
  const CI_YAML = fs.readFileSync(ADE_CI_YAML_PATH, "utf8");
  const CI_FILE: WorkflowFileSource = { path: ".github/workflows/ci.yml", content: CI_YAML };

  it("reconstructs install -> parallel -> ci-pass from the real ci.yml", async () => {
    const service = makeService([CI_FILE]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [
        run({
          name: "CI",
          runAttempt: 2,
          jobs: [
            job({ id: 10, name: "install" }),
            job({ id: 11, name: "typecheck-desktop" }),
            job({ id: 12, name: "lint-desktop" }),
            job({ id: 13, name: "ci-pass" }),
          ],
        }),
      ],
    });

    expect(graph.source).toBe("worktree");
    expect(graph.unavailableReason).toBeNull();
    expect(graph.attempt).toBe(2);

    const byId = new Map(graph.nodes.map((node) => [node.jobId, node]));
    expect(byId.get("install")?.tier).toBe(0);
    expect(byId.get("typecheck-desktop")?.tier).toBe(1);
    expect(byId.get("lint-desktop")?.tier).toBe(1);
    // The gate sits one tier past its deepest dependency.
    expect(byId.get("ci-pass")!.tier).toBeGreaterThan(1);

    expect(graph.edges).toContainEqual({ from: "install", to: "typecheck-desktop" });
    expect(graph.edges).toContainEqual({ from: "typecheck-desktop", to: "ci-pass" });
    // `secret-scan` has no needs, so it must have no inbound edge.
    expect(graph.edges.filter((edge) => edge.to === "secret-scan")).toEqual([]);
  });

  it("collapses matrix legs into one node whose state is the worst leg", async () => {
    const service = makeService([CI_FILE]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [
        run({
          name: "CI",
          conclusion: "failure",
          jobs: [
            job({ id: 1, name: "install" }),
            job({
              id: 2,
              name: "test-desktop (main)",
              conclusion: "success",
              startedAt: "2026-07-27T11:00:00Z",
              completedAt: "2026-07-27T11:05:00Z",
            }),
            job({
              id: 3,
              name: "test-desktop (renderer)",
              conclusion: "failure",
              startedAt: "2026-07-27T11:00:00Z",
              completedAt: "2026-07-27T11:09:00Z",
              steps: [
                { name: "Run tests", status: "completed", conclusion: "failure", number: 3, startedAt: null, completedAt: null },
              ],
            }),
          ],
        }),
      ],
    });

    const node = graph.nodes.find((entry) => entry.jobId === "test-desktop")!;
    expect(node.legs).toHaveLength(2);
    expect(node.legs.map((leg) => leg.name)).toEqual([
      "test-desktop (main)",
      "test-desktop (renderer)",
    ]);
    expect(node.state).toBe("failed");
    // Node span covers every leg: earliest start, latest completion.
    expect(node.durationMs).toBe(9 * 60_000);
    // Steps come from the failing leg, not the first one.
    expect(node.steps.map((step) => step.name)).toEqual(["Run tests"]);
    // Exactly one node per template job — legs never leak out as nodes.
    expect(graph.nodes.filter((entry) => entry.displayName === "test-desktop")).toHaveLength(1);
  });

  it("reports live elapsed for a running node instead of null", async () => {
    const service = makeService([CI_FILE]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [
        run({
          name: "CI",
          status: "in_progress",
          conclusion: null,
          jobs: [
            job({
              id: 1,
              name: "install",
              status: "in_progress",
              conclusion: null,
              startedAt: new Date(NOW - 90_000).toISOString(),
            }),
          ],
        }),
      ],
    });
    const node = graph.nodes.find((entry) => entry.jobId === "install")!;
    expect(node.state).toBe("running");
    expect(node.durationMs).toBe(90_000);
    expect(node.completedAt).toBeNull();
  });

  it("degrades a reusable workflow to swimlanes without dropping the other workflow", async () => {
    const reusable: WorkflowFileSource = {
      path: ".github/workflows/release.yml",
      content: ["name: Release", "jobs:", "  call:", "    uses: ./.github/workflows/inner.yml"].join("\n"),
    };
    const service = makeService([CI_FILE, reusable]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [
        run({ name: "CI", jobs: [job({ id: 1, name: "install" }), job({ id: 2, name: "ci-pass" })] }),
        run({ id: 2, name: "Release", jobs: [job({ id: 3, name: "call / publish" })] }),
      ],
    });

    // CI still graphs, so the graph as a whole is available.
    expect(graph.source).toBe("worktree");
    expect(graph.unavailableReason).toBeNull();
    expect(graph.edges).toContainEqual({ from: "install", to: "ci-pass" });

    // The reusable workflow's job is a flat swimlane node with no edges.
    const swimlane = graph.nodes.find((entry) => entry.displayName === "call / publish")!;
    expect(swimlane.workflowName).toBe("Release");
    expect(swimlane.tier).toBe(0);
    expect(graph.edges.some((edge) => edge.to === swimlane.jobId)).toBe(false);
  });

  it("joins duplicate workflow names by file path and never guesses when the path is missing", async () => {
    const buildWorkflow: WorkflowFileSource = {
      path: ".github/workflows/build.yml",
      content: [
        "name: CI",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "  gate:",
        "    needs: build",
        "    runs-on: ubuntu-latest",
      ].join("\n"),
    };
    const securityWorkflow: WorkflowFileSource = {
      path: ".github/workflows/security.yml",
      content: [
        "name: CI",
        "jobs:",
        "  scan:",
        "    runs-on: ubuntu-latest",
        "  report:",
        "    needs: scan",
        "    runs-on: ubuntu-latest",
      ].join("\n"),
    };
    const service = makeService([buildWorkflow, securityWorkflow]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [
        run({
          id: 31,
          name: "CI",
          workflowPath: ".github/workflows/security.yml",
          jobs: [job({ id: 31, name: "scan" }), job({ id: 32, name: "report" })],
        }),
        run({
          id: 33,
          name: "CI",
          jobs: [job({ id: 33, name: "unknown-a" }), job({ id: 34, name: "unknown-b" })],
        }),
      ],
    });

    expect(graph.edges).toContainEqual({ from: "scan", to: "report" });
    expect(graph.edges.some((edge) => edge.from.includes("unknown") || edge.to.includes("unknown"))).toBe(false);
    expect(graph.nodes.map((node) => node.displayName)).toEqual(
      expect.arrayContaining(["scan", "report", "unknown-a", "unknown-b"]),
    );
  });

  it("reports unavailableReason when every workflow degrades", async () => {
    const reusable: WorkflowFileSource = {
      path: ".github/workflows/release.yml",
      content: ["name: Release", "jobs:", "  call:", "    uses: ./.github/workflows/inner.yml"].join("\n"),
    };
    const service = makeService([reusable]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [run({ name: "Release", jobs: [job({ id: 1, name: "call / publish" })] })],
    });
    expect(graph.source).toBe("none");
    expect(graph.unavailableReason).toBe("reusable-workflow");
    expect(graph.edges).toEqual([]);
    expect(graph.nodes).toHaveLength(1);
  });

  it("breaks a cycle in malformed YAML rather than hanging", async () => {
    const cyclic: WorkflowFileSource = {
      path: ".github/workflows/cycle.yml",
      content: [
        "name: Cycle",
        "jobs:",
        "  a:",
        "    needs: c",
        "  b:",
        "    needs: a",
        "  c:",
        "    needs: b",
      ].join("\n"),
    };
    const service = makeService([cyclic]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [
        run({
          name: "Cycle",
          jobs: [job({ id: 1, name: "a" }), job({ id: 2, name: "b" }), job({ id: 3, name: "c" })],
        }),
      ],
    });
    expect(graph.nodes.map((node) => node.jobId).sort()).toEqual(["a", "b", "c"]);
    expect(graph.edges).toHaveLength(3);
    // Every node still gets a finite tier.
    for (const node of graph.nodes) expect(Number.isFinite(node.tier)).toBe(true);
    expect(graph.criticalPath.length).toBeGreaterThan(0);
  });

  it("falls back to the Contents API when the worktree cannot answer", async () => {
    const service = createWorkflowGraph({
      readWorktreeWorkflows: async () => null,
      readContentsApiWorkflows: async () => [CI_FILE],
      now: () => NOW,
    });
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [run({ name: "CI", jobs: [job({ id: 1, name: "install" }), job({ id: 2, name: "ci-pass" })] })],
    });
    expect(graph.source).toBe("contents-api");
    expect(graph.edges).toContainEqual({ from: "install", to: "ci-pass" });
  });

  it("returns source none with no-workflow-file when no source has the YAML", async () => {
    const service = makeService(null);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [run({ name: "CI", jobs: [job({ id: 1, name: "install" }), job({ id: 2, name: "ci-pass" })] })],
    });
    expect(graph.source).toBe("none");
    expect(graph.unavailableReason).toBe("no-workflow-file");
    // Never guess an edge.
    expect(graph.edges).toEqual([]);
    // Jobs still render as swimlanes.
    expect(graph.nodes.map((node) => node.displayName).sort()).toEqual(["ci-pass", "install"]);
  });

  it("returns not-actions when the PR has no Actions runs at all", async () => {
    const service = makeService([CI_FILE]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [],
      checks: [
        { id: 90, name: "CodeRabbit", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null },
      ],
    });
    expect(graph.source).toBe("none");
    expect(graph.unavailableReason).toBe("not-actions");
    expect(graph.externalChecks).toHaveLength(1);
  });

  it("routes non-Actions checks to externalChecks and carries check-run ids", async () => {
    const service = makeService([CI_FILE]);
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [run({ name: "CI", jobs: [job({ id: 1, name: "install" })] })],
      checks: [
        {
          id: 501,
          name: "install",
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://github.com/acme/repo/runs/501",
          startedAt: null,
          completedAt: null,
        },
        { id: 502, name: "vercel", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null },
        { id: null, name: "ci/legacy-status", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null },
      ],
    });

    const install = graph.nodes.find((node) => node.jobId === "install")!;
    expect(install.checkRunId).toBe(501);
    expect(install.detailsUrl).toBe("https://github.com/acme/repo/runs/501");
    expect(graph.externalChecks.map((check) => check.name)).toEqual(["vercel", "ci/legacy-status"]);
  });

  it("flags a stale run and resolves staleBehindBy", async () => {
    const service = makeService([CI_FILE], {
      countCommitsBetween: async ({ fromSha, toSha }) =>
        fromSha === "oldsha" && toSha === "headsha" ? 2 : null,
    });
    const graph = await service.build({
      ...BASE_INPUT,
      runs: [run({ name: "CI", headSha: "oldsha", jobs: [job({ id: 1, name: "install" })] })],
    });
    expect(graph.stale).toBe(true);
    expect(graph.staleBehindBy).toBe(2);
  });

  it("caches parsed YAML per (repo, headSha) and honours force", async () => {
    let reads = 0;
    const service = createWorkflowGraph({
      readWorktreeWorkflows: async () => {
        reads += 1;
        return [CI_FILE];
      },
      readContentsApiWorkflows: async () => null,
      now: () => NOW,
    });
    const input = {
      ...BASE_INPUT,
      runs: [run({ name: "CI", jobs: [job({ id: 1, name: "install" })] })],
    };
    await service.build(input);
    await service.build(input);
    expect(reads).toBe(1);

    await service.build({ ...input, force: true });
    expect(reads).toBe(2);

    // A new head SHA is a new cache key.
    await service.build({ ...input, headSha: "other" });
    expect(reads).toBe(3);

    service.invalidate();
    await service.build(input);
    expect(reads).toBe(4);
  });
});
