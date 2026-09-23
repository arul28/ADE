import type { AgentChatSendArgs, ChatLaunchQueueMessageArgs } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import type { ChatLaunchRecord as LaunchRecord } from "./chatLaunchRecords";

/**
 * Delivery of the messages a user typed while a launch's lane was still being
 * set up. Split out of `chatLaunchService.ts`; the per-launch state lives on the
 * service's launch runtime so dispose/cancel can clear it in one place.
 */

export type QueuedDeliveryState = {
  /** The in-flight queued-message delivery. */
  delivery: Promise<void> | null;
  deliveryAttempts: number;
  deliveryTimer: ReturnType<typeof setTimeout> | null;
};

/** `ensureManagedSession`'s wording when the chat no longer exists. */
const CHAT_SESSION_GONE_PATTERN = /Chat session '[^']*' was not found|is not an agent chat session/;
/** Automatic re-delivery attempts for a queued message after its first send failed (queueMessage retries too). */
const QUEUED_DELIVERY_BACKOFF_MS = [2_000, 10_000, 30_000];

export function createQueuedMessageDelivery(deps: {
  logger: Logger;
  sendMessage(args: AgentChatSendArgs, options: { awaitDispatch?: boolean; routeActiveToSteer: true }): Promise<unknown>;
  stateFor: (launchId: string) => QueuedDeliveryState;
  publish: (record: LaunchRecord) => void;
  isDisposed: () => boolean;
}) {
  const send = (
    sessionId: string,
    message: Pick<ChatLaunchQueueMessageArgs, "text" | "displayText" | "attachments">,
  ): Promise<unknown> => deps.sendMessage(
    {
      sessionId,
      text: message.text,
      ...(message.displayText ? { displayText: message.displayText } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    },
    { awaitDispatch: false, routeActiveToSteer: true },
  );

  /**
   * Deliver queued messages in order. A failed send keeps the message (with
   * `deliveryError` set so clients can show it), stops the queue so order is
   * preserved, and retries on a bounded backoff — and again on every
   * queueMessage. Messages are never dropped.
   */
  const deliver = (record: LaunchRecord): Promise<void> => {
    const state = deps.stateFor(record.snapshot.launchId);
    if (state.delivery) return state.delivery;
    if (state.deliveryTimer) {
      clearTimeout(state.deliveryTimer);
      state.deliveryTimer = null;
    }
    const run = (async () => {
      const sessionId = record.snapshot.sessionId;
      if (!sessionId) return;
      while (record.snapshot.queuedMessages.length > 0 && record.snapshot.phase !== "cancelled" && !deps.isDisposed()) {
        const next = record.snapshot.queuedMessages[0]!;
        try {
          await send(sessionId, next);
        } catch (error) {
          const message = getErrorMessage(error);
          deps.logger.warn("chat_launch.queued_message_failed", { launchId: record.snapshot.launchId, attempt: state.deliveryAttempts, error: message });
          if (CHAT_SESSION_GONE_PATTERN.test(message)) {
            // The chat itself is gone (deleted after it started): nothing can
            // ever deliver these, so say so once and let the launch expire
            // instead of pinning it and every later send behind a dead head.
            const undelivered = record.snapshot.queuedMessages.length;
            record.snapshot.queuedMessages = [];
            record.snapshot.error = `The chat was deleted before ${undelivered === 1 ? "a queued message" : `${undelivered} queued messages`} could be sent.`;
            deps.publish(record);
            return;
          }
          next.deliveryError = message;
          deps.publish(record);
          const backoff = QUEUED_DELIVERY_BACKOFF_MS[state.deliveryAttempts];
          state.deliveryAttempts += 1;
          if (backoff != null && !deps.isDisposed()) {
            state.deliveryTimer = setTimeout(() => {
              state.deliveryTimer = null;
              void deliver(record);
            }, backoff);
            state.deliveryTimer.unref?.();
          }
          return;
        }
        state.deliveryAttempts = 0;
        record.snapshot.queuedMessages.shift();
        deps.publish(record);
      }
    })();
    state.delivery = run;
    void run.finally(() => {
      if (state.delivery === run) state.delivery = null;
    });
    return run;
  };

  return { send, deliver };
}
