import { compactFirstEligibleAtMs, compactFirstOffer, compactFirstSupportedProvider, lastFinishedTurnMs, type CompactFirstOffer } from "../../../desktop/src/shared/compactFirst";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";

/** The user's `/compact-first` choice for one chat, kept with the turn end it was made after. */
export type CompactFirstChoice = { value: boolean; turnEndedAtMs: number | null };

export type CompactFirstState = {
  sessionId: string;
  offer: CompactFirstOffer | null;
  /** Whether the next send compacts first. */
  enabled: boolean;
  turnEndedAtMs: number | null;
  /** When the prompt cache runs out, so the footer can re-render on time; null with no finished turn. */
  eligibleAt: number | null;
};

/**
 * Compact first, as on desktop and iOS: once a supported chat's prompt cache
 * has expired (Claude, Codex, or a Pi/OpenCode model with a known vendor), the
 * offer makes the next send compact the chat before it. The choice covers one
 * send, so a new turn end drops it.
 */
export function deriveCompactFirstState({ session, events, blocked, choice, now }: {
  session: AgentChatSessionSummary | null;
  events: readonly AgentChatEventEnvelope[];
  /** A question, approval or queued message is pending; the offer would only flash. */
  blocked: boolean;
  choice: CompactFirstChoice | undefined;
  now: number;
}): CompactFirstState | null {
  if (!session || !session.compactionIdleMode || !compactFirstSupportedProvider(session.provider)) return null;
  const { endedAtMs, startedAtMs } = lastFinishedTurnMs(events);
  // A running turn is never offered; skip the event walk while deltas stream.
  const offer = blocked || session.status === "active" ? null : compactFirstOffer({
    provider: session.provider,
    model: session.model,
    events,
    cache: session.promptCache,
    idleMs: session.compactFirstIdleMs,
    minTokens: session.compactFirstMinTokens,
    mode: session.compactionIdleMode,
    now,
  });
  return {
    sessionId: session.sessionId,
    offer,
    enabled: choice && choice.turnEndedAtMs === endedAtMs ? choice.value : session.compactionIdleMode === "always",
    turnEndedAtMs: endedAtMs,
    eligibleAt: compactFirstEligibleAtMs({ provider: session.provider, model: session.model, cache: session.promptCache, idleMs: session.compactFirstIdleMs }, endedAtMs, startedAtMs),
  };
}
