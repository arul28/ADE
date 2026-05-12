import { describe, expect, it } from "vitest";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeInputPump } from "./claudeInputPump";

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    session_id: "",
  };
}

describe("ClaudeInputPump", () => {
  it("delivers buffered messages in order", async () => {
    const pump = new ClaudeInputPump();
    const first = userMessage("first");
    const second = userMessage("second");

    pump.push(first);
    pump.push(second);

    const iterator = pump[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: first });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: second });
  });

  it("resolves pending reads and closes cleanly", async () => {
    const pump = new ClaudeInputPump();
    const iterator = pump[Symbol.asyncIterator]();
    const pending = iterator.next();
    const message = userMessage("hello");

    pump.push(message);
    await expect(pending).resolves.toEqual({ done: false, value: message });

    pump.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects pushes after close", () => {
    const pump = new ClaudeInputPump();

    pump.close();

    expect(() => pump.push(userMessage("too late"))).toThrow(/closed/i);
  });
});
