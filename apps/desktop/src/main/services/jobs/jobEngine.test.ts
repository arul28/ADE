import { describe, expect, it, vi } from "vitest";
import { createJobEngine } from "./jobEngine";

describe("jobEngine deterministic refresh", () => {
  it("queues lane refresh hooks without pack refresh side effects", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

    const engine = createJobEngine({
      logger,
    });

    engine.onSessionEnded({ laneId: "lane-1", sessionId: "session-1" });

    expect(logger.info).toHaveBeenCalledWith(
      "jobs.refresh_lane.begin",
      expect.objectContaining({ laneId: "lane-1", sessionId: "session-1", reason: "session_end" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "jobs.refresh_lane.done",
      expect.objectContaining({ laneId: "lane-1", sessionId: "session-1", reason: "session_end" })
    );
    engine.dispose();
  });

  it("skips periodic full conflict prediction by default in dev stability mode", async () => {
    const previousViteUrl = process.env.VITE_DEV_SERVER_URL;
    const previousStabilityMode = process.env.ADE_STABILITY_MODE;
    const previousConflictPrediction = process.env.ADE_ENABLE_CONFLICT_PREDICTION;
    const previousAllBackgroundTasks = process.env.ADE_ENABLE_ALL_BACKGROUND_TASKS;
    vi.useFakeTimers();

    try {
      process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
      delete process.env.ADE_STABILITY_MODE;
      delete process.env.ADE_ENABLE_CONFLICT_PREDICTION;
      delete process.env.ADE_ENABLE_ALL_BACKGROUND_TASKS;

      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
      const conflictService = { runPrediction: vi.fn().mockResolvedValue(undefined) } as any;
      const engine = createJobEngine({ logger, conflictService });

      await vi.advanceTimersByTimeAsync(121_000);

      expect(conflictService.runPrediction).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "jobs.conflicts.periodic_skipped",
        expect.objectContaining({ reason: "stability_mode" }),
      );
      engine.dispose();
    } finally {
      vi.useRealTimers();
      if (previousViteUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
      else process.env.VITE_DEV_SERVER_URL = previousViteUrl;
      if (previousStabilityMode === undefined) delete process.env.ADE_STABILITY_MODE;
      else process.env.ADE_STABILITY_MODE = previousStabilityMode;
      if (previousConflictPrediction === undefined) delete process.env.ADE_ENABLE_CONFLICT_PREDICTION;
      else process.env.ADE_ENABLE_CONFLICT_PREDICTION = previousConflictPrediction;
      if (previousAllBackgroundTasks === undefined) delete process.env.ADE_ENABLE_ALL_BACKGROUND_TASKS;
      else process.env.ADE_ENABLE_ALL_BACKGROUND_TASKS = previousAllBackgroundTasks;
    }
  });

  it("allows periodic full conflict prediction when explicitly enabled in dev", async () => {
    const previousViteUrl = process.env.VITE_DEV_SERVER_URL;
    const previousConflictPrediction = process.env.ADE_ENABLE_CONFLICT_PREDICTION;
    vi.useFakeTimers();

    try {
      process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
      process.env.ADE_ENABLE_CONFLICT_PREDICTION = "1";

      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
      const conflictService = { runPrediction: vi.fn().mockResolvedValue(undefined) } as any;
      const engine = createJobEngine({ logger, conflictService });

      await vi.advanceTimersByTimeAsync(120_250);

      expect(conflictService.runPrediction).toHaveBeenCalledWith({});
      engine.dispose();
    } finally {
      vi.useRealTimers();
      if (previousViteUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
      else process.env.VITE_DEV_SERVER_URL = previousViteUrl;
      if (previousConflictPrediction === undefined) delete process.env.ADE_ENABLE_CONFLICT_PREDICTION;
      else process.env.ADE_ENABLE_CONFLICT_PREDICTION = previousConflictPrediction;
    }
  });
});
