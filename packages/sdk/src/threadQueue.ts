import type { AgentChatEventEnvelope, AgentChatFileRef } from "./types.js";

/** One message waiting in a thread's queue. */
export type ThreadQueueItem = {
  id: string;
  text: string;
  attachments?: AgentChatFileRef[];
};

/**
 * The thread's queued messages, in order, folded from its event history with
 * the same rules ADE's own composer uses (`chatRuntimeState.ts`), so an SDK host
 * and ADE never disagree about what is still waiting.
 */
export function pendingQueue(events: readonly AgentChatEventEnvelope[]): ThreadQueueItem[] {
  const queued = new Map<string, ThreadQueueItem>();
  const settled = new Set<string>();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "user_message" && typeof event.steerId === "string" && event.steerId) {
      if (event.deliveryState === "queued") {
        if (!settled.has(event.steerId)) queued.set(event.steerId, {
          id: event.steerId,
          text: typeof event.displayText === "string" ? event.displayText : String(event.text ?? ""),
          ...(Array.isArray(event.attachments) ? { attachments: event.attachments as AgentChatFileRef[] } : {}),
        });
      } else {
        queued.delete(event.steerId);
        // The same rule as ADE's own queue (`isSettledSteerDeliveryState`):
        // `accepted` is not final, because a Cursor or OpenCode turn can
        // refuse an inline steer and the same steerId comes back `queued`.
        if (event.deliveryState !== "accepted") settled.add(event.steerId);
      }
    } else if (event.type === "queue_reordered" && Array.isArray(event.steerIds)) {
      const reordered = new Map<string, ThreadQueueItem>();
      for (const id of event.steerIds) if (typeof id === "string" && queued.has(id)) reordered.set(id, queued.get(id)!);
      for (const [id, entry] of queued) if (!reordered.has(id)) reordered.set(id, entry);
      queued.clear();
      for (const [id, entry] of reordered) queued.set(id, entry);
    } else if (event.type === "user_message_resolution" && typeof event.steerId === "string") {
      queued.delete(event.steerId);
      settled.add(event.steerId);
    } else if (event.type === "system_notice" && typeof event.steerId === "string" && typeof event.message === "string" && /cancelled|delivering/i.test(event.message)) {
      // ADE's own queue resolves a steer on exactly these two notices.
      queued.delete(event.steerId);
      settled.add(event.steerId);
    } else if (event.type === "command_lifecycle" && typeof event.steerId === "string" && event.status !== "queued") {
      queued.delete(event.steerId);
      settled.add(event.steerId);
    } else if (event.type === "queue_recovery" && event.state === "restored" && Array.isArray(event.restoredSteers)) {
      // A restored queue comes back with its messages, after their earlier
      // cancellation settled them.
      for (const steer of event.restoredSteers as Array<{ steerId?: unknown; text?: unknown; attachments?: unknown }>) {
        if (typeof steer.steerId !== "string" || !steer.steerId) continue;
        settled.delete(steer.steerId);
        queued.set(steer.steerId, {
          id: steer.steerId,
          text: typeof steer.text === "string" ? steer.text : "",
          ...(Array.isArray(steer.attachments) ? { attachments: steer.attachments as AgentChatFileRef[] } : {}),
        });
      }
    }
  }
  return [...queued.values()];
}

/** The newest cancelled queue that can still be restored, or null. */
export function restorableQueueId(events: readonly AgentChatEventEnvelope[]): string | null {
  const recovery = [...events].reverse().find(({ event }) =>
    event.type === "queue_recovery" && event.state === "available" && typeof event.recoveryId === "string",
  );
  const recoveryId = recovery?.event.recoveryId;
  return typeof recoveryId === "string" ? recoveryId : null;
}
