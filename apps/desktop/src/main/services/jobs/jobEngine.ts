import type { Logger } from "../logging/logger";
import type { createPackService } from "../packs/packService";

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
  packService
}: {
  logger: Logger;
  packService: ReturnType<typeof createPackService>;
}) {
  const laneQueue = new Map<string, LaneQueueState>();

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
    }
  };
}
