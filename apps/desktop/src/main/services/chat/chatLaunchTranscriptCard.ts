import type { AgentChatEventEnvelope, ChatLaunchSnapshot } from "../../../shared/types";
import type { AdeCardPayload } from "../../../shared/adeCard";
import { buildLaneSetupCard } from "../../../shared/chatLaunch";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";

/**
 * A launch's transcript card (`ade_card` variant "lane_setup", built in
 * shared/chatLaunch). Kept in step with the launch once the chat exists; the
 * first emit waits for the opening `user_message` so the card lands under the
 * user's bubble, exactly where the pending chat showed it.
 */

const CARD_FALLBACK_DELAY_MS = 4_000;

/** Per-launch card state; lives on the launch's runtime so dispose clears it. */
export type LaneSetupCardState = {
  cardEmitted: boolean;
  cardTimer: ReturnType<typeof setTimeout> | null;
  unsubscribeChat: (() => void) | null;
};

export function createLaneSetupTranscriptCard(deps: {
  agentChatService: {
    emitAdeCard: (args: { sessionId: string; card: AdeCardPayload }) => Promise<void>;
    subscribeToEvents: (callback: (event: AgentChatEventEnvelope) => void) => () => void;
  };
  logger: Logger;
  now: () => Date;
  stateFor: (launchId: string) => LaneSetupCardState;
  isDisposed: () => boolean;
}) {
  /** Re-emit the card from the record's current snapshot (after the first emit). */
  const sync = async (record: { snapshot: ChatLaunchSnapshot }): Promise<void> => {
    const snapshot = record.snapshot;
    if (snapshot.kind !== "chat" || !snapshot.sessionCreated || !snapshot.sessionId) return;
    if (snapshot.phase === "cancelled") return;
    if (!deps.stateFor(snapshot.launchId).cardEmitted) return;
    try {
      await deps.agentChatService.emitAdeCard({ sessionId: snapshot.sessionId, card: buildLaneSetupCard(snapshot, deps.now().getTime()) });
    } catch (error) {
      deps.logger.warn("chat_launch.card_emit_failed", { launchId: snapshot.launchId, error: getErrorMessage(error) });
    }
  };

  /** Emit the first card once the opening message lands (or after a short fallback). */
  const arm = (record: { snapshot: ChatLaunchSnapshot }): void => {
    const sessionId = record.snapshot.sessionId;
    if (!sessionId || deps.isDisposed()) return;
    const state = deps.stateFor(record.snapshot.launchId);
    if (state.cardEmitted || state.unsubscribeChat) return;
    const emitFirst = () => {
      if (state.cardEmitted) return;
      state.cardEmitted = true;
      state.unsubscribeChat?.();
      state.unsubscribeChat = null;
      if (state.cardTimer) clearTimeout(state.cardTimer);
      state.cardTimer = null;
      void sync(record);
    };
    state.unsubscribeChat = deps.agentChatService.subscribeToEvents((envelope) => {
      if (envelope.sessionId === sessionId && envelope.event.type === "user_message") emitFirst();
    });
    state.cardTimer = setTimeout(emitFirst, CARD_FALLBACK_DELAY_MS);
    state.cardTimer.unref?.();
  };

  return { sync, arm };
}
