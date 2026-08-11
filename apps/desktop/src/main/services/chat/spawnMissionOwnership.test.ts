import { describe, expect, it } from "vitest";

import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  isMissionDirective,
  parentShouldWakeForChildTurn,
  stripHostAuthoredMessageProvenance,
} from "./spawnMissionOwnership";

const PARENT = "parent-session";
const CHILD = "child-session";

let sequence = 0;
const userMessage = (
  event: Partial<Extract<AgentChatEvent, { type: "user_message" }>>,
): AgentChatEventEnvelope => {
  sequence += 1;
  return {
    sessionId: CHILD,
    sequence,
    timestamp: new Date(Date.UTC(2026, 7, 11, 0, sequence)).toISOString(),
    event: { type: "user_message", text: "…", ...event },
  };
};

const parentDispatch = (turnId: string) => userMessage({
  turnId,
  metadata: { spawnDispatch: { parentSessionId: PARENT, dispatchedAt: "2026-08-11T00:00:00.000Z" } },
});
const humanMessage = (turnId: string) => userMessage({ turnId });
const scheduledWake = (turnId: string) => userMessage({
  turnId,
  metadata: { scheduledWake: { scheduleId: "wake-1", kind: "wakeup", firedAt: "2026-08-11T00:10:00.000Z" } },
});

describe("isMissionDirective", () => {
  it("counts a plain message as a directive", () => {
    expect(isMissionDirective({ type: "user_message", text: "do it" })).toBe(true);
  });

  it.each([
    ["a scheduler delivery", { scheduledWake: { scheduleId: "s", kind: "wakeup" as const, firedAt: "x" } }],
    ["a grandchild completion", { spawnCompletion: { childSessionId: "g", childTitle: "g", spawnKind: "subagent" as const, status: "completed" as const } }],
    ["another agent relaying", { agentRelay: { fromSessionId: "grandchild" } }],
    ["a host continuation", { hostContinuation: { reason: "interrupted_turn_recovery" as const } }],
    ["a legacy continuity recovery", { kind: "continuity_recovery" }],
    ["an orchestration worker status ping", { orchestrationOrigin: { runId: "r", fromSessionId: "worker", kind: "queue", intent: "status" } }],
    ["an orchestration question", { orchestrationOrigin: { runId: "r", fromSessionId: "worker", kind: "queue", intent: "question" } }],
  ])("does not count %s as a directive", (_label, metadata) => {
    expect(isMissionDirective({ type: "user_message", text: "…", metadata })).toBe(false);
  });

  it.each([["handoff"], ["cross_machine_handoff"]])(
    "counts a %s prompt as a directive — it carries a human's continuation intent",
    (kind) => {
      expect(isMissionDirective({ type: "user_message", text: "…", metadata: { kind } })).toBe(true);
    },
  );

  it("counts an explicit orchestration directive as a directive", () => {
    expect(isMissionDirective({
      type: "user_message",
      text: "…",
      metadata: { orchestrationOrigin: { runId: "r", fromSessionId: "lead", kind: "queue", intent: "directive" } },
    })).toBe(true);
  });

  it("does not count a queued message, whose delivered twin carries the real metadata", () => {
    expect(isMissionDirective({ type: "user_message", text: "…", deliveryState: "queued" })).toBe(false);
  });
});

describe("parentShouldWakeForChildTurn", () => {
  const shouldWake = (history: AgentChatEventEnvelope[], turnId: string) =>
    parentShouldWakeForChildTurn({ history, parentSessionId: PARENT, turnId });

  it("wakes for the turn the parent dispatched", () => {
    expect(shouldWake([parentDispatch("t1")], "t1")).toBe(true);
  });

  it("wakes for a scheduler-started turn while the parent owns the mission", () => {
    expect(shouldWake([parentDispatch("t1"), scheduledWake("t2")], "t2")).toBe(true);
  });

  it("stays quiet once a human takes the mission over", () => {
    expect(shouldWake([parentDispatch("t1"), humanMessage("t2")], "t2")).toBe(false);
    expect(shouldWake([parentDispatch("t1"), humanMessage("t2"), scheduledWake("t3")], "t3")).toBe(false);
  });

  it("returns to the parent when it dispatches again", () => {
    const history = [parentDispatch("t1"), humanMessage("t2"), parentDispatch("t3"), scheduledWake("t4")];
    expect(shouldWake(history, "t4")).toBe(true);
  });

  it("keeps ownership through a scheduled wake that was queued behind a busy turn", () => {
    // The queue path persists the queued copy without `scheduledWake`; the
    // delivered copy carries it. Counting the queued copy would read as a
    // directive and silently hand the mission away from the parent.
    const history = [
      parentDispatch("t1"),
      userMessage({ turnId: "t1", steerId: "s1", deliveryState: "queued" }),
      userMessage({
        turnId: "t2",
        steerId: "s1",
        deliveryState: "delivered",
        metadata: { scheduledWake: { scheduleId: "wake-1", kind: "wakeup", firedAt: "2026-08-11T00:10:00.000Z" } },
      }),
    ];
    expect(shouldWake(history, "t2")).toBe(true);
  });

  it("keeps ownership when an orchestration worker reports status to a lead that is itself a subagent", () => {
    const history = [
      parentDispatch("t1"),
      userMessage({
        turnId: "t2",
        metadata: { orchestrationOrigin: { runId: "r", fromSessionId: "worker", kind: "queue", intent: "status" } },
      }),
    ];
    expect(shouldWake(history, "t2")).toBe(true);
  });

  it("keeps ownership when the child's own grandchild reports in", () => {
    const history = [
      parentDispatch("t1"),
      userMessage({ turnId: "t2", metadata: { agentRelay: { fromSessionId: "grandchild" } } }),
    ];
    expect(shouldWake(history, "t2")).toBe(true);
  });

  it("still wakes for a parent-dispatched turn a human interrupted mid-flight", () => {
    // Ownership moved to the human, but the parent is still owed the result of
    // the turn it started.
    const history = [parentDispatch("t1"), humanMessage("t2")];
    expect(shouldWake(history, "t1")).toBe(true);
  });

  it("still wakes when a human steers inline into the parent-dispatched turn", () => {
    // An inline steer joins the running turn and reuses its id, so the turn's
    // last user message is the human's — the parent dispatch is still in there.
    const history = [parentDispatch("t1"), humanMessage("t1")];
    expect(shouldWake(history, "t1")).toBe(true);
  });

  it("does not wake for a parent message still queued behind someone else's turn", () => {
    // The queued row carries the running turn's id. Counting it would wake the
    // parent for a turn a human started, before the parent's own message ran.
    const history = [
      humanMessage("t1"),
      userMessage({
        turnId: "t1",
        steerId: "s1",
        deliveryState: "queued",
        metadata: { spawnDispatch: { parentSessionId: PARENT, dispatchedAt: "2026-08-11T00:05:00.000Z" } },
      }),
    ];
    expect(shouldWake(history, "t1")).toBe(false);
  });

  it("stays quiet for a child with no parent-dispatched history at all", () => {
    expect(shouldWake([humanMessage("t1")], "t1")).toBe(false);
    expect(shouldWake([], "t1")).toBe(false);
  });

  it("ignores a stamp naming a different parent", () => {
    const history = [userMessage({
      turnId: "t1",
      metadata: { spawnDispatch: { parentSessionId: "someone-else", dispatchedAt: "x" } },
    })];
    expect(shouldWake(history, "t1")).toBe(false);
  });
});

describe("stripHostAuthoredMessageProvenance", () => {
  it("removes every host-authored marker and keeps caller data", () => {
    const metadata: Record<string, unknown> = {
      requestId: "req-1",
      spawnDispatch: { parentSessionId: PARENT, dispatchedAt: "x" },
      agentRelay: { fromSessionId: "x" },
      hostContinuation: { reason: "plan_followup" },
      scheduledWake: { scheduleId: "s", kind: "wakeup", firedAt: "x" },
      spawnCompletion: { childSessionId: "c", childTitle: "c", spawnKind: "subagent", status: "completed" },
    };
    stripHostAuthoredMessageProvenance(metadata);
    expect(metadata).toEqual({ requestId: "req-1" });
  });
});
