import type { OpenCodeEvent } from "@opencode/client";
import { describe, expect, it } from "vitest";
import { createOpenCodeTurnMapper } from "./openCodeEventMapper";

function makeMapper() {
  return createOpenCodeTurnMapper({
    turnId: "turn-1",
    deps: {
      activityForToolName: (tool: string) => ({ activity: "working" as const, detail: `Running ${tool}` }),
      reasoningDetail: "Thinking",
      workingDetail: "Working",
    },
    reasoningModel: false,
    contextWindow: null,
    model: undefined,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

describe("OpenCode turn mapper tool failures", () => {
  // A failed tool is the model's to read and carry on from: the failed row is
  // the whole report, and a chat-level `error` drew a turn-failure card over a
  // turn that kept going.
  it.each([
    [{ id: "call-1", error: { message: "command failed", type: "ShellError" } }, "command failed", "ShellError"],
    [{ id: "call-1" }, "Tool failed", null],
  ])("reports session.tool.failed as a failed tool_result, never a chat-level error (%#)", (data, message, errorType) => {
    const mapper = makeMapper();
    mapper.map({ type: "session.tool.input.started", data: { id: "call-1", name: "bash" } } as OpenCodeEvent);

    const out = mapper.map({ type: "session.tool.failed", data } as OpenCodeEvent);

    expect(out.map((entry) => entry.event.type)).toEqual(["tool_result"]);
    expect(out[0].event).toMatchObject({
      type: "tool_result",
      tool: "bash",
      status: "failed",
      result: { error: message, errorType },
      turnId: "turn-1",
    });
    expect(out.some((entry) => entry.event.type === "error")).toBe(false);
  });

  it("ignores a repeated end for a tool call already finished", () => {
    const mapper = makeMapper();
    mapper.map({ type: "session.tool.input.started", data: { id: "call-1", name: "bash" } } as OpenCodeEvent);

    const first = mapper.map({ type: "session.tool.failed", data: { id: "call-1" } } as OpenCodeEvent);
    const second = mapper.map({
      type: "session.tool.failed",
      data: { id: "call-1", error: { message: "again" } },
    } as OpenCodeEvent);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
