import type { OpenCodeEvent } from "@opencode/client";
import { describe, expect, it } from "vitest";
import {
  mapOpenCodeChildEvent,
  openCodeChildSettled,
  openCodeChildStarted,
  rememberOpenCodeSubagentCall,
  takeUnbilledOpenCodeChildCost,
  type OpenCodeChildSessions,
} from "./openCodeChildSessions";
import { openCodeTurnCostUsd } from "./openCodeTurnUsage";

describe("OpenCode child sessions", () => {
  it("keeps a restarted child's progress attached to its parent tool call", () => {
    const state: OpenCodeChildSessions = {
      parentSessionId: "parent-session",
      subagents: new Map(),
      pendingSubagentCalls: [],
      callForChild: (childId) => childId === "child-session" ? "tool-call-1" : null,
    };
    rememberOpenCodeSubagentCall(state, "tool-call-1", { description: "Inspect files" });
    const started = openCodeChildStarted(
      state,
      { sessionID: "child-session", parentID: "parent-session" },
      "turn-1",
    );
    expect(started?.parentToolUseId).toBe("tool-call-1");
    expect(openCodeChildSettled(state, "child-session", "completed", "Finished")).not.toBeNull();

    const child = state.subagents.get("child-session");
    expect(child).toBeDefined();
    const progress = mapOpenCodeChildEvent(state, "child-session", child!, {
      type: "session.execution.started",
      data: { sessionID: "child-session" },
    } as OpenCodeEvent);

    expect(progress).toMatchObject([{
      type: "subagent_progress",
      taskId: "child-session",
      parentToolUseId: "tool-call-1",
    }]);
  });

  it("bills what subagents spend to exactly one parent turn", () => {
    const state: OpenCodeChildSessions = {
      parentSessionId: "parent-session",
      subagents: new Map(),
      pendingSubagentCalls: [],
      callForChild: () => null,
    };
    openCodeChildStarted(state, { sessionID: "child-session", parentID: "parent-session" }, "turn-1");
    const child = state.subagents.get("child-session")!;
    expect(child, "child tracked").toBeTruthy();
    const step = (messageId: string, cost: number) => mapOpenCodeChildEvent(state, "child-session", child, {
      type: "session.step.ended",
      data: { sessionID: "child-session", assistantMessageID: messageId, cost, tokens: { input: 10, output: 5 } },
    } as unknown as OpenCodeEvent);

    step("m1", 0.1);
    const firstTurn = takeUnbilledOpenCodeChildCost(state);
    expect(firstTurn).toBeCloseTo(0.1);
    // The parent's own steps cost 0.3: the turn bills both.
    expect(openCodeTurnCostUsd({ costUsd: 0.3, costSource: "provider" }, firstTurn)).toBeCloseTo(0.4);

    // A turn with no new child spend bills nothing of the child's again.
    expect(takeUnbilledOpenCodeChildCost(state)).toBe(0);
    expect(openCodeTurnCostUsd(null, 0)).toBeUndefined();

    // A background child keeps working after its turn: a re-sent step that
    // grew and a new step land on the next turn, once.
    step("m1", 0.12);
    step("m2", 0.05);
    const nextTurn = takeUnbilledOpenCodeChildCost(state);
    expect(nextTurn).toBeCloseTo(0.07);
    expect(openCodeTurnCostUsd(null, nextTurn)).toBeCloseTo(0.07);
  });
});
