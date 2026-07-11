import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claudeSdk = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
}));

function makeClaudeQuery(messages: Array<Record<string, unknown>>) {
  const iterator = (async function* () {
    for (const message of messages) yield message;
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
  claudeSdk.messages = [
    { type: "system", subtype: "init", session_id: "sdk-task-todos", slash_commands: [] },
    ...messages,
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sdk-task-todos",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ];

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

async function runTaskFixture(messages: Array<Record<string, unknown>>) {
  const { service, events } = createHarness(messages);
  const session = await service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
  });
  await service.runSessionTurn({ sessionId: session.id, text: "Exercise Claude task tracking." });
  await service.disposeAll();
  return events
    .filter((envelope) => envelope.sessionId === session.id)
    .map((envelope) => envelope.event)
    .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "todo_update" }> =>
      event.type === "todo_update",
    );
}

function taskToolUse(id: string, name: "TaskCreate" | "TaskUpdate", input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name, input }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-task-todos-"));
  fs.mkdirSync(path.join(tempRoot, ".ade", "cache", "chat-sessions"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".ade", "transcripts", "chat"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Claude TaskCreate and TaskUpdate todo tracking", () => {
  it("remaps ordinal task id 1 onto the first created task without fabricating a ghost row", async () => {
    const todoEvents = await runTaskFixture([
      taskToolUse("toolu_A", "TaskCreate", { subject: "Synthesize review findings" }),
      taskToolUse("toolu_B", "TaskUpdate", { taskId: "1", status: "in_progress" }),
    ]);

    expect(todoEvents).toHaveLength(2);
    expect(todoEvents[0].items).toEqual([
      { id: "toolu_A", description: "Synthesize review findings", status: "pending" },
    ]);
    expect(todoEvents[1].items).toEqual([
      { id: "1", description: "Synthesize review findings", status: "in_progress" },
    ]);
    expect(todoEvents[1].items.some((item) => item.description === "1")).toBe(false);
  });

  it("maps ordinal task id 2 to the second created task while preserving order and the first task", async () => {
    const todoEvents = await runTaskFixture([
      taskToolUse("toolu_A", "TaskCreate", { subject: "Inspect implementation" }),
      taskToolUse("toolu_B", "TaskCreate", { subject: "Write regression tests" }),
      taskToolUse("toolu_C", "TaskUpdate", { taskId: "2", status: "completed" }),
    ]);

    expect(todoEvents).toHaveLength(3);
    expect(todoEvents.at(-1)?.items).toEqual([
      { id: "toolu_A", description: "Inspect implementation", status: "pending" },
      { id: "2", description: "Write regression tests", status: "completed" },
    ]);
    expect(todoEvents.at(-1)?.items.map((item) => item.description)).toEqual([
      "Inspect implementation",
      "Write regression tests",
    ]);
  });

  it("ignores a bare update for an unknown ordinal instead of emitting a fabricated todo", async () => {
    const todoEvents = await runTaskFixture([
      taskToolUse("toolu_A", "TaskCreate", { subject: "Only known task" }),
      taskToolUse("toolu_B", "TaskUpdate", { taskId: "7" }),
    ]);

    expect(todoEvents).toHaveLength(1);
    expect(todoEvents[0].items).toEqual([
      { id: "toolu_A", description: "Only known task", status: "pending" },
    ]);
    expect(todoEvents.flatMap((event) => event.items).some((item) => item.description === "7")).toBe(false);
  });

  it("creates a subject-bearing todo for an unknown ordinal beyond the creation map", async () => {
    const todoEvents = await runTaskFixture([
      taskToolUse("toolu_A", "TaskCreate", { subject: "Existing task" }),
      taskToolUse("toolu_B", "TaskUpdate", { taskId: "9", subject: "New follow-up", status: "pending" }),
    ]);

    expect(todoEvents).toHaveLength(2);
    expect(todoEvents.at(-1)?.items).toEqual([
      { id: "toolu_A", description: "Existing task", status: "pending" },
      { id: "9", description: "New follow-up", status: "pending" },
    ]);
    expect(todoEvents.at(-1)?.items.filter((item) => item.id === "9")).toHaveLength(1);
  });
});
