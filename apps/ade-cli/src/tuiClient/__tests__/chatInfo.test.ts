import { describe, expect, it } from "vitest";
import { deriveChatInfoSnapshot } from "../chatInfo";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { TokenStats } from "../adeApi";

function env(timestamp: string, event: AgentChatEventEnvelope["event"], sequence: number): AgentChatEventEnvelope {
  return { sessionId: "s1", timestamp, sequence, event };
}

function session(overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    provider: "claude",
    model: "claude-opus-4-7",
    title: null,
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:00:00.000Z",
    endedAt: null,
    lastOutputPreview: null,
    summary: null,
    ...overrides,
  } as AgentChatSessionSummary;
}

function tokenStats(overrides: Partial<TokenStats> = {}): TokenStats {
  return {
    percent: 25,
    streaming: false,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    contextWindow: null,
    costUsd: null,
    rateLimit: { usedPercentage: null, resetsAt: null },
    ...overrides,
  } as TokenStats;
}

describe("deriveChatInfoSnapshot", () => {
  it("derives plan from the most recent plan event with current/total counts and live state", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-05-18T12:00:00.000Z", {
        type: "plan",
        steps: [
          { text: "old step", status: "completed" },
        ],
      }, 1),
      env("2026-05-18T12:00:01.000Z", { type: "text", text: "thinking" }, 2),
      env("2026-05-18T12:00:02.000Z", {
        type: "plan",
        steps: [
          { text: "patch runtime bridge", status: "completed" },
          { text: "verify desktop smoke", status: "in_progress" },
          { text: "ship", status: "pending" },
        ],
      }, 3),
    ];

    const snapshot = deriveChatInfoSnapshot({
      events,
      activeSession: null,
      provider: "codex",
      modelLabel: "gpt-5.5",
      laneLabel: "lane-1",
      snapshots: [],
      tokenStats: null,
      goal: null,
      streaming: false,
    });

    expect(snapshot.plan).toEqual({
      current: 2,
      total: 3,
      live: true,
      steps: [
        { text: "patch runtime bridge", status: "completed" },
        { text: "verify desktop smoke", status: "in_progress" },
        { text: "ship", status: "pending" },
      ],
    });
    expect(snapshot.provider).toBe("codex");
    expect(snapshot.modelLabel).toBe("gpt-5.5");
  });

  it("returns null plan and null token summary when there are no plan events and no token stats", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [
        env("2026-05-18T12:00:00.000Z", { type: "text", text: "hi" }, 1),
      ],
      activeSession: null,
      provider: "claude",
      modelLabel: "claude-opus-4-7",
      laneLabel: null,
      snapshots: [],
      tokenStats: null,
      goal: null,
      streaming: true,
    });

    expect(snapshot.plan).toBeNull();
    expect(snapshot.tokenSummary).toBeNull();
    expect(snapshot.contextPercent).toBeNull();
    expect(snapshot.streaming).toBe(true);
  });

  it("formats token usage as +input/output with cache marker and cost", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [],
      activeSession: null,
      provider: "claude",
      modelLabel: "claude-opus-4-7",
      laneLabel: null,
      snapshots: [],
      tokenStats: tokenStats({
        percent: 42,
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 5500,
        costUsd: 0.14,
      }),
      goal: null,
      streaming: false,
    });

    expect(snapshot.contextPercent).toBe(42);
    expect(snapshot.tokenSummary).toBe("+1.2k/340 (5.5k✶) $0.14");
  });

  it("derives a completed-only plan as non-live with current pointing at the completed count", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-05-18T12:00:00.000Z", {
        type: "plan",
        steps: [
          { text: "one", status: "completed" },
          { text: "two", status: "completed" },
        ],
      }, 1),
    ];

    const snapshot = deriveChatInfoSnapshot({
      events,
      activeSession: null,
      provider: "claude",
      modelLabel: "claude-opus-4-7",
      laneLabel: "lane-1",
      snapshots: [],
      tokenStats: null,
      goal: null,
      streaming: false,
    });

    expect(snapshot.plan).toMatchObject({ current: 2, total: 2, live: false });
  });

  it("prefers the active session provider over the argument and passes laneLabel/streaming through", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [],
      activeSession: session({ provider: "codex" }),
      provider: "claude",
      modelLabel: "claude-opus-4-7",
      laneLabel: "fixing-cli-send-error",
      snapshots: [
        { id: "x1", name: "delegated", kind: "subagent", status: "running", summary: "" },
      ],
      tokenStats: null,
      goal: null,
      streaming: true,
      inspectedSubagentId: "x1",
    });

    expect(snapshot.provider).toBe("codex");
    expect(snapshot.laneLabel).toBe("fixing-cli-send-error");
    expect(snapshot.streaming).toBe(true);
    expect(snapshot.snapshots).toHaveLength(1);
    expect(snapshot.inspectedSubagentId).toBe("x1");
  });
});
