import type { PrCreationStrategy } from "./types/prs";

/**
 * Resolve how drift against a PR should be handled based on its creation
 * strategy:
 *
 *   - `pr_target` (default when strategy is null/unset): the PR's base branch
 *     is treated as the canonical target. When it advances, drift is visible
 *     as a `pr_target` RebaseNeed and — if the lane's auto-rebase policy is
 *     enabled — the auto-rebase service will fire. Mode: "auto".
 *
 *   - `lane_base`: the PR carries an immutable base. Drift against the PR
 *     target surfaces as rebase attention ONLY; auto-rebase must NOT fire.
 *     Instead the lane gets a `rebasePending` status so the user can choose
 *     to rebase manually or update the PR base by hand. Mode: "manual".
 *
 * A thin helper so the two call sites (rebase suggestion classifier and
 * auto-rebase execution) share one source of truth.
 */
export function resolvePrRebaseMode(
  creationStrategy: PrCreationStrategy | null | undefined,
): "auto" | "manual" {
  return creationStrategy === "lane_base" ? "manual" : "auto";
}

/**
 * Narrow a raw DB column value to a valid `PrCreationStrategy`, returning
 * `null` for missing/unknown values. Used wherever we read
 * `pull_requests.creation_strategy` from storage.
 */
export function normalizePrCreationStrategy(
  value: unknown,
): PrCreationStrategy | null {
  return value === "pr_target" || value === "lane_base" ? value : null;
}
