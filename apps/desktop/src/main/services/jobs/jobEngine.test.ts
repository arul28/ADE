import { describe, expect, it, vi } from "vitest";
import { createJobEngine } from "./jobEngine";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("jobEngine deterministic refresh", () => {
  it("queues lane refresh hooks without pack refresh side effects", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

    const engine = createJobEngine({
      logger,
    });

    engine.onSessionEnded({ laneId: "lane-1", sessionId: "session-1" });
    await flush();
    await flush();
    await flush();

    expect(logger.info).toHaveBeenCalledWith(
      "jobs.refresh_lane.begin",
      expect.objectContaining({ laneId: "lane-1", sessionId: "session-1", reason: "session_end" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "jobs.refresh_lane.done",
      expect.objectContaining({ laneId: "lane-1", sessionId: "session-1", reason: "session_end" })
    );
  });
});
