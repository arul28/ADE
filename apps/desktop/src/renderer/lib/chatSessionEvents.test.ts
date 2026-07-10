/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope, AgentChatSession, AgentChatSessionSummary } from "../../shared/types";
import {
  announceWorkChatSessionCreated,
  compareChatSessionsByEffectiveRecency,
  getChatSessionLocalTouchTimestampForEvent,
  getEffectiveChatSessionRecencyMs,
  shouldRefreshSessionListForChatEvent,
  subscribeWorkChatSessionCreated,
} from "./chatSessionEvents";

function makeEnvelope(event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: new Date().toISOString(),
    event,
  };
}

function makeSession(
  sessionId: string,
  overrides: Partial<Pick<AgentChatSessionSummary, "startedAt" | "lastActivityAt">> = {},
): Pick<AgentChatSessionSummary, "sessionId" | "startedAt" | "lastActivityAt"> {
  return {
    sessionId,
    startedAt: "2026-03-24T10:00:00.000Z",
    lastActivityAt: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("work chat session creation events", () => {
  it("delivers the newly-created session and unsubscribes cleanly", () => {
    const listener = vi.fn();
    const session = {
      id: "session-1",
      laneId: "lane-1",
      provider: "codex",
    } as AgentChatSession;
    const unsubscribe = subscribeWorkChatSessionCreated(listener);

    announceWorkChatSessionCreated("/project/a", session);
    expect(listener).toHaveBeenCalledWith({ projectRoot: "/project/a", session });

    unsubscribe();
    announceWorkChatSessionCreated("/project/a", session);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("shouldRefreshSessionListForChatEvent", () => {
  it("refreshes on turn completion", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "done", turnId: "turn-1", status: "completed" }))).toBe(true);
  });

  it("refreshes on chat errors", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "error", message: "boom" }))).toBe(true);
  });

  it("refreshes when a turn starts or user input lands mid-turn", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "status", turnStatus: "started", turnId: "turn-1" }))).toBe(true);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "approval_request", itemId: "approval-1", kind: "tool_call", description: "Need approval" }))).toBe(true);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "pending_input_resolved", itemId: "approval-1", resolution: "accepted" }))).toBe(true);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "user_message", text: "ship it" }))).toBe(true);
  });

  it("refreshes when runtime-native title metadata changes", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({
      type: "session_meta_updated",
      title: "Runtime Naming Investigation",
      manuallyNamed: false,
    }))).toBe(true);
  });

  it("refreshes next-wake summaries for schedule changes but not background task noise", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({
      type: "scheduled_work_update",
      id: "wake-1",
      kind: "wakeup",
      status: "scheduled",
      nextRunAt: "2026-07-09T09:12:00.000Z",
    }))).toBe(true);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({
      type: "scheduled_work_update",
      id: "background-1",
      kind: "background_task",
      status: "running",
    }))).toBe(false);
  });

  it("ignores noisy intermediate events", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "status", turnStatus: "completed" }))).toBe(false);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "text", text: "hello" }))).toBe(false);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "tool_call", tool: "functions.exec", args: {}, itemId: "tool-1" }))).toBe(false);
  });
});

describe("getChatSessionLocalTouchTimestampForEvent", () => {
  it("returns the envelope timestamp for meaningful local activity", () => {
    const timestamp = "2026-03-24T10:05:00.000Z";
    expect(getChatSessionLocalTouchTimestampForEvent({
      sessionId: "session-1",
      timestamp,
      event: { type: "status", turnStatus: "started", turnId: "turn-1" },
    })).toBe(timestamp);
  });

  it("ignores high-frequency transcript events", () => {
    expect(getChatSessionLocalTouchTimestampForEvent(makeEnvelope({ type: "text", text: "streaming..." }))).toBeNull();
  });
});

describe("effective chat session recency", () => {
  it("prefers a local touch over persisted timestamps", () => {
    const session = makeSession("session-1", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:02:00.000Z",
    });

    expect(getEffectiveChatSessionRecencyMs(session, "2026-03-24T10:03:00.000Z")).toBe(Date.parse("2026-03-24T10:03:00.000Z"));
  });

  it("sorts by effective recency with deterministic fallbacks", () => {
    const older = makeSession("older", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:01:00.000Z",
    });
    const newer = makeSession("newer", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:02:00.000Z",
    });
    const localTouches = new Map<string, string>([["older", "2026-03-24T10:03:00.000Z"]]);

    expect(compareChatSessionsByEffectiveRecency(older, newer, localTouches)).toBeLessThan(0);
  });

  it("falls back to lastActivityAt when no local touch exists", () => {
    const session = makeSession("session-1", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:05:00.000Z",
    });

    expect(getEffectiveChatSessionRecencyMs(session)).toBe(Date.parse("2026-03-24T10:05:00.000Z"));
  });

  it("falls back to startedAt when lastActivityAt is missing", () => {
    const session = makeSession("session-1", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: undefined,
    });

    expect(getEffectiveChatSessionRecencyMs(session)).toBe(Date.parse("2026-03-24T10:00:00.000Z"));
  });

  it("returns 0 when all timestamps are missing", () => {
    const session = makeSession("session-1", {
      startedAt: undefined,
      lastActivityAt: undefined,
    });

    expect(getEffectiveChatSessionRecencyMs(session)).toBe(0);
  });

  it("accepts a Record-based local touch map for comparisons", () => {
    const older = makeSession("older", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:01:00.000Z",
    });
    const newer = makeSession("newer", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:02:00.000Z",
    });
    const localTouches: Record<string, string | null | undefined> = {
      older: "2026-03-24T10:03:00.000Z",
    };

    expect(compareChatSessionsByEffectiveRecency(older, newer, localTouches)).toBeLessThan(0);
  });

  it("breaks ties by sessionId for deterministic ordering", () => {
    const sessionA = makeSession("a-session", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:00:00.000Z",
    });
    const sessionB = makeSession("b-session", {
      startedAt: "2026-03-24T10:00:00.000Z",
      lastActivityAt: "2026-03-24T10:00:00.000Z",
    });

    const result = compareChatSessionsByEffectiveRecency(sessionA, sessionB);
    expect(result).not.toBe(0);
    // "a-session" < "b-session" lexicographically, so localeCompare returns negative
    expect(result).toBeLessThan(0);
  });
});

describe("getChatSessionLocalTouchTimestampForEvent edge cases", () => {
  it("returns timestamp for done events", () => {
    const timestamp = "2026-03-24T10:05:00.000Z";
    expect(getChatSessionLocalTouchTimestampForEvent({
      sessionId: "session-1",
      timestamp,
      event: { type: "done", turnId: "turn-1", status: "completed" },
    })).toBe(timestamp);
  });

  it("returns timestamp for error events", () => {
    const timestamp = "2026-03-24T10:05:00.000Z";
    expect(getChatSessionLocalTouchTimestampForEvent({
      sessionId: "session-1",
      timestamp,
      event: { type: "error", message: "fail" },
    })).toBe(timestamp);
  });

  it("returns timestamp for failed and interrupted status events", () => {
    const timestamp = "2026-03-24T10:05:00.000Z";
    expect(getChatSessionLocalTouchTimestampForEvent({
      sessionId: "session-1",
      timestamp,
      event: { type: "status", turnStatus: "failed", turnId: "turn-1" },
    })).toBe(timestamp);
    expect(getChatSessionLocalTouchTimestampForEvent({
      sessionId: "session-1",
      timestamp,
      event: { type: "status", turnStatus: "interrupted", turnId: "turn-1" },
    })).toBe(timestamp);
  });

  it("returns null for completed status events", () => {
    expect(getChatSessionLocalTouchTimestampForEvent(makeEnvelope({
      type: "status", turnStatus: "completed",
    }))).toBeNull();
  });

  it("returns null for reasoning events", () => {
    expect(getChatSessionLocalTouchTimestampForEvent(makeEnvelope({
      type: "reasoning", text: "Thinking...", itemId: "r-1", turnId: "turn-1",
    }))).toBeNull();
  });

  it("returns null for tool_call events", () => {
    expect(getChatSessionLocalTouchTimestampForEvent(makeEnvelope({
      type: "tool_call", tool: "Bash", args: {}, itemId: "t-1",
    }))).toBeNull();
  });
});
