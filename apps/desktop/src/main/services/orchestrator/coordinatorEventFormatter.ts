// ---------------------------------------------------------------------------
// Coordinator Event Formatter — 4-tier context system for formatting runtime
// events into coordinator-digestible summaries.
// ---------------------------------------------------------------------------

import type {
  OrchestratorRuntimeEvent,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorAttempt,
  OrchestratorStepStatus,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventTier = 1 | 2 | 3 | 4;

export type FormattedEvent = {
  tier: EventTier;
  /** Tier 1: ~50 token one-liner summary. */
  summary: string;
  /** Tier 2: ~200-500 token digest with context. */
  digest?: string;
  /** Tier 3: Full output text, available on demand. */
  fullOutput?: string;
  /** Tier 4: Shared fact keys for cross-step knowledge. */
  factKeys?: string[];
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<string>([
  "succeeded",
  "failed",
  "skipped",
  "canceled",
]);

function countByStatus(steps: OrchestratorStep[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of steps) {
    counts[step.status] = (counts[step.status] ?? 0) + 1;
  }
  return counts;
}

function progressFraction(graph: OrchestratorRunGraph): {
  done: number;
  total: number;
  pct: number;
} {
  const total = graph.steps.length;
  const done = graph.steps.filter((s) => TERMINAL_STATUSES.has(s.status)).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, pct };
}

function stepStatusIcon(status: OrchestratorStepStatus): string {
  switch (status) {
    case "succeeded":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "running":
      return "\u25B6";
    case "ready":
      return "\u25CB";
    case "pending":
      return "\u25CB";
    case "blocked":
      return "\u26A0";
    case "skipped":
      return "\u2192";
    case "canceled":
      return "\u2205";
    default:
      return "?";
  }
}

function readyStepKeys(graph: OrchestratorRunGraph): string[] {
  return graph.steps
    .filter((s) => s.status === "ready")
    .map((s) => s.stepKey);
}

function failedStepSummaries(graph: OrchestratorRunGraph): string[] {
  return graph.steps
    .filter((s) => s.status === "failed")
    .map((s) => {
      const lastAttempt = graph.attempts
        .filter((a) => a.stepId === s.id)
        .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))[0];
      const errMsg = lastAttempt?.errorMessage ?? "unknown error";
      return `${s.stepKey}: ${errMsg}`;
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a generic runtime event into tiered context.
 */
export function formatRuntimeEvent(
  event: OrchestratorRuntimeEvent,
  context?: {
    graph?: OrchestratorRunGraph;
    step?: OrchestratorStep;
    attempt?: OrchestratorAttempt;
  },
): FormattedEvent {
  const { graph: g, step, attempt } = context ?? {};

  // Build tier-1 summary
  const eventLabel = event.type.replace("orchestrator-", "").replace(/-/g, "_").toUpperCase();
  const stepTag = step ? ` ${step.stepKey}` : "";
  const progressTag =
    g ? (() => {
      const { done, total, pct } = progressFraction(g);
      return ` (${done}/${total}, ${pct}%)`;
    })() : "";

  const summary = `[${eventLabel}]${stepTag} ${event.reason}${progressTag}`;

  // Build tier-2 digest if graph is available
  let digest: string | undefined;
  if (g) {
    const parts: string[] = [summary];
    const ready = readyStepKeys(g);
    if (ready.length > 0) {
      parts.push(`Ready: ${ready.join(", ")}`);
    }
    const failed = failedStepSummaries(g);
    if (failed.length > 0) {
      parts.push(`Failed: ${failed.join("; ")}`);
    }
    if (attempt?.resultEnvelope?.summary) {
      parts.push(`Result: ${attempt.resultEnvelope.summary}`);
    }
    digest = parts.join("\n");
  }

  return { tier: g ? 2 : 1, summary, digest };
}

/**
 * Format a step completion event with rich context.
 */
export function formatStepCompletion(
  step: OrchestratorStep,
  attempt: OrchestratorAttempt | null,
  graph: OrchestratorRunGraph,
): FormattedEvent {
  const { done, total, pct } = progressFraction(graph);
  const icon = stepStatusIcon(step.status);
  const summary = `[STEP_DONE] ${step.stepKey} ${icon} (${done}/${total}, ${pct}%)`;

  const parts: string[] = [summary];
  if (attempt?.resultEnvelope?.summary) {
    parts.push(`Summary: ${attempt.resultEnvelope.summary}`);
  }
  if (attempt?.resultEnvelope?.warnings?.length) {
    parts.push(`Warnings: ${attempt.resultEnvelope.warnings.join("; ")}`);
  }
  const ready = readyStepKeys(graph);
  if (ready.length > 0) {
    parts.push(`Next ready: ${ready.join(", ")}`);
  }
  const running = graph.steps.filter((s) => s.status === "running");
  if (running.length > 0) {
    parts.push(`Running: ${running.map((s) => s.stepKey).join(", ")}`);
  }
  const digest = parts.join("\n");

  const fullOutput = attempt?.resultEnvelope
    ? JSON.stringify(attempt.resultEnvelope, null, 2)
    : undefined;

  return { tier: 2, summary, digest, fullOutput };
}

/**
 * Format a step failure event with diagnostic context.
 */
export function formatStepFailure(
  step: OrchestratorStep,
  attempt: OrchestratorAttempt | null,
  errorMessage: string,
): FormattedEvent {
  const retryInfo =
    step.retryLimit > 0
      ? ` (retry ${step.retryCount}/${step.retryLimit})`
      : "";
  const summary = `[STEP_FAIL] ${step.stepKey} \u2717${retryInfo}`;

  const parts: string[] = [summary, `Error: ${errorMessage}`];
  if (attempt?.errorClass && attempt.errorClass !== "none") {
    parts.push(`Class: ${attempt.errorClass}`);
  }
  if (step.retryCount < step.retryLimit) {
    parts.push(`Action: Will retry (attempt ${step.retryCount + 1}/${step.retryLimit})`);
  } else if (step.retryLimit > 0) {
    parts.push("Action: Retries exhausted, needs intervention");
  }
  const digest = parts.join("\n");

  return { tier: 2, summary, digest };
}

/**
 * Build a compact progress summary string for the entire run.
 */
export function formatProgressSummary(graph: OrchestratorRunGraph): string {
  const { done, total, pct } = progressFraction(graph);
  const counts = countByStatus(graph.steps);
  const parts: string[] = [
    `Progress: ${done}/${total} (${pct}%)`,
    `Run: ${graph.run.status}`,
  ];

  const statusLine = Object.entries(counts)
    .map(([status, count]) => `${status}=${count}`)
    .join(" ");
  parts.push(statusLine);

  const running = graph.steps.filter((s) => s.status === "running");
  if (running.length > 0) {
    parts.push(`Active: ${running.map((s) => s.stepKey).join(", ")}`);
  }

  const ready = readyStepKeys(graph);
  if (ready.length > 0) {
    parts.push(`Ready: ${ready.join(", ")}`);
  }

  const failed = failedStepSummaries(graph);
  if (failed.length > 0) {
    parts.push(`Failed: ${failed.join("; ")}`);
  }

  return parts.join(" | ");
}
