import { describe, expect, it } from "vitest";
import { HOST_ONLY_CHAT_METADATA_KEYS } from "../../../shared/chatAutoResume";

import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  countHumanChildMessagesForTurn,
  formatHumanChildMessageAnnotation,
  isHumanChildMessage,
  HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS,
  messageClearsAttentionMarkers,
  resolveSpawnEndedTurnId,
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

  it("counts a steer once, on the turn where the model got it", () => {
    // A steer writes one row per lifecycle state on the same steerId.
    const history = [
      userMessage({ turnId: "t1", steerId: "folded", deliveryState: "accepted" }),
      userMessage({ turnId: "t1", steerId: "folded", deliveryState: "inline" }),
      // Refused on t1, then sent as its own turn t2.
      userMessage({ turnId: "t1", steerId: "refused", deliveryState: "accepted" }),
      userMessage({ turnId: "t1", steerId: "refused", deliveryState: "queued" }),
      userMessage({ turnId: "t2", steerId: "refused", deliveryState: "delivered" }),
      // Went nowhere.
      userMessage({ turnId: "t1", steerId: "dropped", deliveryState: "accepted" }),
      userMessage({ turnId: "t1", steerId: "dropped", deliveryState: "failed" }),
    ];
    expect(countHumanChildMessagesForTurn(history, "t1")).toBe(1);
    expect(countHumanChildMessagesForTurn(history, "t2")).toBe(1);
    expect(countHumanChildMessagesForTurn(history, "t3")).toBe(0);
  });
});

describe("resolveSpawnEndedTurnId", () => {
  const lifecycle = (
    type: "status" | "done",
    turnId: string,
    provenance?: AgentChatEventEnvelope["provenance"],
  ): AgentChatEventEnvelope => {
    sequence += 1;
    return {
      sessionId: CHILD,
      sequence,
      timestamp: new Date(Date.UTC(2026, 7, 11, 1, sequence)).toISOString(),
      event: (type === "done"
        ? { type: "done", turnId, status: "completed" }
        : { type: "status", turnId, turnStatus: "started" }) as AgentChatEvent,
      ...(provenance ? { provenance } : {}),
    };
  };
  const deliveryFailed = (childTurnId: string): AgentChatEventEnvelope => {
    sequence += 1;
    return {
      sessionId: CHILD,
      sequence,
      timestamp: new Date(Date.UTC(2026, 7, 11, 2, sequence)).toISOString(),
      event: {
        type: "system_notice",
        noticeKind: "warning",
        message: "Could not tell the parent.",
        status: "spawn_completion_delivery_failed",
        detail: { spawnCompletionDeliveryFailure: { childTurnId: ` ${childTurnId} ` } },
      } as AgentChatEvent,
    };
  };

  it.each([
    {
      label: "skips an idle child whose latest turn already reported",
      history: () => [lifecycle("status", "t1"), lifecycle("done", "t1")],
      expected: null,
    },
    {
      label: "reports a done turn whose delivery failed",
      history: () => [lifecycle("done", "t1"), deliveryFailed("t1")],
      expected: "t1",
    },
    {
      label: "does not let another turn's failure notice re-report the latest turn",
      history: () => [lifecycle("done", "t0"), deliveryFailed("t0"), lifecycle("done", "t1")],
      expected: null,
    },
    {
      label: "takes the live turn id mid-turn after a reported turn",
      history: () => [lifecycle("done", "t1")],
      childMidTurn: true,
      liveTurnId: "t2",
      expected: "t2",
    },
    {
      label: "falls back mid-turn when the live turn has no id yet",
      history: () => [lifecycle("done", "t1")],
      childMidTurn: true,
      expected: "fallback",
    },
    {
      label: "reports a latest turn that never finished",
      history: () => [lifecycle("done", "t1"), lifecycle("status", "t2")],
      expected: "t2",
    },
    {
      label: "uses the recent entry turn when no turn ever got a lifecycle id",
      history: () => [],
      recentEntryTurnId: " r1 ",
      expected: "r1",
    },
    {
      label: "falls back when no turn ever got any id",
      history: () => [],
      expected: "fallback",
    },
    {
      label: "ignores a Codex subagent thread's lifecycle",
      history: () => [
        lifecycle("status", "t1"),
        lifecycle("done", "sub-1", { targetKind: "codex_subagent" } as AgentChatEventEnvelope["provenance"]),
      ],
      expected: "t1",
    },
    {
      label: "reports an idless done after a reported turn under this done's own id",
      history: () => [lifecycle("status", "t1"), lifecycle("done", "t1")],
      source: "done" as const,
      expected: "fallback",
    },
    {
      label: "files an idless done under the open turn it ends",
      history: () => [lifecycle("status", "t1"), lifecycle("done", "t1"), lifecycle("status", "t2")],
      source: "done" as const,
      expected: "t2",
    },
    {
      label: "does not file an idless done under an older turn that still looks open",
      history: () => [lifecycle("status", "t1"), lifecycle("status", "t2"), lifecycle("done", "t2")],
      source: "done" as const,
      expected: "fallback",
    },
  ])("$label", ({ history, childMidTurn, liveTurnId, recentEntryTurnId, source, expected }) => {
    expect(resolveSpawnEndedTurnId({
      history: history(),
      childMidTurn: childMidTurn ?? false,
      liveTurnId: liveTurnId ?? null,
      recentEntryTurnId: recentEntryTurnId ?? null,
      fallbackId: "fallback",
      source: source ?? "delete",
    })).toBe(expected);
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

  it("removes the host-only dispatch markers too", () => {
    // Both keys exempt their message from the auto-resume cancel sweep, so an
    // untrusted caller that could assert either one would leave a chat's resume
    // armed through real activity to fire unattended later.
    const metadata: Record<string, unknown> = {
      requestId: "req-2",
      usageLimitResume: "manual",
      scheduledWake: { scheduleId: "s", kind: "wakeup", firedAt: "x" },
    };
    stripHostAuthoredMessageProvenance(metadata);
    expect(metadata).toEqual({ requestId: "req-2" });
  });

  it("contains every host-only chat metadata key", () => {
    // Spread, not copied: a key added to the dispatch-exemption set must reach
    // the untrusted edges without anyone remembering to update this list.
    for (const key of HOST_ONLY_CHAT_METADATA_KEYS) {
      expect(HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS).toContain(key);
    }
  });
});

describe("messageClearsAttentionMarkers", () => {
  it("treats a plain message as the user engaging", () => {
    expect(messageClearsAttentionMarkers(undefined)).toBe(true);
    expect(messageClearsAttentionMarkers(null)).toBe(true);
    expect(messageClearsAttentionMarkers({})).toBe(true);
  });

  it("refuses every host-authored delivery", () => {
    // The reported bug in one assertion: a child reporting in must not be able
    // to clear the parent's raised hand. Nor may a scheduler, nor a
    // continuation prompt ADE wrote itself.
    expect(messageClearsAttentionMarkers({
      spawnCompletion: { childSessionId: "c", childTitle: "t", summary: "s" },
    } as never)).toBe(false);
    expect(messageClearsAttentionMarkers({
      hostContinuation: { reason: "plan_followup" },
    } as never)).toBe(false);
    expect(messageClearsAttentionMarkers({
      scheduledWake: { scheduleId: "s", kind: "cron", firedAt: "now", reason: "tick" },
    } as never)).toBe(false);
  });

  it("lets a board move clear, because a drag is a person acting", () => {
    expect(messageClearsAttentionMarkers({
      boardMove: { from: "done", to: "working", at: "2026-09-11T00:00:00.000Z", moveId: "m" },
    } as never)).toBe(true);
  });

  it("does not let a move INTO Needs you erase the hand it just raised", () => {
    expect(messageClearsAttentionMarkers({
      boardMove: { from: "working", to: "needs_you", at: "2026-09-11T00:00:00.000Z", moveId: "m" },
    } as never)).toBe(false);
  });
});
