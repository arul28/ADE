// ---------------------------------------------------------------------------
// Workflow pipeline graph — reconstructs the CI dependency DAG for a PR.
//
// GitHub's Actions jobs API does not return `needs:`, so the only honest way to
// draw a pipeline graph is to parse the workflow YAML that actually ran (at the
// PR's head SHA) and join it to live run state. We parse ONLY `jobs.<id>.needs`
// and `jobs.<id>.strategy.matrix` — nothing else. Anything we cannot resolve
// degrades that WORKFLOW to flat swimlanes rather than guessing an edge.
//
// Source order (see docs/features/pull-requests/README.md):
//   1. lane worktree `.github/workflows/*.yml|*.yaml` read at the head SHA via
//      `git show <sha>:<path>` — so the graph matches the code that ran, not
//      whatever is in the working tree right now.
//   2. GitHub Contents API `?ref=<headSha>` — fork PRs / non-local repos.
//   3. Neither → `source: "none"` with an `unavailableReason`.
//
// Parsed YAML is cached per `(repo, headSha)` behind a TTL. The graph itself is
// cheap to recompute from live run state, so it is never cached — that keeps
// running-node elapsed times live without a refresh (see ade-perf-prs: local
// first, batched, TTL-bound, nothing blocking first open).
// ---------------------------------------------------------------------------

import YAML from "yaml";
import {
  pipelineStateOf,
  worstPipelineState,
} from "../../../shared/prPipelineState";
import type {
  PrActionJob,
  PrActionRun,
  PrCheck,
  PrPipelineState,
  PrWorkflowGraph,
  PrWorkflowGraphEdge,
  PrWorkflowGraphNode,
  PrWorkflowGraphSource,
  PrWorkflowGraphUnavailableReason,
  PrWorkflowMatrixLeg,
} from "../../../shared/types/prs";

/** One workflow YAML file located at a head SHA. */
export type WorkflowFileSource = {
  /** Repo-relative path, e.g. `.github/workflows/ci.yml`. */
  path: string;
  /** Raw YAML text. */
  content: string;
};

/**
 * Reads workflow YAML for a repo at an exact SHA. Returning `null` means "this
 * source could not answer" (no worktree, network failure); returning `[]` means
 * "answered, and there are no workflow files".
 */
export type WorkflowFileReader = (args: {
  repoOwner: string;
  repoName: string;
  headSha: string;
  worktreePath: string | null;
}) => Promise<WorkflowFileSource[] | null>;

export type WorkflowGraphDeps = {
  /** Source 1: `git show <sha>:.github/workflows/<file>` in a lane worktree. */
  readWorktreeWorkflows: WorkflowFileReader;
  /** Source 2: GitHub Contents API at `?ref=<headSha>`. */
  readContentsApiWorkflows: WorkflowFileReader;
  /**
   * Optional: commits between a stale run's head SHA and the PR head SHA.
   * Returning `null` (or omitting the dep) leaves `staleBehindBy` null.
   */
  countCommitsBetween?: (args: {
    worktreePath: string | null;
    fromSha: string;
    toSha: string;
  }) => Promise<number | null>;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** Injectable clock so running-node elapsed math is testable. */
  now?: () => number;
  /** Parsed-YAML cache TTL. Defaults to 10 minutes. */
  cacheTtlMs?: number;
  /** Max cached `(repo, headSha)` entries. Defaults to 32. */
  cacheMaxEntries?: number;
};

export type WorkflowGraphInput = {
  repoOwner: string;
  repoName: string;
  /** The PR's current head SHA. */
  headSha: string;
  /** Lane worktree for source 1, when the PR is backed by a local lane. */
  worktreePath: string | null;
  /** Live Actions runs for this PR (already fetched by the caller). */
  runs: PrActionRun[];
  /** All checks for this PR; non-Actions ones land in `externalChecks`. */
  checks: PrCheck[];
  /** Skip the parsed-YAML cache and re-read the source. */
  force?: boolean;
};

/**
 * The pipeline-graph service. One implementation today
 * (`createWorkflowGraph`); the interface exists so a different reconstruction
 * strategy (e.g. a real workflow parser, or a server-side graph) can be swapped
 * in without touching `prService`.
 */
export interface WorkflowGraph {
  build(input: WorkflowGraphInput): Promise<PrWorkflowGraph>;
  /** Drop cached YAML. No args clears everything. */
  invalidate(args?: { repoOwner?: string; repoName?: string; headSha?: string }): void;
}

/* ────────────────────────── YAML parsing (needs + matrix only) ───────────── */

/** A job as we understand it — deliberately a tiny subset of the real schema. */
export type ParsedWorkflowJob = {
  /** `jobs.<id>` key. */
  id: string;
  /** Static `name:` when present and free of `${{ }}`; else null. */
  staticName: string | null;
  needs: string[];
  isMatrix: boolean;
};

export type ParsedWorkflow = {
  path: string;
  /** Workflow `name:`, falling back to the file path (what GitHub does). */
  name: string;
  jobs: ParsedWorkflowJob[];
  /**
   * Non-null when this workflow cannot be graphed and must render as flat
   * swimlanes. The rest of the graph is unaffected.
   */
  degraded: PrWorkflowGraphUnavailableReason | null;
};

const DYNAMIC_EXPRESSION = "${{";

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeNeeds(raw: unknown): string[] {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length ? [trimmed] : [];
  }
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/**
 * Parse one workflow file down to `{ id, name, needs, isMatrix }` per job.
 *
 * Degrades the whole file (never the whole graph) when we would otherwise have
 * to invent structure: a reusable-workflow `uses:` job whose real jobs live in
 * another file, a `name:` built from an expression we cannot evaluate, or YAML
 * that will not parse at all.
 */
export function parseWorkflowFile(source: WorkflowFileSource): ParsedWorkflow {
  const fallbackName = source.path;
  let doc: unknown;
  try {
    doc = YAML.parse(source.content);
  } catch {
    return { path: source.path, name: fallbackName, jobs: [], degraded: "unparseable" };
  }

  const root = asPlainRecord(doc);
  if (!root) {
    return { path: source.path, name: fallbackName, jobs: [], degraded: "unparseable" };
  }

  const workflowName =
    typeof root.name === "string" && root.name.trim().length ? root.name.trim() : fallbackName;
  const jobsRecord = asPlainRecord(root.jobs);
  if (!jobsRecord) {
    return { path: source.path, name: workflowName, jobs: [], degraded: "unparseable" };
  }

  const jobs: ParsedWorkflowJob[] = [];
  let degraded: PrWorkflowGraphUnavailableReason | null = null;

  for (const [jobId, rawJob] of Object.entries(jobsRecord)) {
    const job = asPlainRecord(rawJob);
    if (!job) {
      degraded = degraded ?? "unparseable";
      continue;
    }

    // A `uses:` job is a reusable workflow: its real jobs live in a file we did
    // not (and by design will not) fetch, so its `needs` graph is incomplete.
    if (typeof job.uses === "string" && job.uses.trim().length > 0) {
      degraded = degraded ?? "reusable-workflow";
    }

    const rawName = typeof job.name === "string" ? job.name : null;
    if (rawName && rawName.includes(DYNAMIC_EXPRESSION)) {
      // We cannot evaluate the expression, so we cannot join this job to its
      // live run by name.
      degraded = degraded ?? "dynamic-job-name";
    }

    const strategy = asPlainRecord(job.strategy);
    const matrix = strategy ? strategy.matrix : undefined;
    const isMatrix = matrix != null && (typeof matrix === "object" || typeof matrix === "string");

    jobs.push({
      id: jobId,
      staticName: rawName && !rawName.includes(DYNAMIC_EXPRESSION) ? rawName.trim() : null,
      needs: normalizeNeeds(job.needs),
      isMatrix,
    });
  }

  return { path: source.path, name: workflowName, jobs, degraded };
}

/* ────────────────────────────── state rollup ─────────────────────────────── */

export { worstPipelineState };

/**
 * Map an Actions job onto the unified pipeline state.
 *
 * `cancelled` maps to `failed` deliberately: a cancelled job did not pass and
 * the user has to do something about it, so hiding it as a skip would make a
 * red pipeline look green.
 */
export function pipelineStateForJob(job: Pick<PrActionJob, "status" | "conclusion">): PrPipelineState {
  return pipelineStateOf(job);
}

/* ─────────────────────────── matrix name matching ────────────────────────── */

/**
 * GitHub names an expanded matrix job `"<base> (<v1, v2, …>)"`, where `<base>`
 * is the job's `name:` when set, else the `jobs.<id>` key. We match by prefix on
 * `` `${base} (` `` — the documented format — and never by fuzzy contains.
 */
export function matrixLegMatches(liveJobName: string, base: string): boolean {
  return liveJobName.startsWith(`${base} (`) && liveJobName.endsWith(")");
}

function jobMatchesTemplate(liveJobName: string, job: ParsedWorkflowJob): boolean {
  if (liveJobName === job.id) return true;
  if (job.staticName && liveJobName === job.staticName) return true;
  if (matrixLegMatches(liveJobName, job.id)) return true;
  if (job.staticName && matrixLegMatches(liveJobName, job.staticName)) return true;
  return false;
}

/* ──────────────────────────── topology helpers ───────────────────────────── */

/**
 * Longest-path tiering over `needs`, cycle-safe.
 *
 * Kahn's algorithm gives tiers for the acyclic part. Anything still holding an
 * in-degree afterwards is in a cycle (only reachable via malformed YAML); those
 * nodes are parked one tier past the DAG instead of spinning forever.
 */
export function computeTiers(
  nodeIds: readonly string[],
  edges: readonly PrWorkflowGraphEdge[],
): Map<string, number> {
  const known = new Set(nodeIds);
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }

  const tiers = new Map<string, number>();
  const queue: string[] = [];
  for (const id of nodeIds) {
    if ((indegree.get(id) ?? 0) === 0) {
      tiers.set(id, 0);
      queue.push(id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    const currentTier = tiers.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      tiers.set(next, Math.max(tiers.get(next) ?? 0, currentTier + 1));
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  // Cycle break: everything Kahn could not settle sits one tier past the DAG.
  const settledMax = tiers.size ? Math.max(...tiers.values()) : -1;
  for (const id of nodeIds) {
    if (!tiers.has(id)) tiers.set(id, settledMax + 1);
  }
  return tiers;
}

/**
 * Longest-duration path through the DAG — the chain that actually sets
 * wall-clock time. Nodes stuck in a cycle are skipped rather than traversed.
 */
export function computeCriticalPath(
  nodes: readonly Pick<PrWorkflowGraphNode, "jobId" | "durationMs" | "tier">[],
  edges: readonly PrWorkflowGraphEdge[],
): string[] {
  if (nodes.length === 0) return [];
  const duration = new Map<string, number>();
  for (const node of nodes) duration.set(node.jobId, Math.max(0, node.durationMs ?? 0));

  // Tier order is a valid topological order for the acyclic part, and stable
  // for the cycle remnants (which all share one tier).
  const ordered = [...nodes].sort((a, b) => a.tier - b.tier || a.jobId.localeCompare(b.jobId));
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.jobId, []);
  for (const edge of edges) {
    const list = incoming.get(edge.to);
    if (!list || !incoming.has(edge.from)) continue;
    list.push(edge.from);
  }

  const best = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const node of ordered) {
    let bestPredCost = 0;
    let bestPred: string | null = null;
    for (const pred of incoming.get(node.jobId) ?? []) {
      const cost = best.get(pred);
      // Undefined = predecessor not yet settled (a back edge in a cycle) — skip.
      if (cost == null) continue;
      if (cost > bestPredCost) {
        bestPredCost = cost;
        bestPred = pred;
      }
    }
    best.set(node.jobId, bestPredCost + (duration.get(node.jobId) ?? 0));
    prev.set(node.jobId, bestPred);
  }

  let tail: string | null = null;
  let tailCost = -1;
  for (const node of ordered) {
    const cost = best.get(node.jobId) ?? 0;
    if (cost > tailCost) {
      tailCost = cost;
      tail = node.jobId;
    }
  }
  if (!tail) return [];

  const path: string[] = [];
  const guard = new Set<string>();
  let cursor: string | null = tail;
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    path.push(cursor);
    cursor = prev.get(cursor) ?? null;
  }
  return path.reverse();
}

/* ─────────────────────────────── the service ─────────────────────────────── */

type CacheEntry = {
  expiresAt: number;
  source: PrWorkflowGraphSource;
  workflows: ParsedWorkflow[];
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 32;

function cacheKey(repoOwner: string, repoName: string, headSha: string): string {
  return `${repoOwner}/${repoName}@${headSha}`;
}

/** Elapsed for a leg/node — live for anything still running. */
function durationFor(startedAt: string | null, completedAt: string | null, nowMs: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = completedAt ? Date.parse(completedAt) : nowMs;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function earliest(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = value;
  }
  return best;
}

/** Latest completion, or null if any leg has not completed yet. */
function latestCompletion(legs: readonly PrActionJob[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const leg of legs) {
    if (!leg.completedAt) return null;
    const ms = Date.parse(leg.completedAt);
    if (Number.isNaN(ms)) return null;
    if (ms > bestMs) {
      bestMs = ms;
      best = leg.completedAt;
    }
  }
  return best;
}

/** The leg whose steps we surface: the failing one, else the first. */
function representativeLeg(legs: readonly PrActionJob[]): PrActionJob | null {
  if (legs.length === 0) return null;
  return legs.find((leg) => pipelineStateForJob(leg) === "failed") ?? legs[0]!;
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The runs endpoint can return more than one run for the same workflow/head
 * (manual dispatches and re-runs). Chart only the newest episode per workflow;
 * otherwise old jobs appear beside the live attempt and corrupt every rollup.
 */
export function latestRunsByWorkflow(runs: readonly PrActionRun[]): PrActionRun[] {
  const latest = new Map<string, PrActionRun>();
  for (const run of runs) {
    const key = run.workflowPath?.trim() || run.name.trim() || `run:${run.id}`;
    const existing = latest.get(key);
    if (
      !existing
      || timestampMs(run.createdAt) > timestampMs(existing.createdAt)
      || (
        timestampMs(run.createdAt) === timestampMs(existing.createdAt)
        && (
          timestampMs(run.updatedAt) > timestampMs(existing.updatedAt)
          || (
            timestampMs(run.updatedAt) === timestampMs(existing.updatedAt)
            && run.id > existing.id
          )
        )
      )
    ) {
      latest.set(key, run);
    }
  }
  return [...latest.values()];
}

export function createWorkflowGraph(deps: WorkflowGraphDeps): WorkflowGraph {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_TTL_MS;
  const maxEntries = deps.cacheMaxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, CacheEntry>();

  const putCache = (key: string, entry: CacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  /** Source 1 → source 2 → nothing. Never guesses. */
  const loadWorkflows = async (
    input: WorkflowGraphInput,
  ): Promise<{ source: PrWorkflowGraphSource; workflows: ParsedWorkflow[] }> => {
    const key = cacheKey(input.repoOwner, input.repoName, input.headSha);
    if (!input.force) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) {
        return { source: hit.source, workflows: hit.workflows };
      }
      if (hit) cache.delete(key);
    }

    const attempts: Array<{ source: Exclude<PrWorkflowGraphSource, "none">; read: WorkflowFileReader }> = [
      { source: "worktree", read: deps.readWorktreeWorkflows },
      { source: "contents-api", read: deps.readContentsApiWorkflows },
    ];

    for (const attempt of attempts) {
      let files: WorkflowFileSource[] | null = null;
      try {
        files = await attempt.read({
          repoOwner: input.repoOwner,
          repoName: input.repoName,
          headSha: input.headSha,
          worktreePath: input.worktreePath,
        });
      } catch (error) {
        deps.logger?.warn("prs.workflow_graph_source_failed", {
          source: attempt.source,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!files || files.length === 0) continue;
      const workflows = files.map(parseWorkflowFile);
      const result = { source: attempt.source as PrWorkflowGraphSource, workflows };
      putCache(key, { expiresAt: now() + ttlMs, ...result });
      return result;
    }

    const empty = { source: "none" as PrWorkflowGraphSource, workflows: [] as ParsedWorkflow[] };
    putCache(key, { expiresAt: now() + ttlMs, ...empty });
    return empty;
  };

  const build = async (input: WorkflowGraphInput): Promise<PrWorkflowGraph> => {
    const nowMs = now();
    const runs = latestRunsByWorkflow(input.runs ?? []);
    const checks = input.checks ?? [];

    const attempt = runs.reduce((max, run) => Math.max(max, run.runAttempt ?? 1), 1);

    // A PR with no Actions runs at all is not graphable — say so honestly
    // instead of drawing an empty canvas.
    if (runs.length === 0) {
      return {
        source: "none",
        unavailableReason: "not-actions",
        headSha: input.headSha,
        attempt,
        nodes: [],
        edges: [],
        criticalPath: [],
        externalChecks: [...checks],
        stale: false,
        staleBehindBy: null,
      };
    }

    const { source, workflows } = await loadWorkflows(input);
    const byWorkflowPath = new Map<string, ParsedWorkflow>();
    const workflowsByName = new Map<string, ParsedWorkflow[]>();
    for (const workflow of workflows) {
      byWorkflowPath.set(workflow.path, workflow);
      const sameName = workflowsByName.get(workflow.name) ?? [];
      sameName.push(workflow);
      workflowsByName.set(workflow.name, sameName);
    }

    const checkIdByName = new Map<string, number>();
    const checkNames = new Set<string>();
    for (const check of checks) {
      checkNames.add(check.name);
      if (typeof check.id === "number" && check.id > 0 && !checkIdByName.has(check.name)) {
        checkIdByName.set(check.name, check.id);
      }
    }

    const usedNodeIds = new Set<string>();
    /** `jobId` must be unique graph-wide; qualify on collision across files. */
    const claimNodeId = (workflowName: string, rawId: string): string => {
      if (!usedNodeIds.has(rawId)) {
        usedNodeIds.add(rawId);
        return rawId;
      }
      let candidate = `${workflowName}/${rawId}`;
      let suffix = 2;
      while (usedNodeIds.has(candidate)) candidate = `${workflowName}/${rawId}#${suffix++}`;
      usedNodeIds.add(candidate);
      return candidate;
    };

    const nodes: PrWorkflowGraphNode[] = [];
    const edges: PrWorkflowGraphEdge[] = [];
    const matchedJobNames = new Set<string>();
    const degradeReasons: PrWorkflowGraphUnavailableReason[] = [];
    let graphedAnyWorkflow = false;
    let staleRunSha: string | null = null;

    const checkUrlByName = new Map<string, string>();
    for (const check of checks) {
      if (check.detailsUrl && !checkUrlByName.has(check.name)) checkUrlByName.set(check.name, check.detailsUrl);
    }
    const checkDetailsUrlFor = (jobName: string): string | null => checkUrlByName.get(jobName) ?? null;

    const makeNode = (args: {
      nodeId: string;
      displayName: string;
      workflowName: string;
      legJobs: PrActionJob[];
      runId: number | null;
      isMatrix: boolean;
    }): PrWorkflowGraphNode => {
      const { legJobs } = args;
      const legs: PrWorkflowMatrixLeg[] = args.isMatrix
        ? legJobs.map((job) => ({
            name: job.name,
            jobId: job.id > 0 ? job.id : null,
            state: pipelineStateForJob(job),
            durationMs: durationFor(job.startedAt, job.completedAt, nowMs),
            detailsUrl: checkDetailsUrlFor(job.name),
          }))
        : [];
      const startedAt = earliest(legJobs.map((job) => job.startedAt));
      const completedAt = latestCompletion(legJobs);
      const representative = representativeLeg(legJobs);
      return {
        jobId: args.nodeId,
        displayName: args.displayName,
        workflowName: args.workflowName,
        state: legJobs.length ? worstPipelineState(legJobs.map(pipelineStateForJob)) : "unknown",
        tier: 0, // assigned below, once every node exists
        durationMs: durationFor(startedAt, completedAt, nowMs),
        startedAt,
        completedAt,
        legs,
        steps: representative?.steps ?? [],
        checkRunId: representative
          ? (representative.checkRunId ?? checkIdByName.get(representative.name) ?? null)
          : null,
        actionsJobId: representative && representative.id > 0 ? representative.id : null,
        runId: args.runId,
        detailsUrl: representative ? checkDetailsUrlFor(representative.name) : null,
      };
    };

    for (const run of runs) {
      const runJobs = Array.isArray(run.jobs) ? run.jobs : [];
      if (run.headSha && input.headSha && run.headSha !== input.headSha) {
        staleRunSha = staleRunSha ?? run.headSha;
      }
      const runWorkflowPath = run.workflowPath?.trim() || null;
      const nameMatches = workflowsByName.get(run.name) ?? [];
      const workflow = runWorkflowPath
        ? byWorkflowPath.get(runWorkflowPath)
        : nameMatches.length === 1
          ? nameMatches[0]
          : undefined;
      const runId = run.id > 0 ? run.id : null;

      // Degraded or unmatched workflow → flat swimlane nodes, zero edges.
      if (!workflow || workflow.degraded || workflow.jobs.length === 0) {
        if (workflow?.degraded) degradeReasons.push(workflow.degraded);
        else if (!workflow) degradeReasons.push("no-workflow-file");
        for (const job of runJobs) {
          matchedJobNames.add(job.name);
          nodes.push(
            makeNode({
              nodeId: claimNodeId(run.name, job.name),
              displayName: job.name,
              workflowName: run.name,
              legJobs: [job],
              runId,
              isMatrix: false,
            }),
          );
        }
        continue;
      }

      graphedAnyWorkflow = true;
      const nodeIdByTemplateId = new Map<string, string>();

      for (const templateJob of workflow.jobs) {
        const legJobs = runJobs.filter((job) => jobMatchesTemplate(job.name, templateJob));
        for (const job of legJobs) matchedJobNames.add(job.name);

        const base = templateJob.staticName ?? templateJob.id;
        const isMatrix =
          templateJob.isMatrix || legJobs.some((job) => matrixLegMatches(job.name, base));
        const nodeId = claimNodeId(workflow.name, templateJob.id);
        nodeIdByTemplateId.set(templateJob.id, nodeId);
        nodes.push(
          makeNode({
            nodeId,
            displayName: base,
            workflowName: workflow.name,
            legJobs,
            runId,
            isMatrix,
          }),
        );
      }

      for (const templateJob of workflow.jobs) {
        const to = nodeIdByTemplateId.get(templateJob.id);
        if (!to) continue;
        for (const need of templateJob.needs) {
          const from = nodeIdByTemplateId.get(need);
          // A `needs:` pointing at a job that does not exist is malformed YAML;
          // dropping the edge beats inventing a node for it.
          if (!from) continue;
          edges.push({ from, to });
        }
      }

      // Jobs GitHub ran that the template did not describe (e.g. a job added by
      // a re-run of an older workflow revision) still deserve a swimlane node.
      for (const job of runJobs) {
        if (matchedJobNames.has(job.name)) continue;
        matchedJobNames.add(job.name);
        nodes.push(
          makeNode({
            nodeId: claimNodeId(run.name, job.name),
            displayName: job.name,
            workflowName: run.name,
            legJobs: [job],
            runId,
            isMatrix: false,
          }),
        );
      }
    }

    const tiers = computeTiers(
      nodes.map((node) => node.jobId),
      edges,
    );
    for (const node of nodes) node.tier = tiers.get(node.jobId) ?? 0;

    const criticalPath = computeCriticalPath(nodes, edges);

    const externalChecks = checks.filter((check) => !matchedJobNames.has(check.name));

    let unavailableReason: PrWorkflowGraphUnavailableReason | null = null;
    if (!graphedAnyWorkflow) {
      unavailableReason =
        source === "none" ? "no-workflow-file" : (degradeReasons[0] ?? "no-workflow-file");
    }

    let staleBehindBy: number | null = null;
    if (staleRunSha && deps.countCommitsBetween) {
      try {
        staleBehindBy = await deps.countCommitsBetween({
          worktreePath: input.worktreePath,
          fromSha: staleRunSha,
          toSha: input.headSha,
        });
      } catch {
        staleBehindBy = null;
      }
    }

    return {
      source: graphedAnyWorkflow ? source : "none",
      unavailableReason,
      headSha: input.headSha,
      attempt,
      nodes,
      edges,
      criticalPath,
      externalChecks,
      stale: staleRunSha != null,
      staleBehindBy,
    };
  };

  const invalidate: WorkflowGraph["invalidate"] = (args) => {
    if (!args || (!args.repoOwner && !args.repoName && !args.headSha)) {
      cache.clear();
      return;
    }
    if (args.repoOwner && args.repoName && args.headSha) {
      cache.delete(cacheKey(args.repoOwner, args.repoName, args.headSha));
      return;
    }
    const prefix = args.repoOwner && args.repoName ? `${args.repoOwner}/${args.repoName}@` : null;
    for (const key of [...cache.keys()]) {
      if (prefix && key.startsWith(prefix)) cache.delete(key);
      else if (args.headSha && key.endsWith(`@${args.headSha}`)) cache.delete(key);
    }
  };

  return { build, invalidate };
}
