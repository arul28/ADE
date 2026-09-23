import type { AdeTurnUsageAmendment, AdeTurnUsageRecord, AgentChatPlanUsage } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { evictOldestEntries, evictOldestSetEntries, getErrorMessage } from "../shared/utils";
import {
  CURSOR_DASHBOARD_RECONCILE_DELAYS_MS,
  CURSOR_TURN_START_SKEW_MS,
  cursorDashboardEventKey,
  cursorDashboardUsageEnabled,
  fetchCursorDashboardUsageEvents,
  selectCursorTurnEvents,
  summarizeCursorTurnEvents,
  type CursorDashboardFetchResult,
} from "./cursorDashboardUsage";
import { fetchFactorySessionCredits } from "./extraProviderQuota";
import { apiEquivalentTurnUsd, type TurnUsageLedger } from "./turnUsageLedger";

/**
 * Follow-ups that correct a ledger row after the turn ended, from a provider
 * record that is written some time after the turn: Cursor's dashboard usage
 * events and Factory's per-session credits. They run on timers, off the chat
 * path, and a failure only leaves the row as the turn wrote it.
 */

type Schedule = (run: () => void, delayMs: number) => void;

const defaultSchedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
};

/** A Cursor event may land a little after the turn's `done`. */
const CURSOR_TURN_END_GRACE_MS = 60_000;
const MAX_SEEN_CURSOR_EVENT_KEYS = 4_096;
const MAX_FACTORY_SESSIONS = 1_024;
/** Factory writes a session's credits a moment after the Droid turn ends. */
const FACTORY_CREDITS_DELAY_MS = 15_000;

/** What the follow-ups remember between turns. One per ledger, so two ADE homes never share it. */
type ReconcilerState = {
  /** Dashboard events already written onto a turn. */
  seenCursorEventKeys: Set<string>;
  /** Factory credits each Droid session had used at its last known turn, by Droid session id. */
  factoryCreditTotals: Map<string, number>;
  /** The newest pending Factory read per Droid session; the next read waits for it. */
  factoryReads: Map<string, Promise<void>>;
};

let reconcilerStates = new WeakMap<object, ReconcilerState>();

function reconcilerState(ledger: object): ReconcilerState {
  let state = reconcilerStates.get(ledger);
  if (!state) {
    state = { seenCursorEventKeys: new Set(), factoryCreditTotals: new Map(), factoryReads: new Map() };
    reconcilerStates.set(ledger, state);
  }
  return state;
}

function mergePlanUsage(existing: AgentChatPlanUsage[] | null | undefined, next: AgentChatPlanUsage): AgentChatPlanUsage[] {
  return [...(existing ?? []).filter((entry) => entry.unit !== next.unit), next];
}

export type CursorDashboardReconcileArgs = {
  ledger: Pick<TurnUsageLedger, "amend">;
  record: AdeTurnUsageRecord;
  /** The Cursor SDK agent id, which Cursor's dashboard calls `conversationId`. */
  agentId: string;
  /**
   * When the session's next turn started after `afterMs`, if it did (the
   * ledger's `nextTurnStartAfter` for this session). Read at every attempt, so
   * a turn that started after this one settled still bounds its window.
   */
  nextTurnStartAfter?: ((afterMs: number) => number | null) | null;
  logger?: Pick<Logger, "info" | "warn"> | null;
  fetchEvents?: (args: { startMs: number; endMs: number }) => Promise<CursorDashboardFetchResult>;
  schedule?: Schedule;
  delaysMs?: readonly number[];
  nowMs?: () => number;
};

/**
 * Re-reads Cursor's dashboard after a Cursor turn and, at the first attempt
 * that finds the turn's events, writes the served model, Cursor's charge, and
 * the request count onto the ledger row. The events are matched by agent id
 * and by the turn's time span, and each event is used once. The span ends at
 * the grace period after `done` or just before the session's next turn,
 * whichever is first.
 */
export function scheduleCursorDashboardReconcile(args: CursorDashboardReconcileArgs): void {
  const agentId = args.agentId.trim();
  if (!agentId) return;
  const now = args.nowMs ?? Date.now;
  const schedule = args.schedule ?? defaultSchedule;
  const delays = args.delaysMs ?? CURSOR_DASHBOARD_RECONCILE_DELAYS_MS;
  const fetchEvents = args.fetchEvents ?? ((range) => fetchCursorDashboardUsageEvents(range));
  const endedAtMs = Date.parse(args.record.at);
  const startedAtMs = Date.parse(args.record.startedAt ?? "") || endedAtMs;
  if (!Number.isFinite(endedAtMs)) return;
  const state = reconcilerState(args.ledger);

  const latestEventMs = (): number => {
    const graceEndMs = endedAtMs + CURSOR_TURN_END_GRACE_MS;
    const nextTurnStartMs = args.nextTurnStartAfter?.(startedAtMs) ?? null;
    return nextTurnStartMs == null ? graceEndMs : Math.min(graceEndMs, nextTurnStartMs - 1);
  };

  const attempt = async (index: number): Promise<void> => {
    const result = await fetchEvents({ startMs: startedAtMs - CURSOR_TURN_START_SKEW_MS, endMs: now() });
    if (!result.ok) {
      // `no_token` means no usable Cursor desktop login on this machine: nothing to retry.
      if (result.reason !== "no_token") {
        args.logger?.warn("usage.cursor_dashboard_reconcile_failed", {
          reason: result.reason,
          status: result.status ?? null,
          attempt: index + 1,
        });
      }
      return;
    }
    const upperMs = latestEventMs();
    const events = selectCursorTurnEvents(result.events, {
      agentId,
      turnStartedAtMs: startedAtMs,
      seenKeys: state.seenCursorEventKeys,
    }).filter((event) => event.timestampMs <= upperMs);
    const summary = summarizeCursorTurnEvents(events);
    if (!summary) {
      if (index + 1 < delays.length) schedule(() => run(index + 1), delays[index + 1]! - delays[index]!);
      return;
    }
    for (const key of summary.eventKeys) state.seenCursorEventKeys.add(key);
    evictOldestSetEntries(state.seenCursorEventKeys, MAX_SEEN_CURSOR_EVENT_KEYS);
    const split = {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheReadTokens: summary.cacheReadTokens,
      cacheWriteTokens: summary.cacheWriteTokens,
      // Cursor's events have no reasoning line; the row keeps its own count.
      reasoningTokens: args.record.reasoningTokens,
    };
    const patch: AdeTurnUsageAmendment["patch"] = {
      usageConfidence: "measured",
      inputTokens: split.inputTokens,
      outputTokens: split.outputTokens,
      cacheReadTokens: split.cacheReadTokens,
      cacheWriteTokens: split.cacheWriteTokens,
      // The dashboard's tokens and served model replace the turn's own, so the
      // list price is worked out again from them. The turn wrote it from the
      // requested model, which for an "auto" turn has no list price at all.
      apiEquivalentUsd: apiEquivalentTurnUsd(
        summary.servedModel ?? args.record.servedModel ?? args.record.requestedModel,
        split,
        {
          contextTokens: args.record.contextTokens,
          cacheWrite1hTokens: args.record.cacheWrite1hTokens,
          timestampMs: endedAtMs,
          provider: args.record.provider,
        },
      ),
    };
    if (summary.servedModel) patch.servedModel = summary.servedModel;
    if (summary.costUsd != null) {
      patch.costUsd = summary.costUsd;
      patch.costSource = "provider";
    }
    if (summary.requests != null) {
      patch.planUsage = mergePlanUsage(args.record.planUsage, { unit: "cursor_request", amount: summary.requests });
    }
    args.ledger.amend(args.record.key, "cursor_dashboard", patch);
    args.logger?.info("usage.cursor_dashboard_reconciled", {
      sessionId: args.record.sessionId,
      turnId: args.record.turnId,
      events: events.length,
      servedModel: summary.servedModel,
      attempt: index + 1,
      eventKey: events.length ? cursorDashboardEventKey(events[0]!) : null,
    });
  };

  // Every attempt, not only the first, logs a thrown fetch instead of leaving an unhandled rejection.
  function run(index: number): void {
    void attempt(index).catch((error) => {
      args.logger?.warn("usage.cursor_dashboard_reconcile_failed", {
        reason: "exception",
        error: getErrorMessage(error),
        attempt: index + 1,
      });
    });
  }

  schedule(() => run(0), delays[0] ?? 0);
}

export type FactoryCreditsReconcileArgs = {
  ledger: Pick<TurnUsageLedger, "amend">;
  record: AdeTurnUsageRecord;
  droidSessionId: string;
  logger?: Pick<Logger, "warn"> | null;
  fetchCredits?: (sessionId: string) => Promise<number | null>;
  schedule?: Schedule;
  delayMs?: number;
};

/**
 * Reads the Droid session's Factory credits after a Droid turn and writes the
 * running total onto the turn's row. When this brain saw the session's
 * previous total, the difference goes on the row as the turn's own
 * `factory_credit` plan usage. With no Factory key, the read returns at once.
 * One session's reads run one after another, so a slow earlier read can never
 * replace a newer total.
 */
export function scheduleFactoryCreditsReconcile(args: FactoryCreditsReconcileArgs): void {
  const sessionId = args.droidSessionId.trim();
  if (!sessionId) return;
  const schedule = args.schedule ?? defaultSchedule;
  const fetchCredits = args.fetchCredits ?? ((id: string) => fetchFactorySessionCredits(id));
  const state = reconcilerState(args.ledger);

  const read = async (): Promise<void> => {
    const total = await fetchCredits(sessionId);
    if (total == null) return;
    const previous = state.factoryCreditTotals.get(sessionId);
    state.factoryCreditTotals.delete(sessionId);
    state.factoryCreditTotals.set(sessionId, total);
    evictOldestEntries(state.factoryCreditTotals, MAX_FACTORY_SESSIONS);
    const patch: AdeTurnUsageAmendment["patch"] = { factoryCreditsSessionTotal: total };
    if (previous != null && total >= previous) {
      patch.planUsage = mergePlanUsage(args.record.planUsage, {
        unit: "factory_credit",
        amount: Math.round((total - previous) * 10_000) / 10_000,
      });
    }
    args.ledger.amend(args.record.key, "factory_sessions", patch);
  };

  schedule(() => {
    const earlier = state.factoryReads.get(sessionId) ?? Promise.resolve();
    const pending = earlier.then(read).catch((error) => {
      args.logger?.warn("usage.factory_credits_reconcile_failed", { error: getErrorMessage(error) });
    });
    state.factoryReads.set(sessionId, pending);
    void pending.finally(() => {
      if (state.factoryReads.get(sessionId) === pending) state.factoryReads.delete(sessionId);
    });
  }, args.delayMs ?? FACTORY_CREDITS_DELAY_MS);
}

/**
 * Starts every provider follow-up a settled turn needs. The chat service calls
 * this once per ledger row and names only the provider handles it holds.
 */
export function scheduleTurnUsageFollowUps(args: {
  ledger: Pick<TurnUsageLedger, "amend" | "nextTurnStartAfter">;
  record: AdeTurnUsageRecord;
  cursorAgentId?: string | null;
  droidSessionId?: string | null;
  logger?: Pick<Logger, "info" | "warn"> | null;
}): void {
  if (args.cursorAgentId && cursorDashboardUsageEnabled()) {
    scheduleCursorDashboardReconcile({
      ledger: args.ledger,
      record: args.record,
      agentId: args.cursorAgentId,
      nextTurnStartAfter: (afterMs) => args.ledger.nextTurnStartAfter(args.record.sessionId, afterMs),
      logger: args.logger,
    });
  }
  if (args.droidSessionId) {
    scheduleFactoryCreditsReconcile({
      ledger: args.ledger,
      record: args.record,
      droidSessionId: args.droidSessionId,
      logger: args.logger,
    });
  }
}

export const _testing = {
  resetReconcilerState(): void {
    reconcilerStates = new WeakMap();
  },
};
