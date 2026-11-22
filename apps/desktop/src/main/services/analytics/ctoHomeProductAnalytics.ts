import type { ProductAnalyticsService } from "./productAnalyticsService";

/** One fact per outcome an hour: re-picking the same home is not a new move. */
const CTO_HOME_MOVE_ANALYTICS_DEDUPE_MS = 60 * 60_000;

/**
 * How a move of the CTO to a new home machine went, from that machine:
 * `completed`, it took the CTO another machine left in the account;
 * `kept`, it already held the newest copy (or there was none);
 * `failed`, the account couldn't be read, so the copy is taken later.
 */
export type CtoHomeMoveOutcome = "completed" | "kept" | "failed";

/**
 * Called by the account copy where the move lands. Never the machine, its
 * name, the repository, the notes, the conversation, or the routines.
 */
export function reportCtoHomeMove(
  service: Pick<ProductAnalyticsService, "captureInternal"> | null | undefined,
  outcome: CtoHomeMoveOutcome,
): void {
  service?.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    properties: { feature: "cto", action: "cto_home_move", outcome },
    dedupeKey: `cto_home_move:${outcome}`,
    minimumIntervalMs: CTO_HOME_MOVE_ANALYTICS_DEDUPE_MS,
  });
}
