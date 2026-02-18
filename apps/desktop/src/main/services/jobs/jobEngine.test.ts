import { describe, expect, it, vi } from "vitest";
import { createJobEngine } from "./jobEngine";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("jobEngine narrative payload propagation", () => {
  it("passes project context into hosted narrative calls", async () => {
    const requestLaneNarrative = vi.fn(async (args: any) => {
      args.onJobSubmitted?.({
        jobId: "job-1",
        status: "queued"
      });
      return {
        jobId: "job-1",
        artifactId: "artifact-1",
        narrative: "summary",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 1200,
        timing: {
          schema: "ade.hostedNarrativeTiming.v1",
          submitStartedAt: "2026-02-16T00:00:00.000Z",
          submitDurationMs: 5,
          queueWaitMs: 50,
          pollDurationMs: 100,
          artifactFetchMs: 8,
          totalDurationMs: 163,
          timeoutMs: 120000,
          timeoutReason: null
        }
      };
    });

    const applyHostedNarrative = vi.fn();
    const recordEvent = vi.fn();

    const engine = createJobEngine({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      packService: {
        refreshLanePack: vi.fn(async () => ({
          packKey: "lane:lane-1",
          deterministicUpdatedAt: "2026-02-16T00:00:00.000Z",
          contentHash: "abc"
        })),
        refreshProjectPack: vi.fn(async () => ({})),
        getLaneExport: vi.fn(async () => ({
          content: "lane export",
          level: "standard",
          approxTokens: 100,
          maxTokens: 300,
          clipReason: null,
          omittedSections: []
        })),
        getProjectExport: vi.fn(async () => ({
          content: "project export",
          header: { packKey: "project" },
          level: "lite",
          approxTokens: 70,
          maxTokens: 120,
          clipReason: null,
          omittedSections: []
        })),
        applyHostedNarrative,
        recordEvent
      } as any,
      hostedAgentService: {
        getStatus: () => ({ enabled: true }),
        requestLaneNarrative
      } as any,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "hosted" } })
      } as any,
      byokLlmService: undefined
    });

    engine.onSessionEnded({ laneId: "lane-1", sessionId: "session-1" });
    await flush();
    await flush();
    await flush();

    expect(requestLaneNarrative).toHaveBeenCalledTimes(1);
    const requestArg = requestLaneNarrative.mock.calls[0]?.[0];
    expect(requestArg.projectContext.projectExport).toContain("project export");
    expect(requestArg.projectContext.refs.projectPackKey).toBe("project");

    expect(applyHostedNarrative).toHaveBeenCalledTimes(1);
    const applyArg = applyHostedNarrative.mock.calls[0]?.[0];
    expect(applyArg.metadata.timing.totalDurationMs).toBe(163);
    expect(applyArg.metadata.timeoutReason).toBeNull();

    const requestedEvent = recordEvent.mock.calls.find((call) => call?.[0]?.eventType === "narrative_requested");
    expect(requestedEvent?.[0]?.payload?.projectExportLevel).toBe("lite");
  });
});
