import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claudeSdk = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  releaseIdleMessages: null as null | (() => void),
}));

function makeClaudeQuery(messages: Array<Record<string, unknown>>) {
  let releaseIdleMessages!: () => void;
  const idleGate = new Promise<void>((resolve) => {
    releaseIdleMessages = resolve;
  });
  claudeSdk.releaseIdleMessages = releaseIdleMessages;
  const iterator = (async function* () {
    yield { type: "system", subtype: "init", session_id: "sdk-text-dedup", slash_commands: [] };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sdk-text-dedup",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    await idleGate;
    for (const message of messages) yield message;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sdk-text-dedup",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  })();
  return Object.assign(iterator, {
    close: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    reloadPlugins: vi.fn(async () => ({ commands: [], agents: [], plugins: [], error_count: 0 })),
    supportedCommands: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({
      categories: [],
      totalTokens: 0,
      maxTokens: 0,
      rawMaxTokens: 0,
      percentage: 0,
      gridRows: [],
      model: "",
    })),
  });
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((config: { name?: string; tools?: Array<{ name: string }> }) => ({
    type: "sdk",
    name: config?.name,
    instance: {
      _registeredTools: Object.fromEntries((config?.tools ?? []).map((tool) => [tool.name, tool])),
    },
  })),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  query: vi.fn(() => makeClaudeQuery(claudeSdk.messages)),
  renameSession: vi.fn(async () => undefined),
  startup: vi.fn(async () => ({
    query: () => makeClaudeQuery(claudeSdk.messages),
    close: vi.fn(),
  })),
  tagSession: vi.fn(async () => undefined),
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));

vi.mock("@factory/droid-sdk", () => ({
  createSdkMcpServer: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));

vi.mock("../ai/tools/universalTools", () => ({
  createUniversalToolSet: vi.fn(() => ({
    readFile: { description: "stub", parameters: {}, execute: vi.fn() },
    grep: { description: "stub", parameters: {}, execute: vi.fn() },
    TodoRead: { description: "stub", parameters: {}, execute: vi.fn() },
    TodoWrite: { description: "stub", parameters: {}, execute: vi.fn() },
    bash: { description: "stub", parameters: {}, execute: vi.fn() },
  })),
}));
vi.mock("../ai/tools/workflowTools", () => ({ createWorkflowTools: vi.fn(() => []) }));
vi.mock("../ai/tools/linearTools", () => ({ createLinearTools: vi.fn(() => []) }));
vi.mock("../ai/tools/ctoOperatorTools", () => ({ createCtoOperatorTools: vi.fn(() => []) }));
vi.mock("../ai/tools/systemPrompt", () => ({
  buildCodingAgentSystemPrompt: vi.fn(() => "system prompt"),
  composeSystemPrompt: vi.fn(() => "system prompt"),
}));
vi.mock("../ai/claudeModelUtils", () => ({ resolveClaudeCliModel: vi.fn((model: string) => model) }));
vi.mock("../ai/providerRuntimeHealth", () => ({
  getProviderRuntimeHealth: vi.fn(() => null),
  reportProviderRuntimeAuthFailure: vi.fn(),
  reportProviderRuntimeFailure: vi.fn(),
  reportProviderRuntimeReady: vi.fn(),
}));
vi.mock("../ai/claudeRuntimeProbe", () => ({
  CLAUDE_RUNTIME_AUTH_ERROR: "Claude authentication failed",
  isClaudeRuntimeAuthError: vi.fn(() => false),
}));
vi.mock("../ai/claudeCodeExecutable", () => ({
  isExecutablePath: vi.fn(() => true),
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/usr/local/bin/claude", source: "path" })),
}));
vi.mock("../ai/authDetector", () => ({ detectAllAuth: vi.fn(async () => []) }));
vi.mock("../git/git", () => ({ runGit: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) }));
vi.mock("./permissionMapping", () => ({
  mapPermissionToClaude: vi.fn(() => "default"),
  mapPermissionToCodex: vi.fn(() => ({ approvalPolicy: "on-request", sandbox: "read-only" })),
}));
vi.mock("../../../shared/chatTranscript", () => ({ parseAgentChatTranscript: vi.fn(() => []) }));

import { createAgentChatService } from "./agentChatService";
import type { AgentChatEventEnvelope } from "../../../shared/types";

let tempRoot: string;

function createHarness(messages: Array<Record<string, unknown>>) {
  claudeSdk.messages = messages;
  claudeSdk.releaseIdleMessages = null;

  const sessions = new Map<string, Record<string, any>>();
  const claudePointers = new Map<string, Record<string, any>>();
  const sessionService = {
    create: vi.fn((args: Record<string, any>) => {
      sessions.set(args.sessionId, {
        id: args.sessionId,
        laneId: args.laneId,
        title: args.title ?? "Chat",
        toolType: args.toolType ?? "claude-chat",
        status: "running",
        startedAt: args.startedAt ?? new Date().toISOString(),
        endedAt: null,
        archivedAt: null,
        transcriptPath: args.transcriptPath ?? "",
        resumeCommand: args.resumeCommand ?? null,
        goal: args.goal ?? null,
        manuallyNamed: false,
      });
    }),
    get: vi.fn((sessionId: string) => sessions.get(sessionId) ?? null),
    list: vi.fn(() => [...sessions.values()]),
    reopen: vi.fn(),
    end: vi.fn(),
    deleteSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    updateMeta: vi.fn(),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
    clearTurnStartMarkers: vi.fn(),
    markLastTurnFailed: vi.fn(),
    clearLastTurnFailed: vi.fn(),
    setSummary: vi.fn(),
    setResumeCommand: vi.fn(),
    upsertClaudeSessionPointer: vi.fn((pointer: Record<string, any>) => {
      const next = { ...claudePointers.get(pointer.chatSessionId), ...pointer };
      if (pointer.chatSessionId) claudePointers.set(pointer.chatSessionId, next);
      return next;
    }),
    getClaudeSessionPointer: vi.fn(() => null),
    getClaudeSessionPointerByChatSessionId: vi.fn((sessionId: string) => claudePointers.get(sessionId) ?? null),
    listClaudeSessionPointers: vi.fn(() => [...claudePointers.values()]),
  };
  const laneService = {
    getLaneBaseAndBranch: vi.fn(() => ({
      baseRef: "main",
      branchRef: "feature/test",
      worktreePath: tempRoot,
      laneType: "feature",
    })),
    list: vi.fn(async () => []),
    getSummary: vi.fn(async () => null),
    getLane: vi.fn(() => null),
    listLinearIssuesForSession: vi.fn(() => []),
  };
  const events: AgentChatEventEnvelope[] = [];
  const transcriptsDir = path.join(tempRoot, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const service = createAgentChatService({
    projectRoot: tempRoot,
    transcriptsDir,
    laneService: laneService as any,
    sessionService: sessionService as any,
    projectConfigService: {
      get: vi.fn(() => ({
        effective: {
          ai: {
            permissions: { cli: { mode: "edit" }, inProcess: { mode: "edit" } },
            chat: {},
            sessionIntelligence: {},
          },
        },
      })),
      getAll: vi.fn(() => ({})),
      set: vi.fn(),
    } as any,
    aiIntegrationService: {
      summarizeTerminal: vi.fn(async () => ({ text: "", structuredOutput: null })),
      getMode: vi.fn(() => "subscription"),
    } as any,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    appVersion: "0.0.1-test",
    getDirtyFileTextForPath: () => undefined,
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
  });
  return { service, events };
}

async function runTextFixture(messages: Array<Record<string, unknown>>) {
  const { service, events } = createHarness(messages);
  const session = await service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
  });
  await service.runSessionTurn({ sessionId: session.id, text: "Exercise Claude text deduplication." });
  expect(claudeSdk.releaseIdleMessages, "Claude query should be waiting at the idle-reader boundary").toBeTypeOf("function");
  claudeSdk.releaseIdleMessages?.();
  await vi.waitFor(() => {
    expect(events.filter((envelope) => envelope.sessionId === session.id && envelope.event.type === "done")).toHaveLength(2);
  }, { timeout: 2_000 });
  await service.disposeAll();
  return events
    .filter((envelope) => envelope.sessionId === session.id)
    .map((envelope) => envelope.event)
    .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
}

function messageStart(messageId: string) {
  return {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
    },
  };
}

function textDelta(messageId: string, text: string) {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      message: { id: messageId },
      delta: { type: "text_delta", text },
    },
  };
}

function assistantSnapshot(
  messageId: string,
  text: string,
  extras: { timestamp?: string; resumedFromIncompleteThinking?: boolean } = {},
) {
  return {
    type: "assistant",
    ...(extras.timestamp ? { timestamp: extras.timestamp } : {}),
    ...(extras.resumedFromIncompleteThinking ? { resumed_from_incomplete_thinking: true } : {}),
    message: {
      id: messageId,
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-text-dedup-"));
  fs.mkdirSync(path.join(tempRoot, ".ade", "cache", "chat-sessions"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".ade", "transcripts", "chat"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Claude assistant text snapshot deduplication", () => {
  it("emits only the unseen suffix when a full snapshot follows streamed prefix deltas", async () => {
    const messageId = "msg-prefix-then-snapshot";
    const fullText = "I checked the renderer and added focused tests.";
    const textEvents = await runTextFixture([
      messageStart(messageId),
      textDelta(messageId, "I checked "),
      textDelta(messageId, "the renderer"),
      assistantSnapshot(messageId, fullText),
    ]);

    expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
    expect(textEvents.every((event) => event.messageId === messageId)).toBe(true);
    expect(textEvents.map((event) => event.text).join("").match(/I checked the renderer/g)).toHaveLength(1);
  });

  it("does not re-emit an old full snapshot after another message_start resets stream-local state", async () => {
    const messageId = "msg-redelivered-after-other-start";
    const fullText = "Review findings are synthesized.";
    const textEvents = await runTextFixture([
      messageStart(messageId),
      textDelta(messageId, "Review findings "),
      assistantSnapshot(messageId, fullText),
      messageStart("msg-different"),
      assistantSnapshot(messageId, fullText),
    ]);

    expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
    expect(textEvents.every((event) => event.messageId === messageId)).toBe(true);
    expect(textEvents.map((event) => event.text).join("").match(/Review findings/g)).toHaveLength(1);
  });

  it("emits identical back-to-back assistant snapshots only once", async () => {
    const messageId = "msg-identical-snapshots";
    const fullText = "The final answer appears once.";
    const textEvents = await runTextFixture([
      assistantSnapshot(messageId, fullText),
      assistantSnapshot(messageId, fullText),
    ]);

    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toMatchObject({ text: fullText, messageId });
    expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
  });

  it("preserves resumed incomplete-thinking text and its provider timestamp", async () => {
    const messageId = "msg-resumed-incomplete-thinking";
    const fullText = "Recovered text must not be discarded.";
    const originTimestamp = "2026-07-16T14:15:16.000Z";
    const textEvents = await runTextFixture([
      assistantSnapshot(messageId, fullText),
      assistantSnapshot(messageId, fullText, {
        timestamp: originTimestamp,
        resumedFromIncompleteThinking: true,
      }),
    ]);

    expect(textEvents.map((event) => event.text).join("")).toBe(`${fullText}${fullText}`);
    expect(textEvents.at(-1)).toMatchObject({
      messageId,
      originTimestamp,
    });
  });
});
