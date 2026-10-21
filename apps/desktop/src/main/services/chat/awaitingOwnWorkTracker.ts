import type { Logger } from "../logging/logger";

export type AwaitingOwnWorkTracker = {
  /** Record (an ISO time) or clear (null) the marker; a no-op when nothing changes. */
  set: (sessionId: string, at: string | null) => void;
  /** The session summary's field: `{ awaitingOwnWorkAt }` while marked, else nothing. */
  summaryFields: (sessionId: string) => { awaitingOwnWorkAt?: string };
};

/**
 * Chats whose last reply Jev read as waiting on their own work, and when.
 * Live only: a restart stops that work too. Read by the session summary, so
 * every change tells the Work list to read it again.
 */
export function createAwaitingOwnWorkTracker(deps: {
  logger: Logger;
  onChanged: (sessionId: string) => void;
}): AwaitingOwnWorkTracker {
  const atBySession = new Map<string, string>();
  return {
    set(sessionId, at) {
      if (at ? atBySession.get(sessionId) === at : !atBySession.has(sessionId)) return;
      if (at) atBySession.set(sessionId, at);
      else atBySession.delete(sessionId);
      if (at) deps.logger.info("agent_chat.turn_end_awaiting_own_work", { sessionId });
      deps.onChanged(sessionId);
    },
    summaryFields(sessionId) {
      const at = atBySession.get(sessionId);
      return at !== undefined ? { awaitingOwnWorkAt: at } : {};
    },
  };
}
