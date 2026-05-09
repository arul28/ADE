import type { PrConvergenceState } from "../../../../shared/types";

const AUTO_MERGE_ARMED_REASON_PREFIX = "auto-merge armed via gh CLI";

export function isWaitingForGithubAutoMerge(runtime: PrConvergenceState | null): boolean {
  return runtime?.status === "converged"
    && runtime.pollerStatus === "waiting_for_checks"
    && Boolean(runtime.pauseReason?.startsWith(AUTO_MERGE_ARMED_REASON_PREFIX));
}
