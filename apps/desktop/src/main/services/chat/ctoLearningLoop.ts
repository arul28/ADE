import type { AgentChatEvent } from "../../../shared/types/chat";
import type { CtoLearnedPayload } from "../cto/ctoLearningService";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { buildCtoReviewPrompt, CTO_REVIEW_REASON } from "./ctoQuietTurn";

/** At most one hidden review turn per CTO thread in this window. */
export const CTO_REVIEW_MIN_INTERVAL_MS = 5 * 60_000;

/** The chat event that draws (or redraws, after an Undo) a turn's "Learned" row. */
export function ctoLearnedEvent(payload: Pick<CtoLearnedPayload, "learnId" | "changes" | "turnId">): AgentChatEvent {
  return {
    type: "cto_learned",
    learnId: payload.learnId,
    changes: payload.changes,
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
  };
}

/** Whether a thread can take the review turn now; anything else skips it. */
export type CtoReviewReadiness = "ready" | "gone" | "busy" | "runtime_mid_turn";

/**
 * The hidden review turn after a correction: the person corrected the CTO and
 * the turn saved no lesson, so ADE asks the CTO, in a turn nobody sees, to fix
 * the cause (a rule, a skill, a note). Its text is dropped
 * (`stepCtoQuietTurn`); a lesson it saves shows as the usual Learned row.
 * The rate limit is in memory: a brain restart may allow one more.
 */
export function createCtoReviewTurns(deps: {
  logger: Pick<Logger, "info" | "warn">;
  readiness: (sessionId: string) => CtoReviewReadiness;
  sendWake: (sessionId: string, text: string, metadata: { hostContinuation: { reason: typeof CTO_REVIEW_REASON } }) => Promise<unknown>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const lastAtBySession = new Map<string, number>();

  /**
   * A CTO turn ended. Starts the review on the next tick, after the turn's own
   * last events, and only into a quiet thread: when the person already wrote
   * again, their turn comes first and this review is dropped.
   */
  const maybeStart = (sessionId: string, correction: string | null, learnedThisTurn: boolean): void => {
    if (!correction || learnedThisTurn) return;
    if (now() - (lastAtBySession.get(sessionId) ?? 0) < CTO_REVIEW_MIN_INTERVAL_MS) {
      deps.logger.info("agent_chat.cto_review_skipped", { sessionId, reason: "rate_limited" });
      return;
    }
    setTimeout(() => {
      const readiness = deps.readiness(sessionId);
      if (readiness !== "ready") {
        // A runtime still finishing its turn (a Stop whose `done` is late)
        // would end the review's quiet with that `done`.
        if (readiness === "runtime_mid_turn") deps.logger.info("agent_chat.cto_review_skipped", { sessionId, reason: readiness });
        return;
      }
      lastAtBySession.set(sessionId, now());
      deps.logger.info("agent_chat.cto_review_started", { sessionId });
      void deps.sendWake(sessionId, buildCtoReviewPrompt(correction), { hostContinuation: { reason: CTO_REVIEW_REASON } })
        .catch((error) => {
          deps.logger.warn("agent_chat.cto_review_failed", { sessionId, error: getErrorMessage(error) });
        });
    }, 0);
  };

  return { maybeStart };
}
