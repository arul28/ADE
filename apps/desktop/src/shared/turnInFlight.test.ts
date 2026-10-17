import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types";
import { latestTurnProgressAt, turnHasOpenWork } from "./turnInFlight";

const event = (value: Record<string, unknown>) => value as unknown as AgentChatEvent;

const envelope = (timestamp: string, value: Record<string, unknown>): AgentChatEventEnvelope => ({
  sessionId: "session-1",
  timestamp,
  event: event(value),
});

describe("turnHasOpenWork", () => {
  it.each([
    {
      name: "reports an open tool call as work in flight",
      events: [event({ type: "tool_call", tool: "Bash", args: {}, itemId: "t1" })],
      expected: true,
    },
    {
      name: "clears a tool once its non-running result arrives",
      events: [
        event({ type: "tool_call", tool: "Bash", args: {}, itemId: "t1" }),
        event({ type: "tool_result", tool: "Bash", result: "done", itemId: "t1", status: "completed" }),
      ],
      expected: false,
    },
    {
      // The stall case: an interrupt drops the turn before a tool ever gets a
      // result. Folding the whole session window would leave that tool open
      // forever, so a new turn must reset the fold at its `started` boundary.
      name: "does not let a dangling tool from an earlier turn hold a new turn open",
      events: [
        event({ type: "tool_call", tool: "Bash", args: {}, itemId: "old" }),
        event({ type: "status", turnStatus: "started" }),
        event({ type: "text", text: "a later turn" }),
      ],
      expected: false,
    },
    {
      // Codex's sleep tool is a deliberate wait, the same as a long command.
      name: "reports a running codex sleep as work in flight",
      events: [event({ type: "codex_sleep", itemId: "s1", status: "running" })],
      expected: true,
    },
    {
      name: "clears a codex sleep once its completed result arrives",
      events: [
        event({ type: "codex_sleep", itemId: "s1", status: "running" }),
        event({ type: "codex_sleep", itemId: "s1", status: "completed" }),
      ],
      expected: false,
    },
  ])("$name", ({ events, expected }) => {
    expect(turnHasOpenWork(events)).toBe(expected);
  });
});

describe("latestTurnProgressAt", () => {
  it.each([
    {
      name: "returns the newest real progress event's timestamp",
      envelopes: [envelope("2026-08-17T12:00:00.000Z", { type: "text", text: "working" })],
      expected: "2026-08-17T12:00:00.000Z",
    },
    {
      // ADE writes its own stall and recovery notices while a turn is quiet.
      // Counting them would let the notice reset the very silence it reports.
      name: "does not let trailing turn_health and codex_turn_recovery notices move the clock",
      envelopes: [
        envelope("2026-08-17T12:00:00.000Z", { type: "text", text: "working" }),
        envelope("2026-08-17T12:03:00.000Z", { type: "turn_health", state: "stalled" }),
        envelope("2026-08-17T12:04:00.000Z", { type: "codex_turn_recovery" }),
      ],
      expected: "2026-08-17T12:00:00.000Z",
    },
    {
      name: "does not let a trailing system_notice move the clock",
      envelopes: [
        envelope("2026-08-17T12:00:00.000Z", { type: "tool_call", tool: "Bash", itemId: "t1" }),
        envelope("2026-08-17T12:05:00.000Z", { type: "system_notice" }),
      ],
      expected: "2026-08-17T12:00:00.000Z",
    },
    {
      name: "skips a dropped steer and keeps the last accepted progress",
      envelopes: [
        envelope("2026-08-17T12:00:00.000Z", { type: "text", text: "working" }),
        envelope("2026-08-17T12:01:00.000Z", { type: "user_message", text: "steer", deliveryState: "failed" }),
      ],
      expected: "2026-08-17T12:00:00.000Z",
    },
    {
      name: "counts an accepted steer as progress",
      envelopes: [
        envelope("2026-08-17T12:00:00.000Z", { type: "text", text: "working" }),
        envelope("2026-08-17T12:01:00.000Z", { type: "user_message", text: "steer", deliveryState: "accepted" }),
      ],
      expected: "2026-08-17T12:01:00.000Z",
    },
    {
      name: "returns null for an empty window",
      envelopes: [],
      expected: null,
    },
    {
      name: "returns null when the window holds only ADE-written events",
      envelopes: [
        envelope("2026-08-17T12:00:00.000Z", { type: "session_meta_updated" }),
        envelope("2026-08-17T12:01:00.000Z", { type: "system_notice" }),
      ],
      expected: null,
    },
  ])("$name", ({ envelopes, expected }) => {
    expect(latestTurnProgressAt(envelopes)).toBe(expected);
  });
});
