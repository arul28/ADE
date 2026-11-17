/**
 * Waits until a chat has no running turn, for a message that must go only
 * to an idle chat (Claude takes a send during a turn and then fails that
 * turn). It listens for the chat's `done` event and reads the chat's state
 * only then, never on a timer: one read at the start, one short settle read
 * (a turn just accepted shows as active a moment later), and one read per
 * turn end.
 */

import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types";

export type IdleWaitChat = {
  getSessionSummary: (sessionId: string) => Promise<{ status?: string | null } | null>;
  subscribeToEvents: (listener: (envelope: AgentChatEventEnvelope) => void) => () => void;
};

/** The longest wait; false then (the turn still runs, and the message waits for a later round). */
export const CHAT_IDLE_WAIT_MS = 30 * 60_000;
/** A turn that a send just started shows as active within this time. */
const SETTLE_MS = 3_000;

/** True when the chat is idle (or gone, so the send itself says so); false at `limitMs`. */
export async function waitForChatIdleByEvents(
  chat: IdleWaitChat,
  sessionId: string,
  options: { limitMs?: number; settleMs?: number } = {},
): Promise<boolean> {
  const limitMs = options.limitMs ?? CHAT_IDLE_WAIT_MS;
  const settleMs = options.settleMs ?? SETTLE_MS;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let checking = false;
    let checkAgain = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const finish = (idle: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
      resolve(idle);
    };
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timer.unref?.();
      timers.add(timer);
    };
    const active = async (): Promise<boolean> => {
      const summary = await chat.getSessionSummary(sessionId).catch(() => null);
      return summary?.status === "active";
    };
    /** Idle twice, `settleMs` apart: a turn that was only about to start shows by the second read. */
    const check = async () => {
      if (settled) return;
      if (checking) {
        checkAgain = true;
        return;
      }
      checking = true;
      try {
        do {
          checkAgain = false;
          if (await active()) continue;
          await new Promise<void>((done) => later(settleMs, done));
          if (!(await active())) {
            finish(true);
            return;
          }
        } while (checkAgain && !settled);
      } finally {
        checking = false;
      }
    };
    const unsubscribe = chat.subscribeToEvents((envelope) => {
      if (envelope.sessionId === sessionId && envelope.event.type === "done") void check();
    });
    later(limitMs, () => finish(false));
    void check();
  });
}
