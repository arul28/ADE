import {
  decideOrphanBackgroundTerminal,
  decideOrphanSubagentTerminal,
  deriveOrphanChildChatState,
  orphanRowChildSessionCandidate,
  type OrphanChildChatState,
  type OrphanStopAttribution,
} from "../../../shared/chatOrphanRunReconcile";
import { deriveBackgroundItems } from "../../../shared/chatScheduledWork";
import { subagentSnapshotsFromEvents } from "../../../shared/chatSubagents";
import type { ChatScheduledWorkSnapshot } from "../../../shared/chatScheduledWork";
import type { SubagentSnapshot } from "../../../shared/chatSubagents";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";

/**
 * The one place that turns "this chat's rows outlived the process that owned
 * them" into terminal events.
 *
 * Two callers reach the same rows: a chat somebody reopens (the restart
 * reconcile, which runs off `ensureClaudeSessionRuntime`) and a chat nobody
 * ever reopens (the timer sweep below). They used to be separate code with
 * separate verdicts and separate copy, so the same dead subagent read
 * differently depending on whether the owner happened to click it — and only
 * the sweep consulted the spawned child chat's own row. This module is that
 * code once: the decision comes from `shared/chatOrphanRunReconcile`, the
 * emission happens here, and the restart path keeps only what is genuinely
 * restart-specific (the system_notice and the unsettled parent turn).
 */

const STALE_RUN_SWEEP_INTERVAL_MS = 60 * 1000;
const STALE_RUN_SWEEP_START_DELAY_MS = 5 * 1000;
const STALE_RUN_SWEEP_SESSION_SCAN_LIMIT = 200;
/** Exported for the budget test: the per-pass work cap is the thing it proves. */
export const STALE_RUN_SWEEP_SESSIONS_PER_PASS = 8;
/**
 * How long a chat with a genuinely running delegate sits out.
 *
 * Such a chat can never be marked swept — its row still needs a terminal event
 * once the delegate stops — but re-reading its full transcript every minute
 * spends one of the eight per-pass slots forever, and a handful of them starves
 * every other chat behind them. Ten minutes is far shorter than the hours these
 * rows used to stay wrong, and long enough that the budget belongs to chats
 * that can actually be healed.
 */
const STALE_RUN_SWEEP_REVISIT_MS = 10 * 60 * 1000;

type ScheduledWorkEvent = Extract<AgentChatEvent, { type: "scheduled_work_update" }>;

/** All this module needs from a managed chat session. */
export type StaleRunSweepManagedSession = {
  session: { id: string };
  runtime: unknown;
  closed?: boolean;
};

/** The child-chat row fields the verdict reads, plus what the report comes from. */
export type StaleRunSweepChatRow = {
  id: string;
  status: "running" | "completed" | "failed" | "disposed" | "detached";
  endedAt?: string | null;
  lastTurnFailedAt?: string | null;
  summary?: string | null;
  statusNote?: string | null;
};

export type StaleRunSweepOutcome = {
  backgroundStopped: number;
  subagentsTerminalized: number;
  /** Delegates whose own chat is still alive — deliberately left running. */
  subagentsLeftRunning: number;
};

export type StaleRunSweepDeps<TManaged extends StaleRunSweepManagedSession> = {
  readFullTranscriptEnvelopesForSessionId: (sessionId: string) => AgentChatEventEnvelope[];
  /** Chat session ids this brain could sweep, newest first. */
  listChatSessionIds: (limit: number) => string[];
  /** One chat session row by id; null when it is gone or is not a chat. */
  getChatSessionRow: (sessionId: string) => StaleRunSweepChatRow | null;
  /**
   * True when the row's child is terminalized by another path — a tracked CLI
   * child, whose PTY exit reports its own result. The sweep leaves such a row
   * alone (the hook starts that path for an ended child) instead of reading
   * the missing chat row as "the subagent chat is gone".
   */
  deferChildTerminal?: (childSessionId: string) => boolean;
  /** Windows-safe liveness of the brain that owns a chat's runtime. */
  chatRuntimeOwnerLive: (sessionId: string) => boolean;
  /**
   * May this brain write to the chat? `quiet` suppresses the per-call warn:
   * the sweep re-probes every foreign chat on every pass, and this module
   * announces a foreign owner once per verdict change instead.
   */
  chatRuntimeAdoptable: (sessionId: string, options?: { quiet?: boolean }) => boolean;
  /** This brain's managed session when it already has one; never constructs. */
  peekManagedSession: (sessionId: string) => TManaged | undefined;
  ensureManagedSession: (sessionId: string) => TManaged;
  /** Ids of the chats this brain currently holds a runtime for. */
  liveRuntimeSessionIds: () => Iterable<string>;
  restartRecoveryStopAttribution: (sessionId: string) => OrphanStopAttribution;
  emitChatEvent: (managed: TManaged, event: AgentChatEvent) => void;
  /** Scheduled-work emission, so a live runtime's row bookkeeping stays in sync. */
  emitScheduledWorkUpdate: (managed: TManaged, event: ScheduledWorkEvent) => void;
  persistChatState: (managed: TManaged) => void;
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  /** Clock, injectable so the revisit delay is testable without real waiting. */
  now?: () => number;
};

export type StaleRunSweep<TManaged extends StaleRunSweepManagedSession> = {
  /**
   * Close every row in this chat that the event stream left running. The caller
   * owns the decision that the chat is reconcilable (no live runtime of its
   * own, adoptable) and may pass transcript envelopes it has already read.
   */
  terminalizeStaleRowsForSession: (
    managed: TManaged,
    attribution: OrphanStopAttribution,
    envelopes?: AgentChatEventEnvelope[],
  ) => StaleRunSweepOutcome;
  /** One sweep pass over the chats this brain may reconcile. */
  reconcileStaleRuns: () => void;
  /** Arm the start-up pass and the recurring timer. Idempotent. */
  start: () => void;
  dispose: () => void;
};

type StaleRows = {
  background: ChatScheduledWorkSnapshot[];
  subagents: SubagentSnapshot[];
};

function collectStaleRows(envelopes: AgentChatEventEnvelope[]): StaleRows {
  return {
    background: deriveBackgroundItems(envelopes).filter(
      (snapshot) => snapshot.status === "scheduled" || snapshot.status === "running",
    ),
    // An agent whose terminal result is already in the stream is not stale,
    // whatever a late progress echo did to its status: closing it again is
    // what stamped "stopped · the ADE brain restarted" on finished agents.
    subagents: subagentSnapshotsFromEvents(envelopes).filter(
      (snapshot) => snapshot.kind === "subagent"
        && snapshot.status === "running"
        && !snapshot.endedAt,
    ),
  };
}

const EMPTY_OUTCOME: StaleRunSweepOutcome = {
  backgroundStopped: 0,
  subagentsTerminalized: 0,
  subagentsLeftRunning: 0,
};

export function createStaleRunSweep<TManaged extends StaleRunSweepManagedSession>(
  deps: StaleRunSweepDeps<TManaged>,
): StaleRunSweep<TManaged> {
  const {
    readFullTranscriptEnvelopesForSessionId,
    listChatSessionIds,
    getChatSessionRow,
    deferChildTerminal,
    chatRuntimeOwnerLive,
    chatRuntimeAdoptable,
    peekManagedSession,
    ensureManagedSession,
    liveRuntimeSessionIds,
    restartRecoveryStopAttribution,
    emitChatEvent,
    emitScheduledWorkUpdate,
    persistChatState,
    logger,
  } = deps;
  const now = deps.now ?? (() => Date.now());

  /**
   * What this process already decided about a chat, one mark per session id:
   *
   * - `swept`: nothing left to close. Idempotent twice over — the mark is a
   *   fast path, and the emitted terminal events are themselves what a
   *   re-derivation reads, so a second pass (or another brain's) finds nothing.
   * - `revisit`: left running on purpose, not due again until `dueAt`. See
   *   `STALE_RUN_SWEEP_REVISIT_MS` for why such a chat sits out.
   * - `foreignAnnounced`: another live brain owns it and the warn already
   *   fired, so the per-pass re-probe stays quiet until the verdict changes.
   *
   * One map rather than three collections keyed the same way: a session has
   * exactly one of these states, and the size guard below can then measure the
   * thing it bounds.
   */
  type SweepMark =
    | { kind: "swept" }
    | { kind: "revisit"; dueAt: number }
    | { kind: "foreignAnnounced" };
  const SWEPT_MARK: SweepMark = { kind: "swept" };
  const FOREIGN_MARK: SweepMark = { kind: "foreignAnnounced" };
  const marks = new Map<string, SweepMark>();

  /** The spawned ADE chat behind a subagent row, when the row really is one. */
  const resolveOrphanChildChat = (
    parentSessionId: string,
    rowId: string,
  ): { state: OrphanChildChatState; report: string | null } | null => {
    const candidate = orphanRowChildSessionCandidate(rowId);
    if (!candidate || candidate === parentSessionId) return null;
    try {
      if (deferChildTerminal?.(candidate)) return { state: "active", report: null };
    } catch {
      // A failed deferral check falls through to the chat verdict.
    }
    let row: StaleRunSweepChatRow | null = null;
    try {
      row = getChatSessionRow(candidate);
    } catch {
      return null;
    }
    if (!row) {
      // Only a row that looked like a chat pointer earns the "gone" verdict; a
      // plain SDK task id is not a deleted chat.
      return rowId.trim().startsWith("chat:") ? { state: "missing", report: null } : null;
    }
    return {
      state: deriveOrphanChildChatState(row, chatRuntimeOwnerLive(row.id)),
      report: row.statusNote?.trim() || row.summary?.trim() || null,
    };
  };

  const emitStaleTerminals = (
    managed: TManaged,
    attribution: OrphanStopAttribution,
    stale: StaleRows,
  ): StaleRunSweepOutcome => {
    const sessionId = managed.session.id;
    const decisions = stale.subagents.map((snapshot) => {
      const child = resolveOrphanChildChat(sessionId, snapshot.id);
      return {
        snapshot,
        terminal: decideOrphanSubagentTerminal({
          row: snapshot,
          childState: child?.state ?? null,
          childReport: child?.report ?? null,
          attribution,
        }),
      };
    });
    const emittable = decisions.filter((entry) => entry.terminal !== null);
    if (stale.background.length === 0 && emittable.length === 0) {
      return { ...EMPTY_OUTCOME, subagentsLeftRunning: decisions.length };
    }

    for (const snapshot of stale.background) {
      const terminal = decideOrphanBackgroundTerminal({ row: snapshot, attribution });
      emitScheduledWorkUpdate(managed, {
        type: "scheduled_work_update",
        id: snapshot.id,
        kind: "background_task",
        status: terminal.status,
        origin: "background_task",
        title: snapshot.title,
        summary: terminal.summary,
        stopSource: terminal.stopSource,
        stopReason: terminal.stopReason,
        ...(snapshot.sourceTaskId ? { sourceTaskId: snapshot.sourceTaskId } : {}),
        ...(snapshot.sourceToolUseId ? { sourceToolUseId: snapshot.sourceToolUseId } : {}),
        ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
      });
    }
    for (const { snapshot, terminal } of emittable) {
      if (!terminal) continue;
      emitChatEvent(managed, {
        type: "subagent_result",
        taskId: snapshot.id,
        parentToolUseId: snapshot.parentToolUseId ?? null,
        status: terminal.status,
        summary: terminal.summary,
        finalSummary: terminal.finalSummary,
        ...(terminal.stopSource ? { stopSource: terminal.stopSource } : {}),
        ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}),
        ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
      });
    }
    persistChatState(managed);
    const outcome: StaleRunSweepOutcome = {
      backgroundStopped: stale.background.length,
      subagentsTerminalized: emittable.length,
      subagentsLeftRunning: decisions.length - emittable.length,
    };
    logger.info("agent_chat.stale_run_rows_reconciled", {
      sessionId,
      backgroundTasksStopped: outcome.backgroundStopped,
      subagentRowsTerminalized: outcome.subagentsTerminalized,
      subagentRowsLeftRunning: outcome.subagentsLeftRunning,
      stopSource: attribution.stopSource,
    });
    return outcome;
  };

  const terminalizeStaleRowsForSession = (
    managed: TManaged,
    attribution: OrphanStopAttribution,
    envelopes?: AgentChatEventEnvelope[],
  ): StaleRunSweepOutcome => {
    const source = envelopes ?? readFullTranscriptEnvelopesForSessionId(managed.session.id);
    if (source.length === 0) return EMPTY_OUTCOME;
    const stale = collectStaleRows(source);
    if (stale.background.length === 0 && stale.subagents.length === 0) return EMPTY_OUTCOME;
    return emitStaleTerminals(managed, attribution, stale);
  };

  /**
   * One chat with no live runtime of its own.
   *
   * An outcome means "this brain looked and this is what it found" — the caller
   * turns that into a mark. `null` means "did not look": the chat was handed to
   * someone else, so nothing was decided about it and its existing mark must
   * survive the pass. Conflating the two retires a chat a sibling brain
   * happened to claim for as long as this process runs. A chat that cannot be
   * materialized at all throws instead — that is a fault, not a handoff.
   */
  const sweepSession = (sessionId: string): StaleRunSweepOutcome | null => {
    const envelopes = readFullTranscriptEnvelopesForSessionId(sessionId);
    if (envelopes.length === 0) return EMPTY_OUTCOME;
    const stale = collectStaleRows(envelopes);
    // Scan before constructing a managed session: most candidates have nothing
    // stale, and materializing one for each of them is the expensive half.
    if (stale.background.length === 0 && stale.subagents.length === 0) return EMPTY_OUTCOME;

    // Not guarded: a session this brain cannot materialize is a real fault, and
    // swallowing it here would make every pass re-read the chat's full
    // transcript and throw again in silence. Letting it reach
    // `reconcileStaleRuns` warns once and backs the chat off with a revisit
    // mark, the same as any other failed sweep.
    const managed = ensureManagedSession(sessionId);
    // A live runtime appeared between the scan and here: it owns these rows.
    if (managed.runtime || managed.closed) return null;
    // And a sibling brain may have claimed the chat in that same window —
    // `ensureManagedSession` reads persisted state, so re-ask afterwards rather
    // than trusting the verdict the candidate list was built from.
    if (!chatRuntimeAdoptable(sessionId, { quiet: true })) return null;

    return emitStaleTerminals(managed, restartRecoveryStopAttribution(sessionId), stale);
  };

  /** Chats this brain should look at, newest first, already cheaply filtered. */
  const sweepCandidates = (): string[] => {
    let ids: string[];
    try {
      ids = listChatSessionIds(STALE_RUN_SWEEP_SESSION_SCAN_LIMIT);
    } catch {
      return [];
    }
    const candidates: string[] = [];
    const at = now();
    for (const id of ids) {
      const mark = marks.get(id);
      if (mark?.kind === "swept") continue;
      // Left running on purpose and not due yet: it still needs a terminal
      // event eventually, just not at the cost of every chat behind it. The
      // mark is cleared where the session is actually processed, not here, so
      // a due candidate that falls outside this pass's budget keeps its clock
      // instead of being re-read on every pass until a slot opens.
      if (mark?.kind === "revisit" && at < mark.dueAt) continue;
      // This brain is driving it; its own teardown paths settle these rows.
      if (peekManagedSession(id)?.runtime) continue;
      // Another live brain owns the runtime. Its rows are not stale, and
      // terminalizing them is exactly the cross-brain stomp
      // `chatRuntimeAdoptable` exists to prevent.
      if (!chatRuntimeAdoptable(id, { quiet: true })) {
        if (mark?.kind !== "foreignAnnounced") {
          marks.set(id, FOREIGN_MARK);
          logger.warn("agent_chat.stale_run_sweep_skipped_foreign_owner", { sessionId: id });
        }
        continue;
      }
      if (mark?.kind === "foreignAnnounced") marks.delete(id);
      candidates.push(id);
    }
    return candidates;
  };

  const reconcileStaleRuns = (): void => {
    // A session that regained a runtime must be eligible again the next time
    // that runtime dies, so drop its "already swept" mark while it is live.
    for (const id of liveRuntimeSessionIds()) marks.delete(id);
    let processed = 0;
    for (const sessionId of sweepCandidates()) {
      if (processed >= STALE_RUN_SWEEP_SESSIONS_PER_PASS) break;
      processed += 1;
      try {
        const outcome = sweepSession(sessionId);
        // Nothing was decided about this chat, so leave its mark exactly as it
        // was: a chat another brain claimed mid-pass is examined again next
        // pass, not retired.
        if (!outcome) continue;
        // A chat that still has a genuinely running delegate is not finished
        // healing: marking it swept would retire it while rows it deliberately
        // left running still need a terminal event once that delegate stops.
        // It gets a fresh revisit clock instead, replacing the one that just
        // came due.
        marks.set(
          sessionId,
          outcome.subagentsLeftRunning === 0
            ? SWEPT_MARK
            : { kind: "revisit", dueAt: now() + STALE_RUN_SWEEP_REVISIT_MS },
        );
      } catch (error) {
        // A throw is a failed look, not a clean chat: back off with a revisit
        // clock rather than retiring rows that were never examined.
        marks.set(sessionId, { kind: "revisit", dueAt: now() + STALE_RUN_SWEEP_REVISIT_MS });
        logger.warn("agent_chat.stale_run_reconcile_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // The map keys on ids that rotate out of the newest-N scan window and are
    // never looked at again, so it is bounded or the bookkeeping outlives the
    // chats it describes.
    if (marks.size > STALE_RUN_SWEEP_SESSION_SCAN_LIMIT * 4) marks.clear();
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let kickoff: ReturnType<typeof setTimeout> | null = null;

  return {
    terminalizeStaleRowsForSession,
    reconcileStaleRuns,
    start: () => {
      if (timer) return;
      timer = setInterval(reconcileStaleRuns, STALE_RUN_SWEEP_INTERVAL_MS);
      timer.unref?.();
      // Brain start: the first pass runs off the event loop so service
      // construction never waits on transcript reads.
      kickoff = setTimeout(() => {
        try {
          reconcileStaleRuns();
        } catch (error) {
          logger.warn("agent_chat.stale_run_sweep_start_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, STALE_RUN_SWEEP_START_DELAY_MS);
      kickoff.unref?.();
    },
    dispose: () => {
      if (timer) clearInterval(timer);
      if (kickoff) clearTimeout(kickoff);
      // Cleared, not just stopped: `start()` is idempotent on `timer`, so
      // leaving the handle behind would make a restart after dispose a
      // permanent no-op.
      timer = null;
      kickoff = null;
    },
  };
}
