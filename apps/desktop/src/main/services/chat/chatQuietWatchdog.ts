import { CODEX_COMPACTION_STALL_MS } from "./codexAppServerFeatures";

/**
 * The one "agent has gone quiet" watchdog every chat provider shares.
 *
 * It watches a running turn and says when the agent has produced nothing for
 * too long: no first event after the turn started, or no activity for a long
 * stretch mid-turn. What it does then is only `onQuiet` — in the chat service
 * that posts the "<Provider> hasn't answered in N minutes — Restart / Keep
 * waiting" card. The watchdog itself never resends, never restarts, and never
 * starts a provider's queue: every way out is the user's.
 *
 * Fed by the chat's own event stream (`observe` from `emitChatEvent`), so a
 * provider gets it by emitting the events every provider already emits:
 * `status: started` arms it, any agent output counts as activity (not ADE's
 * own `activity` placeholder or notices), `done` or a terminal `status` ends
 * it. A provider with a better signal than its emitted
 * events (Codex's raw app-server notifications) can also call `activity`.
 *
 * A compaction counts as activity: while one is open the turn is waiting on
 * it, so the quiet budget is the compaction's (`compactionMs`) rather than the
 * mid-turn one, and its end starts a fresh mid-turn budget.
 *
 * One `setTimeout` per watched chat, re-armed on activity at most once a
 * second (a streamed reply emits hundreds of deltas a second and must not
 * churn timers). No polling.
 */

export type QuietPhase = "first_event" | "mid_turn" | "compaction";

export type QuietThresholds = {
  /** Turn started, nothing from the agent yet. */
  firstEventMs: number;
  /** The agent did something, then went silent. */
  midTurnMs: number;
  /** A compaction is open and silent. */
  compactionMs: number;
};

/** Every provider's budget unless it has a genuine reason for its own. */
export const DEFAULT_QUIET_THRESHOLDS: QuietThresholds = {
  firstEventMs: 120_000,
  midTurnMs: 10 * 60_000,
  compactionMs: 10 * 60_000,
};

/**
 * Per-provider differences, only where genuinely needed:
 * - Codex fails a compaction that has been silent for 3 minutes (its
 *   app-server can drop the compaction's end).
 * - Cursor's SDK either streams within 90 s or has wedged its thread.
 */
export const PROVIDER_QUIET_THRESHOLDS: Readonly<Record<string, Partial<QuietThresholds>>> = {
  codex: { compactionMs: CODEX_COMPACTION_STALL_MS },
  cursor: { firstEventMs: 90_000 },
};

export function quietThresholdsFor(provider: string | null | undefined): QuietThresholds {
  const key = (provider ?? "").trim().toLowerCase();
  return { ...DEFAULT_QUIET_THRESHOLDS, ...(PROVIDER_QUIET_THRESHOLDS[key] ?? {}) };
}

export type QuietWatch = {
  sessionId: string;
  provider: string;
  turnId: string;
  phase: QuietPhase;
  /** When the turn started (or the watch was armed). */
  startedAt: number;
  /** The last activity (or arm / Keep waiting). */
  lastActivityAt: number;
  /** True once the agent produced anything this turn. */
  sawActivity: boolean;
  /** Open compactions (item ids, or "compaction" when the provider names none). */
  openCompactions: Set<string>;
};

export type QuietInfo = Readonly<Omit<QuietWatch, "openCompactions">> & {
  silentMs: number;
  thresholdMs: number;
};

/**
 * The event shape the watchdog reads (a subset of `AgentChatEvent`, kept loose
 * so this module does not depend on the full event union).
 */
export type QuietObservedEvent = { type: string; [key: string]: unknown };

/**
 * Events that are not the agent working: what the user or ADE wrote, ADE's
 * own notices and cards, and turn boundaries (handled separately).
 */
const NOT_AGENT_ACTIVITY: ReadonlySet<string> = new Set([
  "user_message",
  "user_message_resolution",
  "system_notice",
  "turn_health",
  "turn_recovery",
  "codex_turn_stalled",
  "codex_turn_recovery",
  "status",
  "done",
  "error",
  "notice",
  "mcp_startup_status",
  "provider_health",
]);

const COMPACTION_EVENTS: ReadonlySet<string> = new Set(["context_compact", "codex_context_compaction"]);

export type ChatQuietWatchdog = ReturnType<typeof createChatQuietWatchdog>;

export function createChatQuietWatchdog(options: {
  /** The watch went quiet past its budget. The watch is disarmed first; call `keepWaiting` to watch again. */
  onQuiet: (info: QuietInfo) => void;
  thresholdsFor?: (provider: string) => QuietThresholds;
  now?: () => number;
  /** Re-arming on activity is throttled to this (ms). */
  rearmGranularityMs?: number;
}) {
  const now = options.now ?? Date.now;
  const thresholdsFor = options.thresholdsFor ?? quietThresholdsFor;
  const granularity = options.rearmGranularityMs ?? 1_000;
  const watches = new Map<string, QuietWatch & { timer: ReturnType<typeof setTimeout> | null; dueAt: number }>();

  const thresholdOf = (watch: QuietWatch): number => {
    const thresholds = thresholdsFor(watch.provider);
    if (watch.openCompactions.size > 0) return thresholds.compactionMs;
    return watch.sawActivity ? thresholds.midTurnMs : thresholds.firstEventMs;
  };

  const phaseOf = (watch: QuietWatch): QuietPhase =>
    watch.openCompactions.size > 0 ? "compaction" : watch.sawActivity ? "mid_turn" : "first_event";

  const schedule = (sessionId: string): void => {
    const watch = watches.get(sessionId);
    if (!watch) return;
    watch.phase = phaseOf(watch);
    const dueAt = watch.lastActivityAt + thresholdOf(watch);
    // A timer due at (about) the same moment is already right.
    if (watch.timer && Math.abs(watch.dueAt - dueAt) < granularity) return;
    if (watch.timer) clearTimeout(watch.timer);
    watch.dueAt = dueAt;
    const timer = setTimeout(() => fire(sessionId, timer), Math.max(1, dueAt - now()));
    (timer as { unref?: () => void }).unref?.();
    watch.timer = timer;
  };

  const fire = (sessionId: string, timer: ReturnType<typeof setTimeout>): void => {
    const watch = watches.get(sessionId);
    if (!watch || watch.timer !== timer) return;
    watch.timer = null;
    const at = now();
    const thresholdMs = thresholdOf(watch);
    // Activity moved the deadline after this timer was set (throttled re-arm).
    if (at < watch.lastActivityAt + thresholdMs - granularity) {
      schedule(sessionId);
      return;
    }
    const { openCompactions: _open, timer: _timer, dueAt: _due, ...rest } = watch;
    options.onQuiet({ ...rest, phase: phaseOf(watch), silentMs: at - watch.lastActivityAt, thresholdMs });
  };

  const arm = (args: { sessionId: string; provider: string; turnId: string; startedAt?: number }): void => {
    const existing = watches.get(args.sessionId);
    if (existing?.turnId === args.turnId) return;
    if (existing?.timer) clearTimeout(existing.timer);
    const at = args.startedAt ?? now();
    watches.set(args.sessionId, {
      sessionId: args.sessionId,
      provider: args.provider,
      turnId: args.turnId,
      phase: "first_event",
      startedAt: at,
      lastActivityAt: at,
      sawActivity: false,
      openCompactions: new Set(),
      timer: null,
      dueAt: 0,
    });
    schedule(args.sessionId);
  };

  /** The watched turn did something. A foreign turn id is ignored. */
  const activity = (sessionId: string, turnId?: string | null): void => {
    const watch = watches.get(sessionId);
    if (!watch || (turnId && turnId !== watch.turnId)) return;
    watch.sawActivity = true;
    watch.lastActivityAt = now();
    schedule(sessionId);
  };

  const compaction = (sessionId: string, state: "open" | "closed", itemId?: string | null, turnId?: string | null): void => {
    const watch = watches.get(sessionId);
    if (!watch || (turnId && turnId !== watch.turnId)) return;
    const key = itemId?.trim() || "compaction";
    if (state === "open") watch.openCompactions.add(key);
    else if (itemId?.trim()) watch.openCompactions.delete(key);
    else watch.openCompactions.clear();
    watch.sawActivity = true;
    watch.lastActivityAt = now();
    schedule(sessionId);
  };

  /** The turn ended (or is no longer watched). With a turn id, only that turn's watch. */
  const clear = (sessionId: string, turnId?: string | null): void => {
    const watch = watches.get(sessionId);
    if (!watch || (turnId && turnId !== watch.turnId)) return;
    if (watch.timer) clearTimeout(watch.timer);
    watches.delete(sessionId);
  };

  /**
   * "Keep waiting", or a silence the provider explained (an open command, a
   * pending approval): watch the same turn again from now, same phase.
   */
  const keepWaiting = (sessionId: string, turnId: string): boolean => {
    const watch = watches.get(sessionId);
    if (!watch || watch.turnId !== turnId) return false;
    watch.lastActivityAt = now();
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    schedule(sessionId);
    return true;
  };

  /** Feed one chat event. Returns nothing; the watchdog decides from the event alone. */
  const observe = (sessionId: string, provider: string, event: QuietObservedEvent): void => {
    const turnId = typeof event.turnId === "string" && event.turnId.length ? event.turnId : null;
    if (event.type === "status") {
      if (event.turnStatus === "started") {
        if (turnId) arm({ sessionId, provider, turnId });
      } else {
        clear(sessionId, turnId);
      }
      return;
    }
    if (event.type === "done") {
      clear(sessionId, turnId);
      return;
    }
    if (COMPACTION_EVENTS.has(event.type)) {
      const state = event.state;
      const itemId = typeof event.compactionId === "string"
        ? event.compactionId
        : typeof event.itemId === "string" ? event.itemId : null;
      if (state === "started") compaction(sessionId, "open", itemId, turnId);
      else if (state === "completed" || state === "failed" || state === undefined) compaction(sessionId, "closed", itemId, turnId);
      else activity(sessionId, turnId);
      return;
    }
    if (NOT_AGENT_ACTIVITY.has(event.type)) return;
    // ADE posts `activity: thinking/working` itself the moment a turn starts,
    // so it is not the agent answering. A provider retry or reconnect is.
    if (event.type === "activity" && event.providerRetry !== true) return;
    activity(sessionId, turnId);
  };

  return {
    arm,
    activity,
    compaction,
    clear,
    keepWaiting,
    observe,
    get: (sessionId: string): QuietInfo | null => {
      const watch = watches.get(sessionId);
      if (!watch) return null;
      const { openCompactions: _open, timer: _timer, dueAt: _due, ...rest } = watch;
      return { ...rest, phase: phaseOf(watch), silentMs: now() - watch.lastActivityAt, thresholdMs: thresholdOf(watch) };
    },
    dispose: (): void => {
      for (const watch of watches.values()) if (watch.timer) clearTimeout(watch.timer);
      watches.clear();
    },
  };
}

/** "2 minutes" for the card: whole minutes, never under one. */
export function formatQuietMinutes(silentMs: number): string {
  const minutes = Math.max(1, Math.round(silentMs / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
