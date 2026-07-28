import type { PrPipelineState } from "./types/prs";

export type PrPipelineStateInput = {
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
};

/**
 * Canonical GitHub check/job → ADE pipeline-state mapping.
 *
 * `cancelled`, `timed_out`, and `action_required` are failures because they did
 * not produce a passing merge signal. `neutral` and `skipped` remain visible
 * but do not make the pipeline red.
 */
export function pipelineStateOf(item: PrPipelineStateInput): PrPipelineState {
  if (item.status === "queued") return "queued";
  if (item.status === "in_progress") return "running";
  switch (item.conclusion) {
    case "success":
      return "passed";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
      return "failed";
    case "neutral":
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

const STATE_RANK: Record<PrPipelineState, number> = {
  failed: 0,
  unknown: 1,
  running: 2,
  queued: 3,
  passed: 4,
  skipped: 5,
};

/** Worst-first rollup used for matrix jobs and aggregate summaries. */
export function worstPipelineState(states: readonly PrPipelineState[]): PrPipelineState {
  if (states.length === 0) return "unknown";
  let worst = states[0]!;
  for (let index = 1; index < states.length; index += 1) {
    const state = states[index]!;
    if (STATE_RANK[state] < STATE_RANK[worst]) worst = state;
  }
  return worst;
}
