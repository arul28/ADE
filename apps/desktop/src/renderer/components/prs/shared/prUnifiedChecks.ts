import type { PrActionRun, PrActionStep, PrCheck, PrPipelineState } from "../../../../shared/types";
import { pipelineStateOf } from "../../../../shared/prPipelineState";

export { pipelineStateOf };

export type UnifiedCheckItem = {
  id: string;
  name: string;
  displayName: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "skipped"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | null;
  /** Final duration in whole seconds. Null while a job is still running — use {@link checkElapsedMs} for live elapsed. */
  duration: number | null;
  detailsUrl: string | null;
  source: "actions_job" | "check";
  /**
   * Steps of the job, with their `startedAt`/`completedAt` intact. The service
   * already fetches per-step timings; this type used to narrow them away, which
   * is why in-node step progress had no durations to render.
   */
  steps?: PrActionStep[];
  /** Workflow this job belongs to — the grouping key for the swimlane fallback. */
  workflowName?: string;
  startedAt: string | null;
  completedAt: string | null;
  /** GitHub Actions job id, the key for the failing-step log excerpt fetch. */
  jobId: number | null;
  /** Workflow run id, when this item came from an Actions run. */
  runId: number | null;
  /**
   * Check-run id, so `rerunChecks({ checkRunIds })` is reachable for Checks API
   * rows. Actions job ids and check-run ids are different namespaces.
   */
  checkRunId: number | null;
};

/**
 * The ONE rollup of a check/job into a pipeline state. Three implementations
 * used to disagree here — `cancelled` was a skip in one and a failure in
 * another, and none of them partitioned the set, so the progress bar
 * under-filled. Every consumer now goes through this.
 *
 * `cancelled` counts as a failure: it is not a green signal, it blocks merge,
 * and it is re-runnable — which is exactly what the failure affordances offer.
 */
/** Counts per {@link PrPipelineState}. The six buckets always sum to `total`. */
export type PrCheckBuckets = {
  total: number;
  passed: number;
  failed: number;
  running: number;
  queued: number;
  skipped: number;
  unknown: number;
};

export const EMPTY_CHECK_BUCKETS: PrCheckBuckets = {
  total: 0, passed: 0, failed: 0, running: 0, queued: 0, skipped: 0, unknown: 0,
};

export function summarizePipelineStates(
  items: Array<{ status: "queued" | "in_progress" | "completed"; conclusion: string | null }>,
): PrCheckBuckets {
  const buckets: PrCheckBuckets = { ...EMPTY_CHECK_BUCKETS, total: items.length };
  for (const item of items) {
    buckets[pipelineStateOf(item)] += 1;
  }
  return buckets;
}

/**
 * States that should be surfaced to the user rather than folded into "done":
 * anything failing, unresolved, or still moving.
 */
export function isAttentionState(state: PrPipelineState): boolean {
  return state === "failed" || state === "unknown" || state === "running" || state === "queued";
}

/** True when nothing is queued or running — the pipeline has settled. */
export function isPipelineTerminal(buckets: PrCheckBuckets): boolean {
  return buckets.running === 0 && buckets.queued === 0;
}

/**
 * Live elapsed for a check/job, in milliseconds. A job that started 14 minutes
 * ago and has not finished has `completedAt === null`, so the stored `duration`
 * is null — measure against `now` instead of rendering nothing.
 */
export function checkElapsedMs(
  item: { startedAt: string | null; completedAt: string | null },
  now: number = Date.now(),
): number | null {
  if (!item.startedAt) return null;
  const start = Date.parse(item.startedAt);
  const end = item.completedAt ? Date.parse(item.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function normalizeCheckName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCheckComposite(workflowName: string, jobName: string): string {
  return `${normalizeCheckName(workflowName)}/${normalizeCheckName(jobName)}`;
}

function extractActionsJobId(detailsUrl: string | null | undefined): string | null {
  const match = (detailsUrl ?? "").match(/\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/);
  return match?.[1] ?? null;
}

function isActionsRunUrl(detailsUrl: string | null | undefined): boolean {
  return /\/actions\/runs\/\d+(?:[/?#]|\/|$)/.test(detailsUrl ?? "");
}

/**
 * Third-party check runs link to `https://github.com/o/r/runs/<check run id>`.
 * Pulling the id out is what makes per-check re-run reachable for them.
 */
function extractCheckRunId(detailsUrl: string | null | undefined): number | null {
  const match = (detailsUrl ?? "").match(/\/runs\/(\d+)(?:[/?#]|$)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildActionsJobDetailsUrl(runUrl: string, jobId: number): string | null {
  const trimmed = runUrl.trim();
  if (!trimmed) return null;
  if (jobId > 0 && /\/actions\/runs\/\d+(?:[/?#]|$)/.test(trimmed)) {
    return `${trimmed.replace(/\/$/, "")}/job/${jobId}`;
  }
  return trimmed;
}

function completedDurationSeconds(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  return startedAt && completedAt
    ? Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000)
    : null;
}

export function buildUnifiedChecks(checks: PrCheck[], actionRuns: PrActionRun[]): UnifiedCheckItem[] {
  const items: UnifiedCheckItem[] = [];
  const coveredNames = new Set<string>();
  const coveredActionJobIds = new Set<string>();

  const latestRunByWorkflow = new Map<string, PrActionRun>();
  for (const run of actionRuns) {
    const existing = latestRunByWorkflow.get(run.name);
    if (!existing || new Date(run.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestRunByWorkflow.set(run.name, run);
    }
  }
  const dedupedRuns = Array.from(latestRunByWorkflow.values());

  const actionJobNameCounts = new Map<string, number>();
  for (const run of dedupedRuns) {
    for (const job of run.jobs) {
      const normalizedName = normalizeCheckName(job.name);
      if (!normalizedName) continue;
      actionJobNameCounts.set(normalizedName, (actionJobNameCounts.get(normalizedName) ?? 0) + 1);
    }
  }
  const uniqueActionJobNames = new Set(
    Array.from(actionJobNameCounts.entries())
      .filter(([, count]) => count === 1)
      .map(([name]) => name),
  );

  for (const run of dedupedRuns) {
    for (const job of run.jobs) {
      const canonicalName = `${run.name} / ${job.name}`;
      coveredNames.add(normalizeCheckName(canonicalName));
      coveredNames.add(normalizeCheckComposite(run.name, job.name));
      if (job.id > 0) coveredActionJobIds.add(String(job.id));

      const detailsUrl = buildActionsJobDetailsUrl(run.htmlUrl, job.id);

      items.push({
        id: `job-${job.id}`,
        name: canonicalName,
        displayName: canonicalName,
        status: job.status,
        conclusion: job.conclusion,
        duration: completedDurationSeconds(job.startedAt, job.completedAt),
        detailsUrl,
        source: "actions_job",
        steps: job.steps,
        workflowName: run.name,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        jobId: job.id > 0 ? job.id : null,
        runId: run.id,
        checkRunId: job.checkRunId ?? null,
      });
    }
  }

  for (const check of checks) {
    const lowerName = normalizeCheckName(check.name);
    const actionsJobId = extractActionsJobId(check.detailsUrl);
    if (actionsJobId && coveredActionJobIds.has(actionsJobId)) continue;
    if (coveredNames.has(lowerName)) continue;
    if (isActionsRunUrl(check.detailsUrl) && uniqueActionJobNames.has(lowerName)) continue;
    const slashIdx = check.name.indexOf("/");
    if (slashIdx > 0) {
      const workflowPart = check.name.slice(0, slashIdx).trim();
      const jobPart = check.name.slice(slashIdx + 1).trim();
      if (coveredNames.has(normalizeCheckComposite(workflowPart, jobPart))) continue;
    }

    items.push({
      id: `check-${check.name}`,
      name: check.name,
      displayName: check.name,
      status: check.status,
      conclusion: check.conclusion,
      duration: completedDurationSeconds(check.startedAt, check.completedAt),
      detailsUrl: check.detailsUrl,
      source: "check",
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      jobId: Number(extractActionsJobId(check.detailsUrl)) || null,
      runId: null,
      // The service now carries the real check-run id; the URL is the fallback
      // for combined-status rows and older runtimes.
      checkRunId: check.id ?? extractCheckRunId(check.detailsUrl),
    });
  }

  // failure/unknown → still moving → settled, then alphabetical. Uses the one
  // shared rollup so ordering can't disagree with the counts again.
  const sortRank: Record<PrPipelineState, number> = {
    failed: 0, unknown: 0, running: 1, queued: 1, passed: 2, skipped: 2,
  };
  items.sort((a, b) => {
    const aPriority = sortRank[pipelineStateOf(a)];
    const bPriority = sortRank[pipelineStateOf(b)];
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.name.localeCompare(b.name);
  });

  return items;
}

export function findUnifiedCheckId(check: PrCheck, checks: PrCheck[], actionRuns: PrActionRun[]): string | null {
  const unified = buildUnifiedChecks(checks, actionRuns);
  if (unified.length === 0) return null;

  const actionsJobId = extractActionsJobId(check.detailsUrl);
  if (actionsJobId) {
    const byJobId = unified.find((item) => item.id === `job-${actionsJobId}`);
    if (byJobId) return byJobId.id;
  }

  const normalizedName = normalizeCheckName(check.name);
  const exact = unified.find(
    (item) =>
      normalizeCheckName(item.name) === normalizedName
      || normalizeCheckName(item.displayName) === normalizedName,
  );
  if (exact) return exact.id;

  const slashIdx = check.name.indexOf("/");
  if (slashIdx > 0) {
    const workflowPart = check.name.slice(0, slashIdx).trim();
    const jobPart = check.name.slice(slashIdx + 1).trim();
    const composite = normalizeCheckComposite(workflowPart, jobPart);
    const byComposite = unified.find((item) => normalizeCheckName(item.name) === composite);
    if (byComposite) return byComposite.id;
  }

  const fallback = unified.find((item) => item.id === `check-${check.name}`);
  return fallback?.id ?? null;
}

export function formatCheckDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export function unifiedChecksToPrChecks(checks: PrCheck[], actionRuns: PrActionRun[]): PrCheck[] {
  return buildUnifiedChecks(checks, actionRuns).map((c): PrCheck => ({
    name: c.displayName,
    status: c.status,
    conclusion: c.conclusion,
    detailsUrl: c.detailsUrl,
    // Carried through, not nulled: consumers compute live elapsed from these.
    startedAt: c.startedAt,
    completedAt: c.completedAt,
  }));
}
