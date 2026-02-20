import { describe, expect, it, vi } from "vitest";
import { createJobEngine } from "./jobEngine";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("jobEngine deterministic refresh", () => {
  it("refreshes lane and project packs without AI narrative generation", async () => {
    const refreshLanePack = vi.fn(async () => ({
      packKey: "lane:lane-1",
      deterministicUpdatedAt: "2026-02-16T00:00:00.000Z",
      contentHash: "abc"
    }));
    const refreshProjectPack = vi.fn(async () => ({}));
    const generateNarrative = vi.fn();

    const engine = createJobEngine({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      packService: {
        refreshLanePack,
        refreshProjectPack,
      } as any,
      aiIntegrationService: {
        generateNarrative
      } as any,
      laneService: {
        getLaneBaseAndBranch: () => ({ worktreePath: "/tmp/demo" })
      } as any,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "subscription" } })
      } as any
    });

    engine.onSessionEnded({ laneId: "lane-1", sessionId: "session-1" });
    await flush();
    await flush();
    await flush();

    expect(refreshLanePack).toHaveBeenCalledTimes(1);
    expect(refreshLanePack).toHaveBeenCalledWith({
      laneId: "lane-1",
      sessionId: "session-1",
      reason: "session_end"
    });

    expect(refreshProjectPack).toHaveBeenCalledTimes(1);
    expect(refreshProjectPack).toHaveBeenCalledWith({
      reason: "session_end",
      laneId: "lane-1"
    });

    // AI narrative generation should NOT be called - packs are purely deterministic
    expect(generateNarrative).not.toHaveBeenCalled();
  });
});
