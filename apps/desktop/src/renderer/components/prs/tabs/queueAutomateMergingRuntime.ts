import type { PrConvergenceState } from "../../../../shared/types";

export function isWaitingForGithubAutoMerge(runtime: PrConvergenceState | null): boolean {
  return runtime?.status === "converged"
    && runtime.pollerStatus === "waiting_for_checks"
    && runtime.mergeWaitKind === "github_auto_merge_armed";
}
