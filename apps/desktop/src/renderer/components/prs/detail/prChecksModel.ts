/**
 * Pure model for the CI / Checks pipeline visualizer.
 *
 * Everything here is deliberately free of React so the layout maths, the
 * fallback graph, the "why is there no graph" copy, and the copy-as-markdown
 * payload can be tested directly.
 */

import type {
  PrActionStep,
  PrCheck,
  PrCheckLogExcerpt,
  PrPipelineState,
  PrWorkflowGraph,
  PrWorkflowGraphNode,
  PrWorkflowGraphUnavailableReason,
  PrWorkflowMatrixLeg,
} from "../../../../shared/types";
import { buildDeeplink } from "../../../../shared/deeplinks";
import { STATE_RANK, worstPipelineState } from "../../../../shared/prPipelineState";
import { STATE_LABEL } from "./prChecksVisuals";
import {
  checkElapsedMs,
  pipelineStateOf,
  type PrCheckBuckets,
  type UnifiedCheckItem,
} from "../shared/prUnifiedChecks";

// ---------------------------------------------------------------------------
// View selection (persisted per project)
// ---------------------------------------------------------------------------

export type ChecksView = "graph" | "list" | "failures";

export const CHECKS_VIEW_STORAGE_KEY = "ade:prs:checksView:v1";

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
export function workflowNameOf(item: UnifiedCheckItem): string | null {
  if (item.workflowName?.trim()) return item.workflowName.trim();
  const idx = item.name.indexOf(" / ");
  return idx > 0 ? item.name.slice(0, idx).trim() : null;
}

/**
 * A job's own name, with its workflow's name stripped off the front.
 *
 * `"CI / build"` inside the `CI` workflow reads as `build`; a name that does not
 * carry the prefix comes back untouched. One implementation, because the graph
 * fallback, the live matrix and the list sections all need exactly this and had
 * grown three copies of it.
 */
export function stripWorkflowPrefix(displayName: string, workflowName: string | null): string {
  const name = displayName.trim();
  const prefix = workflowName?.trim() ? `${workflowName.trim()} / ` : null;
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length).trim() : name;
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
      const displayName = stripWorkflowPrefix(item.displayName, workflowName);
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
  return stripWorkflowPrefix(item.displayName, item.workflowName ?? null);
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
    STATE_RANK[pipelineStateOf(left)] - STATE_RANK[pipelineStateOf(right)]
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
      state: worstPipelineState(liveItems.map(pipelineStateOf)),
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

// ---------------------------------------------------------------------------
// Job detail plan — what the log drawer should actually show
// ---------------------------------------------------------------------------

/** One step of a job, ready to render: number, name, outcome, own duration. */
export type CheckStepRow = {
  number: number;
  name: string;
  state: PrPipelineState;
  /** Precise outcome word. `state` alone folds cancelled/timed-out into "failed". */
  outcomeLabel: string;
  durationMs: number | null;
};

/**
 * Whether a job-log excerpt is worth a GitHub round trip on open.
 *
 * Only a failed job earns one automatically. The `steps` array below already
 * carries names, outcomes, and per-step timings for every other state, and it
 * arrived with the checks poll the tab was running anyway — rendering it costs
 * nothing. Downloading a passed job's log costs a redirect plus a
 * multi-megabyte blob to show the tail of `Post Run actions/checkout`.
 */
export type CheckDetailPlan = {
  state: PrPipelineState;
  /** Header word. Always rendered as text, never carried by colour alone. */
  outcomeLabel: string;
  /** One line of fact under the header. Empty string when there is nothing true to say. */
  summary: string;
  /** True only for a failed job, or when the user explicitly asked for the log. */
  wantsLogExcerpt: boolean;
  steps: CheckStepRow[];
  /** The step that failed, for a failed job. */
  failedStep: CheckStepRow | null;
  /** The step in flight, for a running job. */
  currentStep: CheckStepRow | null;
  /** Summed step durations — where the job's time actually went. */
  stepsTotalMs: number | null;
};

/**
 * Precise outcome word for a step or job.
 *
 * `pipelineStateOf` folds cancelled, timed-out, and action-required into
 * `failed` on purpose — they are all "not green, blocks merge". That is right
 * for counting and wrong for narrating: telling a user their cancelled job
 * "failed" is a small lie that sends them looking for a test failure that does
 * not exist.
 */
export function outcomeLabelOf(
  item: { status: "queued" | "in_progress" | "completed"; conclusion: string | null },
): string {
  if (item.status === "queued") return "Queued";
  if (item.status === "in_progress") return "Running";
  switch (item.conclusion) {
    case "success": return "Passed";
    case "failure": return "Failed";
    case "cancelled": return "Cancelled";
    case "timed_out": return "Timed out";
    case "action_required": return "Needs action";
    case "neutral": return "Neutral";
    case "skipped": return "Skipped";
    default: return "Unknown";
  }
}

/**
 * Header word for a node we only know by pipeline state.
 *
 * Derived from `STATE_LABEL` rather than written out again: the drawer's header
 * word and the glyph's accessible name have to agree, and two hand-kept tables
 * eventually disagree.
 */
const STATE_OUTCOME_LABEL = Object.fromEntries(
  Object.entries(STATE_LABEL).map(([state, word]) => [state, word.charAt(0).toUpperCase() + word.slice(1)]),
) as Record<PrPipelineState, string>;

function toStepRow(step: PrActionStep, now: number): CheckStepRow {
  return {
    number: step.number,
    name: step.name,
    state: pipelineStateOf(step),
    outcomeLabel: outcomeLabelOf(step),
    durationMs: checkElapsedMs(step, now),
  };
}

/**
 * What the drawer should show for one job.
 *
 * Reads the graph node first — it is already hydrated from the checks the tab
 * polls, so the whole plan resolves with zero extra GitHub calls — and lets a
 * loaded excerpt refine the step list and the outcome word when one is present.
 */
export function buildCheckDetailPlan(
  node: Pick<PrWorkflowGraphNode, "state" | "steps" | "durationMs">,
  excerpt: PrCheckLogExcerpt | null,
  now: number = Date.now(),
): CheckDetailPlan {
  const state = excerpt?.jobState ?? node.state;
  const outcomeLabel = excerpt?.jobStatus
    ? outcomeLabelOf({ status: excerpt.jobStatus, conclusion: excerpt.jobConclusion ?? null })
    : STATE_OUTCOME_LABEL[state];

  const rawSteps = (excerpt?.steps?.length ? excerpt.steps : node.steps) ?? [];
  const steps = [...rawSteps]
    .sort((left, right) => left.number - right.number)
    .map((step) => toStepRow(step, now));

  const measured = steps.filter((step) => step.durationMs != null);
  const stepsTotalMs = measured.length > 0
    ? measured.reduce((total, step) => total + (step.durationMs ?? 0), 0)
    : null;

  const failedStep = steps.find((step) => step.state === "failed") ?? null;
  const currentStep = steps.find((step) => step.state === "running") ?? null;

  const total = steps.length;
  const doneCount = steps.filter((step) => step.state !== "running" && step.state !== "queued").length;
  const summary = (() => {
    switch (state) {
      case "failed":
        return failedStep
          ? `Failed at step ${failedStep.number}${total ? ` of ${total}` : ""} · ${failedStep.name}`
          : "GitHub didn't say which step failed.";
      case "passed":
        return total > 0 ? `${total} steps, all passed` : "Passed. GitHub reported no steps for this job.";
      case "running":
        return currentStep
          ? `Running step ${currentStep.number}${total ? ` of ${total}` : ""} · ${currentStep.name}`
          : total > 0 ? `${doneCount} of ${total} steps done` : "Running. No steps reported yet.";
      case "queued":
        return "Queued. GitHub hasn't started this job yet.";
      case "skipped":
        return total > 0 ? `Didn't run · ${total} steps skipped` : "Didn't run.";
      default:
        return "GitHub didn't report an outcome for this job.";
    }
  })();

  return {
    state,
    outcomeLabel,
    summary,
    // Only a failure earns an automatic log download; see the type's doc above.
    wantsLogExcerpt: state === "failed",
    steps,
    failedStep,
    currentStep,
    stepsTotalMs,
  };
}

// ---------------------------------------------------------------------------
// Copy failure as markdown
// ---------------------------------------------------------------------------

export type CopyExcerptInput = {
  excerpt: PrCheckLogExcerpt;
  elapsedLabel: string | null;
  pr: { repoOwner: string; repoName: string; githubPrNumber: number };
  /**
   * The graph node's own name, for the degraded reads that omit `jobName`.
   * Without it a copy taken while GitHub was unreachable reads "CI failure — ".
   */
  fallbackJobName?: string | null;
};

/**
 * Job, step, elapsed, fenced excerpt, and an ADE deeplink back to this tab.
 *
 * The heading follows the job's real outcome. Pasting "CI failure — build" into
 * a chat for a job that passed is the same lie the drawer used to tell, and it
 * is the one an agent would then act on.
 */
export function buildLogExcerptMarkdown(
  { excerpt, elapsedLabel, pr, fallbackJobName }: CopyExcerptInput,
): string {
  const deeplink = buildDeeplink(
    { kind: "pr", repoOwner: pr.repoOwner, repoName: pr.repoName, prNumber: pr.githubPrNumber },
    { form: "ade" },
  );
  const failed = (excerpt.jobState ?? "failed") === "failed";
  const outcome = excerpt.jobStatus
    ? outcomeLabelOf({ status: excerpt.jobStatus, conclusion: excerpt.jobConclusion ?? null })
    : "Failed";
  const jobName = excerpt.jobName?.trim() || fallbackJobName?.trim() || "this job";
  const heading = failed
    ? `**CI failure — ${jobName}**`
    : `**CI job ${outcome.toLowerCase()} — ${jobName}**`;
  const stepLabel = excerpt.failingStepName
    ? excerpt.failingStepNumber != null && excerpt.stepTotal != null
      ? `${excerpt.failingStepName} (step ${excerpt.failingStepNumber}/${excerpt.stepTotal})`
      : excerpt.failingStepName
    : failed
      ? "unknown step"
      : null;
  const longestFence = Math.max(
    2,
    ...Array.from(excerpt.lines.join("\n").matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestFence + 1);
  // No fenced block at all when there is no excerpt — an empty fence reads as
  // "the job produced no output", which is a different claim from "ADE did not
  // fetch the log".
  const body = excerpt.lines.length > 0
    ? [fence, ...excerpt.lines, ...(excerpt.truncated ? ["… (truncated)"] : []), fence]
    : [
        excerpt.logStatus === "unavailable"
          ? `_ADE couldn't read this job's log: ${excerpt.logUnavailableReason ?? "GitHub didn't answer."}_`
          : "_No log excerpt was fetched — see the full log on GitHub._",
      ];
  const lines = [
    heading,
    "",
    ...(stepLabel ? [`- Step: ${stepLabel}`] : []),
    ...(!failed && excerpt.stepTotal != null ? [`- Steps: ${excerpt.stepTotal}`] : []),
    ...(elapsedLabel ? [`- Elapsed: ${elapsedLabel}`] : []),
    ...(excerpt.headline ? [`- Headline: ${excerpt.headline}`] : []),
    "",
    ...body,
    "",
    `[Open in ADE](${deeplink})`,
  ];
  if (excerpt.htmlUrl) lines.push(`[Full log on GitHub](${excerpt.htmlUrl})`);
  return lines.join("\n");
}
