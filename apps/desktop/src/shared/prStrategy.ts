import type { PrCreationStrategy } from "./types/prs";

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
