import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import { createChatSession, DEFAULT_CODEX_REASONING_EFFORT, latestTokenStats, sendChatMessage } from "../adeApi";
import type { AdeCodeConnection } from "../types";

function envelope(
  sequence: number,
  event: AgentChatEventEnvelope["event"],
): AgentChatEventEnvelope {
  return {
    sessionId: "s1",
    timestamp: `2026-01-01T12:00:0${sequence}.000Z`,
    sequence,
    event,
  };
}

describe("latestTokenStats", () => {
  it("tracks streaming state, context percentage, token counts, and cost", () => {
    const events = [
      envelope(1, { type: "status", turnStatus: "started" }),
      envelope(2, {
        type: "tokens",
        turnId: "turn-1",
        inputTokens: 2_000,
        outputTokens: 500,
        contextWindow: 10_000,
      } as AgentChatEventEnvelope["event"]),
      envelope(3, {
        type: "done",
        turnId: "turn-1",
        status: "completed",
        usage: { inputTokens: 2_100, outputTokens: 700 },
        costUsd: 0.42,
      }),
    ];

    expect(latestTokenStats(events)).toEqual({
      percent: 28,
      streaming: false,
      inputTokens: 2_100,
      outputTokens: 700,
      costUsd: 0.42,
    });
  });

  it("falls back to the active model contextWindow when the event omits one", () => {
    const events = [
      envelope(1, { type: "status", turnStatus: "started" }),
      envelope(2, {
        type: "done",
        turnId: "turn-1",
        status: "completed",
        usage: { inputTokens: 40_000, outputTokens: 10_000 },
        costUsd: 0.12,
      }),
    ];

    expect(latestTokenStats(events, 200_000)).toEqual({
      percent: 25,
      streaming: false,
      inputTokens: 40_000,
      outputTokens: 10_000,
      costUsd: 0.12,
    });
  });

  it("returns null percent when no contextWindow is available", () => {
    const events = [
      envelope(1, {
        type: "done",
        turnId: "turn-1",
        status: "completed",
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ];
    expect(latestTokenStats(events).percent).toBeNull();
  });
});

describe("createChatSession", () => {
  it("defaults Codex chats to GPT-5.5 low reasoning", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return {
          id: "chat-1",
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        };
      },
    } as unknown as AdeCodeConnection;

    await createChatSession({ connection, laneId: "lane-1" });

    expect(calls).toEqual([
      expect.objectContaining({
        domain: "chat",
        action: "createSession",
        args: expect.objectContaining({
          provider: "codex",
          model: "gpt-5.5",
          modelId: "openai/gpt-5.5",
          reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
          surface: "work",
        }),
      }),
    ]);
  });

  it("passes native model controls when creating chats", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return {
          id: "chat-1",
          laneId: "lane-1",
          provider: args?.provider,
          model: args?.model,
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        };
      },
    } as unknown as AdeCodeConnection;

    await createChatSession({
      connection,
      laneId: "lane-1",
      provider: "codex",
      modelId: "openai/gpt-5.5",
      reasoningEffort: "high",
      codexFastMode: true,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });

    expect(calls[0]?.args).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-5.5",
      modelId: "openai/gpt-5.5",
      reasoningEffort: "high",
      codexFastMode: true,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    }));
  });
});

describe("sendChatMessage", () => {
  it("waits until the runtime has accepted the turn", async () => {
    const calls: Array<{ domain: string; action: string; argsList: unknown[] }> = [];
    const connection = {
      actionList: async (domain: string, action: string, argsList: unknown[]) => {
        calls.push({ domain, action, argsList });
      },
    } as unknown as AdeCodeConnection;

    await sendChatMessage(connection, "chat-1", "hello");

    expect(calls).toEqual([
      {
        domain: "chat",
        action: "sendMessage",
        argsList: [
          { sessionId: "chat-1", text: "hello" },
          { awaitDispatch: true },
        ],
      },
    ]);
  });
});
