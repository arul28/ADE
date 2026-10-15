// ---------------------------------------------------------------------------
// Claude Code's own idle compaction, kept by ADE.
//
// Claude Code compacts a big chat 54 minutes into its one-hour prompt cache,
// while the cache is still warm and the compaction reads the chat at the cached
// price. ADE closes an idle Claude process after five minutes, so Claude's own
// timer never fires here. With "Always compact first" ADE keeps the timer
// instead: one per chat, set when a turn ends, cleared when the next starts.
// A chat the timer misses compacts on its next send, as before.
//
// The rule for when (`warmIdleCompactAtMs`) is pure and lives in
// `shared/compactFirst`; this module is the bookkeeping that turns it into a
// `/compact` turn. It is separate from `agentChatService` because it needs only
// the few things below from that service.
// ---------------------------------------------------------------------------

import { getErrorMessage } from "../shared/utils";

/** Claude skips a timer that fired this late (a machine that slept): the cache may be gone. */
const WARM_IDLE_COMPACT_MAX_LATE_MS = 60_000;

export type WarmIdleCompactionSchedulerOptions<TChat> = {
  sessionIdOf: (chat: TChat) => string;
  /** When this chat should compact, or null when it should not (`warmIdleCompactAtMs`). */
  compactAt: (chat: TChat) => Promise<number | null>;
  /** True when nothing is running or waiting on the person, the same check a Compact first send makes. */
  isIdle: (chat: TChat) => boolean;
  /** Runs `/compact` as its own turn. */
  compact: (chat: TChat) => Promise<unknown>;
  logger: {
    info: (event: string, meta?: Record<string, unknown>) => void;
    warn: (event: string, meta?: Record<string, unknown>) => void;
  };
};

export type WarmIdleCompactionScheduler<TChat> = {
  /** After a turn ends: replace this chat's timer with one for its new state. */
  schedule: (chat: TChat) => Promise<void>;
  /** When a turn starts, or the chat is archived, deleted or ended. */
  clear: (sessionId: string) => void;
  dispose: () => void;
};

export function createWarmIdleCompactionScheduler<TChat>(
  options: WarmIdleCompactionSchedulerOptions<TChat>,
): WarmIdleCompactionScheduler<TChat> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Each chat's live claim, unique across chats and time. A schedule or a fire
  // that awaited history acts only if its claim is still the chat's: a clear
  // (a turn started, the chat was put away) or a later schedule replaced it.
  // One number per chat until its next clear, schedule or dispose.
  const claims = new Map<string, number>();
  let lastClaim = 0;
  const claim = (sessionId: string): number => {
    const next = ++lastClaim;
    claims.set(sessionId, next);
    return next;
  };

  const clear = (sessionId: string): void => {
    claims.delete(sessionId);
    const timer = timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(sessionId);
  };

  const fire = async (chat: TChat, fireAt: number, held: number): Promise<void> => {
    const sessionId = options.sessionIdOf(chat);
    timers.delete(sessionId);
    if (Date.now() - fireAt > WARM_IDLE_COMPACT_MAX_LATE_MS) return;
    // The same schedule read again: no turn since, same cache, still big.
    const stillDue = (await options.compactAt(chat)) === fireAt;
    if (!stillDue || claims.get(sessionId) !== held || !options.isIdle(chat)) return;
    options.logger.info("agent_chat.warm_idle_compaction", { sessionId });
    try {
      await options.compact(chat);
    } catch (error) {
      options.logger.warn("agent_chat.warm_idle_compaction_failed", { sessionId, error: getErrorMessage(error) });
    }
  };

  const schedule = async (chat: TChat): Promise<void> => {
    const sessionId = options.sessionIdOf(chat);
    clear(sessionId);
    const held = claim(sessionId);
    try {
      const fireAt = await options.compactAt(chat);
      if (fireAt == null || claims.get(sessionId) !== held) return;
      const timer = setTimeout(() => void fire(chat, fireAt, held), Math.max(0, fireAt - Date.now()));
      timer.unref?.();
      timers.set(sessionId, timer);
    } catch (error) {
      options.logger.warn("agent_chat.warm_idle_compaction_schedule_failed", { sessionId, error: getErrorMessage(error) });
    }
  };

  const dispose = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    claims.clear();
  };

  return { schedule, clear, dispose };
}
