import { describe, expect, it } from "vitest";
import {
  createLocalReasoningToolCallRepairMiddleware,
  parseRequiredToolCallFromReasoning,
} from "./middleware";

async function collectStreamParts(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader();
  const parts: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function streamFromParts(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

describe("parseRequiredToolCallFromReasoning", () => {
  it("parses LM Studio reasoning-content XML tool calls", () => {
    const parsed = parseRequiredToolCallFromReasoning(
      [
        "<tool_call>",
        "<function=readFile>",
        "<parameter=file_path>",
        "/repo/apps/web/src/app/SiteRoutes.tsx",
        "</parameter>",
        "<parameter=offset>12</parameter>",
        "</function>",
        "</tool_call>",
      ].join("\n"),
      ["readFile"],
    );

    expect(parsed).toEqual({
      toolName: "readFile",
      input: {
        file_path: "/repo/apps/web/src/app/SiteRoutes.tsx",
        offset: 12,
      },
    });
  });

  it("ignores tool calls for tools that are not currently allowed", () => {
    const parsed = parseRequiredToolCallFromReasoning(
      "<tool_call><function=grep><parameter=pattern>Route</parameter></function></tool_call>",
      ["readFile"],
    );

    expect(parsed).toBeNull();
  });
});

describe("createLocalReasoningToolCallRepairMiddleware", () => {
  it("injects a synthetic tool-call chunk when a local openai-compatible runtime hides it in reasoning", async () => {
    const middleware = createLocalReasoningToolCallRepairMiddleware({
      id: "lmstudio/qwen3.5-9b",
      shortId: "qwen3.5-9b",
      displayName: "qwen3.5-9b",
      family: "lmstudio",
      authTypes: ["local"],
      contextWindow: 32768,
      maxOutputTokens: 4096,
      capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
      color: "#000000",
      sdkProvider: "@ai-sdk/openai-compatible",
      sdkModelId: "qwen3.5-9b",
      isCliWrapped: false,
    });

    const wrapped = await middleware.wrapStream?.({
      doStream: async () => ({
        stream: streamFromParts([
          { type: "reasoning-start", id: "reasoning-0" },
          { type: "reasoning-delta", id: "reasoning-0", delta: "<tool_call>\n<function=readFile>\n" },
          { type: "reasoning-delta", id: "reasoning-0", delta: "<parameter=file_path>\n/repo/apps/web/src/app/SiteRoutes.tsx\n</parameter>\n" },
          { type: "reasoning-delta", id: "reasoning-0", delta: "</function>\n</tool_call>" },
          { type: "reasoning-end", id: "reasoning-0" },
          { type: "finish-step", finishReason: "stop" },
        ]),
      }),
      params: {
        toolChoice: { type: "required" },
        tools: [
          { name: "readFile" },
        ],
      },
    } as never);

    const parts = await collectStreamParts(wrapped!.stream as ReadableStream<unknown>);
    const syntheticToolCall = parts.find(
      (part): part is { type: string; toolName?: string; input?: Record<string, unknown> } =>
        !!part && typeof part === "object" && (part as { type?: string }).type === "tool-call",
    );

    expect(syntheticToolCall).toEqual({
      type: "tool-call",
      toolCallId: expect.any(String),
      toolName: "readFile",
      input: JSON.stringify({
        file_path: "/repo/apps/web/src/app/SiteRoutes.tsx",
      }),
    });
  });
});
