import { describe, expect, it } from "vitest";
import type { AgentChatSessionStatus } from "../../../shared/types";
import type { ChatScheduledWorkSnapshot, ChatSubagentSnapshot } from "./chatExecutionSummary";
import {
  PANE_SELF_HEAL_CHAT_ENDED_SUMMARY,
  PANE_SELF_HEAL_CHAT_IDLE_SUMMARY,
  PANE_SELF_HEAL_RUNTIME_GONE_SUMMARY,
  paneRowChildSessionId,
  selfHealBackgroundSnapshots,
  selfHealSubagentSnapshots,
} from "./chatPaneSelfHeal";

function subagent(overrides: Partial<ChatSubagentSnapshot> = {}): ChatSubagentSnapshot {
  return {
    taskId: "task-1",
    description: "Audit chat renderer",
    status: "running",
    startedAt: "2026-09-18T02:00:00.000Z",
    updatedAt: "2026-09-18T02:00:10.000Z",
    summary: null,
    ...overrides,
  };
}

function background(overrides: Partial<ChatScheduledWorkSnapshot> = {}): ChatScheduledWorkSnapshot {
  return {
    id: "bg-1",
    kind: "background_task",
    status: "running",
    title: "npm run dev",
    summary: null,
    createdAt: "2026-09-18T02:00:00.000Z",
    updatedAt: "2026-09-18T02:00:00.000Z",
    ...overrides,
  };
}

const statuses = (entries: Record<string, AgentChatSessionStatus>) =>
  new Map<string, AgentChatSessionStatus>(Object.entries(entries));

describe("selfHealSubagentSnapshots", () => {
  it("heals nothing when the host cannot say whether the runtime is alive", () => {
    const input = [subagent()];
    expect(selfHealSubagentSnapshots(input, {})).toBe(input);
  });

  it("heals nothing while the runtime is alive and no child chat contradicts the row", () => {
    const input = [subagent()];
    expect(selfHealSubagentSnapshots(input, { runtimeAlive: true })).toBe(input);
  });

  it("stops every running row once the host says the runtime is gone", () => {
    const [healed] = selfHealSubagentSnapshots([subagent()], { runtimeAlive: false });
    expect(healed?.status).toBe("stopped");
    expect(healed?.summary).toBe(PANE_SELF_HEAL_RUNTIME_GONE_SUMMARY);
  });

  it("leaves already-terminal rows exactly as they are", () => {
    const done = subagent({ status: "completed", summary: "Shipped" });
    const [healed] = selfHealSubagentSnapshots([done], { runtimeAlive: false });
    expect(healed).toBe(done);
  });

  it("keeps a delegate running when its own subagent chat is still active", () => {
    const row = subagent({ taskId: "chat:child-1", childSessionId: "child-1" });
    const [healed] = selfHealSubagentSnapshots([row], {
      runtimeAlive: false,
      childChatStatuses: statuses({ "child-1": "active" }),
    });
    expect(healed?.status).toBe("running");
  });

  it("stops a delegate whose chat went idle even while the parent runtime is alive", () => {
    const row = subagent({ taskId: "chat:child-1", childSessionId: "child-1" });
    const [healed] = selfHealSubagentSnapshots([row], {
      runtimeAlive: true,
      childChatStatuses: statuses({ "child-1": "idle" }),
    });
    expect(healed?.status).toBe("stopped");
    expect(healed?.summary).toBe(PANE_SELF_HEAL_CHAT_IDLE_SUMMARY);
  });

  it("names an ended subagent chat as the reason", () => {
    const row = subagent({ taskId: "chat:child-1" });
    const [healed] = selfHealSubagentSnapshots([row], {
      runtimeAlive: false,
      childChatStatuses: statuses({ "child-1": "ended" }),
    });
    expect(healed?.summary).toBe(PANE_SELF_HEAL_CHAT_ENDED_SUMMARY);
  });

  it("preserves a summary the agent actually wrote", () => {
    const [healed] = selfHealSubagentSnapshots(
      [subagent({ summary: "Read 12 files" })],
      { runtimeAlive: false },
    );
    expect(healed?.summary).toBe("Read 12 files");
    expect(healed?.finalSummary).toBe("Read 12 files");
  });

  it("is idempotent — a second pass changes nothing and keeps the array identity", () => {
    const once = selfHealSubagentSnapshots([subagent()], { runtimeAlive: false });
    expect(selfHealSubagentSnapshots(once, { runtimeAlive: false })).toBe(once);
  });
});

describe("selfHealBackgroundSnapshots", () => {
  it("heals nothing on an unknown or live runtime", () => {
    const input = [background()];
    expect(selfHealBackgroundSnapshots(input, {})).toBe(input);
    expect(selfHealBackgroundSnapshots(input, { runtimeAlive: true })).toBe(input);
  });

  it("stops running, fired, and scheduled rows when the runtime is gone", () => {
    const healed = selfHealBackgroundSnapshots(
      [background(), background({ id: "bg-2", status: "fired" }), background({ id: "bg-3", status: "scheduled" })],
      { runtimeAlive: false },
    );
    expect(healed.map((item) => item.status)).toEqual(["stopped", "stopped", "stopped"]);
    expect(healed[0]?.summary).toBe(PANE_SELF_HEAL_RUNTIME_GONE_SUMMARY);
  });

  it("leaves completed rows alone", () => {
    const done = background({ status: "completed" });
    expect(selfHealBackgroundSnapshots([done], { runtimeAlive: false })[0]).toBe(done);
  });
});

describe("paneRowChildSessionId", () => {
  it("prefers the resolved childSessionId", () => {
    expect(paneRowChildSessionId(subagent({ taskId: "chat:x", childSessionId: "child-1" }))).toBe("child-1");
  });

  it("falls back to the chat: taskId", () => {
    expect(paneRowChildSessionId(subagent({ taskId: "chat:child-2" }))).toBe("child-2");
  });

  it("returns null for a plain SDK task row", () => {
    expect(paneRowChildSessionId(subagent({ taskId: "toolu_123" }))).toBeNull();
  });
});
