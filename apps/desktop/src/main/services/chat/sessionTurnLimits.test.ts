import { describe, expect, it } from "vitest";
import type { AgentChatEvent } from "../../../shared/types";
import { clampTurnTimerMs, isForeignTurnEvent, trackTurnInFlight } from "./sessionTurnLimits";

const event = (value: Record<string, unknown>) => value as unknown as AgentChatEvent;

describe("trackTurnInFlight", () => {
  it("holds the idle watch open for foreground work but never for background tasks", () => {
    const inFlight = new Set<string>();
    trackTurnInFlight(inFlight, event({ type: "subagent_started", taskId: "bg", description: "watch", background: true }));
    trackTurnInFlight(inFlight, event({ type: "subagent_started", taskId: "cron", description: "tick", taskType: "background" }));
    expect(inFlight.size).toBe(0);

    trackTurnInFlight(inFlight, event({ type: "subagent_started", taskId: "fg", description: "review" }));
    trackTurnInFlight(inFlight, event({ type: "approval_request", itemId: "ask-1", kind: "command", description: "run?" }));
    trackTurnInFlight(inFlight, event({ type: "command", itemId: "cmd-1", command: "npm test", cwd: "/", output: "", status: "running" }));
    expect([...inFlight].sort()).toEqual(["command:cmd-1", "input:ask-1", "subagent:fg"]);

    trackTurnInFlight(inFlight, event({ type: "subagent_result", taskId: "fg", status: "completed" }));
    trackTurnInFlight(inFlight, event({ type: "pending_input_resolved", itemId: "ask-1", resolution: "accepted" }));
    trackTurnInFlight(inFlight, event({ type: "command", itemId: "cmd-1", command: "npm test", cwd: "/", output: "ok", status: "completed" }));
    expect(inFlight.size).toBe(0);
  });

  it("keeps a tool call open until a non-running result arrives", () => {
    const inFlight = new Set<string>();
    trackTurnInFlight(inFlight, event({ type: "tool_call", tool: "Bash", args: {}, itemId: "t1" }));
    trackTurnInFlight(inFlight, event({ type: "tool_result", tool: "Bash", result: "", itemId: "t1", status: "running" }));
    expect(inFlight.has("tool:t1")).toBe(true);
    trackTurnInFlight(inFlight, event({ type: "tool_result", tool: "Bash", result: "done", itemId: "t1", status: "completed" }));
    expect(inFlight.has("tool:t1")).toBe(false);
  });
});

describe("isForeignTurnEvent", () => {
  it("drops only events stamped with a different turn", () => {
    expect(isForeignTurnEvent("turn-2", "turn-1")).toBe(true);
    expect(isForeignTurnEvent("turn-2", "turn-2")).toBe(false);
    // Unknown on either side is not evidence of another turn.
    expect(isForeignTurnEvent(null, "turn-1")).toBe(false);
    expect(isForeignTurnEvent("turn-2", undefined)).toBe(false);
  });
});

describe("clampTurnTimerMs", () => {
  it("never passes a delay Node cannot hold, and never stops a turn instantly", () => {
    // Past 2^31-1 ms a Node timer fires at once.
    expect(clampTurnTimerMs(60 * 24 * 60 * 60_000)).toBe(2_147_483_647);
    expect(clampTurnTimerMs(10)).toBe(15_000);
    expect(clampTurnTimerMs(90_000.7)).toBe(90_000);
  });
});
