import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claudeSdk = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  /** Holds the query open before its result, so a test can act mid-turn. */
  gate: null as null | { reached: () => void; open: Promise<void> },
  /** The CLI's live settings control; null is a process that does not offer it. */
  applyFlagSettings: null as null | ((settings: Record<string, unknown>) => Promise<void>),
  /** Keep the stream open after the result until close(), as a live process does. */
  holdOpen: false,
}));

function makeClaudeQuery(messages: Array<Record<string, unknown>>) {
  let closeStream = () => {};
  const closed = new Promise<void>((resolve) => { closeStream = resolve; });
  const holdOpen = claudeSdk.holdOpen;
  const iterator = (async function* () {
    for (const message of messages) yield message;
    if (claudeSdk.gate) {
      claudeSdk.gate.reached();
      await claudeSdk.gate.open;
    }
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sdk-query-lifecycle",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    if (holdOpen) await closed;
  })();
  return Object.assign(iterator, {
    ...(claudeSdk.applyFlagSettings ? { applyFlagSettings: claudeSdk.applyFlagSettings } : {}),
    close: vi.fn(() => closeStream()),
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

vi.mock("@factory/droid-sdk/node", () => ({
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
vi.mock("../ai/tools/ctoOperatorTools", () => ({ createCtoOperatorTools: vi.fn(() => []) }));
vi.mock("../ai/tools/systemPrompt", () => ({
  buildCodingAgentSystemPrompt: vi.fn(() => "system prompt"),
  buildNativeSubagentRoutingGuidance: vi.fn(() => "native subagent routing"),
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
vi.mock("../../../shared/chatTranscript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/chatTranscript")>()),
  parseAgentChatTranscript: vi.fn(() => []),
}));

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
    recordsForSession: vi.fn(() => []),
    terminatedByAdeSince: vi.fn(() => false),
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
    clearTurnStartMarkers: vi.fn(),
    clearAttentionRequest: vi.fn(() => true),
    clearSessionActivity: vi.fn(),
    markLastTurnFailed: vi.fn(),
    clearLastTurnFailed: vi.fn(),
    setSummary: vi.fn(),
    setResumeCommand: vi.fn(),
    upsertClaudeSessionPointer: vi.fn((pointer: Record<string, any>) => {
      const next = { tags: [], ...claudePointers.get(pointer.chatSessionId), ...pointer };
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
    getAccountUsage: () => null,
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
  claudeSdk.gate = null;
  claudeSdk.applyFlagSettings = null;
  claudeSdk.holdOpen = false;
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

  it("keeps the agent process while a background task runs when a setting changes", async () => {
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

    // A reset would end the process and the background task with it, so the
    // reset stays pending until the background work is gone. (This mock's
    // stream ends after its turn, which a live process kept for background
    // work does not, so only the reset's own reap is ruled out.)
    expect(reaper.reapForSession).not.toHaveBeenCalledWith(session.id, "claude_session_reset");
    expect(lifecycleRestartNotices(events)).toHaveLength(0);
  });

  // The running process takes the new effort itself when it can, so nothing
  // waits and nothing restarts; when it refuses, the change waits for the
  // background work and the summary says which effort is still running.
  it.each([
    { name: "applies it live", applyFlagSettings: async () => undefined, deferred: false },
    {
      name: "defers it and reports the running effort when the process refuses",
      applyFlagSettings: async () => { throw new Error("unsupported"); },
      deferred: true,
    },
  ])("an effort change during background work $name", async ({ applyFlagSettings, deferred }) => {
    const live = vi.fn(applyFlagSettings);
    claudeSdk.applyFlagSettings = live;
    claudeSdk.holdOpen = true;
    const { service, events, reaper, session } = await createDrivenSession([
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "background-task-1", task_type: "local_bash", description: "Run the verification suite" }],
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
    const running = (await service.getSessionSummary(session.id))?.reasoningEffort ?? null;
    expect(running).not.toBe("low");

    await service.updateSession({ sessionId: session.id, reasoningEffort: "low" });

    expect(live).toHaveBeenCalledWith({ effortLevel: "low", ultracode: false });
    expect(reaper.reapForSession).not.toHaveBeenCalledWith(session.id, "claude_session_reset");
    expect(lifecycleRestartNotices(events)).toHaveLength(0);
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.reasoningEffortChange).toEqual(
      deferred ? { current: running, next: "low", appliesAfter: "background" } : undefined,
    );
  });

  // A chat waiting on background work it then loses must be told once, and
  // only once: the wake turn starts the work again, and if a second restart
  // loses that too, waking again would loop for as long as restarts happen.
  it("wakes once, not again when a second restart loses the work the wake turn restarted", async () => {
    const { service, events, session } = await createDrivenSession([
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "background-task-1", task_type: "local_bash", description: "Run the verification suite" }],
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
    const wakeTurns = () => events.filter((envelope) =>
      envelope.event.type === "user_message"
      && (envelope.event.metadata as { hostContinuation?: { reason?: string } } | undefined)
        ?.hostContinuation?.reason === "background_work_lost");
    const lossNotices = () => events.filter((envelope) =>
      envelope.event.type === "system_notice" && /ended with the agent process/.test(envelope.event.message));

    await service.restartSession({ sessionId: session.id });
    await vi.waitFor(() => expect(wakeTurns()).toHaveLength(1));
    expect(lossNotices()[0]?.event).toMatchObject({ message: expect.stringContaining("npm test") });
    // The wake turn ran the same work again, and it is running when the next restart lands.
    await vi.waitFor(() => expect(events.filter((envelope) => envelope.event.type === "done")).toHaveLength(2));

    await service.restartSession({ sessionId: session.id });
    await vi.waitFor(() => expect(lossNotices()).toHaveLength(2));
    // The second loss's notice is the receipt of its wake decision, written
    // synchronously when the loss is reported: no wake, the next turn is told.
    expect(lossNotices()[1]?.event).toMatchObject({
      message: expect.stringContaining("The agent is told on its next turn."),
    });
    expect(wakeTurns()).toHaveLength(1);
  });

  // An afterTurn restart asked for mid-turn (the agent running `ade chat restart`
  // on itself) waits for that turn to end, runs once, and does not run again on a later turn.
  it("defers an afterTurn restart until the turn that asked for it ends, then runs it once", async () => {
    const { service, events } = createHarness([]);
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    let reached!: () => void;
    const parked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    claudeSdk.gate = {
      reached,
      open: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const restartNotices = () => events.filter((envelope) =>
      envelope.event.type === "system_notice" && /Agent session restarted/.test(envelope.event.message));
    const turn = service.runSessionTurn({ sessionId: session.id, text: "Restart yourself when done." });
    await parked;

    const scheduled = await service.restartSession({ sessionId: session.id, afterTurn: true });
    expect(scheduled).toMatchObject({ restarted: false, scheduled: true });
    expect(restartNotices()).toHaveLength(0);

    claudeSdk.gate = null;
    release();
    await turn;
    await vi.waitFor(() => expect(restartNotices()).toHaveLength(1));

    await service.runSessionTurn({ sessionId: session.id, text: "A later turn." });
    await vi.waitFor(() => expect(events.filter((envelope) => envelope.event.type === "done")).toHaveLength(2));
    // The deferred restart is scheduled on a zero-delay timer after `done`; let that timer run before asserting it did not fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(restartNotices()).toHaveLength(1);
  });

  it("does not emit an orphan notice when reset has no open background task", async () => {
    const { service, events, session } = await createDrivenSession([]);

    await resetReasoningEffort(service, session.id);

    expect(lifecycleRestartNotices(events)).toHaveLength(0);
  });
});
