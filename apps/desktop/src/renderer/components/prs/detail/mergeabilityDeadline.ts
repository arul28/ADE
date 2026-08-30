export interface MergeabilityDeadline {
  prId: string;
  deadlineAtMs: number;
}

export const MERGEABILITY_POLL_WINDOW_MS = 60_000;

/**
 * The mergeability poll's wall-clock ceiling must survive effect re-runs: the
 * poll governor's generation is a dependency of the polling effect and churns
 * on every governor transition, so a deadline minted per mount re-arms
 * indefinitely during an outage — the 2026-08-21 runaway held one PR's
 * merge-box loop live for two hours that way. The deadline is carried across
 * re-runs for the same PR and re-minted only when the polled PR changes; a new
 * computing episode re-mints because the caller drops the carried value when
 * mergeability stops computing.
 */
export function resolveMergeabilityDeadline(
  current: MergeabilityDeadline | null,
  prId: string,
  nowMs: number,
): MergeabilityDeadline {
  if (current && current.prId === prId) return current;
  return { prId, deadlineAtMs: nowMs + MERGEABILITY_POLL_WINDOW_MS };
}
