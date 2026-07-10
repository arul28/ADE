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

  it("partitions fired one-shot wakeups into schedule history", () => {
    const events = [
      envelope({
        type: "scheduled_work_update",
        id: "wake-1",
        kind: "wakeup",
        status: "scheduled",
      }, 0),
      envelope({
        type: "scheduled_work_update",
        id: "wake-1",
        kind: "wakeup",
        status: "completed",
        firedAt: "2026-01-01T12:01:00.000Z",
        late: true,
      }, 1),
      envelope({
        type: "scheduled_work_update",
        id: "cron-1",
        kind: "cron",
        status: "scheduled",
      }, 2),
    ];

    expect(deriveActiveScheduleItems(events).map((item) => item.id)).toEqual(["cron-1"]);
    expect(deriveScheduleHistory(events)).toMatchObject([{
      id: "wake-1",
      status: "completed",
      late: true,
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

  it("stops stale background work when its turn finishes without changing schedules", () => {
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
    expect(snapshots.find((item) => item.id === "background-1")?.status).toBe("stopped");
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

  it("uses an explicit next-run timestamp for wakeups", () => {
    const nowMs = new Date(2026, 0, 1, 6, 0, 0, 0).getTime();
    const nextRunAt = new Date(2026, 0, 1, 6, 30, 0, 0).toISOString();
    expect(scheduledNextFireLabel(snapshot({ kind: "wakeup", nextRunAt }), nowMs))
      .toBe("next in 30m · 6:30 AM");
  });
});
