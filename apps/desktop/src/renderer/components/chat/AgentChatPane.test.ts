import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary } from "../../../shared/types";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import {
  resolveChatSessionProfile,
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

describe("resolveChatSessionProfile", () => {
  it("keeps computer-use-off chats lightweight", () => {
    expect(resolveChatSessionProfile({ ...createDefaultComputerUsePolicy(), mode: "off" })).toBe("light");
  });

  it("promotes computer-use-enabled chats to workflow sessions", () => {
    expect(resolveChatSessionProfile(createDefaultComputerUsePolicy())).toBe("workflow");
    expect(resolveChatSessionProfile({ ...createDefaultComputerUsePolicy(), mode: "enabled" })).toBe("workflow");
  });
});

describe("shouldPromoteSessionForComputerUse", () => {
  it("promotes older light sessions when computer use is on", () => {
    const policy = createDefaultComputerUsePolicy();

    expect(shouldPromoteSessionForComputerUse({ sessionProfile: "light" }, policy)).toBe(true);
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: undefined }, policy)).toBe(true);
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: "workflow" }, policy)).toBe(false);
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: "light" }, { ...policy, mode: "off" })).toBe(false);
  });
});
