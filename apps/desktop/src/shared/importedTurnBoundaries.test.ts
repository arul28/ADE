import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";
import { withImportedTurnBoundaries } from "./importedTurnBoundaries";

function env(event: AgentChatEvent, index: number): AgentChatEventEnvelope {
  return { sessionId: "s", timestamp: new Date(1_000 + index).toISOString(), event };
}

describe("withImportedTurnBoundaries", () => {
  it("closes each turn that did tool work so its tool calls show in the done summary", () => {
    const out = withImportedTurnBoundaries([
      env({ type: "user_message", text: "run tests" }, 0),
      env({ type: "tool_call", tool: "Bash", args: { command: "npm test" }, itemId: "t1" }, 1),
      env({ type: "tool_result", tool: "Bash", result: "ok", itemId: "t1" }, 2),
      env({ type: "text", text: "Tests pass." }, 3),
      env({ type: "user_message", text: "thanks" }, 4),
      env({ type: "text", text: "You're welcome." }, 5),
    ]);
    expect(out.map((e) => e.event.type)).toEqual([
      "user_message", "tool_call", "tool_result", "text", "done", "user_message", "text",
    ]);
    const done = out[4]!;
    expect(done.event).toMatchObject({ type: "done", status: "completed" });
    expect(done.timestamp).toBe(out[3]!.timestamp);
  });

  it("closes the last turn and leaves input that already has done events alone", () => {
    const withTool = [
      env({ type: "user_message", text: "go" }, 0),
      env({ type: "command", command: "ls", cwd: "/", output: "", itemId: "c", status: "completed" }, 1),
    ];
    expect(withImportedTurnBoundaries(withTool).at(-1)!.event.type).toBe("done");
    const already = [...withTool, env({ type: "done", turnId: "t", status: "completed" }, 2)];
    expect(withImportedTurnBoundaries(already)).toBe(already);
  });
});
