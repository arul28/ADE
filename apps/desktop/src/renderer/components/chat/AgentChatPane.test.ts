import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary } from "../../../shared/types";
import { resolveNextSelectedSessionId } from "./AgentChatPane";

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
    permissionMode: "plan",
    computerUse: undefined,
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
