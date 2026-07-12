import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";
import {
  backgroundCommandCwd,
  backgroundCommandLabel,
  deriveBackgroundItems,
  deriveActiveScheduleItems,
  deriveScheduleHistory,
  deriveScheduleItems,
  deriveScheduledWorkSnapshots,
  isEarlierBackgroundItem,
  isEarlierScheduleItem,
  nextCronFireAt,
  scheduledNextFireLabel,
  type ChatScheduledWorkSnapshot,
} from "./chatScheduledWork";

function envelope(event: AgentChatEvent, index: number): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: new Date(Date.UTC(2026, 0, 1, 12, index)).toISOString(),
    event,
  };
}

function snapshot(overrides: Partial<ChatScheduledWorkSnapshot>): ChatScheduledWorkSnapshot {
  return {
    id: "work-1",
    kind: "cron",
    status: "scheduled",
    title: "Scheduled task",
    summary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("chatScheduledWork helpers", () => {
  it("uses the shared Earlier membership for background and schedule rows", () => {
    expect(isEarlierBackgroundItem(snapshot({ kind: "background_task", status: "completed" }))).toBe(true);
    expect(isEarlierBackgroundItem(snapshot({ kind: "background_task", status: "failed" }))).toBe(false);
    expect(isEarlierScheduleItem(snapshot({ kind: "wakeup", status: "fired", recurring: false }))).toBe(true);
    expect(isEarlierScheduleItem(snapshot({ kind: "wakeup", status: "fired", recurring: true }))).toBe(false);
    expect(isEarlierScheduleItem(snapshot({ kind: "cron", status: "cancelled" }))).toBe(true);
    expect(isEarlierScheduleItem(snapshot({ kind: "cron", status: "missed" }))).toBe(false);
  });

  it("partitions schedule kinds from background tasks", () => {
    const kinds = ["wakeup", "cron", "loop", "remote_trigger", "background_task"] as const;
    const events = kinds.map((kind, index) => envelope({
      type: "scheduled_work_update",
      id: `${kind}-${index}`,
      kind,
      status: "scheduled",
    }, index));

    expect(deriveScheduleItems(events).map((item) => item.kind).sort()).toEqual([
      "cron",
      "loop",
      "remote_trigger",
      "wakeup",
    ]);
    expect(deriveBackgroundItems(events).map((item) => item.kind)).toEqual(["background_task"]);
  });

  it("filters historical Agent-as-Background duplicates by lifecycle identity", () => {
    const events = [
      envelope({
        type: "subagent_started",
        taskId: "agent-1",
        agentId: "agent-1",
        agentType: "Explore",
        taskType: "subagent",
        description: "Review code",
        background: true,
      }, 0),
      envelope({
        type: "scheduled_work_update",
        id: "background:agent-1",
        kind: "background_task",
        status: "running",
        sourceTaskId: "agent-1",
      }, 1),
      envelope({
        type: "scheduled_work_update",
        id: "background:shell-1",
        kind: "background_task",
        status: "running",
        sourceTaskId: "shell-1",
      }, 2),
    ];

    expect(deriveBackgroundItems(events).map((item) => item.id)).toEqual(["background:shell-1"]);
  });

  it("keeps recurring fired wakeups active and moves fired one-shots to history", () => {
    const events = [
      envelope({
        type: "scheduled_work_update",
        id: "wake-one-shot",
        kind: "wakeup",
        status: "fired",
        recurring: false,
      }, 0),
      envelope({
        type: "scheduled_work_update",
        id: "wake-recurring",
        kind: "wakeup",
        status: "fired",
        recurring: true,
        firedAt: "2026-01-01T12:01:00.000Z",
      }, 1),
      envelope({
        type: "scheduled_work_update",
        id: "cron-1",
        kind: "cron",
        status: "scheduled",
      }, 2),
    ];

    expect(deriveActiveScheduleItems(events).map((item) => item.id)).toEqual([
      "cron-1",
      "wake-recurring",
    ]);
    expect(deriveScheduleHistory(events)).toMatchObject([{
      id: "wake-one-shot",
      status: "fired",
    }]);
  });

  it("builds a compact label from a wrapped background command", () => {
    expect(backgroundCommandLabel("cd /x/y && FOO=1 nohup npx vitest run a.test.ts"))
      .toBe("npx vitest run a.test.ts");
    expect(backgroundCommandLabel("\n exec   npm   test \nignored" )).toBe("npm test");
    expect(backgroundCommandLabel("cd /x &&")).toBe("cd /x &&");
  });

  it("extracts the cwd from a leading cd prefix", () => {
    expect(backgroundCommandCwd("cd /x/y && npx vitest run a.test.ts")).toBe("/x/y");
    expect(backgroundCommandCwd("cd \"/path with spaces\" && npm test")).toBe("/path with spaces");
    expect(backgroundCommandCwd("cd '/single/quoted' && ls")).toBe("/single/quoted");
    // No cd prefix → null.
    expect(backgroundCommandCwd("npm test")).toBeNull();
    expect(backgroundCommandCwd("")).toBeNull();
    // A cd without a && chain is not a directory prefix for a command.
    expect(backgroundCommandCwd("cd /x")).toBeNull();
  });

  it("keeps background work running when its parent turn finishes", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "scheduled_work_update",
        id: "background-1",
        kind: "background_task",
        status: "running",
        turnId: "turn-1",
      }, 0),
      envelope({
        type: "scheduled_work_update",
        id: "cron-1",
        kind: "cron",
        status: "running",
        turnId: "turn-1",
      }, 1),
      envelope({ type: "done", turnId: "turn-1", status: "completed" }, 2),
    ];

    const snapshots = deriveScheduledWorkSnapshots(events);
    expect(snapshots.find((item) => item.id === "background-1")?.status).toBe("running");
    expect(snapshots.find((item) => item.id === "cron-1")?.status).toBe("running");
  });

  it("does not stop a background task updated after the turn terminal event", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "scheduled_work_update",
        id: "background-1",
        kind: "background_task",
        status: "running",
        turnId: "turn-1",
      }, 0),
      envelope({ type: "status", turnStatus: "completed", turnId: "turn-1" }, 1),
      envelope({
        type: "scheduled_work_update",
        id: "background-1",
        kind: "background_task",
        status: "running",
        turnId: "turn-1",
      }, 2),
    ];

    expect(deriveScheduledWorkSnapshots(events)[0]?.status).toBe("running");
  });

  it("computes deterministic next-fire labels for simple cron expressions", () => {
    const nowMs = new Date(2026, 0, 1, 6, 0, 0, 0).getTime();
    expect(scheduledNextFireLabel(snapshot({ cron: "0 9 * * *" }), nowMs))
      .toBe("next in 3h · 9:00 AM");
    expect(scheduledNextFireLabel(snapshot({ cron: "not a cron expression" }), nowMs)).toBeNull();
  });

  it.each([
    ["ranges", "10-12 6 * * *", 9, 10],
    ["stepped ranges", "10-50/20 6 * * *", 10, 30],
    ["offset steps", "5/20 6 * * *", 5, 25],
    ["wildcard steps", "*/15 6 * * *", 1, 15],
    ["lists", "5,25,45 6 * * *", 5, 25],
  ])("computes the next fire for %s", (_label, cron, currentMinute, expectedMinute) => {
    const nowMs = new Date(2026, 0, 1, 6, currentMinute, 0, 0).getTime();
    const expected = new Date(2026, 0, 1, 6, expectedMinute, 0, 0).getTime();
    expect(nextCronFireAt(cron, nowMs)).toBe(expected);
  });

  it("builds a next-fire label for a stepped cron range", () => {
    const nowMs = new Date(2026, 0, 1, 8, 0, 0, 0).getTime();
    expect(scheduledNextFireLabel(snapshot({ cron: "15-45/15 9 * * *" }), nowMs))
      .toBe("next in 1h 15m · 9:15 AM");
  });

  it("uses an explicit next-run timestamp for wakeups", () => {
    const nowMs = new Date(2026, 0, 1, 6, 0, 0, 0).getTime();
    const nextRunAt = new Date(2026, 0, 1, 6, 30, 0, 0).toISOString();
    expect(scheduledNextFireLabel(snapshot({ kind: "wakeup", nextRunAt }), nowMs))
      .toBe("next in 30m · 6:30 AM");
  });
});
