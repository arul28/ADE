import type { OpenCodeEvent } from "@opencode/client";
import { describe, expect, it } from "vitest";
import {
  mapOpenCodeChildEvent,
  openCodeChildSettled,
  openCodeChildStarted,
  rememberOpenCodeSubagentCall,
  type OpenCodeChildSessions,
} from "./openCodeChildSessions";

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
});
