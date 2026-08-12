import { describe, expect, it } from "vitest";

import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  countHumanChildMessagesForTurn,
  formatHumanChildMessageAnnotation,
  isHumanChildMessage,
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

describe("isHumanChildMessage", () => {
  it("counts a plain human message", () => {
    expect(isHumanChildMessage({ type: "user_message", text: "hold on" })).toBe(true);
  });

  it("counts a handoff prompt as a human continuation", () => {
    expect(isHumanChildMessage({ type: "user_message", text: "…", metadata: { kind: "handoff" } })).toBe(true);
  });

  it("does not count a parent dispatch", () => {
    expect(isHumanChildMessage({
      type: "user_message",
      text: "Ship it.",
      metadata: { spawnDispatch: { parentSessionId: PARENT, dispatchedAt: "x" } },
    })).toBe(false);
  });

  it("does not count a scheduled wake", () => {
    expect(isHumanChildMessage({
      type: "user_message",
      text: "…",
      metadata: { scheduledWake: { scheduleId: "s", kind: "wakeup", firedAt: "x" } },
    })).toBe(false);
  });

  it("does not count a queued copy", () => {
    expect(isHumanChildMessage({ type: "user_message", text: "…", deliveryState: "queued" })).toBe(false);
  });

  it("does not count an orchestration directive as a human message", () => {
    expect(isHumanChildMessage({
      type: "user_message",
      text: "Ship the worker task.",
      metadata: { orchestrationOrigin: { runId: "r", fromSessionId: "lead", kind: "queue", intent: "directive" } },
    })).toBe(false);
  });
});

describe("countHumanChildMessagesForTurn", () => {
  it("counts human messages on the finished turn and ignores parent dispatches and other turns", () => {
    const history = [
      parentDispatch("t1"),
      humanMessage("t1"),
      humanMessage("t1"),
      scheduledWake("t2"),
      humanMessage("t2"),
    ];
    expect(countHumanChildMessagesForTurn(history, "t1")).toBe(2);
    expect(countHumanChildMessagesForTurn(history, "t2")).toBe(1);
  });
});

describe("formatHumanChildMessageAnnotation", () => {
  it("returns null when the user sent nothing", () => {
    expect(formatHumanChildMessageAnnotation(0)).toBeNull();
  });

  it("uses singular and plural copy", () => {
    expect(formatHumanChildMessageAnnotation(1)).toBe("The user also sent 1 message to this chat.");
    expect(formatHumanChildMessageAnnotation(3)).toBe("The user also sent 3 messages to this chat.");
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
