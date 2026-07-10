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
    model: "claude-opus-4-8",
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
      modelLabel: "claude-opus-4-8",
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
      modelLabel: "claude-opus-4-8",
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
      modelLabel: "claude-opus-4-8",
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
      modelLabel: "claude-opus-4-8",
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

  it("carries the active session's earliest next wake into chat info", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [],
      activeSession: session({ nextWakeAt: "2026-07-09T12:12:00.000Z" }),
      provider: "claude",
      modelLabel: "claude-opus-4-8",
      laneLabel: "lane",
      snapshots: [],
      tokenStats: null,
      goal: null,
      streaming: false,
    });

    expect(snapshot.nextWakeAt).toBe("2026-07-09T12:12:00.000Z");
  });

  it("derives todos, plan explanation, and the lane PR rollup", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [
        env("2026-05-18T12:00:00.000Z", {
          type: "plan",
          turnId: "t1",
          steps: [{ text: "step", status: "in_progress" }],
          explanation: "Do the risky part first.",
          streamingText: "still planning…",
        } as never, 1),
        env("2026-05-18T12:00:01.000Z", {
          type: "todo_update",
          items: [
            { id: "todo-1", description: "Fix adapter", status: "completed" },
            { id: "todo-2", description: "Add tests", status: "pending" },
          ],
        } as never, 2),
      ],
      activeSession: session({ provider: "codex" }),
      provider: "codex",
      modelLabel: "gpt-5.5",
      laneLabel: "lane",
      snapshots: [],
      tokenStats: null,
      goal: null,
      streaming: false,
      pr: { number: 7, state: "open", checksPassed: 1, checksTotal: 2 },
    });

    expect(snapshot.planExplanation).toBe("Do the risky part first.");
    expect(snapshot.planStreamingText).toBe("still planning…");
    expect(snapshot.todos).toEqual([
      { id: "todo-1", description: "Fix adapter", status: "completed" },
      { id: "todo-2", description: "Add tests", status: "pending" },
    ]);
    expect(snapshot.pr).toEqual({ number: 7, state: "open", checksPassed: 1, checksTotal: 2 });
  });

  it("derives the latest scheduled work rows from Claude SDK wakeup events", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [
        env("2026-07-07T12:00:00.000Z", {
          type: "scheduled_work_update",
          id: "wake-1",
          kind: "wakeup",
          status: "scheduled",
          title: "Check the build",
          nextRunAt: "2026-07-07T12:15:00.000Z",
          reason: "after CI starts",
        }, 1),
        env("2026-07-07T12:16:00.000Z", {
          type: "scheduled_work_update",
          id: "wake-1",
          kind: "wakeup",
          status: "running",
          title: "Check the build",
          lastRunAt: "2026-07-07T12:16:00.000Z",
          reason: "after CI starts",
        }, 2),
      ],
      activeSession: session({ provider: "claude" }),
      provider: "claude",
      modelLabel: "claude-opus-4-7",
      laneLabel: "lane",
      snapshots: [],
      tokenStats: null,
      goal: null,
      streaming: false,
    });

    expect(snapshot.scheduledWork).toEqual([
      expect.objectContaining({
        id: "wake-1",
        kind: "wakeup",
        status: "running",
        title: "Check the build",
        reason: "after CI starts",
        createdAt: "2026-07-07T12:00:00.000Z",
        updatedAt: "2026-07-07T12:16:00.000Z",
      }),
    ]);
  });

  it("partitions background_task work into backgroundWork, keeping schedule kinds in scheduledWork", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [
        env("2026-07-07T12:00:00.000Z", {
          type: "scheduled_work_update",
          id: "bg-1",
          kind: "background_task",
          status: "running",
          title: "cd /repo && npm run dev",
        }, 1),
        env("2026-07-07T12:00:01.000Z", {
          type: "scheduled_work_update",
          id: "cron-1",
          kind: "cron",
          status: "scheduled",
          title: "Nightly",
        }, 2),
      ],
      activeSession: session({ provider: "claude" }),
      provider: "claude",
      modelLabel: "claude-opus-4-8",
      laneLabel: "lane",
      snapshots: [],
      tokenStats: null,
      goal: null,
      streaming: false,
    });

    expect(snapshot.scheduledWork.map((item) => item.id)).toEqual(["cron-1"]);
    expect(snapshot.backgroundWork.map((item) => item.id)).toEqual(["bg-1"]);
  });

  it("filters historical command-as-subagent snapshots out of the roster", () => {
    const snapshot = deriveChatInfoSnapshot({
      events: [],
      activeSession: session({ provider: "claude" }),
      provider: "claude",
      modelLabel: "claude-opus-4-8",
      laneLabel: "lane",
      snapshots: [
        { id: "real", name: "Explore renderer", kind: "subagent", status: "running", summary: "" },
        { id: "cmd", name: "npm run dev", kind: "subagent", status: "running", summary: "", taskType: "background" },
      ],
      tokenStats: null,
      goal: null,
      streaming: false,
    });

    expect(snapshot.snapshots.map((item) => item.id)).toEqual(["real"]);
  });
});
