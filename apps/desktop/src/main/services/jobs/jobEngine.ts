import type { Logger } from "../logging/logger";
import type { createPackService } from "../packs/packService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createLaneService } from "../lanes/laneService";

type RefreshRequest = {
  laneId: string;
  reason: string;
  sessionId?: string;
};

type LaneQueueState = {
  running: boolean;
  pending: boolean;
  next: RefreshRequest | null;
};

export function createJobEngine({
  logger,
  packService,
  conflictService,
  aiIntegrationService: _aiIntegrationService,
  laneService: _laneService,
  projectConfigService: _projectConfigService,
}: {
  logger: Logger;
  packService: ReturnType<typeof createPackService>;
  conflictService?: ReturnType<typeof createConflictService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  laneService?: ReturnType<typeof createLaneService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
}) {
  const laneQueue = new Map<string, LaneQueueState>();
  const dirtyLaneQueue = new Set<string>();
  let dirtyQueueTimer: NodeJS.Timeout | null = null;
  let fullConflictPredictionQueued = false;
  let periodicTimer: NodeJS.Timeout | null = null;

  const ensureState = (laneId: string): LaneQueueState => {
    const existing = laneQueue.get(laneId);
    if (existing) return existing;
    const created: LaneQueueState = { running: false, pending: false, next: null };
    laneQueue.set(laneId, created);
    return created;
  };

  const runLaneRefresh = async (laneId: string) => {
    const state = ensureState(laneId);
    if (state.running) return;
    state.running = true;

    while (state.pending) {
      const payload = state.next;
      state.pending = false;
      state.next = null;
      if (!payload) continue;

      try {
        logger.info("jobs.refresh_lane.begin", payload);

        await packService.refreshLanePack({
          laneId: payload.laneId,
          reason: payload.reason,
          sessionId: payload.sessionId
        });

        await packService.refreshProjectPack({
          reason: payload.reason,
          laneId: payload.laneId
        });

        logger.info("jobs.refresh_lane.done", payload);
      } catch (error) {
        logger.error("jobs.refresh_lane.failed", {
          ...payload,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    state.running = false;
  };

  const enqueueLaneRefresh = (request: RefreshRequest) => {
    const state = ensureState(request.laneId);
    state.pending = true;
    state.next = request;
    void runLaneRefresh(request.laneId);
  };

  const flushConflictPredictionQueue = async () => {
    dirtyQueueTimer = null;
    if (!conflictService) return;

    if (fullConflictPredictionQueued) {
      fullConflictPredictionQueued = false;
      dirtyLaneQueue.clear();
      try {
        logger.info("jobs.conflicts.predict.begin", { scope: "all" });
        await conflictService.runPrediction({});
        logger.info("jobs.conflicts.predict.done", { scope: "all" });
      } catch (error) {
        logger.warn("jobs.conflicts.predict.failed", {
          scope: "all",
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    const laneIds = Array.from(dirtyLaneQueue);
    dirtyLaneQueue.clear();
    for (const laneId of laneIds) {
      try {
        logger.info("jobs.conflicts.predict.begin", { scope: "lane", laneId });
        await conflictService.runPrediction({ laneId });
        logger.info("jobs.conflicts.predict.done", { scope: "lane", laneId });
      } catch (error) {
        logger.warn("jobs.conflicts.predict.failed", {
          scope: "lane",
          laneId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const queueConflictPrediction = (args: { laneId?: string; debounceMs?: number }) => {
    if (!conflictService) return;
    if (args.laneId) {
      dirtyLaneQueue.add(args.laneId);
    } else {
      fullConflictPredictionQueued = true;
      dirtyLaneQueue.clear();
    }
    if (dirtyQueueTimer) clearTimeout(dirtyQueueTimer);
    dirtyQueueTimer = setTimeout(() => {
      void flushConflictPredictionQueue();
    }, args.debounceMs ?? 1_200);
  };

  const startPeriodicPrediction = () => {
    if (!conflictService || periodicTimer) return;
    periodicTimer = setInterval(() => {
      queueConflictPrediction({ debounceMs: 250 });
    }, 120_000);
  };

  startPeriodicPrediction();
  queueConflictPrediction({ debounceMs: 2_000 });

  return {
    enqueueLaneRefresh,

    onSessionEnded(args: { laneId: string; sessionId: string }) {
      enqueueLaneRefresh({
        laneId: args.laneId,
        sessionId: args.sessionId,
        reason: "session_end"
      });
    },

    onHeadChanged(args: { laneId: string; reason: string }) {
      enqueueLaneRefresh({
        laneId: args.laneId,
        reason: args.reason
      });
      queueConflictPrediction({ laneId: args.laneId, debounceMs: 1_500 });
    },

    onLaneDirtyChanged(args: { laneId: string; reason: string }) {
      logger.debug("jobs.conflicts.queue_lane_dirty", args);
      queueConflictPrediction({ laneId: args.laneId, debounceMs: 900 });
    },

    runConflictPredictionNow(args: { laneId?: string } = {}) {
      queueConflictPrediction({ laneId: args.laneId, debounceMs: 0 });
    },

    dispose() {
      if (dirtyQueueTimer) {
        clearTimeout(dirtyQueueTimer);
        dirtyQueueTimer = null;
      }
      if (periodicTimer) {
        clearInterval(periodicTimer);
        periodicTimer = null;
      }
    }
  };
}
