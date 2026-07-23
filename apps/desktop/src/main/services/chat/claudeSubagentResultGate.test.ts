import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claudeSdk = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  holdOpen: false,
  release: null as null | (() => void),
}));

function makeClaudeQuery(messages: Array<Record<string, unknown>>) {
  let release: (() => void) | null = null;
  const gate = claudeSdk.holdOpen
    ? new Promise<void>((resolve) => {
      release = resolve;
      claudeSdk.release = resolve;
    })
    : Promise.resolve();
  const iterator = (async function* () {
    for (const message of messages) yield message;
    await gate;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sdk-subagent-result-gate",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  })();
  return Object.assign(iterator, {
    close: vi.fn(() => release?.()),
    interrupt: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
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
const activeServices: Array<{ disposeAll: () => Promise<void> }> = [];

function createHarness(messages: Array<Record<string, unknown>>, holdOpen = false) {
  claudeSdk.messages = [
    { type: "system", subtype: "init", session_id: "sdk-subagent-result-gate", slash_commands: [] },
    ...messages,
  ];
  claudeSdk.holdOpen = holdOpen;
  claudeSdk.release = null;

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
  activeServices.push(service);
  return { service, events };
}

async function createSession(messages: Array<Record<string, unknown>>, holdOpen = false) {
  const harness = createHarness(messages, holdOpen);
  const session = await harness.service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
  });
  await vi.waitFor(() => {
    expect(harness.events.some((envelope) =>
      envelope.sessionId === session.id
      && envelope.event.type === "system_notice"
      && envelope.event.message === "Session ready"
    )).toBe(true);
  });
  return { ...harness, session };
}

function resultsFor(events: AgentChatEventEnvelope[], taskId: string) {
  return events.filter((envelope) =>
    envelope.event.type === "subagent_result" && envelope.event.taskId === taskId
  ).map((envelope) => envelope.event);
}

async function interruptAfterEvent(
  messages: Array<Record<string, unknown>>,
  ready: (event: AgentChatEventEnvelope) => boolean,
) {
  const harness = await createSession(messages, true);
  const sendPromise = harness.service.sendMessage({
    sessionId: harness.session.id,
    text: "Exercise Claude subagent lifecycle gating.",
  });
  await vi.waitFor(() => {
    expect(harness.events.some(ready)).toBe(true);
  });
  await harness.service.interrupt({ sessionId: harness.session.id });
  claudeSdk.release?.();
  await expect(sendPromise).resolves.toBeUndefined();
  return harness.events;
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-subagent-result-gate-"));
  fs.mkdirSync(path.join(tempRoot, ".ade", "cache", "chat-sessions"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".ade", "transcripts", "chat"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
  vi.clearAllMocks();
});

afterEach(async () => {
  claudeSdk.release?.();
  await Promise.all(activeServices.splice(0).map((service) => service.disposeAll()));
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Claude subagent result gate", () => {
  it("does not emit an interrupted result for a task_updated id that never started", async () => {
    const taskId = "phantom-task";
    const events = await interruptAfterEvent([
      {
        type: "system",
        subtype: "task_updated",
        task_id: taskId,
        patch: { status: "in_progress", description: "Unknown SDK task" },
      },
    ], (envelope) => envelope.event.type === "subagent_progress" && envelope.event.taskId === taskId);

    expect(resultsFor(events, taskId)).toHaveLength(0);
  });

  it("emits exactly one stopped result for a subagent that emitted started", async () => {
    const taskId = "real-subagent";
    const events = await interruptAfterEvent([
      {
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        description: "Inspect the chat pipeline",
        task_type: "subagent",
      },
    ], (envelope) => envelope.event.type === "subagent_started" && envelope.event.taskId === taskId);

    expect(resultsFor(events, taskId)).toEqual([
      expect.objectContaining({ type: "subagent_result", taskId, status: "stopped" }),
    ]);
  });

  it("emits one completed result and suppresses a second terminal update", async () => {
    const taskId = "completed-subagent";
    const { service, events, session } = await createSession([
      {
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        description: "Finish the focused review",
        task_type: "subagent",
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status: "completed",
        summary: "Review complete",
      },
      {
        type: "system",
        subtype: "task_updated",
        task_id: taskId,
        patch: { status: "completed" },
      },
    ]);

    await service.runSessionTurn({ sessionId: session.id, text: "Complete the subagent task." });

    expect(resultsFor(events, taskId)).toEqual([
      expect.objectContaining({ type: "subagent_result", taskId, status: "completed" }),
    ]);
  });

  it("stops only the two surfaced subagents when five unknown task ids are tracked", async () => {
    const realIds = ["real-a", "real-b"];
    const strayIds = ["stray-1", "stray-2", "stray-3", "stray-4", "stray-5"];
    const events = await interruptAfterEvent([
      ...realIds.map((taskId) => ({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        description: `Started ${taskId}`,
        task_type: "subagent",
      })),
      ...strayIds.map((taskId) => ({
        type: "system",
        subtype: "task_updated",
        task_id: taskId,
        patch: { status: "in_progress", description: `Unknown ${taskId}` },
      })),
    ], (envelope) => envelope.event.type === "subagent_progress" && envelope.event.taskId === strayIds.at(-1));

    const stoppedResults = events.filter((envelope) =>
      envelope.event.type === "subagent_result" && envelope.event.status === "stopped"
    );
    expect(stoppedResults).toHaveLength(2);
    expect(stoppedResults.map((envelope) => envelope.event.type === "subagent_result" && envelope.event.taskId).sort())
      .toEqual(realIds);
    expect(strayIds.flatMap((taskId) => resultsFor(events, taskId))).toHaveLength(0);
  });
});
