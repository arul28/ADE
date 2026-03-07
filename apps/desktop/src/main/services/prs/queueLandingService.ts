import { randomUUID } from "node:crypto";
import type {
  QueueEntryState,
  QueueState,
  QueueLandingState,
  QueueLandingEntry,
  MergeMethod,
  LandResult,
  PrSummary,
  PrEventPayload
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { nowIso } from "../shared/utils";

type QueueLandingRow = {
  id: string;
  group_id: string;
  project_id: string;
  state: string;
  entries_json: string;
  current_position: number;
  started_at: string;
  completed_at: string | null;
};

function parseEntries(raw: string): QueueLandingEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToState(row: QueueLandingRow): QueueLandingState {
  return {
    queueId: row.id,
    groupId: row.group_id,
    state: row.state as QueueState,
    entries: parseEntries(row.entries_json),
    currentPosition: Number(row.current_position),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null
  };
}

const activeLandingLoops = new Map<string, Promise<void>>();

export function createQueueLandingService({
  db,
  logger,
  projectId,
  prService,
  emitEvent
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  prService: {
    land: (args: { prId: string; method: MergeMethod }) => Promise<LandResult>;
    listGroupPrs: (groupId: string) => Promise<PrSummary[]>;
  };
  emitEvent: (event: PrEventPayload) => void;
}) {
  const Q_COLS = "id, group_id, project_id, state, entries_json, current_position, started_at, completed_at";

  const getRow = (queueId: string): QueueLandingRow | null =>
    db.get<QueueLandingRow>(
      `select ${Q_COLS} from queue_landing_state where id = ? and project_id = ? limit 1`,
      [queueId, projectId]
    );

  const getRowByGroup = (groupId: string): QueueLandingRow | null =>
    db.get<QueueLandingRow>(
      `select ${Q_COLS} from queue_landing_state
       where group_id = ? and project_id = ? and state in ('landing', 'paused')
       order by started_at desc limit 1`,
      [groupId, projectId]
    );

  const saveState = (state: QueueLandingState): void => {
    db.run(
      `insert into queue_landing_state(id, group_id, project_id, state, entries_json, current_position, started_at, completed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         state = excluded.state,
         entries_json = excluded.entries_json,
         current_position = excluded.current_position,
         completed_at = excluded.completed_at`,
      [
        state.queueId,
        state.groupId,
        projectId,
        state.state,
        JSON.stringify(state.entries),
        state.currentPosition,
        state.startedAt,
        state.completedAt
      ]
    );
  };

  const emitQueueStep = (groupId: string, prId: string, entryState: QueueEntryState, position: number): void => {
    emitEvent({
      type: "queue-step",
      groupId,
      prId,
      entryState,
      position,
      timestamp: nowIso()
    });
  };

  const emitQueueState = (groupId: string, state: QueueState, currentPosition: number): void => {
    emitEvent({
      type: "queue-state",
      groupId,
      state,
      currentPosition,
      timestamp: nowIso()
    });
  };

  const runLandingLoop = async (
    queueState: QueueLandingState,
    method: MergeMethod
  ): Promise<void> => {
    const entries = queueState.entries;

    for (let i = queueState.currentPosition; i < entries.length; i++) {
      // Re-read to check for pause/cancel between iterations.
      const freshRow = getRow(queueState.queueId);
      if (!freshRow || freshRow.state !== "landing") return;

      const entry = entries[i]!;
      if (entry.state === "landed" || entry.state === "skipped") {
        logger.debug("queue_landing.entry_already_terminal", {
          queueId: queueState.queueId, prId: entry.prId, state: entry.state, position: i
        });
        continue;
      }

      entry.state = "landing";
      queueState.currentPosition = i;
      saveState(queueState);
      emitQueueStep(queueState.groupId, entry.prId, "landing", i);

      try {
        const result = await prService.land({ prId: entry.prId, method });

        if (result.success) {
          entry.state = "landed";
          saveState(queueState);
          emitQueueStep(queueState.groupId, entry.prId, "landed", i);
        } else {
          entry.state = "failed";
          entry.error = result.error ?? "Land failed";
          queueState.state = "paused";
          saveState(queueState);
          emitQueueStep(queueState.groupId, entry.prId, "failed", i);
          emitQueueState(queueState.groupId, "paused", i);
          logger.warn("queue_landing.entry_failed", {
            queueId: queueState.queueId,
            prId: entry.prId,
            position: i,
            error: entry.error
          });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.state = "failed";
        entry.error = message;
        queueState.state = "paused";
        saveState(queueState);
        emitQueueStep(queueState.groupId, entry.prId, "failed", i);
        emitQueueState(queueState.groupId, "paused", i);
        logger.error("queue_landing.entry_error", {
          queueId: queueState.queueId,
          prId: entry.prId,
          position: i,
          error: message
        });
        return;
      }
    }

    // All entries processed successfully.
    queueState.state = "completed";
    queueState.completedAt = nowIso();
    saveState(queueState);
    emitQueueState(queueState.groupId, "completed", queueState.currentPosition);
    logger.info("queue_landing.completed", {
      queueId: queueState.queueId,
      groupId: queueState.groupId
    });
  };

  const startQueue = async (args: {
    groupId: string;
    method: MergeMethod;
    autoResolve?: boolean;
    confidenceThreshold?: number;
  }): Promise<QueueLandingState> => {
    // Guard: prevent double-start for the same group
    const existing = getRowByGroup(args.groupId);
    if (existing && existing.state === "landing") {
      return rowToState(existing);
    }

    const prs = await prService.listGroupPrs(args.groupId);
    const sorted = [...prs].sort((a, b) => {
      // Position is determined by the group member ordering; for now sort by creation.
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return aTime - bTime;
      return a.id.localeCompare(b.id);
    });

    const entries: QueueLandingEntry[] = sorted.map((pr, index) => ({
      prId: pr.id,
      laneId: pr.laneId,
      laneName: pr.title || pr.headBranch,
      position: index,
      state: "pending" as QueueEntryState
    }));

    const queueId = randomUUID();
    const now = nowIso();
    const queueState: QueueLandingState = {
      queueId,
      groupId: args.groupId,
      state: "landing",
      entries,
      currentPosition: 0,
      startedAt: now,
      completedAt: null
    };

    saveState(queueState);
    emitQueueState(args.groupId, "landing", 0);
    logger.info("queue_landing.started", {
      queueId,
      groupId: args.groupId,
      entryCount: entries.length,
      method: args.method
    });

    // Run the loop asynchronously so the caller gets the initial state immediately.
    // Wait for any prior loop on this queue to finish before starting a new one.
    const prior = activeLandingLoops.get(queueId) ?? Promise.resolve();
    const loopPromise = prior.then(() => runLandingLoop(queueState, args.method)).catch((error) => {
      logger.error("queue_landing.loop_fatal", { queueId, error: String(error) });
      queueState.state = "paused";
      saveState(queueState);
    });
    activeLandingLoops.set(queueId, loopPromise);
    void loopPromise.finally(() => {
      if (activeLandingLoops.get(queueId) === loopPromise) {
        activeLandingLoops.delete(queueId);
      }
    });

    return queueState;
  };

  const pauseQueue = (queueId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    if (!row) return null;
    const state = rowToState(row);
    if (state.state !== "landing") return state;

    state.state = "paused";
    saveState(state);
    emitQueueState(state.groupId, "paused", state.currentPosition);
    logger.info("queue_landing.paused", { queueId, groupId: state.groupId });
    return state;
  };

  const resumeQueue = (queueId: string, method: MergeMethod): QueueLandingState | null => {
    const row = getRow(queueId);
    if (!row) return null;
    const state = rowToState(row);
    if (state.state !== "paused") return state;

    // Reset the failed entry at current position back to pending so it can be retried.
    const currentEntry = state.entries[state.currentPosition];
    if (currentEntry && (currentEntry.state === "failed" || currentEntry.state === "paused")) {
      currentEntry.state = "pending";
      currentEntry.error = undefined;
    }

    state.state = "landing";
    saveState(state);
    emitQueueState(state.groupId, "landing", state.currentPosition);
    logger.info("queue_landing.resumed", { queueId, groupId: state.groupId });

    const prior = activeLandingLoops.get(queueId) ?? Promise.resolve();
    const loopPromise = prior.then(() => runLandingLoop(state, method)).catch((error) => {
      logger.error("queue_landing.loop_fatal", { queueId, error: String(error) });
      state.state = "paused";
      saveState(state);
    });
    activeLandingLoops.set(queueId, loopPromise);
    void loopPromise.finally(() => {
      if (activeLandingLoops.get(queueId) === loopPromise) {
        activeLandingLoops.delete(queueId);
      }
    });

    return state;
  };

  const cancelQueue = (queueId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    if (!row) return null;
    const state = rowToState(row);
    if (state.state === "completed" || state.state === "cancelled") return state;

    for (const entry of state.entries) {
      if (entry.state === "pending" || entry.state === "landing" || entry.state === "failed" || entry.state === "paused") {
        entry.state = "skipped";
      }
    }

    state.state = "cancelled";
    state.completedAt = nowIso();
    saveState(state);
    emitQueueState(state.groupId, "cancelled", state.currentPosition);
    logger.info("queue_landing.cancelled", { queueId, groupId: state.groupId });
    return state;
  };

  const skipEntry = (queueId: string, prId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    if (!row) return null;
    const state = rowToState(row);

    const entry = state.entries.find((e) => e.prId === prId);
    if (!entry) return state;
    if (entry.state === "landed") return state;

    entry.state = "skipped";
    entry.error = undefined;

    // Advance current position past any skipped/landed entries.
    while (
      state.currentPosition < state.entries.length &&
      (state.entries[state.currentPosition]!.state === "skipped" ||
        state.entries[state.currentPosition]!.state === "landed")
    ) {
      state.currentPosition++;
    }

    // If all entries are now terminal, mark the queue as completed.
    const allTerminal = state.entries.every(
      (e) => e.state === "landed" || e.state === "skipped"
    );
    if (allTerminal && state.state !== "completed" && state.state !== "cancelled") {
      state.state = "completed";
      state.completedAt = nowIso();
    }

    saveState(state);
    emitQueueStep(state.groupId, prId, "skipped", entry.position);
    if (allTerminal) {
      emitQueueState(state.groupId, "completed", state.currentPosition);
    }
    logger.info("queue_landing.entry_skipped", { queueId, prId, groupId: state.groupId });
    return state;
  };

  const getQueueState = (queueId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    return row ? rowToState(row) : null;
  };

  const getQueueStateByGroup = (groupId: string): QueueLandingState | null => {
    const row = getRowByGroup(groupId);
    return row ? rowToState(row) : null;
  };

  const init = (): void => {
    const interrupted = db.all<QueueLandingRow>(
      `select ${Q_COLS} from queue_landing_state where project_id = ? and state = 'landing'`,
      [projectId]
    );

    for (const row of interrupted) {
      const state = rowToState(row);
      state.state = "paused";

      // Mark the actively-landing entry as paused too.
      const currentEntry = state.entries[state.currentPosition];
      if (currentEntry && currentEntry.state === "landing") {
        currentEntry.state = "paused";
      }

      saveState(state);
      logger.warn("queue_landing.interrupted_recovery", {
        queueId: state.queueId,
        groupId: state.groupId,
        position: state.currentPosition
      });
    }

    if (interrupted.length > 0) {
      logger.info("queue_landing.init_recovered", { count: interrupted.length });
    }
  };

  return {
    startQueue,
    pauseQueue,
    resumeQueue,
    cancelQueue,
    skipEntry,
    getQueueState,
    getQueueStateByGroup,
    init
  };
}
