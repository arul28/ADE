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
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sdk-query-lifecycle",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  })();
  return Object.assign(iterator, {
    close: vi.fn(),
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
import type { ClaudeSubprocessReaper } from "./claudeSubprocessReaper";
import type { AgentChatEventEnvelope } from "../../../shared/types";

let tempRoot: string;
const activeServices: Array<{ disposeAll: () => Promise<void> }> = [];

function createReaperSpy(): ClaudeSubprocessReaper {
  return {
    reapForSession: vi.fn(),
    reapAll: vi.fn(),
    reapStaleRegistry: vi.fn(),
    register: vi.fn(),
    spawnClaudeCodeProcess: vi.fn(() => ({ pid: 4321 }) as any),
    liveRecords: vi.fn(() => []),
  };
}

function createHarness(messages: Array<Record<string, unknown>>) {
  claudeSdk.messages = [
    { type: "system", subtype: "init", session_id: "sdk-query-lifecycle", slash_commands: [] },
    ...messages,
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
  const reaper = createReaperSpy();
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
    claudeSubprocessReaper: reaper,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    appVersion: "0.0.1-test",
    getDirtyFileTextForPath: () => undefined,
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
  });
  activeServices.push(service);
  return { service, events, reaper };
}

async function createDrivenSession(messages: Array<Record<string, unknown>>) {
  const harness = createHarness(messages);
  const session = await harness.service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
  });
  await harness.service.runSessionTurn({
    sessionId: session.id,
    text: "Exercise the Claude query lifecycle.",
  });
  vi.mocked(harness.reaper.reapForSession).mockClear();
  return { ...harness, session };
}

async function resetReasoningEffort(
  service: ReturnType<typeof createAgentChatService>,
  sessionId: string,
) {
  await service.updateSession({
    sessionId,
    reasoningEffort: "high",
  });
}

function lifecycleRestartNotices(events: AgentChatEventEnvelope[]) {
  return events.filter((envelope) =>
    envelope.event.type === "system_notice"
    && /session restarted/i.test(envelope.event.message)
    && /background tasks were stopped/i.test(envelope.event.message)
  );
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-query-lifecycle-"));
  fs.mkdirSync(path.join(tempRoot, ".ade", "cache", "chat-sessions"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".ade", "transcripts", "chat"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((service) => service.disposeAll()));
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Claude query lifecycle", () => {
  it("reaps the session subprocesses when a reasoning change resets the query", async () => {
    const { service, reaper, session } = await createDrivenSession([]);

    await resetReasoningEffort(service, session.id);

    expect(reaper.reapForSession).toHaveBeenCalledWith(
      session.id,
      expect.stringMatching(/^claude_/),
    );
  });

  it("emits an orphan notice when reset stops an open background task", async () => {
    const { service, events, reaper, session } = await createDrivenSession([
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{
          task_id: "background-task-1",
          task_type: "local_bash",
          description: "Run the verification suite",
        }],
      },
      {
        type: "system",
        subtype: "task_started",
        task_id: "background-task-1",
        task_type: "local_bash",
        description: "Run the verification suite",
        command: "npm test",
      },
    ]);

    await resetReasoningEffort(service, session.id);

    expect(reaper.reapForSession).toHaveBeenCalledWith(
      session.id,
      expect.stringMatching(/^claude_/),
    );
    expect(lifecycleRestartNotices(events)).toHaveLength(1);
  });

  it("does not emit an orphan notice when reset has no open background task", async () => {
    const { service, events, session } = await createDrivenSession([]);

    await resetReasoningEffort(service, session.id);

    expect(lifecycleRestartNotices(events)).toHaveLength(0);
  });
});
