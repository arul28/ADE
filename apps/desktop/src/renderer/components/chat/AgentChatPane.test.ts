import { describe, expect, it, vi } from "vitest";
import { getModelById } from "../../../shared/modelRegistry";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../shared/types";
import {
  buildParallelLaunchPrompt,
  cleanupTransientParallelLaunchLanes,
  formatParallelLaunchFailureMessage,
  mergeChatHistorySnapshot,
  parallelLaneModelSuffix,
  resolveNextSelectedSessionId,
  shouldPromoteSessionForComputerUse,
} from "./AgentChatPane";

function buildSession(sessionId: string): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "lane-1",
    provider: "claude",
    model: "claude",
    endedAt: null,
    lastOutputPreview: null,
    summary: null,
    startedAt: "2026-03-16T00:00:00.000Z",
    lastActivityAt: "2026-03-16T00:00:00.000Z",
    status: "idle",
    title: null,
    goal: null,
    completion: null,
    reasoningEffort: null,
    executionMode: "focused",
  };
}

describe("resolveNextSelectedSessionId", () => {
  it("keeps the pending newly created session selected while list refresh still only contains the older chat", () => {
    const rows = [buildSession("claude-existing")];

    expect(resolveNextSelectedSessionId({
      rows,
      current: null,
      pendingSelectedSessionId: "codex-new",
      optimisticSessionIds: new Set(["codex-new"]),
      draftSelectionLocked: false,
      forceDraft: false,
      preferDraftStart: false,
    })).toBe("codex-new");
  });

  it("falls back to the newest persisted chat once no pending selection exists", () => {
    const rows = [buildSession("claude-existing"), buildSession("older")];

    expect(resolveNextSelectedSessionId({
      rows,
      current: null,
      pendingSelectedSessionId: null,
      optimisticSessionIds: new Set(),
      draftSelectionLocked: false,
      forceDraft: false,
      preferDraftStart: false,
    })).toBe("claude-existing");
  });
});

describe("shouldPromoteSessionForComputerUse", () => {
  it("promotes older light sessions when the session profile isn't already workflow", () => {
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: "light" })).toBe(true);
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: undefined })).toBe(true);
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: "workflow" })).toBe(false);
  });
});

describe("mergeChatHistorySnapshot", () => {
  function envelope(
    timestamp: string,
    sequence: number,
    text: string,
  ): AgentChatEventEnvelope {
    return {
      sessionId: "session-1",
      timestamp,
      sequence,
      event: {
        type: "text",
        text,
        messageId: `message-${text}`,
      },
    };
  }

  it("keeps live events after a provider sequence reset", () => {
    const beforeRestart = envelope("2026-04-30T23:14:47.751Z", 1003, "before restart");
    const afterRestartUser = envelope("2026-04-30T23:19:57.083Z", 1, "after restart user");
    const afterRestartReply = envelope("2026-04-30T23:21:34.621Z", 66, "after restart reply");
    const stillLive = envelope("2026-04-30T23:25:10.427Z", 146, "still live");

    const merged = mergeChatHistorySnapshot(
      [beforeRestart, afterRestartUser, afterRestartReply],
      [beforeRestart, afterRestartUser, afterRestartReply, stillLive],
    );

    expect(merged.map((entry) => entry.event.type === "text" ? entry.event.text : "")).toEqual([
      "before restart",
      "after restart user",
      "after restart reply",
      "still live",
    ]);
  });

  it("keeps same-millisecond live tail events without trusting global sequence order", () => {
    const snapshotLast = envelope("2026-04-30T23:25:10.427Z", 146, "snapshot last");
    const sameMillisecondTail = envelope("2026-04-30T23:25:10.427Z", 1, "same millisecond tail");

    const merged = mergeChatHistorySnapshot(
      [snapshotLast],
      [snapshotLast, sameMillisecondTail],
    );

    expect(merged.map((entry) => entry.event.type === "text" ? entry.event.text : "")).toEqual([
      "snapshot last",
      "same millisecond tail",
    ]);
  });
});

describe("parallel launch helpers", () => {
  it("keeps same-family model lane suffixes distinct", () => {
    expect(parallelLaneModelSuffix(getModelById("openai/gpt-5.4"))).toBe("codex-gpt-5-4");
    expect(parallelLaneModelSuffix(getModelById("openai/gpt-5.4-mini"))).toBe("codex-gpt-5-4-mini");
  });

  it("preserves the default attachment review request when project docs are prepended", () => {
    const result = buildParallelLaunchPrompt({
      text: "",
      attachmentCount: 2,
    });

    expect(result.displayText).toBe("Please review the attached files.");
    expect(result.sendText).toBe("Please review the attached files.");
  });

  it("uses an issue-context prompt for context-only parallel launches", () => {
    const result = buildParallelLaunchPrompt({
      text: "",
      attachmentCount: 0,
      contextAttachmentCount: 1,
    });

    expect(result.displayText).toBe("Use the attached issue context.");
    expect(result.sendText).toBe("Use the attached issue context.");
  });

  it("force-cleans transient lanes and refreshes lane state after rollback", async () => {
    const deleteLane = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Lane has uncommitted changes."));
    const refreshLanes = vi.fn().mockResolvedValue(undefined);
    const onCleanupError = vi.fn();

    const issues = await cleanupTransientParallelLaunchLanes({
      laneIds: ["lane-a", "lane-b"],
      deleteLane,
      refreshLanes,
      onCleanupError,
    });

    expect(deleteLane).toHaveBeenNthCalledWith(1, { laneId: "lane-a", force: true });
    expect(deleteLane).toHaveBeenNthCalledWith(2, { laneId: "lane-b", force: true });
    expect(refreshLanes).toHaveBeenCalledTimes(1);
    expect(onCleanupError).toHaveBeenCalledWith(expect.objectContaining({
      phase: "delete",
      laneId: "lane-b",
    }));
    expect(issues).toEqual([
      expect.objectContaining({
        phase: "delete",
        laneId: "lane-b",
      }),
    ]);
  });

  it("treats already-deleted lanes as cleaned up during rollback retries", async () => {
    const deleteLane = vi.fn().mockRejectedValue(new Error("Lane not found."));
    const refreshLanes = vi.fn().mockResolvedValue(undefined);
    const onCleanupError = vi.fn();

    const issues = await cleanupTransientParallelLaunchLanes({
      laneIds: ["lane-a"],
      deleteLane,
      refreshLanes,
      onCleanupError,
    });

    expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-a", force: true });
    expect(refreshLanes).toHaveBeenCalledTimes(1);
    expect(onCleanupError).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
  });

  it("formats rollback failures so leaked child lanes are surfaced to the user", () => {
    expect(formatParallelLaunchFailureMessage({
      launchError: "Lane 2 failed to send.",
      cleanupIssues: [
        { phase: "delete", laneId: "lane-a", error: new Error("locked") },
        { phase: "refresh", laneId: null, error: new Error("refresh failed") },
      ],
    })).toBe(
      "Lane 2 failed to send. Cleanup could not delete lane lane-a; lane list refresh also failed. Check the lane list before retrying.",
    );
  });
});
