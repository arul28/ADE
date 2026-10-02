import { describe, expect, it } from "vitest";
import type { AgentChatEvent } from "./types";
import { turnHasOpenWork } from "./turnInFlight";

const event = (value: Record<string, unknown>) => value as unknown as AgentChatEvent;

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
  ])("$name", ({ events, expected }) => {
    expect(turnHasOpenWork(events)).toBe(expected);
  });
});
