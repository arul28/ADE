import { describe, expect, it, vi } from "vitest";
import { createEpisodicSummaryService } from "./episodicSummaryService";

describe("episodicSummaryService", () => {
  it("skips trivial short session summaries", async () => {
    const executeTask = vi.fn();
    const addMemory = vi.fn();
    const service = createEpisodicSummaryService({
      projectId: "project-1",
      projectRoot: "/tmp/project-1",
      aiIntegrationService: { executeTask } as any,
      memoryService: { addMemory } as any,
    });

    service.enqueueSessionSummary({
      sessionId: "session-1",
      role: "cto",
      summary: "Session closed.",
      startedAt: "2026-03-13T05:00:00.000Z",
      endedAt: "2026-03-13T05:00:55.000Z",
    });

    await Promise.resolve();

    expect(executeTask).not.toHaveBeenCalled();
    expect(addMemory).not.toHaveBeenCalled();
  });

  it("disables episodic summaries when the service is disabled", async () => {
    const executeTask = vi.fn();
    const addMemory = vi.fn();
    const service = createEpisodicSummaryService({
      projectId: "project-1",
      projectRoot: "/tmp/project-1",
      enabled: false,
      aiIntegrationService: { executeTask } as any,
      memoryService: { addMemory } as any,
    });

    service.enqueueSessionSummary({
      sessionId: "session-2",
      role: "worker",
      summary: "Investigated Linear routing behavior.",
      startedAt: "2026-03-13T05:00:00.000Z",
      endedAt: "2026-03-13T05:02:00.000Z",
      decisions: ["Move webhook setup out of onboarding."],
    });

    await Promise.resolve();

    expect(executeTask).not.toHaveBeenCalled();
    expect(addMemory).not.toHaveBeenCalled();
  });
});
