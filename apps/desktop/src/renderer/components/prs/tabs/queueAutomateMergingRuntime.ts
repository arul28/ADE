import type { ConvergenceRuntimeStatus, PrConvergenceState } from "../../../../shared/types";

export type WatcherOutcome = "working" | "merged" | "halted";

const HALT_STATUSES: ReadonlySet<ConvergenceRuntimeStatus> = new Set([
  "paused",
  "failed",
  "cancelled",
  "stopped",
]);

/**
 * Classify a Path-to-Merge watcher's runtime for the queue automation loop.
 * The watcher stays "working" (running / polling / launching) until ground-truth
 * merge flips it to "merged", or it halts (paused / failed / cancelled / stopped).
 */
export function classifyWatcherOutcome(runtime: PrConvergenceState | null): WatcherOutcome {
  const status = runtime?.status ?? null;
  if (status === "merged") return "merged";
  if (status && HALT_STATUSES.has(status)) return "halted";
  return "working";
}
