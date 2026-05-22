import type { PrActionRun, PrCheck } from "../../../../shared/types";

export type UnifiedCheckItem = {
  id: string;
  name: string;
  displayName: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
  duration: number | null;
  detailsUrl: string | null;
  source: "actions_job" | "check";
  steps?: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
  workflowName?: string;
};

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

function buildActionsJobDetailsUrl(runUrl: string, jobId: number): string | null {
  const trimmed = runUrl.trim();
  if (!trimmed) return null;
  if (jobId > 0 && /\/actions\/runs\/\d+(?:[/?#]|$)/.test(trimmed)) {
    return `${trimmed.replace(/\/$/, "")}/job/${jobId}`;
  }
  return trimmed;
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

      const duration = job.startedAt && job.completedAt
        ? Math.round((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)
        : null;
      const detailsUrl = buildActionsJobDetailsUrl(run.htmlUrl, job.id);

      items.push({
        id: `job-${job.id}`,
        name: canonicalName,
        displayName: canonicalName,
        status: job.status,
        conclusion: job.conclusion,
        duration,
        detailsUrl,
        source: "actions_job",
        steps: job.steps,
        workflowName: run.name,
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

    const duration = check.startedAt && check.completedAt
      ? Math.round((new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000)
      : null;

    items.push({
      id: `check-${check.name}`,
      name: check.name,
      displayName: check.name,
      status: check.status,
      conclusion: check.conclusion,
      duration,
      detailsUrl: check.detailsUrl,
      source: "check",
    });
  }

  items.sort((a, b) => {
    const aPriority = a.conclusion === "failure" ? 0 : a.status !== "completed" ? 1 : 2;
    const bPriority = b.conclusion === "failure" ? 0 : b.status !== "completed" ? 1 : 2;
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
    startedAt: null,
    completedAt: null,
  }));
}
