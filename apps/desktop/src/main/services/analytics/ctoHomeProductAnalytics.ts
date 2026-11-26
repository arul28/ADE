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

/** One fact an hour: the question is whether people react, not how often. */
const CTO_MESSAGE_REACTION_ANALYTICS_DEDUPE_MS = 60 * 60_000;

/**
 * The person put an emoji on a CTO reply (`chat.reactToMessage`), reported by
 * the brain that stored it. Never the emoji, the message, the chat, or the machine.
 */
export function reportCtoMessageReaction(
  service: Pick<ProductAnalyticsService, "captureInternal"> | null | undefined,
): void {
  service?.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    properties: { feature: "cto", action: "cto_message_reaction", outcome: "completed" },
    dedupeKey: "cto_message_reaction",
    minimumIntervalMs: CTO_MESSAGE_REACTION_ANALYTICS_DEDUPE_MS,
  });
}
