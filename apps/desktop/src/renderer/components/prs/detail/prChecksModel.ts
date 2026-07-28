/**
 * Pure model for the CI / Checks pipeline visualizer.
 *
 * Everything here is deliberately free of React so the layout maths, the
 * fallback graph, the "why is there no graph" copy, and the copy-as-markdown
 * payload can be tested directly.
 */

import type {
  PrCheck,
  PrCheckLogExcerpt,
  PrPipelineState,
  PrWorkflowGraph,
  PrWorkflowGraphNode,
  PrWorkflowGraphUnavailableReason,
  PrWorkflowMatrixLeg,
} from "../../../../shared/types";
import { buildDeeplink } from "../../../../shared/deeplinks";
import {
  checkElapsedMs,
  pipelineStateOf,
  summarizePipelineStates,
  type PrCheckBuckets,
  type UnifiedCheckItem,
} from "../shared/prUnifiedChecks";

// ---------------------------------------------------------------------------
// View selection (persisted per project)
// ---------------------------------------------------------------------------

export type ChecksView = "graph" | "list" | "failures";

export const CHECKS_VIEW_STORAGE_KEY = "ade:prs:checksView:v1";
export const CHECKS_VIEWS: ChecksView[] = ["graph", "list", "failures"];
export const DEFAULT_CHECKS_VIEW: ChecksView = "graph";

function isChecksView(value: unknown): value is ChecksView {
  return value === "graph" || value === "list" || value === "failures";
}

/** Same idiom as the detail-tab persistence in `PrDetailPane`, keyed by project. */
export function readStoredChecksView(projectId: string | null | undefined): ChecksView | null {
  if (!projectId) return null;
  try {
    const raw = window.localStorage.getItem(CHECKS_VIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed?.[projectId];
    return isChecksView(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredChecksView(projectId: string | null | undefined, view: ChecksView): void {
  if (!projectId) return;
  try {
    const raw = window.localStorage.getItem(CHECKS_VIEW_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    parsed[projectId] = view;
    window.localStorage.setItem(CHECKS_VIEW_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}

// ---------------------------------------------------------------------------
// Honest copy for a missing graph
// ---------------------------------------------------------------------------

/**
 * Plain-language reason the dependency graph is unavailable. We never guess an
 * edge, so when the graph is missing the UI says why in the user's terms.
 */
export function graphUnavailableCopy(
  reason: PrWorkflowGraphUnavailableReason | null | undefined,
): string {
  switch (reason) {
    case "no-workflow-file":
      return "ADE couldn't find the workflow file for these checks, so it can't chart their order — showing them grouped by workflow instead.";
    case "unparseable":
      return "ADE couldn't parse this workflow file, so it can't chart job dependencies — showing the jobs grouped by workflow instead.";
    case "reusable-workflow":
      return "This workflow calls another workflow, so ADE can't chart its dependencies — showing the jobs grouped by workflow instead.";
    case "dynamic-job-name":
      return "This workflow builds job names at runtime, so ADE can't match them to the file — showing the jobs grouped by workflow instead.";
    case "not-actions":
      return "These checks don't come from GitHub Actions, so there's no workflow file to chart — showing them grouped by reporter instead.";
    default:
      return "No dependency graph for these checks yet — showing them grouped by workflow instead.";
  }
}

// ---------------------------------------------------------------------------
// Fallback graph derived locally from the unified checks
// ---------------------------------------------------------------------------

/**
 * Workflow a unified item belongs to. Actions jobs carry it directly; a
 * check-run row spells it as `"<workflow> / <job>"`, which is the only handle we
 * get for PRs where the jobs API is unavailable (e.g. unmapped GitHub-tab PRs).
 */
function workflowNameOf(item: UnifiedCheckItem): string | null {
  if (item.workflowName) return item.workflowName;
  const idx = item.name.indexOf(" / ");
  return idx > 0 ? item.name.slice(0, idx).trim() : null;
}

/**
 * True when an item belongs in a workflow swimlane rather than the "external ·
 * not graphable" lane. A check run that links to an Actions run, or that names
 * its workflow, is a workflow job we simply couldn't chart — calling it
 * "external" would be wrong.
 */
function belongsToAWorkflow(item: UnifiedCheckItem): boolean {
  if (item.source === "actions_job") return true;
  if (/\/actions\/runs\/\d+/.test(item.detailsUrl ?? "")) return true;
  return workflowNameOf(item) != null;
}

/**
 * A `source: "none"` graph built from the checks we already have. Used when the
 * workflow-graph service can't answer — no workflow file, an unmapped
 * GitHub-tab PR (the graph endpoint requires a `pull_requests` row), or an
 * older runtime — so the tab degrades to the honest swimlane fallback instead
 * of rendering blank or an error.
 */
export function deriveFallbackGraph(
  items: UnifiedCheckItem[],
  options: { headSha?: string | null; reason?: PrWorkflowGraphUnavailableReason | null } = {},
): PrWorkflowGraph {
  const nodes: PrWorkflowGraphNode[] = items
    .filter(belongsToAWorkflow)
    .map((item) => {
      const workflowName = workflowNameOf(item);
      const displayName = workflowName && item.displayName.startsWith(`${workflowName} / `)
        ? item.displayName.slice(workflowName.length + 3)
        : item.displayName;
      return {
        jobId: item.id,
        displayName,
        workflowName: workflowName ?? "Checks",
        state: pipelineStateOf(item),
        tier: 0,
        durationMs: checkElapsedMs(item),
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        legs: [],
        steps: item.steps ?? [],
        checkRunId: item.checkRunId,
        actionsJobId: item.jobId,
        runId: item.runId,
        detailsUrl: item.detailsUrl,
      };
    });

  const externalChecks: PrCheck[] = items
    .filter((item) => !belongsToAWorkflow(item))
    .map((item) => ({
      id: item.checkRunId,
      name: item.displayName,
      status: item.status,
      conclusion: item.conclusion,
      detailsUrl: item.detailsUrl,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
    }));

  return {
    source: "none",
    unavailableReason: options.reason ?? null,
    headSha: options.headSha ?? "",
    attempt: 1,
    nodes,
    edges: [],
    criticalPath: [],
    externalChecks,
    stale: false,
    staleBehindBy: null,
  };
}

// ---------------------------------------------------------------------------
// Refresh a parsed graph from the checks the pane already polled
// ---------------------------------------------------------------------------

function normalizedName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function liveJobName(item: UnifiedCheckItem): string {
  const workflowName = item.workflowName?.trim();
  const displayName = item.displayName.trim();
  return workflowName && displayName.startsWith(`${workflowName} / `)
    ? displayName.slice(workflowName.length + 3).trim()
    : displayName;
}

const LIVE_STATE_RANK: Record<PrPipelineState, number> = {
  failed: 0,
  unknown: 1,
  running: 2,
  queued: 3,
  passed: 4,
  skipped: 5,
};

function worstLiveState(items: UnifiedCheckItem[]): PrPipelineState {
  if (items.length === 0) return "unknown";
  return items
    .map(pipelineStateOf)
    .reduce((worst, state) => (
      LIVE_STATE_RANK[state] < LIVE_STATE_RANK[worst] ? state : worst
    ));
}

function earliestTimestamp(values: Array<string | null>): string | null {
  return values
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

function latestCompletion(items: UnifiedCheckItem[]): string | null {
  if (items.some((item) => !item.completedAt)) return null;
  return items
    .map((item) => item.completedAt)
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function matchingLiveItems(
  node: PrWorkflowGraphNode,
  items: UnifiedCheckItem[],
): UnifiedCheckItem[] {
  const workflow = normalizedName(node.workflowName);
  const nodeNames = new Set([normalizedName(node.displayName), normalizedName(node.jobId)]);
  const legIds = new Set(
    node.legs.flatMap((leg) => (leg.jobId != null ? [leg.jobId] : [])),
  );
  const legNames = new Set(node.legs.map((leg) => normalizedName(leg.name)));
  const bases = [...nodeNames].filter(Boolean);

  return items.filter((item) => {
    if (workflow && normalizedName(item.workflowName) !== workflow) return false;
    if (
      item.jobId != null
      && (legIds.has(item.jobId) || item.jobId === node.checkRunId)
    ) {
      return true;
    }
    if (item.checkRunId != null && item.checkRunId === node.checkRunId) return true;
    const name = normalizedName(liveJobName(item));
    if (legNames.has(name) || nodeNames.has(name)) return true;
    return bases.some((base) => name.startsWith(`${base} (`) && name.endsWith(")"));
  });
}

function representativeLiveItem(items: UnifiedCheckItem[]): UnifiedCheckItem | null {
  return [...items].sort((left, right) => (
    LIVE_STATE_RANK[pipelineStateOf(left)] - LIVE_STATE_RANK[pipelineStateOf(right)]
    || liveJobName(left).localeCompare(liveJobName(right))
  ))[0] ?? null;
}

/**
 * Keep dependency edges from the YAML-backed service graph, but refresh job
 * state/timing/steps from the checks and Actions runs `PrDetailPane` already
 * polls. Re-fetching the whole graph every five seconds would duplicate the
 * GitHub jobs/checks requests on the hottest CI path.
 */
export function hydrateWorkflowGraph(
  graph: PrWorkflowGraph,
  items: UnifiedCheckItem[],
  now: number = Date.now(),
): PrWorkflowGraph {
  const matchedIds = new Set<string>();
  const nodes = graph.nodes.map((node) => {
    const liveItems = matchingLiveItems(node, items);
    if (liveItems.length === 0) return node;
    for (const item of liveItems) matchedIds.add(item.id);

    const representative = representativeLiveItem(liveItems);
    const startedAt = earliestTimestamp(liveItems.map((item) => item.startedAt));
    const completedAt = latestCompletion(liveItems);
    const matrix = node.legs.length > 0 || liveItems.some((item) => {
      const name = normalizedName(liveJobName(item));
      const base = normalizedName(node.displayName);
      return Boolean(base) && name.startsWith(`${base} (`) && name.endsWith(")");
    });
    const legs: PrWorkflowMatrixLeg[] = matrix
      ? liveItems.map((item) => ({
          name: liveJobName(item),
          jobId: item.jobId ?? item.checkRunId,
          state: pipelineStateOf(item),
          durationMs: checkElapsedMs(item, now),
          detailsUrl: item.detailsUrl,
        }))
      : [];

    return {
      ...node,
      state: worstLiveState(liveItems),
      durationMs: checkElapsedMs({ startedAt, completedAt }, now),
      startedAt,
      completedAt,
      legs,
      steps: representative?.steps ?? node.steps,
      checkRunId: representative?.checkRunId ?? node.checkRunId,
      actionsJobId: representative?.jobId ?? node.actionsJobId,
      runId: representative?.runId ?? node.runId,
      detailsUrl: representative?.detailsUrl ?? node.detailsUrl,
    };
  });

  const externalChecks: PrCheck[] = items
    .filter((item) => !matchedIds.has(item.id) && !belongsToAWorkflow(item))
    .map((item) => ({
      id: item.checkRunId,
      name: item.displayName,
      status: item.status,
      conclusion:
        item.conclusion === "timed_out" || item.conclusion === "action_required"
          ? "failure"
          : item.conclusion,
      detailsUrl: item.detailsUrl,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
    }));

  return { ...graph, nodes, externalChecks };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type GraphColumn = {
  tier: number;
  nodes: PrWorkflowGraphNode[];
  /** Column heading — "Setup" for tier 0, "Gate" for the last tier, else "Parallel · n". */
  label: string;
};

/** Groups nodes into ordered tier columns. Empty tiers are dropped. */
export function buildGraphColumns(nodes: PrWorkflowGraphNode[]): GraphColumn[] {
  const byTier = new Map<number, PrWorkflowGraphNode[]>();
  for (const node of nodes) {
    const tier = Number.isFinite(node.tier) ? node.tier : 0;
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(node);
    else byTier.set(tier, [node]);
  }
  const tiers = Array.from(byTier.keys()).sort((a, b) => a - b);
  return tiers.map((tier, index) => {
    const tierNodes = byTier.get(tier) ?? [];
    const label = index === 0
      ? "Setup"
      : index === tiers.length - 1 && tierNodes.length === 1
        ? "Gate"
        : `Parallel · ${tierNodes.length}`;
    return { tier, nodes: tierNodes, label };
  });
}

/**
 * True when the connector drawn after column `index` feeds a node that is
 * actually running. Only these edges animate — a pulsing line into a queued or
 * finished job is a lie about what the machine is doing.
 */
export function isEdgeLive(graph: PrWorkflowGraph, columns: GraphColumn[], index: number): boolean {
  const upstreamTiers = new Set(columns.slice(0, index + 1).map((c) => c.tier));
  const downstream = new Map<string, PrWorkflowGraphNode>();
  for (const column of columns.slice(index + 1)) {
    for (const node of column.nodes) downstream.set(node.jobId, node);
  }
  const upstreamIds = new Set(
    graph.nodes.filter((n) => upstreamTiers.has(n.tier)).map((n) => n.jobId),
  );
  return graph.edges.some(
    (edge) => upstreamIds.has(edge.from) && downstream.get(edge.to)?.state === "running",
  );
}

// ---------------------------------------------------------------------------
// Node presentation
// ---------------------------------------------------------------------------

/** Live elapsed for a node: measures against `now` while it is still running. */
export function nodeElapsedMs(node: PrWorkflowGraphNode, now: number = Date.now()): number | null {
  if (node.completedAt || !node.startedAt) {
    return node.durationMs ?? checkElapsedMs(node, now);
  }
  return checkElapsedMs(node, now);
}

/** The bit inside the trailing parens of a matrix leg name, e.g. `darwin-arm64, macos-15`. */
export function matrixLegLabel(leg: PrWorkflowMatrixLeg): string {
  const match = /\(([^()]*)\)\s*$/.exec(leg.name);
  return (match?.[1] ?? leg.name).trim();
}

/**
 * One-line caption under a collapsed matrix node, e.g. `4 legs · shard 2 failed`.
 * Names failing legs first, then running ones; silent when everything passed.
 */
export function matrixLegCaption(node: PrWorkflowGraphNode): string | null {
  if (node.legs.length === 0) return null;
  const parts = [`${node.legs.length} legs`];
  const named = (legs: PrWorkflowMatrixLeg[], verb: string) => {
    const labels = legs.map(matrixLegLabel).filter(Boolean);
    if (labels.length === 0) return null;
    const shown = labels.slice(0, 2).join(", ");
    const extra = labels.length > 2 ? ` +${labels.length - 2}` : "";
    return `${shown}${extra} ${verb}`;
  };
  const failed = named(node.legs.filter((l) => l.state === "failed"), "failed");
  if (failed) parts.push(failed);
  const running = named(node.legs.filter((l) => l.state === "running"), "running");
  if (running) parts.push(running);
  return parts.join(" · ");
}

export type StepProgress = { done: number; total: number; pct: number; currentStepName: string | null };

/** Step completion for the inline progress bar inside a running node. */
export function stepProgress(node: PrWorkflowGraphNode): StepProgress | null {
  const steps = node.steps ?? [];
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "completed").length;
  const current = steps.find((s) => s.status === "in_progress") ?? null;
  return {
    done,
    total: steps.length,
    pct: Math.round((done / steps.length) * 100),
    currentStepName: current?.name ?? null,
  };
}

/** Failing nodes, ordered for `j`/`k` navigation and drawer auto-open. */
export function failingNodes(graph: PrWorkflowGraph): PrWorkflowGraphNode[] {
  return graph.nodes.filter((node) => node.state === "failed");
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

/**
 * Buckets for the header strip, always summing to `total`. Matrix nodes count
 * once per leg — the header is about jobs actually executing, not the collapsed
 * template rows the graph draws.
 */
export function graphBuckets(graph: PrWorkflowGraph): PrCheckBuckets {
  const all: PrPipelineState[] = [];
  for (const node of graph.nodes) {
    if (node.legs.length > 0) all.push(...node.legs.map((leg) => leg.state));
    else all.push(node.state);
  }
  all.push(...graph.externalChecks.map(pipelineStateOf));
  const buckets: PrCheckBuckets = {
    total: all.length, passed: 0, failed: 0, running: 0, queued: 0, skipped: 0, unknown: 0,
  };
  for (const state of all) buckets[state] += 1;
  return buckets;
}

/**
 * Numeric GitHub Actions job id to fetch a log excerpt for. Prefers the failing
 * matrix leg, then the node's check-run id (GitHub reuses the job id there),
 * then the `/job/<id>` segment of the details URL.
 */
export function resolveLogJobId(node: PrWorkflowGraphNode): number | null {
  const failingLeg = node.legs.find((leg) => leg.state === "failed" && leg.jobId != null);
  if (failingLeg?.jobId != null) return failingLeg.jobId;
  if (node.legs.length === 1 && node.legs[0]?.jobId != null) return node.legs[0]!.jobId;
  if (node.actionsJobId != null) return node.actionsJobId;
  const match = /\/job\/(\d+)(?:[/?#]|$)/.exec(node.detailsUrl ?? "");
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Wall-clock elapsed across the whole run: earliest start → latest finish (or now). */
export function pipelineElapsedMs(graph: PrWorkflowGraph, now: number = Date.now()): number | null {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  let anyRunning = false;
  for (const node of graph.nodes) {
    if (node.startedAt) {
      const started = Date.parse(node.startedAt);
      if (!Number.isNaN(started)) earliest = Math.min(earliest, started);
    }
    if (node.completedAt) {
      const done = Date.parse(node.completedAt);
      if (!Number.isNaN(done)) latest = Math.max(latest, done);
    } else if (node.state === "running") {
      anyRunning = true;
    }
  }
  if (!Number.isFinite(earliest)) return null;
  const end = anyRunning ? now : Math.max(latest, earliest);
  return Math.max(0, end - earliest);
}

/** Groups items into swimlanes by workflow, for the `source: "none"` fallback. */
export function groupByWorkflow(
  nodes: PrWorkflowGraphNode[],
): Array<{ workflowName: string; nodes: PrWorkflowGraphNode[] }> {
  const byWorkflow = new Map<string, PrWorkflowGraphNode[]>();
  for (const node of nodes) {
    const key = node.workflowName || "Checks";
    const bucket = byWorkflow.get(key);
    if (bucket) bucket.push(node);
    else byWorkflow.set(key, [node]);
  }
  return Array.from(byWorkflow.entries())
    .map(([workflowName, groupNodes]) => ({ workflowName, nodes: groupNodes }))
    .sort((a, b) => a.workflowName.localeCompare(b.workflowName));
}

/** Summary counts for the unified list/failures views. */
export function itemBuckets(items: UnifiedCheckItem[]): PrCheckBuckets {
  return summarizePipelineStates(items);
}

// ---------------------------------------------------------------------------
// Copy failure as markdown
// ---------------------------------------------------------------------------

export type CopyExcerptInput = {
  excerpt: PrCheckLogExcerpt;
  elapsedLabel: string | null;
  pr: { repoOwner: string; repoName: string; githubPrNumber: number };
};

/** Job, step, elapsed, fenced excerpt, and an ADE deeplink back to this tab. */
export function buildLogExcerptMarkdown({ excerpt, elapsedLabel, pr }: CopyExcerptInput): string {
  const deeplink = buildDeeplink(
    { kind: "pr", repoOwner: pr.repoOwner, repoName: pr.repoName, prNumber: pr.githubPrNumber },
    { form: "ade" },
  );
  const stepLabel = excerpt.failingStepName
    ? excerpt.failingStepNumber != null && excerpt.stepTotal != null
      ? `${excerpt.failingStepName} (step ${excerpt.failingStepNumber}/${excerpt.stepTotal})`
      : excerpt.failingStepName
    : "unknown step";
  const longestFence = Math.max(
    2,
    ...Array.from(excerpt.lines.join("\n").matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestFence + 1);
  const lines = [
    `**CI failure — ${excerpt.jobName}**`,
    "",
    `- Step: ${stepLabel}`,
    ...(elapsedLabel ? [`- Elapsed: ${elapsedLabel}`] : []),
    ...(excerpt.headline ? [`- Headline: ${excerpt.headline}`] : []),
    "",
    fence,
    ...excerpt.lines,
    ...(excerpt.truncated ? ["… (truncated)"] : []),
    fence,
    "",
    `[Open in ADE](${deeplink})`,
  ];
  if (excerpt.htmlUrl) lines.push(`[Full log on GitHub](${excerpt.htmlUrl})`);
  return lines.join("\n");
}
