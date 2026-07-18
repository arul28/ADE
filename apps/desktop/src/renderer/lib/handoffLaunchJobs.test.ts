import { describe, expect, it } from "vitest";
import {
  handoffJobLikelyMaterialized,
  handoffLaunchStatusMessage,
  type HandoffLaunchJob,
} from "./handoffLaunchJobs";

const baseJob: HandoffLaunchJob = {
  id: "job-1",
  sourceSessionId: "chat-1",
  laneId: "lane-1",
  laneName: "Lane one",
  targetModelId: "openai/gpt-5.5",
  targetModelLabel: "GPT-5.5",
  targetToolType: "codex-chat",
  status: "preparing-summary",
  createdAtMs: Date.parse("2026-07-17T12:00:00.000Z"),
};

// ADE-122 regression: while a handoff RPC was still in flight, the sidebar
// showed both the placeholder and the real created session — "two new
// sessions" with one vanishing when the RPC settled. The placeholder must be
// treated as materialized once a matching real session row is visible.
describe("handoffJobLikelyMaterialized", () => {
  it("matches a same-lane same-tool session started after the job began", () => {
    expect(handoffJobLikelyMaterialized(baseJob, {
      laneId: "lane-1",
      toolType: "codex-chat",
      startedAt: "2026-07-17T12:00:05.000Z",
    })).toBe(true);
  });

  it("absorbs small clock drift between renderer and runtime", () => {
    expect(handoffJobLikelyMaterialized(baseJob, {
      laneId: "lane-1",
      toolType: "codex-chat",
      startedAt: "2026-07-17T11:59:50.000Z",
    })).toBe(true);
  });

  it("ignores sessions from before the handoff started", () => {
    expect(handoffJobLikelyMaterialized(baseJob, {
      laneId: "lane-1",
      toolType: "codex-chat",
      startedAt: "2026-07-17T11:58:00.000Z",
    })).toBe(false);
  });

  it("ignores sessions in other lanes or with other tool types", () => {
    expect(handoffJobLikelyMaterialized(baseJob, {
      laneId: "lane-2",
      toolType: "codex-chat",
      startedAt: "2026-07-17T12:00:05.000Z",
    })).toBe(false);
    expect(handoffJobLikelyMaterialized(baseJob, {
      laneId: "lane-1",
      toolType: "claude-chat",
      startedAt: "2026-07-17T12:00:05.000Z",
    })).toBe(false);
    expect(handoffJobLikelyMaterialized(baseJob, {
      laneId: "lane-1",
      toolType: null,
      startedAt: "2026-07-17T12:00:05.000Z",
    })).toBe(false);
  });

  it("rejects unparseable start times", () => {
    expect(handoffJobLikelyMaterialized(baseJob, {
      laneId: "lane-1",
      toolType: "codex-chat",
      startedAt: "not-a-date",
    })).toBe(false);
  });
});

describe("handoffLaunchStatusMessage", () => {
  it("labels each stage, including the fork-mode status", () => {
    expect(handoffLaunchStatusMessage("preparing-summary")).toBe("Summarizing chat & creating handoff...");
    expect(handoffLaunchStatusMessage("forking-history")).toBe("Forking chat history...");
    expect(handoffLaunchStatusMessage("creating-chat")).toBe("Creating chat...");
    expect(handoffLaunchStatusMessage("sending-handoff")).toBe("Sending handoff...");
  });
});
