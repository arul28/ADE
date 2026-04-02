import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateText, streamText } from "ai";
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted mock state
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  uuidCounter: 0,
  codexThreadCounter: 0,
  codexTurnCounter: 0,
  cursorSessionCounter: 0,
  codexRequestPayloads: [] as Array<Record<string, unknown>>,
  codexCollaborationModes: [{ mode: "default" }, { mode: "plan" }] as Array<Record<string, unknown> | string>,
  codexLineHandler: null as ((line: string) => void) | null,
  cursorAcquireCalls: [] as Array<Record<string, unknown>>,
  cursorNewSessionCalls: [] as Array<Record<string, unknown>>,
  cursorPromptCalls: [] as Array<Record<string, unknown>>,
  emitCodexPayload(payload: Record<string, unknown>) {
    mockState.codexLineHandler?.(JSON.stringify(payload));
  },
  nextUuid: () => {
    mockState.uuidCounter += 1;
    return `test-uuid-${mockState.uuidCounter}`;
  },
}));

// ---------------------------------------------------------------------------
// vi.mock — external dependencies
// ---------------------------------------------------------------------------

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => mockState.nextUuid(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc: any = {
      stdin: {
        writable: true,
        write: vi.fn((line: string) => {
          const payload = JSON.parse(line);
          mockState.codexRequestPayloads.push(payload);
          if (payload?.id == null || typeof payload?.method !== "string") return true;

          let result: Record<string, unknown> = {};
          if (payload.method === "thread/start") {
            mockState.codexThreadCounter += 1;
            result = { thread: { id: `thread-${mockState.codexThreadCounter}` } };
          } else if (payload.method === "turn/start" || payload.method === "review/start") {
            mockState.codexTurnCounter += 1;
            result = { turn: { id: `turn-${mockState.codexTurnCounter}` } };
          } else if (payload.method === "collaborationMode/list") {
            result = {
              collaborationModes: mockState.codexCollaborationModes,
            };
          } else if (payload.method === "skills/list") {
            result = { skills: [] };
          } else if (payload.method === "account/rateLimits/read") {
            result = { rateLimits: { remaining: 10, limit: 100, resetAt: null } };
          }

          queueMicrotask(() => {
            mockState.emitCodexPayload({
              jsonrpc: "2.0",
              id: payload.id,
              result,
            });
          });
          return true;
        }),
        end: vi.fn(),
      },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      pid: 99999,
    };
    return proc;
  }),
}));

vi.mock("node:readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      on: vi.fn((event: string, handler: (line: string) => void) => {
        if (event === "line") {
          mockState.codexLineHandler = handler;
        }
      }),
      close: vi.fn(),
      [Symbol.asyncIterator]: vi.fn(),
    })),
  },
  createInterface: vi.fn(() => ({
    on: vi.fn((event: string, handler: (line: string) => void) => {
      if (event === "line") {
        mockState.codexLineHandler = handler;
      }
    }),
    close: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
  })),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
  tool: vi.fn((def: Record<string, unknown>) => def),
  jsonSchema: vi.fn((s: unknown) => s),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const Client = vi.fn().mockImplementation(() => ({
    connect: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "" }] })),
    close: vi.fn(),
  }));
  return { Client };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  const StdioClientTransport = vi.fn().mockImplementation(() => ({}));
  return { StdioClientTransport };
});

vi.mock("../ai/codexExecutable", () => ({
  resolveCodexExecutable: vi.fn(() => ({ path: "codex", source: "fallback-command" })),
}));

vi.mock("../ai/providerResolver", () => ({
  normalizeCliMcpServers: vi.fn(() => ({})),
  isModelCliWrapped: vi.fn((modelId: string) => !String(modelId).endsWith("-api")),
  resolveModel: vi.fn(async () => ({})),
  resolveProvider: vi.fn(),
  buildProviderOptions: vi.fn(() => ({})),
}));

vi.mock("../ai/tools/universalTools", () => ({
  createUniversalToolSet: vi.fn((): Record<string, unknown> => ({
    readFile: { description: "stub", parameters: { type: "object", properties: {} }, execute: vi.fn() },
    grep: { description: "stub", parameters: { type: "object", properties: {} }, execute: vi.fn() },
    bash: { description: "stub", parameters: { type: "object", properties: {} }, execute: vi.fn() },
  })),
}));

vi.mock("../ai/tools/workflowTools", () => ({
  createWorkflowTools: vi.fn(() => []),
}));

vi.mock("../ai/tools/linearTools", () => ({
  createLinearTools: vi.fn(() => []),
}));

vi.mock("../ai/tools/ctoOperatorTools", () => ({
  createCtoOperatorTools: vi.fn(() => []),
}));

vi.mock("../ai/tools/systemPrompt", () => ({
  buildCodingAgentSystemPrompt: vi.fn(() => "system prompt"),
  composeSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../ai/claudeModelUtils", () => ({
  resolveClaudeCliModel: vi.fn((model: string) => model),
}));

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
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/usr/local/bin/claude", source: "path" })),
}));

vi.mock("../ai/cursorAgentExecutable", () => ({
  resolveCursorAgentExecutable: vi.fn(() => ({ path: "/usr/local/bin/agent", source: "path" })),
}));

vi.mock("../ai/authDetector", () => ({
  detectAllAuth: vi.fn(async () => []),
}));

vi.mock("../git/git", () => ({
  runGit: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));

vi.mock("../orchestrator/unifiedOrchestratorAdapter", () => ({
  resolveAdeMcpServerLaunch: vi.fn(() => ({
    command: "node",
    cmdArgs: [],
    env: {},
  })),
  resolveUnifiedRuntimeRoot: vi.fn(() => process.cwd()),
}));

vi.mock("../orchestrator/permissionMapping", () => ({
  mapPermissionToClaude: vi.fn(() => "plan"),
  mapPermissionToCodex: vi.fn(() => ({
    approvalPolicy: "on-request",
    sandbox: "read-only",
  })),
}));

vi.mock("../computerUse/proofObserver", () => ({
  createProofObserver: vi.fn(() => ({
    observe: vi.fn(),
    flush: vi.fn(),
  })),
}));

vi.mock("../../../shared/chatTranscript", () => ({
  parseAgentChatTranscript: vi.fn(() => []),
}));

vi.mock("./cursorAcpPool", () => ({
  acquireCursorAcpConnection: vi.fn(async (args: Record<string, unknown>) => {
    mockState.cursorAcquireCalls.push(args);
    return {
      connection: {
        newSession: vi.fn(async (params: Record<string, unknown>) => {
          mockState.cursorNewSessionCalls.push(params);
          mockState.cursorSessionCounter += 1;
          return {
            sessionId: `cursor-acp-session-${mockState.cursorSessionCounter}`,
            modes: { currentModeId: "edit" },
            models: { currentModelId: "auto" },
            configOptions: [],
          };
        }),
        prompt: vi.fn(async (params: Record<string, unknown>) => {
          mockState.cursorPromptCalls.push(params);
          return {
            stopReason: "end_turn",
            usage: { inputTokens: 3, outputTokens: 5 },
          };
        }),
        cancel: vi.fn(),
        unstable_closeSession: vi.fn(),
      },
      bridge: {
        onPermission: null,
        onSessionUpdate: null,
        getRootPath: () => "",
        getDirtyFileText: null,
        onTerminalOutputDelta: null,
        flushTerminalOutput: null,
        onTerminalDisposed: null,
      },
      terminals: new Map(),
      terminalWorkLogBindings: new Map(),
      terminalOutputTimers: new Map(),
      dispose: vi.fn(),
    };
  }),
  releaseCursorAcpConnection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import system under test (after mocks)
// ---------------------------------------------------------------------------
import {
  buildComputerUseDirective,
  createAgentChatService,
} from "./agentChatService";
import { spawn } from "node:child_process";
import { detectAllAuth } from "../ai/authDetector";
import * as providerResolver from "../ai/providerResolver";
import { createUniversalToolSet } from "../ai/tools/universalTools";
import { createWorkflowTools } from "../ai/tools/workflowTools";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import { runGit } from "../git/git";
import { resolveAdeMcpServerLaunch } from "../orchestrator/unifiedOrchestratorAdapter";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import { mapPermissionToClaude } from "../orchestrator/permissionMapping";
import { acquireCursorAcpConnection } from "./cursorAcpPool";
import type { AgentChatEvent, AgentChatEventEnvelope, ComputerUseBackendStatus } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as const;
}

function createMockLaneService() {
  const laneRoots: Record<string, string> = {
    "lane-1": tmpRoot,
    "lane-2": path.join(tmpRoot, "lane-2"),
  };
  fs.mkdirSync(laneRoots["lane-2"], { recursive: true });
  const lanes = [
    { id: "lane-1", name: "Primary", laneType: "primary", branchRef: "feature/primary", worktreePath: laneRoots["lane-1"] },
    { id: "lane-2", name: "Selected", laneType: "feature", branchRef: "feature/selected", worktreePath: laneRoots["lane-2"] },
  ];
  return {
    getLaneBaseAndBranch: vi.fn((laneId: string) => {
      const lane = lanes.find((entry) => entry.id === laneId);
      if (lane) {
        return {
          baseRef: "main",
          branchRef: lane.branchRef,
          worktreePath: lane.worktreePath,
          laneType: lane.laneType,
        };
      }
      return {
        baseRef: "main",
        branchRef: "feature/selected",
        worktreePath: tmpRoot,
        laneType: "feature",
      };
    }),
    list: vi.fn(async () => lanes),
    ensurePrimaryLane: vi.fn(async () => {}),
    create: vi.fn(async ({ name, description, parentLaneId }: { name: string; description?: string; parentLaneId?: string }) => {
      const lane = {
        id: `lane-${lanes.length + 1}`,
        name,
        description: description ?? null,
        laneType: "feature",
        branchRef: `feature/generated-lane-${lanes.length + 1}`,
        worktreePath: path.join(tmpRoot, `generated-lane-${lanes.length + 1}`),
        parentLaneId: parentLaneId ?? "lane-1",
      };
      fs.mkdirSync(lane.worktreePath, { recursive: true });
      lanes.push(lane);
      return lane;
    }),
    getLane: vi.fn((laneId: string) => lanes.find((lane) => lane.id === laneId) ?? null),
  } as any;
}

function createMockSessionService() {
  const sessions = mockState.sessions;
  return {
    create: vi.fn((args: any) => {
      sessions.set(args.sessionId, {
        id: args.sessionId,
        laneId: args.laneId,
        ptyId: args.ptyId ?? null,
        title: args.title ?? "Chat",
        toolType: args.toolType ?? "ai-chat",
        status: "running",
        startedAt: args.startedAt ?? new Date().toISOString(),
        endedAt: null,
        transcriptPath: args.transcriptPath ?? "",
        resumeCommand: args.resumeCommand ?? null,
        lastOutputPreview: null,
        summary: null,
        goal: null,
        headShaStart: null,
        headShaEnd: null,
      });
    }),
    get: vi.fn((sessionId: string) => sessions.get(sessionId) ?? null),
    list: vi.fn((_opts?: any) =>
      Array.from(sessions.values()),
    ),
    reopen: vi.fn((sessionId: string) => {
      const row = sessions.get(sessionId);
      if (row) {
        row.status = "running";
        row.endedAt = null;
      }
    }),
    end: vi.fn((args: any) => {
      const sessionId = typeof args === "string" ? args : args?.sessionId;
      const row = sessions.get(sessionId);
      if (row) {
        row.status = "ended";
        row.endedAt = args?.endedAt ?? new Date().toISOString();
      }
    }),
    updateMeta: vi.fn((args: any) => {
      const row = sessions.get(args.sessionId);
      if (row) {
        if (args.title !== undefined) row.title = args.title;
        if (args.goal !== undefined) row.goal = args.goal;
        if (args.toolType !== undefined) row.toolType = args.toolType;
        if (args.resumeCommand !== undefined) row.resumeCommand = args.resumeCommand;
      }
    }),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
    setSummary: vi.fn(),
    setResumeCommand: vi.fn((sessionId: string, resumeCommand: string | null) => {
      const row = sessions.get(sessionId);
      if (row) {
        row.resumeCommand = resumeCommand;
      }
    }),
  } as any;
}

function createMockProjectConfigService() {
  return {
    get: vi.fn(() => ({
      effective: {
        ai: {
          permissions: {
            cli: { mode: "edit" },
            inProcess: { mode: "edit" },
          },
          chat: {},
          sessionIntelligence: {},
        },
      },
    })),
    getAll: vi.fn(() => ({})),
    set: vi.fn(),
  } as any;
}

function createMockIssueInventoryService() {
  const now = new Date().toISOString();
  const runtimeByPr = new Map<string, Record<string, unknown>>();

  const defaultRuntime = (prId: string) => ({
    prId,
    autoConvergeEnabled: false,
    status: "idle",
    pollerStatus: "idle",
    currentRound: 0,
    activeSessionId: null,
    activeLaneId: null,
    activeHref: null,
    pauseReason: null,
    errorMessage: null,
    lastStartedAt: null,
    lastPolledAt: null,
    lastPausedAt: null,
    lastStoppedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    syncFromPrData: vi.fn((prId: string) => {
      const runtime = { ...defaultRuntime(prId), ...runtimeByPr.get(prId) };
      return {
        prId,
        items: [],
        convergence: {
          currentRound: typeof runtime.currentRound === "number" ? runtime.currentRound : 0,
          maxRounds: 5,
          issuesPerRound: [],
          totalNew: 0,
          totalFixed: 0,
          totalDismissed: 0,
          totalEscalated: 0,
          totalSentToAgent: 0,
          isConverging: false,
          canAutoAdvance: false,
        },
        runtime,
      };
    }),
    getInventory: vi.fn(),
    getNewItems: vi.fn(() => []),
    markSentToAgent: vi.fn(),
    markFixed: vi.fn(),
    markDismissed: vi.fn(),
    markEscalated: vi.fn(),
    getConvergenceStatus: vi.fn(() => ({
      currentRound: 0,
      maxRounds: 5,
      issuesPerRound: [],
      totalNew: 0,
      totalFixed: 0,
      totalDismissed: 0,
      totalEscalated: 0,
      totalSentToAgent: 0,
      isConverging: false,
      canAutoAdvance: false,
    })),
    resetInventory: vi.fn(),
    getConvergenceRuntime: vi.fn((prId: string) => ({
      ...defaultRuntime(prId),
      ...runtimeByPr.get(prId),
    })),
    saveConvergenceRuntime: vi.fn((prId: string, state: Record<string, unknown>) => {
      const existing = runtimeByPr.get(prId) ?? {};
      const merged = { ...defaultRuntime(prId), ...existing, ...state };
      runtimeByPr.set(prId, merged);
      return merged;
    }),
    resetConvergenceRuntime: vi.fn((prId: string) => {
      runtimeByPr.delete(prId);
    }),
    getPipelineSettings: vi.fn(() => ({
      maxRounds: 5,
      autoMerge: false,
      mergeMethod: "repo_default",
      onRebaseNeeded: "pause",
    })),
    savePipelineSettings: vi.fn(),
    deletePipelineSettings: vi.fn(),
  } as any;
}

function createService(overrides: Record<string, unknown> = {}) {
  const logger = createLogger();
  const laneService = createMockLaneService();
  const sessionService = createMockSessionService();
  const projectConfigService = createMockProjectConfigService();
  const issueInventoryService = createMockIssueInventoryService();
  const transcriptsDir = path.join(tmpRoot, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const service = createAgentChatService({
    projectRoot: tmpRoot,
    transcriptsDir,
    projectId: "test-project",
    laneService,
    sessionService,
    projectConfigService,
    issueInventoryService,
    logger: logger as any,
    appVersion: "0.0.1-test",
    getExternalMcpConfigs: () => [],
    getDirtyFileTextForPath: () => undefined,
    ...overrides,
  });

  return { service, logger, laneService, sessionService, projectConfigService, issueInventoryService };
}

function readPersistedChatState(sessionId: string): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${sessionId}.json`), "utf8"),
  ) as Record<string, any>;
}

function writePersistedChatState(sessionId: string, nextState: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${sessionId}.json`),
    JSON.stringify(nextState, null, 2),
    "utf8",
  );
}

async function waitForEvent<T extends AgentChatEventEnvelope>(
  events: AgentChatEventEnvelope[],
  predicate: (event: AgentChatEventEnvelope) => event is T,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = events.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for agent chat event.");
}

function expectResolvedMcpLaunchesToUseStandardProxyFlow(): void {
  const calls = vi.mocked(resolveAdeMcpServerLaunch).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const [args] of calls) {
    // Regression guard: packaged chat surfaces must not force the direct
    // headless MCP path. A previous refactor set preferBundledProxy=false,
    // which bypassed the working ADE proxy path and broke Claude/Codex chat
    // MCP initialization before the first turn could start.
    expect((args as { preferBundledProxy?: boolean }).preferBundledProxy).toBeUndefined();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-svc-test-"));
  // Ensure .ade directories exist
  fs.mkdirSync(path.join(tmpRoot, ".ade", "cache", "chat-sessions"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, ".ade", "transcripts", "chat"), { recursive: true });
  mockState.sessions.clear();
  mockState.uuidCounter = 0;
  mockState.codexThreadCounter = 0;
  mockState.codexTurnCounter = 0;
  mockState.cursorSessionCounter = 0;
  mockState.codexRequestPayloads = [];
  mockState.codexCollaborationModes = [{ mode: "default" }, { mode: "plan" }];
  mockState.codexLineHandler = null;
  mockState.cursorAcquireCalls = [];
  mockState.cursorNewSessionCalls = [];
  mockState.cursorPromptCalls = [];
  vi.mocked(acquireCursorAcpConnection).mockClear();
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
  vi.mocked(unstable_v2_createSession).mockReset();
  vi.mocked(detectAllAuth).mockResolvedValue([]);
  vi.mocked(providerResolver.resolveModel).mockResolvedValue({} as any);
  vi.mocked(parseAgentChatTranscript).mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ============================================================================
// buildComputerUseDirective (exported standalone)
// ============================================================================

describe("buildComputerUseDirective", () => {
  function makeBackendStatus(
    overrides: Partial<{ ghostOs: boolean; agentBrowser: boolean; localFallback: boolean }> = {},
  ): ComputerUseBackendStatus {
    const backends: ComputerUseBackendStatus["backends"] = [];
    if (overrides.ghostOs) {
      backends.push({
        name: "Ghost OS",
        style: "external_mcp",
        available: true,
        state: "connected",
        detail: "Ghost OS connected.",
        supportedKinds: ["screenshot"],
      });
    }
    if (overrides.agentBrowser) {
      backends.push({
        name: "agent-browser",
        style: "external_cli",
        available: true,
        state: "installed",
        detail: "agent-browser CLI installed.",
        supportedKinds: ["screenshot"],
      });
    }
    return {
      backends,
      localFallback: {
        available: overrides.localFallback ?? false,
        detail: overrides.localFallback
          ? "ADE local computer-use tools available."
          : "ADE local fallback missing.",
        supportedKinds: overrides.localFallback ? ["screenshot"] : [],
      },
    };
  }

  it("returns null when no backends, no local fallback, and status is non-null", () => {
    const status = makeBackendStatus({});
    const policy = createDefaultComputerUsePolicy({ allowLocalFallback: false });
    const result = buildComputerUseDirective(policy, status);
    expect(result).toBeNull();
  });

  it("returns a directive when backendStatus is null (unknown status)", () => {
    const result = buildComputerUseDirective(createDefaultComputerUsePolicy(), null);
    expect(result).not.toBeNull();
    expect(result).toContain("Computer Use");
    expect(result).toContain("get_computer_use_backend_status");
  });

  it("includes Ghost OS section when Ghost OS backend is available", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const result = buildComputerUseDirective(createDefaultComputerUsePolicy(), status);
    expect(result).toContain("Ghost OS (Desktop Automation)");
    expect(result).toContain("ghost_context");
    expect(result).toContain("ghost_annotate");
  });

  it("includes agent-browser section when agent-browser is available", () => {
    const status = makeBackendStatus({ agentBrowser: true });
    const result = buildComputerUseDirective(createDefaultComputerUsePolicy(), status);
    expect(result).toContain("agent-browser (Browser Automation)");
    expect(result).not.toContain("Ghost OS (Desktop Automation)");
  });

  it("includes ADE Local fallback section when local fallback is enabled", () => {
    const status = makeBackendStatus({ localFallback: true });
    const policy = createDefaultComputerUsePolicy({ allowLocalFallback: true });
    const result = buildComputerUseDirective(policy, status);
    expect(result).toContain("ADE Local (Fallback)");
    expect(result).toContain("Proof Capture");
  });

  it("always includes Proof Capture section when directive is non-null", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const result = buildComputerUseDirective(createDefaultComputerUsePolicy(), status);
    expect(result).toContain("Proof Capture");
    expect(result).toContain("ingest_computer_use_artifacts");
  });

  it("handles null/undefined policy gracefully", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const result = buildComputerUseDirective(null, status);
    expect(result).not.toBeNull();
    expect(result).toContain("Computer Use");
  });
});

// ============================================================================
// createAgentChatService factory
// ============================================================================

describe("createAgentChatService", () => {
  it("returns an object with all expected methods", () => {
    const { service } = createService();
    expect(service.createSession).toBeTypeOf("function");
    expect(service.handoffSession).toBeTypeOf("function");
    expect(service.sendMessage).toBeTypeOf("function");
    expect(service.steer).toBeTypeOf("function");
    expect(service.interrupt).toBeTypeOf("function");
    expect(service.resumeSession).toBeTypeOf("function");
    expect(service.listSessions).toBeTypeOf("function");
    expect(service.getSessionSummary).toBeTypeOf("function");
    expect(service.getChatTranscript).toBeTypeOf("function");
    expect(service.ensureIdentitySession).toBeTypeOf("function");
    expect(service.approveToolUse).toBeTypeOf("function");
    expect(service.getAvailableModels).toBeTypeOf("function");
    expect(service.getSlashCommands).toBeTypeOf("function");
    expect(service.dispose).toBeTypeOf("function");
    expect(service.disposeAll).toBeTypeOf("function");
    expect(service.updateSession).toBeTypeOf("function");
    expect(service.warmupModel).toBeTypeOf("function");
    expect(service.listSubagents).toBeTypeOf("function");
    expect(service.getSessionCapabilities).toBeTypeOf("function");
    expect(service.cleanupStaleAttachments).toBeTypeOf("function");
    expect(service.setComputerUseArtifactBrokerService).toBeTypeOf("function");
  });

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  describe("createSession", () => {
    it("creates a unified session with valid model", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      expect(session).toBeDefined();
      expect(session.id).toBe("test-uuid-1");
      expect(session.laneId).toBe("lane-1");
      expect(session.provider).toBe("unified");
      expect(session.status).toBe("idle");
      expect(session.completion).toBeNull();
      expect(sessionService.create).toHaveBeenCalledTimes(1);
    });

    it("creates a claude session with default model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      expect(session).toBeDefined();
      expect(session.provider).toBe("claude");
      expect(session.status).toBe("idle");
    });

    it("appends ADE tooling guidance to Claude SDK sessions", async () => {
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-guidance",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(unstable_v2_createSession).toHaveBeenCalled();
      });

      const opts = vi.mocked(unstable_v2_createSession).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toContain("ADE and MCP tools are runtime tool calls, not shell commands.");
      expect(opts?.systemPrompt?.append).toContain(".mcp.json");
    });

    it("pre-approves ADE MCP tools for Claude SDK sessions", async () => {
      vi.mocked(providerResolver.normalizeCliMcpServers).mockImplementation((_provider, servers) => servers ?? {});
      vi.mocked(resolveAdeMcpServerLaunch).mockClear();
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-mcp-allow",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(unstable_v2_createSession).toHaveBeenCalled();
      });

      const opts = vi.mocked(unstable_v2_createSession).mock.calls[0]?.[0] as {
        allowedTools?: string[];
        mcpServers?: Record<string, Record<string, unknown>>;
      } | undefined;
      expect(opts?.mcpServers).toHaveProperty("ade");
      expect(opts?.allowedTools).toContain("mcp__ade__*");
      // This explicitly protects the Claude chat surface, which shares the
      // same MCP launch helper as the other chat providers.
      expectResolvedMcpLaunchesToUseStandardProxyFlow();
    });

    it("requests markdown previews for Claude AskUserQuestion by default", async () => {
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-ask-user-preview",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(unstable_v2_createSession).toHaveBeenCalled();
      });

      const opts = vi.mocked(unstable_v2_createSession).mock.calls[0]?.[0] as {
        toolConfig?: { askUserQuestion?: { previewFormat?: string } };
      } | undefined;
      expect(opts?.toolConfig?.askUserQuestion?.previewFormat).toBe("markdown");
    });

    it("attaches ADE MCP servers through the Claude V2 query controls", async () => {
      vi.mocked(providerResolver.normalizeCliMcpServers).mockImplementation((_provider, servers) => servers ?? {});
      const setMcpServers = vi.fn().mockResolvedValue({
        added: ["ade"],
        removed: [],
        errors: {},
      });
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-mcp-query",
        query: {
          setMcpServers,
        },
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(setMcpServers).toHaveBeenCalledWith(expect.objectContaining({
          ade: expect.objectContaining({
            command: "node",
          }),
        }));
      });
    });

    it("migrates legacy Claude plan mode into interaction mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      expect(session.interactionMode).toBe("plan");
      expect(session.claudePermissionMode).toBe("default");
      expect(session.permissionMode).toBe("plan");
    });

    it("sets sessionProfile to workflow by default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      expect(session.sessionProfile).toBe("workflow");
    });

    it("respects custom sessionProfile", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        sessionProfile: "light",
      });

      expect(session.sessionProfile).toBe("light");
    });

    it("normalizes reasoning effort for unified provider", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        reasoningEffort: "  HIGH  ",
      });

      expect(session.reasoningEffort).toBe("high");
    });

    it("sets surface to work by default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        sessionProfile: "light",
      });

      expect(session.surface).toBe("work");
    });

    it("sets surface to automation when specified", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        surface: "automation",
      });

      expect(session.surface).toBe("automation");
    });

    it("throws when unified provider has no known model ID", async () => {
      const { service } = createService();
      await expect(
        service.createSession({
          laneId: "lane-1",
          provider: "unified",
          model: "nonexistent-model-xyz",
        }),
      ).rejects.toThrow(/model/i);
    });

    it("attaches identityKey when provided", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        identityKey: "cto",
      });

      expect(session.identityKey).toBe("cto");
    });

    it("sets computerUse policy", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        computerUse: { mode: "enabled", allowLocalFallback: false, retainArtifacts: true, preferredBackend: null },
      });

      expect(session.computerUse).toBeDefined();
      expect(session.computerUse!.mode).toBe("enabled");
    });

    it("persists chat state to disk after creation", async () => {
      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const chatSessionsDir = path.join(tmpRoot, ".ade", "cache", "chat-sessions");
      const metaFiles = fs.readdirSync(chatSessionsDir).filter((f) => f.endsWith(".json"));
      expect(metaFiles.length).toBeGreaterThanOrEqual(1);

      const persisted = JSON.parse(fs.readFileSync(path.join(chatSessionsDir, metaFiles[0]!), "utf8"));
      expect(persisted.version).toBe(2);
      expect(persisted.provider).toBe("unified");
    });

    it("writes a chat transcript init record", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        sessionProfile: "light",
      });

      const chatTranscriptsDir = path.join(tmpRoot, ".ade", "transcripts", "chat");
      const transcriptFiles = fs.readdirSync(chatTranscriptsDir).filter((f) => f.endsWith(".jsonl"));
      expect(transcriptFiles.length).toBeGreaterThanOrEqual(1);

      const content = fs.readFileSync(path.join(chatTranscriptsDir, transcriptFiles[0]!), "utf8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.type).toBe("session_init");
      expect(parsed.sessionId).toBe(session.id);
    });

    it("rejects chat creation when the selected lane worktree is unavailable", async () => {
      const { service, laneService } = createService();
      laneService.getLaneBaseAndBranch.mockReturnValue({
        baseRef: "main",
        branchRef: "feature/test",
        worktreePath: path.join(tmpRoot, "missing-lane"),
        laneType: "feature",
      });

      await expect(service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      })).rejects.toThrow(/worktree is unavailable/i);
    });
  });

  describe("handoffSession", () => {
    it("rejects handoff while the source chat is still outputting", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "openai/gpt-5.4",
      });
      source.status = "active";

      await expect(
        service.handoffSession({
          sourceSessionId: source.id,
          targetModelId: "openai/gpt-5.4-mini",
        }),
      ).rejects.toThrow("Wait for the current response to finish before handing off this chat.");
    });

    it("clones chat settings and auto-sends the first handoff prompt", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "openai/gpt-5.4",
        sessionProfile: "light",
        reasoningEffort: "high",
        unifiedPermissionMode: "full-auto",
        computerUse: {
          mode: "enabled",
          allowLocalFallback: false,
          retainArtifacts: true,
          preferredBackend: null,
        },
      });
      source.executionMode = "parallel";
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "Fix the work-tab handoff UI.",
      });
      const sourceRow = mockState.sessions.get(source.id);
      if (sourceRow) {
        sourceRow.summary = "The bug is narrowed to the work-tab header and OpenAI model registry.";
      }

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.4-mini",
      });

      expect(result.usedFallbackSummary).toBe(true);
      expect(result.session.laneId).toBe(source.laneId);
      expect(result.session.modelId).toBe("openai/gpt-5.4-mini");
      expect(result.session.sessionProfile).toBe("light");
      expect(result.session.reasoningEffort).toBe("high");
      expect(result.session.unifiedPermissionMode).toBe("full-auto");
      expect(result.session.computerUse?.mode).toBe("enabled");
      expect(result.session.executionMode).toBe("parallel");
      expect(mockState.sessions.get(result.session.id)?.goal).toBe("Fix the work-tab handoff UI.");

      const transcriptPath = mockState.sessions.get(result.session.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      // Wait for the async transcript write to flush (CI runners can be slow)
      await vi.waitFor(() => {
        const transcript = fs.readFileSync(String(transcriptPath), "utf8");
        expect(transcript).toContain("Chat handoff from previous session");
      }, { timeout: 2000, interval: 50 });
    });

    it("uses AI-generated handoff summaries when a summary model is available", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      vi.mocked(detectAllAuth).mockResolvedValue([{ type: "api-key", provider: "openai" }] as any);
      vi.mocked(generateText).mockResolvedValue({
        text: [
          "## Current goal",
          "- Continue the same ADE work item.",
          "",
          "## Important decisions and preserved context",
          "- Reuse the previous lane context.",
          "",
          "## Files, commands, and errors to preserve",
          "- src/renderer/components/chat/AgentChatPane.tsx",
          "",
          "## Next action or open issue",
          "- Finish wiring the handoff flow.",
        ].join("\n"),
      } as any);

      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "openai/gpt-5.4",
      });
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "Finish the handoff flow.",
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.4-mini",
      });

      expect(generateText).toHaveBeenCalled();
      expect(result.usedFallbackSummary).toBe(false);
    });
  });

  describe("auto memory orientation", () => {
    it("skips memory search for casual turns", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const memoryService = {
        search: vi.fn(async () => []),
      } as any;
      const onEvent = vi.fn();
      const { service } = createService({
        memoryService,
        onEvent,
        computerUseArtifactBrokerService: {
          getBackendStatus: vi.fn(() => ({
            backends: [],
            localFallback: {
              available: false,
              detail: "disabled",
              supportedKinds: [],
            },
          })),
        } as any,
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "thanks",
      });

      expect(memoryService.search).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "memory",
          }),
        }),
      );
    });

    it("skips memory search for obvious test-message pings", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const memoryService = {
        search: vi.fn(async () => []),
      } as any;
      const onEvent = vi.fn();
      const { service } = createService({
        memoryService,
        onEvent,
        computerUseArtifactBrokerService: {
          getBackendStatus: vi.fn(() => ({
            backends: [],
            localFallback: {
              available: false,
              detail: "disabled",
              supportedKinds: [],
            },
          })),
        } as any,
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "this is a test message",
      });

      expect(memoryService.search).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "memory",
          }),
        }),
      );
    });

    it("checks memory and emits a memory notice for coding turns", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 3, outputTokens: 2 } };
        })(),
      } as any);

      const memoryService = {
        search: vi.fn(async ({ scope }: { scope?: string }) => (scope === "project"
          ? [{
              id: "memory-project-1",
              scope: "project",
              tier: 2,
              pinned: false,
              category: "decision",
              content: "Decision: always run focused tests before full Electron builds.",
              importance: "high",
              confidence: 1,
              compositeScore: 0.91,
              createdAt: "2026-03-01T10:00:00.000Z",
            }]
          : [])),
      } as any;
      const onEvent = vi.fn();
      const { service } = createService({
        memoryService,
        onEvent,
        computerUseArtifactBrokerService: {
          getBackendStatus: vi.fn(() => ({
            backends: [],
            localFallback: {
              available: false,
              detail: "disabled",
              supportedKinds: [],
            },
          })),
        } as any,
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Please fix the failing desktop tests and update the renderer.",
      });

      expect(memoryService.search).toHaveBeenCalledTimes(2);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "memory",
            message: expect.stringContaining("Checked memory"),
          }),
        }),
      );
    });
  });

  describe("lane launch directives", () => {
    it("injects the selected lane worktree into the first unified user turn only", async () => {
      const streamCalls: Array<Record<string, unknown>> = [];
      vi.mocked(streamText).mockImplementation((args: Record<string, unknown>) => {
        streamCalls.push(args);
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "openai/gpt-5.4",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the repo and fix the launch bug.",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Now add tests.",
      });

      const firstMessages = Array.isArray(streamCalls[0]?.messages)
        ? (streamCalls[0]!.messages as Array<{ role: string; content: unknown }>)
        : [];
      const secondMessages = Array.isArray(streamCalls[1]?.messages)
        ? (streamCalls[1]!.messages as Array<{ role: string; content: unknown }>)
        : [];
      const firstUserContent = String(firstMessages.at(-1)?.content ?? "");
      const secondUserContent = String(secondMessages.at(-1)?.content ?? "");

      expect(firstUserContent).toContain("[ADE launch directive]");
      expect(firstUserContent).toContain(tmpRoot);
      expect(firstUserContent).toContain("only inside that worktree");
      expect(secondUserContent).not.toContain("[ADE launch directive]");
    });

    it("roots Codex MCP launches in the selected lane worktree while keeping the desktop project root", async () => {
      const laneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(laneRootPath, { recursive: true });
      const laneRoot = fs.realpathSync(laneRootPath);
      // runtimeRoot should always come from the trusted ADE install path
      // (resolveUnifiedRuntimeRoot), never from walking up user repo trees.
      const runtimeRoot = fs.realpathSync(process.cwd());
      vi.mocked(resolveAdeMcpServerLaunch).mockClear();

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and fix the lane launch bug.",
      });

      await vi.waitFor(() => {
        expect(vi.mocked(resolveAdeMcpServerLaunch)).toHaveBeenCalled();
      });

      // Codex app-server was the first place this surfaced in production, so
      // keep a dedicated assertion on the actual Codex chat path too.
      expectResolvedMcpLaunchesToUseStandardProxyFlow();

      const workspaceRoots = vi.mocked(resolveAdeMcpServerLaunch).mock.calls
        .map(([args]) => (args as { workspaceRoot?: string }).workspaceRoot)
        .filter((value): value is string => typeof value === "string");
      const projectRoots = vi.mocked(resolveAdeMcpServerLaunch).mock.calls
        .map(([args]) => (args as { projectRoot?: string }).projectRoot)
        .filter((value): value is string => typeof value === "string");
      const runtimeRoots = vi.mocked(resolveAdeMcpServerLaunch).mock.calls
        .map(([args]) => (args as { runtimeRoot?: string }).runtimeRoot)
        .filter((value): value is string => typeof value === "string");

      expect(workspaceRoots.length).toBeGreaterThan(0);
      expect(new Set(workspaceRoots)).toEqual(new Set([laneRoot]));
      expect(projectRoots.length).toBeGreaterThan(0);
      expect(new Set(projectRoots)).toEqual(new Set([tmpRoot]));
      expect(runtimeRoots.length).toBeGreaterThan(0);
      expect(new Set(runtimeRoots.map((value) => fs.realpathSync(value)))).toEqual(new Set([runtimeRoot]));
    });

    it("executes identity-hosted unified turns from the selected execution lane", async () => {
      const streamCalls: Array<Record<string, unknown>> = [];
      vi.mocked(streamText).mockImplementation((args: Record<string, unknown>) => {
        streamCalls.push(args);
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });
      vi.mocked(createUniversalToolSet).mockClear();
      vi.mocked(createWorkflowTools).mockClear();
      vi.mocked(buildCodingAgentSystemPrompt).mockClear();
      vi.mocked(resolveAdeMcpServerLaunch).mockClear();

      const selectedLaneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(selectedLaneRootPath, { recursive: true });
      const selectedLaneRoot = fs.realpathSync(selectedLaneRootPath);
      const { service } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Fix the lane launch bug without leaving this lane.",
      });

      expect(vi.mocked(createUniversalToolSet)).toHaveBeenCalledWith(
        selectedLaneRoot,
        expect.any(Object),
      );
      expect(vi.mocked(createWorkflowTools)).toHaveBeenCalledWith(
        expect.objectContaining({ laneId: "lane-2" }),
      );
      expect(vi.mocked(buildCodingAgentSystemPrompt)).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: selectedLaneRoot }),
      );
      await vi.waitFor(() => {
        expect(vi.mocked(resolveAdeMcpServerLaunch)).toHaveBeenCalled();
      });
      // Unified/API-backed chats also inject ADE MCP through the same launch
      // resolver, so guard them here as well.
      expectResolvedMcpLaunchesToUseStandardProxyFlow();

      const firstMessages = Array.isArray(streamCalls[0]?.messages)
        ? (streamCalls[0]!.messages as Array<{ role: string; content: unknown }>)
        : [];
      const firstUserContent = String(firstMessages.at(-1)?.content ?? "");
      expect(firstUserContent).toContain("lane 'lane-2'");
      expect(firstUserContent).toContain(selectedLaneRoot);
    });

    it("reinjects the lane binding when an identity session switches execution lanes", async () => {
      const streamCalls: Array<Record<string, unknown>> = [];
      vi.mocked(streamText).mockImplementation((args: Record<string, unknown>) => {
        streamCalls.push(args);
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });

      const { service } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Handle the first selected lane task.",
      });

      await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Handle the second selected lane task.",
      });

      const firstMessages = Array.isArray(streamCalls[0]?.messages)
        ? (streamCalls[0]!.messages as Array<{ role: string; content: unknown }>)
        : [];
      const secondMessages = Array.isArray(streamCalls[1]?.messages)
        ? (streamCalls[1]!.messages as Array<{ role: string; content: unknown }>)
        : [];
      const firstUserContent = String(firstMessages.at(-1)?.content ?? "");
      const secondUserContent = String(secondMessages.at(-1)?.content ?? "");

      expect(firstUserContent).toContain("lane 'lane-2'");
      expect(firstUserContent).toContain(path.join(tmpRoot, "lane-2"));
      expect(secondUserContent).toContain("lane 'lane-1'");
      expect(secondUserContent).toContain(tmpRoot);
    });

    it("rebinds queued unified steers after an identity session switches execution lanes", async () => {
      const streamCalls: Array<Record<string, unknown>> = [];
      const firstTurnControl: { release?: () => void } = {};
      let streamCallCount = 0;
      vi.mocked(streamText).mockImplementation((args: Record<string, unknown>) => {
        streamCalls.push(args);
        streamCallCount += 1;
        if (streamCallCount === 1) {
          return {
            fullStream: (async function* () {
              await new Promise<void>((resolve) => {
                firstTurnControl.release = resolve;
              });
              yield { type: "finish", usage: {} };
            })(),
          } as any;
        }
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });

      const { service } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Handle the current lane task first.",
      });
      await Promise.resolve();

      await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });
      await service.steer({
        sessionId: session.id,
        text: "Continue in the newly selected lane.",
      });

      expect(firstTurnControl.release).toBeTypeOf("function");
      firstTurnControl.release!();
      await firstTurn;
      for (let attempt = 0; attempt < 20 && streamCalls.length < 2; attempt += 1) {
        await Promise.resolve();
      }
      expect(streamCalls).toHaveLength(2);

      const secondMessages = Array.isArray(streamCalls[1]?.messages)
        ? (streamCalls[1]!.messages as Array<{ role: string; content: unknown }>)
        : [];
      const secondUserContent = String(secondMessages.at(-1)?.content ?? "");

      expect(secondUserContent).toContain("lane 'lane-1'");
      expect(secondUserContent).toContain(tmpRoot);
    });

    it("does not persist the lane directive key when a unified turn fails before completion", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          throw new Error("stream failed");
        })(),
      }) as any);

      const { service } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the bug from the selected lane.",
      });

      expect(readPersistedChatState(session.id).lastLaneDirectiveKey).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // listSessions
  // --------------------------------------------------------------------------

  describe("listSessions", () => {
    it("returns empty array when no sessions exist", async () => {
      const { service } = createService();
      const sessions = await service.listSessions();
      expect(sessions).toEqual([]);
    });

    it("returns created sessions", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.provider).toBe("unified");
    });

    it("excludes identity sessions by default", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        identityKey: "cto",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(0);

      const sessionsWithIdentity = await service.listSessions(undefined, { includeIdentity: true });
      expect(sessionsWithIdentity.length).toBe(1);
    });

    it("excludes automation sessions by default", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        surface: "automation",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(0);

      const sessionsWithAutomation = await service.listSessions(undefined, { includeAutomation: true });
      expect(sessionsWithAutomation.length).toBe(1);
    });
  });

  describe("ensureIdentitySession", () => {
    it("hosts canonical identity sessions on the primary lane", async () => {
      const { service } = createService();

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(session.laneId).toBe("lane-1");
      expect(session.permissionMode).toBe("plan");
    });

    it("does not reuse a foreign-lane identity session or auto-close it during migration", async () => {
      const { service, sessionService } = createService();

      const legacy = await service.createSession({
        laneId: "lane-2",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        identityKey: "cto",
      });

      const canonical = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(canonical.id).not.toBe(legacy.id);
      expect(canonical.laneId).toBe("lane-1");
      expect(sessionService.get(legacy.id)?.status).not.toBe("ended");

      const reused = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(reused.id).toBe(canonical.id);
      expect(reused.laneId).toBe("lane-1");
    });

    it("records headShaStart for the selected execution lane instead of the canonical host lane", async () => {
      vi.mocked(runGit).mockImplementation(async (_args, opts) => ({
        stdout: String(opts?.cwd ?? "").includes(path.join(tmpRoot, "lane-2")) ? "lane-2-sha\n" : "lane-1-sha\n",
        stderr: "",
        exitCode: 0,
      }));

      const { service, sessionService } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(sessionService.setHeadShaStart).toHaveBeenLastCalledWith(session.id, "lane-2-sha");
    });
  });

  describe("identity continuity", () => {
    it("replays persisted continuity context after resuming an identity session", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall <= 2) {
          yield {
            type: "system",
            subtype: "init",
            session_id: `sdk-session-${streamCall}`,
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Acknowledged" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, {
        ...persisted,
        continuitySummary: "- Keep the OpenClaw bridge runtime state in machine-local cache.",
        continuitySummaryUpdatedAt: new Date().toISOString(),
        recentConversationEntries: [
          { role: "user", text: "What lane should frontend use?" },
          { role: "assistant", text: "Use the primary-hosted coordinator first." },
        ],
      });

      const resumed = createService().service;
      await resumed.resumeSession({ sessionId: session.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
      send.mockClear();

      const result = await resumed.runSessionTurn({
        sessionId: session.id,
        text: "What should we do next?",
        timeoutMs: 15_000,
      });

      expect(result.sessionId).toBe(session.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Continuity Summary"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Keep the OpenClaw bridge runtime state in machine-local cache."));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("User: What lane should frontend use?"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Assistant: Use the primary-hosted coordinator first."));
    });

    it("persists a continuity snapshot and prewarms a fresh Claude session after identity session reset errors", async () => {
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const recoverySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let primaryStreamCall = 0;
      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-session-1",
              slash_commands: [],
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "assistant",
            session_id: "sdk-session-1",
            message: {
              content: [{ type: "text", text: "Partial answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          throw new Error("session expired");
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      const recoverySession = {
        send: recoverySend,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-2",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-2",
        setPermissionMode,
      };
      vi.mocked(unstable_v2_createSession)
        .mockReturnValueOnce(primarySession as any)
        .mockReturnValueOnce(recoverySession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Please keep the OpenClaw bridge state private.",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const persisted = readPersistedChatState(session.id);
      expect(result.outputText).toContain("Partial answer");
      expect(persisted.sdkSessionId).toBe("sdk-session-2");
      expect(persisted.continuitySummary).toContain("Recent continuity snapshot:");
      expect(persisted.continuitySummary).toContain("User: Please keep the OpenClaw bridge state private.");
      expect(persisted.continuitySummary).toContain("Assistant: Partial answer");
      expect(unstable_v2_createSession).toHaveBeenCalledTimes(2);
      expect(recoverySend).toHaveBeenCalledWith("System initialization check. Respond with only the word READY.");
    });

    it("keeps continuity compaction scoped to identity sessions", async () => {
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const recoverySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let primaryStreamCall = 0;
      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-session-1",
              slash_commands: [],
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "assistant",
            session_id: "sdk-session-1",
            message: {
              content: [{ type: "text", text: "Partial answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          throw new Error("session expired");
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      const recoverySession = {
        send: recoverySend,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-2",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-2",
        setPermissionMode,
      };
      vi.mocked(unstable_v2_createSession)
        .mockReturnValueOnce(primarySession as any)
        .mockReturnValueOnce(recoverySession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Please keep the bridge state private.",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const persisted = readPersistedChatState(session.id);
      expect(result.outputText).toContain("Partial answer");
      expect(persisted.continuitySummary).toBeUndefined();
      expect(unstable_v2_createSession).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // getSessionSummary
  // --------------------------------------------------------------------------

  describe("getSessionSummary", () => {
    it("returns null for unknown session id", async () => {
      const { service } = createService();
      const summary = await service.getSessionSummary("nonexistent-id");
      expect(summary).toBeNull();
    });

    it("returns null for empty session id", async () => {
      const { service } = createService();
      const summary = await service.getSessionSummary("");
      expect(summary).toBeNull();
    });

    it("returns null for whitespace-only session id", async () => {
      const { service } = createService();
      const summary = await service.getSessionSummary("   ");
      expect(summary).toBeNull();
    });

    it("returns summary for an existing session", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const summary = await service.getSessionSummary(created.id);
      expect(summary).not.toBeNull();
      expect(summary!.sessionId).toBe(created.id);
      expect(summary!.provider).toBe("unified");
    });
  });

  // --------------------------------------------------------------------------
  // getSessionCapabilities
  // --------------------------------------------------------------------------

  describe("getSessionCapabilities", () => {
    it("returns default capabilities for unknown session", () => {
      const { service } = createService();
      const caps = service.getSessionCapabilities({ sessionId: "unknown-id" });
      expect(caps).toEqual({
        supportsSubagentInspection: false,
        supportsSubagentControl: false,
        supportsReviewMode: false,
      });
    });

    it("returns capabilities for a unified session (no subagent or review support)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const caps = service.getSessionCapabilities({ sessionId: session.id });
      expect(caps.supportsSubagentInspection).toBe(false);
      expect(caps.supportsSubagentControl).toBe(false);
      expect(caps.supportsReviewMode).toBe(false);
    });

    it("returns capabilities for a claude session (subagent inspection, no review)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const caps = service.getSessionCapabilities({ sessionId: session.id });
      expect(caps.supportsSubagentInspection).toBe(true);
      // supportsSubagentControl is true when a Claude runtime is initialized,
      // which createSession does eagerly for Claude sessions via ensureClaudeSessionRuntime.
      expect(caps.supportsSubagentControl).toBe(true);
      expect(caps.supportsReviewMode).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // listSubagents
  // --------------------------------------------------------------------------

  describe("listSubagents", () => {
    it("returns empty array when no subagents are tracked", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const subagents = service.listSubagents({ sessionId: session.id });
      expect(subagents).toEqual([]);
    });

    it("returns empty array for unknown session", () => {
      const { service } = createService();
      const subagents = service.listSubagents({ sessionId: "unknown-id" });
      expect(subagents).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getSlashCommands
  // --------------------------------------------------------------------------

  describe("getSlashCommands", () => {
    it("returns empty array for unknown session", async () => {
      const { service } = createService();
      const commands = service.getSlashCommands({ sessionId: "unknown-id" });
      expect(commands).toEqual([]);
    });

    it("returns local commands for a unified session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands.length).toBeGreaterThanOrEqual(1);

      const clearCmd = commands.find((c: any) => c.name === "/clear");
      expect(clearCmd).toBeDefined();
      expect(clearCmd!.source).toBe("local");
    });

    it("includes /login command for claude sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeDefined();
      expect(loginCmd!.source).toBe("local");
    });

    it("does not include /login for unified sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // updateSession
  // --------------------------------------------------------------------------

  describe("updateSession", () => {
    it("updates the session title", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        title: "My Custom Title",
      });

      expect(updated.id).toBe(session.id);
      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, title: "My Custom Title" }),
      );
    });

    it("resets title to default when set to empty string", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await service.updateSession({
        sessionId: session.id,
        title: "",
      });

      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, title: "AI Chat" }),
      );
    });

    it("updates reasoning effort", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "high",
      });

      expect(updated.reasoningEffort).toBe("high");
    });

    it("normalizes reasoning effort trimming and lowercase", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "  MEDIUM  ",
      });

      expect(updated.reasoningEffort).toBe("medium");
    });

    it("throws when updating with unknown model id", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await expect(
        service.updateSession({
          sessionId: session.id,
          modelId: "totally-fake-model-123",
        }),
      ).rejects.toThrow(/unknown model/i);
    });

    it("throws when updating with empty model id", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await expect(
        service.updateSession({
          sessionId: session.id,
          modelId: "",
        }),
      ).rejects.toThrow(/modelId is required/i);
    });

    it("updates permission mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      expect(updated.permissionMode).toBe("full-auto");
    });

    it("updates computer use policy", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        computerUse: {
          mode: "enabled",
          allowLocalFallback: true,
          retainArtifacts: true,
          preferredBackend: null,
        },
      });

      expect(updated.computerUse!.mode).toBe("enabled");
    });

    it("manuallyNamed suppresses auto-titling after sendMessage", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-session-1",
              slash_commands: [],
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Done" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      // Mock generateText so auto-title would produce a different name if called
      vi.mocked(generateText).mockResolvedValue({
        text: "Auto Generated Title",
      } as any);

      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Set the title manually with manuallyNamed flag
      await service.updateSession({
        sessionId: session.id,
        title: "My Title",
        manuallyNamed: true,
      });

      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, title: "My Title" }),
      );

      // Send a message — this would normally trigger auto-titling
      await service.sendMessage({
        sessionId: session.id,
        text: "Build me a new feature",
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done",
      );

      // Give auto-title a chance to fire (it's a void promise)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // generateText should NOT have been called for auto-titling because
      // manuallyNamed suppresses it. (generateText is only used for auto-titling.)
      expect(generateText).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // dispose and disposeAll
  // --------------------------------------------------------------------------

  describe("dispose", () => {
    it("disposes a session and marks it ended", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await service.dispose({ sessionId: session.id });

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it("evicts disposed chats from the live managed session cache", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      expect(service.getSlashCommands({ sessionId: session.id })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "/clear" }),
        ]),
      );

      await service.dispose({ sessionId: session.id });

      expect(service.getSlashCommands({ sessionId: session.id })).toEqual([]);
    });

    it("terminates the Codex runtime process tree when disposing a live Codex chat", async () => {
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);
      vi.useFakeTimers();
      try {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Inspect the repo",
        });

        await service.dispose({ sessionId: session.id });

        expect(spawn).toHaveBeenCalledWith(
          "codex",
          ["app-server"],
          expect.objectContaining({ detached: process.platform !== "win32" }),
        );
        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGTERM");

        await vi.advanceTimersByTimeAsync(1500);
        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws when disposing an unknown session", async () => {
      const { service } = createService();
      await expect(service.dispose({ sessionId: "no-such-session" })).rejects.toThrow(/not found/i);
    });
  });

  describe("disposeAll", () => {
    it("disposes all active sessions without throwing", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });
      mockState.uuidCounter = 10; // avoid collision
      await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      // Should not throw
      await expect(service.disposeAll()).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // cleanupStaleAttachments
  // --------------------------------------------------------------------------

  describe("cleanupStaleAttachments", () => {
    it("does nothing when attachments directory does not exist", () => {
      const { service } = createService();
      // Should not throw
      expect(() => service.cleanupStaleAttachments()).not.toThrow();
    });

    it("removes files older than 7 days", () => {
      const { service } = createService();
      const attachDir = path.join(tmpRoot, ".ade", "attachments");
      fs.mkdirSync(attachDir, { recursive: true });

      // Create an old file
      const oldFile = path.join(attachDir, "old-attachment.txt");
      fs.writeFileSync(oldFile, "old data");
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

      // Create a recent file
      const recentFile = path.join(attachDir, "recent-attachment.txt");
      fs.writeFileSync(recentFile, "recent data");

      service.cleanupStaleAttachments();

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(recentFile)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Multiple sessions lifecycle
  // --------------------------------------------------------------------------

  describe("session lifecycle", () => {
    it("creates multiple sessions and lists them independently", async () => {
      const { service } = createService();

      const s1 = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      mockState.uuidCounter = 100;
      const s2 = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      expect(s1.id).not.toBe(s2.id);

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(2);
    });

    it("deduplicates Codex compatibility item notifications", async () => {
      const events: Array<{ type: string; tool?: string; itemId?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            tool: "tool" in event.event ? event.event.tool : undefined,
            itemId: "itemId" in event.event ? event.event.itemId : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Search the repo",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            arguments: { query: "AgentChatPane" },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "codex/event/item_started",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            arguments: { query: "AgentChatPane" },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            success: true,
            contentItems: [{ text: "Found matches" }],
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "codex/event/item_completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            success: true,
            contentItems: [{ text: "Found matches" }],
          },
        },
      });

      const toolCalls = events.filter((event) => event.type === "tool_call" && event.itemId === "item-1");
      const toolResults = events.filter((event) => event.type === "tool_result" && event.itemId === "item-1");

      expect(toolCalls).toHaveLength(1);
      expect(toolResults).toHaveLength(1);
    });

    it("rejects attachments outside the project root before dispatch", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const threadsBefore = mockState.codexThreadCounter;
      const turnsBefore = mockState.codexTurnCounter;
      const outsidePath = path.join(process.cwd(), `.ade-agent-chat-outside-${Date.now()}.txt`);
      fs.writeFileSync(outsidePath, "secret", "utf8");
      try {
        await expect(service.sendMessage({
          sessionId: session.id,
          text: "Review this file",
          attachments: [{ path: outsidePath, type: "file" }],
        })).rejects.toThrow(/project root/);
      } finally {
        fs.rmSync(outsidePath, { force: true });
      }
      expect(mockState.codexThreadCounter).toBe(threadsBefore);
      expect(mockState.codexTurnCounter).toBe(turnsBefore);
    });

    it("keeps public attachment paths trimmed without exposing resolved filesystem paths", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      fs.writeFileSync(path.join(tmpRoot, "note.txt"), "hello", "utf8");

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const attachments = [{ path: " note.txt ", type: "file" as const }];
      await service.sendMessage({
        sessionId: session.id,
        text: "Review this file",
        attachments,
      });

      const userMessage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: { type: "user_message"; attachments?: Array<{ path: string; type: "file" | "image" }> } } =>
          event.event.type === "user_message",
      );

      expect(attachments[0]?.path).toBe(" note.txt ");
      expect(userMessage.event.attachments).toEqual([{ path: "note.txt", type: "file" }]);
    });

    it("logs attachment read failures and keeps the fallback text generic", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, logger } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const attachmentDir = path.join(tmpRoot, "attachment-dir");
      fs.mkdirSync(attachmentDir, { recursive: true });
      vi.mocked(generateText).mockResolvedValue({ text: "Attachment fallback test" } as any);
      let streamArgs: Record<string, unknown> | null = null;
      vi.mocked(streamText).mockImplementation((args: Record<string, unknown>) => {
        streamArgs = args;
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Check this attachment",
        attachments: [{ path: "attachment-dir", type: "file" }],
      });

      const rawMessages = streamArgs && Array.isArray((streamArgs as { messages?: unknown }).messages)
        ? (streamArgs as { messages: Array<{ role: string; content: unknown }> }).messages
        : [];
      const messages = rawMessages;
      const currentUserMessageText = JSON.stringify(messages.at(-1)?.content);
      const userMessageEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
        } => event.event.type === "user_message",
      );
      const rendererPayload = JSON.stringify(userMessageEvent.event);

      expect(currentUserMessageText).toContain("Attachment unavailable: attachment-dir");
      expect(currentUserMessageText).not.toContain("Path is not a regular file");
      expect(currentUserMessageText).not.toContain("EISDIR");
      expect(rendererPayload).not.toContain("Path is not a regular file");
      expect(rendererPayload).not.toContain("EISDIR");
      expect(rendererPayload).not.toContain(attachmentDir);
      expect(rendererPayload).not.toContain(tmpRoot);
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.streaming_attachment_unavailable",
        expect.objectContaining({
          attachmentPath: "attachment-dir",
          error: expect.any(Error),
        }),
      );
    });

    it("prefers the canonical turn-scoped Codex text stream when item-scoped deltas also arrive", async () => {
      const textEvents: Array<{ text: string; itemId?: string; turnId?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          if (event.event.type !== "text") return;
          textEvents.push({
            text: event.event.text,
            itemId: event.event.itemId,
            turnId: event.event.turnId,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Say hello",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Hello",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Hello",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          itemId: "msg-1",
          delta: " world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: " world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Hello world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(textEvents).toEqual([
        {
          text: "Hello world",
          turnId: "turn-1",
        },
      ]);
    });

    it("ignores stale Codex lifecycle notifications from a foreign turn", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.resumeSession({ sessionId: session.id });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-1",
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-stale",
            status: "completed",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: {
          turnId: "turn-stale",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Still streaming",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(events.filter((event) => event.type === "done").map((event) => event.turnId)).toEqual(["turn-1"]);
      expect(events.filter((event) => event.type === "status" && event.turnId === "turn-stale")).toHaveLength(0);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", turnId: "turn-1", text: "Still streaming" }),
      ]));
    });

    it("switches the Claude SDK session into plan mode before a plan turn", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan ready" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan ready");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("uses Claude V2 query controls for plan mode when the wrapper lacks setPermissionMode", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-query-plan",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan via query control" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-query-plan",
        query: {
          setPermissionMode,
        },
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan via query control");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("emits todo_update events for Claude TodoWrite tool uses", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "todo-call-1",
              name: "TodoWrite",
              input: {
                todos: [
                  {
                    content: "Inspect Claude task rendering",
                    activeForm: "Inspecting Claude task rendering",
                    status: "completed",
                  },
                  {
                    content: "Render ADE task list UI",
                    activeForm: "Rendering ADE task list UI",
                    status: "in_progress",
                  },
                ],
              },
            }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Track the current task list.",
      });

      const todoEvent = events.find((event) => event.event.type === "todo_update");
      expect(todoEvent).toBeTruthy();
      expect(todoEvent?.event).toMatchObject({
        type: "todo_update",
        items: [
          {
            id: "todo-0",
            description: "Inspect Claude task rendering",
            status: "completed",
          },
          {
            id: "todo-1",
            description: "Render ADE task list UI",
            status: "in_progress",
          },
        ],
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_call",
            tool: "TodoWrite",
            itemId: "todo-call-1",
          }),
        }),
      ]));
    });
  });

  // --------------------------------------------------------------------------
  // setComputerUseArtifactBrokerService
  // --------------------------------------------------------------------------

  describe("setComputerUseArtifactBrokerService", () => {
    it("accepts a broker service without throwing", () => {
      const { service } = createService();
      const mockBroker = {
        getBackendStatus: vi.fn(() => null),
        ingest: vi.fn(),
      };

      expect(() => service.setComputerUseArtifactBrokerService(mockBroker as any)).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // warmupModel
  // --------------------------------------------------------------------------

  describe("warmupModel", () => {
    it("does nothing for unknown session id", async () => {
      const { service } = createService();
      // Should not throw
      await expect(
        service.warmupModel({ sessionId: "no-such-session", modelId: "anthropic/claude-sonnet-4-6-api" }),
      ).resolves.toBeUndefined();
    });

    it("does nothing for non-anthropic model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      // A non-anthropic-cli model should be a no-op
      await expect(
        service.warmupModel({ sessionId: session.id, modelId: "anthropic/claude-sonnet-4-6-api" }),
      ).resolves.toBeUndefined();
    });

    it("does not rewrite a live session when the requested model does not match the backend session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await expect(
        service.warmupModel({ sessionId: session.id, modelId: "anthropic/claude-sonnet-4-6" }),
      ).resolves.toBeUndefined();

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.provider).toBe("unified");
      expect(summary?.modelId).toBe("anthropic/claude-sonnet-4-6-api");
    });
  });

  // --------------------------------------------------------------------------
  // getAvailableModels
  // --------------------------------------------------------------------------

  describe("getAvailableModels", () => {
    it("returns an array for unified provider", async () => {
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "unified" });
      expect(Array.isArray(models)).toBe(true);
    });

    it("returns an array for codex provider", async () => {
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "codex" });
      expect(Array.isArray(models)).toBe(true);
    });

    it("returns an array for claude provider", async () => {
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "claude" });
      expect(Array.isArray(models)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getChatTranscript
  // --------------------------------------------------------------------------

  describe("getChatTranscript", () => {
    it("returns empty entries for a freshly created session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const transcript = await service.getChatTranscript({ sessionId: session.id });
      expect(transcript.sessionId).toBe(session.id);
      expect(transcript.entries).toEqual([]);
      expect(transcript.truncated).toBe(false);
      expect(transcript.totalEntries).toBe(0);
    });

    it("throws for unknown session", async () => {
      const { service } = createService();
      await expect(
        service.getChatTranscript({ sessionId: "nonexistent-id" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // --------------------------------------------------------------------------
  // Session creation edge cases
  // --------------------------------------------------------------------------

  describe("session creation edge cases", () => {
    it("applies automationId and automationRunId when surface is automation", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        surface: "automation",
        automationId: "auto-1",
        automationRunId: "run-1",
      });

      expect(session.surface).toBe("automation");
      expect(session.automationId).toBe("auto-1");
      expect(session.automationRunId).toBe("run-1");
    });

    it("creates a codex session with specified model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(session.provider).toBe("codex");
      expect(session.status).toBe("idle");
    });

    it("persists capabilityMode when provided", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
        capabilityMode: "cto",
      } as any);

      // capabilityMode may be resolved to a fallback if not fully supported
      expect(session.capabilityMode).toBeDefined();
    });

    it("uses default execution mode for new sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      // executionMode defaults to null or undefined for new sessions
      expect(session.executionMode == null).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Session status transitions
  // --------------------------------------------------------------------------

  describe("session status transitions", () => {
    it("session starts with idle status", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      expect(session.status).toBe("idle");
    });

    it("session has null completion initially", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      expect(session.completion).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Interaction mode handling
  // --------------------------------------------------------------------------

  describe("interaction mode", () => {
    it("defaults interaction mode to null or undefined", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      expect(session.interactionMode == null).toBe(true);
    });

    it("persists plan interaction mode for Claude sessions via claudePermissionMode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      // Plan interaction mode is derived from claudePermissionMode for Claude sessions
      expect(session.interactionMode).toBe("plan");
      expect(session.permissionMode).toBe("plan");
    });

    it("maps claude plan permission mode to interaction mode plan", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      expect(session.interactionMode).toBe("plan");
      expect(session.claudePermissionMode).toBe("default");
    });

    it("sends Codex plan collaboration mode on turn start for plan sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });
      expect(session.permissionMode).toBe("plan");

      await service.sendMessage({
        sessionId: session.id,
        text: "Ask one planning question before coding.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "collaborationMode/list")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      const collaborationMode = params?.collaborationMode as
        | { mode?: unknown; settings?: { model?: unknown; reasoning_effort?: unknown; developer_instructions?: unknown } }
        | undefined;

      expect(collaborationMode?.mode).toBe("plan");
      expect(collaborationMode?.settings?.model).toBe("gpt-5.4");
      expect(collaborationMode?.settings?.reasoning_effort).toBe("medium");
      expect(collaborationMode?.settings?.developer_instructions).toBeNull();
    });

    it("sends Codex default collaboration mode on turn start outside plan mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      const collaborationMode = params?.collaborationMode as { mode?: unknown } | undefined;

      expect(collaborationMode?.mode).toBe("default");
    });

    it("does not auto-upgrade default Codex chats into plan mode", async () => {
      mockState.codexCollaborationModes = [{ mode: "plan" }];
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      expect(params?.collaborationMode).toBeUndefined();
    });

    it("falls back to default collaboration mode when plan is not advertised", async () => {
      mockState.codexCollaborationModes = [{ mode: "default" }];
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Ask one planning question before coding.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "collaborationMode/list")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      const collaborationMode = params?.collaborationMode as { mode?: unknown } | undefined;

      expect(collaborationMode?.mode).toBe("default");
    });
  });

  // --------------------------------------------------------------------------
  // Resume and error recovery
  // --------------------------------------------------------------------------

  describe("resumeSession", () => {
    it("resumes a disposed session back to idle", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      await service.dispose({ sessionId: session.id });
      const resumed = await service.resumeSession({ sessionId: session.id });

      expect(resumed.id).toBe(session.id);
      expect(sessionService.reopen).toHaveBeenCalledWith(session.id);
    });

    it("throws when resuming an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.resumeSession({ sessionId: "unknown-session-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("preserves Claude V2 session continuity after an idle timeout", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let primaryStreamCall = 0;
        let primaryClosed = false;
        const primarySend = vi.fn().mockResolvedValue(undefined);
        const resumedSend = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const primarySession = {
          send: primarySend,
          stream: vi.fn(() => (async function* () {
            primaryStreamCall += 1;
            if (primaryStreamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-1",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-1",
              message: {
                content: [{ type: "text", text: "Partial answer" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };

            while (!primaryClosed) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }

            throw new Error("aborted by user");
          })()),
          close: vi.fn(() => {
            primaryClosed = true;
          }),
          sessionId: "sdk-session-1",
          setPermissionMode,
        };

        const resumedSession = {
          send: resumedSend,
          stream: vi.fn(() => (async function* () {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-session-1",
              slash_commands: [],
            };
            yield {
              type: "assistant",
              session_id: "sdk-session-1",
              message: {
                content: [{ type: "text", text: "You were asking about the new chat buttons." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })()),
          close: vi.fn(),
          sessionId: "sdk-session-1",
          setPermissionMode,
        };

        vi.mocked(unstable_v2_createSession).mockReturnValue(primarySession as any);
        vi.mocked(unstable_v2_resumeSession).mockReturnValue(resumedSession as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });

        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "Add the new chat button",
          timeoutMs: 120_000,
        });
        await vi.advanceTimersByTimeAsync(76_000);
        await firstTurn;

        const persistedAfterTimeout = readPersistedChatState(session.id);
        expect(persistedAfterTimeout.sdkSessionId).toBe("sdk-session-1");
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: expect.objectContaining({
                type: "error",
                message: expect.stringContaining("chat stayed open so you can retry"),
              }),
            }),
            expect.objectContaining({
              event: expect.objectContaining({
                type: "status",
                turnStatus: "failed",
              }),
            }),
          ]),
        );

        events.length = 0;
        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "what happened?",
          timeoutMs: 15_000,
        });

        expect(unstable_v2_resumeSession).toHaveBeenCalledWith(
          "sdk-session-1",
          expect.objectContaining({ model: "sonnet" }),
        );
        expect(resumedSend).toHaveBeenCalledTimes(1);
        expect(followUp.outputText).toContain("new chat buttons");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not abort Claude turns solely because they run longer than five minutes", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);
        let streamCall = 0;

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-long-running",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            for (let index = 0; index < 6; index += 1) {
              yield {
                type: "assistant",
                session_id: "sdk-session-long-running",
                message: {
                  content: [{ type: "text", text: `Chunk ${index + 1}. ` }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              };
              await new Promise((resolve) => setTimeout(resolve, 60_000));
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-long-running",
              message: {
                content: [{ type: "text", text: "Finished after a long run." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })()),
          close: vi.fn(),
          sessionId: "sdk-session-long-running",
          setPermissionMode,
        };

        vi.mocked(unstable_v2_createSession).mockReturnValue(sessionHandle as any);
        vi.mocked(unstable_v2_resumeSession).mockReturnValue(sessionHandle as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });

        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const turn = service.runSessionTurn({
          sessionId: session.id,
          text: "Keep working until the implementation is done.",
          timeoutMs: 500_000,
        });

        await vi.advanceTimersByTimeAsync(361_000);
        const result = await turn;

        expect(result.outputText).toContain("Finished after a long run.");
        expect(events.find((event) => event.event.type === "status" && event.event.turnStatus === "failed")).toBeUndefined();
        expect(events.find((event) => event.event.type === "status" && event.event.turnStatus === "interrupted")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Interrupt
  // --------------------------------------------------------------------------

  describe("interrupt", () => {
    it("throws when interrupting an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.interrupt({ sessionId: "unknown-session-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("emits subagent_result stopped for active subagents on claude interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];

      // The stream function is called multiple times: once for warmup, once for the actual turn.
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          // Warmup stream — init + result to complete prewarm
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-interrupt-sub-1",
            slash_commands: [],
          };
          // Set before final yield: prewarm breaks the stream on `result` without draining further.
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Actual turn stream — emit two task_started events, then hang
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "sub-task-1",
          description: "Subagent A",
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "sub-task-2",
          description: "Subagent B",
        };
        // Hang until test resolves the promise (simulating a long-running turn)
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-interrupt-sub-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      // Start the turn (don't await — it will hang)
      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Do something with subagents",
      });

      // Wait for the subagent_started events to appear
      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_started" && (e.event as any).taskId === "sub-task-2",
      );

      // Now interrupt — should emit subagent_result "stopped" for both
      await service.interrupt({ sessionId: session.id });

      const stoppedEvents = events.filter(
        (e) => e.event.type === "subagent_result" && (e.event as any).status === "stopped",
      );
      expect(stoppedEvents).toHaveLength(2);

      const stoppedTaskIds = stoppedEvents.map((e) => (e.event as any).taskId).sort();
      expect(stoppedTaskIds).toEqual(["sub-task-1", "sub-task-2"]);

      // After interrupt, listSubagents should reflect the stopped status
      const subagents = service.listSubagents({ sessionId: session.id });
      const stoppedSubagents = subagents.filter((s: any) => s.status === "stopped");
      expect(stoppedSubagents).toHaveLength(2);

      // Clean up: unblock the hanging stream so sendPromise resolves
      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("claude interrupt idempotency — second call is a no-op", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-idem-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "working" },
          },
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idem-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Hello",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope => e.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });
      const eventsAfterFirst = events.length;

      await service.interrupt({ sessionId: session.id });
      const newEvents = events.slice(eventsAfterFirst);
      expect(newEvents).toHaveLength(0);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("claude interrupt with no active subagents emits no subagent events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-no-sub-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "tick" },
          },
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-no-sub-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Hello",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope => e.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });

      const subagentResultEvents = events.filter(
        (e) => e.event.type === "subagent_result",
      );
      expect(subagentResultEvents).toHaveLength(0);

      const eventsAfterFirst = events.length;
      await service.interrupt({ sessionId: session.id });
      const newEvents = events.slice(eventsAfterFirst);
      expect(newEvents).toHaveLength(0);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("unified interrupt idempotency — second call is a no-op", async () => {
      const events: AgentChatEventEnvelope[] = [];

      // Mock streamText to create a stream that hangs, giving us a unified
      // runtime in a busy state so we can interrupt it.
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "start-step", stepNumber: 0 };
          yield { type: "text-delta", textDelta: "Thinking..." };
          // Hang until resolved
          await hangPromise;
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "anthropic/claude-sonnet-4-6-api",
        modelId: "anthropic/claude-sonnet-4-6-api",
        permissionMode: "edit",
      });

      // Start a turn so the unified runtime gets created
      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Do something",
      });

      // Wait for the text event to confirm the stream is running
      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope => e.event.type === "text",
      );

      // First interrupt — sets runtime.interrupted = true
      await service.interrupt({ sessionId: session.id });
      const eventsAfterFirst = events.length;

      // Second interrupt — should be a no-op due to idempotency guard
      await service.interrupt({ sessionId: session.id });
      const newEvents = events.slice(eventsAfterFirst);

      // The second interrupt should have produced no new events at all
      expect(newEvents).toHaveLength(0);

      // Clean up
      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // steer
  // --------------------------------------------------------------------------

  describe("steer", () => {
    it("throws when steering an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.steer({
          sessionId: "unknown-session-id",
          text: "refocus on the main bug",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("cancelSteer removes a queued steer and emits a system_notice", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          // init stream
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        if (streamCall === 2) {
          // The blocking turn — yields an assistant message then waits
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Still working" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }

        // streamCall >= 3: any follow-up turn — should NOT happen because the steer was cancelled
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Follow up" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => {
          interruptedTurnClosed = true;
        }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(unstable_v2_createSession).mockReturnValue(mockSession as any);
      vi.mocked(unstable_v2_resumeSession).mockReturnValue(mockSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Start a turn so the runtime is busy
      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do some work",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue a steer — runtime is busy so it should be queued
      await service.steer({ sessionId: session.id, text: "queued steer text" });

      // Find the queued user_message event to get the steerId
      const queuedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "queued steer text",
      );
      expect(queuedEvent).toBeDefined();
      const steerId = (queuedEvent!.event as any).steerId as string;
      expect(steerId).toBeTruthy();

      // Cancel the steer
      await service.cancelSteer({ sessionId: session.id, steerId });

      // Verify a system_notice with "Queued message cancelled." was emitted
      const cancelNotice = events.find(
        (e) =>
          e.event.type === "system_notice"
          && (e.event as any).message === "Queued message cancelled.",
      );
      expect(cancelNotice).toBeDefined();

      // Interrupt the turn to let it complete
      await service.interrupt({ sessionId: session.id });
      await activeTurn;

      // The cancelled steer should NOT have been delivered — `send` should not have been
      // called with "queued steer text"
      const sendCalls = send.mock.calls.map((c: any[]) => c[0]);
      const deliveredSteer = sendCalls.find(
        (arg: any) =>
          (typeof arg === "string" && arg.includes("queued steer text"))
          || (typeof arg === "object" && JSON.stringify(arg).includes("queued steer text")),
      );
      expect(deliveredSteer).toBeUndefined();
    });

    it("editSteer updates the queued steer text and cancels on interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Still working" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }

        // streamCall >= 3: follow-up turn after steer delivery
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Responding to updated text" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => {
          interruptedTurnClosed = true;
        }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(unstable_v2_createSession).mockReturnValue(mockSession as any);
      vi.mocked(unstable_v2_resumeSession).mockReturnValue(mockSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Start a turn so the runtime is busy
      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do some work",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue a steer
      await service.steer({ sessionId: session.id, text: "original steer text" });

      // Get the steerId from the queued user_message event
      const queuedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "original steer text",
      );
      expect(queuedEvent).toBeDefined();
      const steerId = (queuedEvent!.event as any).steerId as string;
      expect(steerId).toBeTruthy();

      // Edit the steer
      await service.editSteer({ sessionId: session.id, steerId, text: "updated text" });

      // Verify a user_message with updated text and deliveryState "queued" was emitted
      const editedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "updated text"
          && (e.event as any).steerId === steerId,
      );
      expect(editedEvent).toBeDefined();

      // Interrupt the turn — queued steers should be cancelled, not delivered
      await service.interrupt({ sessionId: session.id });
      await activeTurn;

      // Wait for the cancellation notice for the queued steer
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "system_notice"
          && (event.event as any).steerId === steerId
          && /cancelled/i.test((event.event as any).message),
      );

      // The steer should NOT have been delivered via send
      const sendCalls = send.mock.calls.map((c: any[]) => c[0]);
      const deliveredWithUpdatedText = sendCalls.find(
        (arg: any) =>
          (typeof arg === "string" && arg.includes("updated text"))
          || (typeof arg === "object" && JSON.stringify(arg).includes("updated text")),
      );
      expect(deliveredWithUpdatedText).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // approveToolUse
  // --------------------------------------------------------------------------

  describe("approveToolUse", () => {
    it("throws when approving for an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.approveToolUse({
          sessionId: "unknown-session-id",
          itemId: "unknown-item-id",
          decision: "accept",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("gracefully handles missing Claude approval without throwing", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-missing-approval",
            slash_commands: [],
          };
          return;
        }
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Done" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-missing-approval",
        setPermissionMode,
      } as any);

      const { service, logger } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Run a turn so the Claude runtime gets created
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Hello",
      });

      // Call approveToolUse with a non-existent itemId — should NOT throw
      await service.approveToolUse({
        sessionId: session.id,
        itemId: "nonexistent-item-id",
        decision: "accept",
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.claude_approval_not_found",
        expect.objectContaining({
          sessionId: session.id,
          itemId: "nonexistent-item-id",
          decision: "accept",
        }),
      );
    });

    it("exits unified plan mode after a one-time plan approval", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let requestApproval:
        | ((args: {
          category: "exitPlanMode";
          description: string;
          detail?: Record<string, unknown>;
        }) => Promise<{ approved: boolean; decision?: string; reason: string }>)
        | null = null;

      vi.mocked(createUniversalToolSet).mockImplementation((_cwd: string, options: any) => {
        requestApproval = options.onApprovalRequest;
        return {};
      });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "start-step", stepNumber: 0 };
          if (!requestApproval) {
            throw new Error("Unified approval handler was not captured.");
          }
          const approvalPromise = requestApproval({
            category: "exitPlanMode",
            description: "Plan ready for approval",
            detail: { planContent: "1. Inspect\n2. Implement" },
          });
          yield { type: "tool-call", toolName: "ExitPlanMode", toolCallId: "tool-exit-plan" };
          const approvalResult = await approvalPromise;
          yield { type: "tool-result", toolName: "ExitPlanMode", toolCallId: "tool-exit-plan", result: approvalResult };
          yield { type: "text-delta", textDelta: "Implementation complete." };
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "openai/gpt-5.4",
        modelId: "openai/gpt-5.4",
        permissionMode: "plan",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Review the plan and implement it after approval.",
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          if (event.event.type !== "approval_request") return false;
          const detail = event.event.detail as { request?: { kind?: string } } | undefined;
          return detail?.request?.kind === "plan_approval";
        },
      );

      await service.approveToolUse({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });

      await sendPromise;

      const updated = await service.getSessionSummary(session.id);
      expect(updated?.permissionMode).toBe("edit");
      expect(updated?.unifiedPermissionMode).toBe("edit");
    });
  });

  it("emits immediate startup activity before unified stream output arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

    vi.mocked(streamText).mockImplementation(() => ({
      fullStream: (async function* () {
        await streamGate;
        yield { type: "finish", usage: {} };
      })(),
    }) as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "unified",
      model: "openai/gpt-5.4",
      modelId: "openai/gpt-5.4",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const startedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const startupActivity = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
      } =>
        event.event.type === "activity"
        && event.event.turnId === startedEvent.event.turnId
        && (event.event.activity === "thinking" || event.event.activity === "working"),
    );

    expect(startupActivity.event.detail).toBeTruthy();

    releaseStream();
    await sendPromise;
  });

  it("emits immediate startup activity before Claude SDK stream output arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
          slash_commands: [],
        };
        return;
      }

      await streamGate;
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(unstable_v2_createSession).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-1",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const startedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const startupActivity = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
      } =>
        event.event.type === "activity"
        && event.event.turnId === startedEvent.event.turnId
        && (event.event.activity === "thinking" || event.event.activity === "working"),
    );

    expect(startupActivity.event.detail).toBeTruthy();

    releaseStream();
    await sendPromise;
  });

  it("emits completed Claude tool_result rows when tool_use_summary arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-tool-summary",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-use-1",
            name: "Read",
            input: { file_path: "apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx" },
          },
        },
      };
      yield {
        type: "tool_use_summary",
        summary: "Checked the shared chat renderer",
        preceding_tool_use_ids: ["tool-use-1"],
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(unstable_v2_createSession).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-tool-summary",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Inspect the shared chat renderer.",
    });

    const completedToolResults = events.filter((event) =>
      event.event.type === "tool_result"
      && event.event.itemId === "tool-use-1"
      && event.event.status === "completed"
    );

    expect(completedToolResults).toHaveLength(1);
    expect(completedToolResults[0]!.event.type).toBe("tool_result");
    if (completedToolResults[0]!.event.type !== "tool_result") {
      throw new Error("Expected tool_result");
    }
    expect(completedToolResults[0]!.event.result).toMatchObject({
      synthetic: true,
      source: "claude_tool_use_summary",
      summary: "Checked the shared chat renderer",
    });
  });

  it("emits completed Claude tool_result rows for open tools when the turn ends without a tool summary", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-tool-fallback",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-use-2",
            name: "Read",
            input: { file_path: "apps/desktop/src/renderer/components/chat/ChatWorkLogBlock.tsx" },
          },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(unstable_v2_createSession).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-tool-fallback",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Inspect the grouped work log renderer.",
    });

    const completedToolResults = events.filter((event) =>
      event.event.type === "tool_result"
      && event.event.itemId === "tool-use-2"
      && event.event.status === "completed"
    );

    expect(completedToolResults).toHaveLength(1);
    expect(completedToolResults[0]!.event.type).toBe("tool_result");
    if (completedToolResults[0]!.event.type !== "tool_result") {
      throw new Error("Expected tool_result");
    }
    expect(completedToolResults[0]!.event.result).toMatchObject({
      synthetic: true,
      source: "claude_turn_finalization",
      finalTurnStatus: "completed",
    });
  });

  it("bridges Claude AskUserQuestion through ADE's question UI", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let permissionResult: Record<string, unknown> | null = null;

    const askInput = {
      questions: [
        {
          question: "What should we do about the two task list views?",
          header: "Task views",
          options: [
            {
              label: "Remove the TurnSummaryCard tasks",
              description: "Keep only the inline task list.",
              preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
            },
            {
              label: "Keep both, improve summary",
              description: "Keep both task views, but make the summary less intrusive.",
              preview: "<div><strong>Hybrid</strong><p>Inline progress plus a compact summary card.</p></div>",
            },
          ],
          multiSelect: false,
        },
        {
          question: "Should the inline task list pin while tasks are active?",
          header: "Inline pinning",
          options: [
            { label: "Yes, pin while active" },
            { label: "No, let it scroll" },
          ],
          multiSelect: false,
        },
      ],
    };

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-ask-user",
          slash_commands: [],
        };
        return;
      }

      const sessionOpts = vi.mocked(unstable_v2_createSession).mock.calls.at(-1)?.[0] as any;
      permissionResult = await sessionOpts.canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-user-1",
      });

      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Thanks, I can continue now." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(unstable_v2_createSession).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-ask-user",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "plan",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Figure out the task list UX and ask any clarifying questions you need.",
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && typeof (event.event.detail as { request?: { providerMetadata?: { tool?: string } } } | undefined)?.request?.providerMetadata?.tool === "string"
        && ((event.event.detail as { request?: { providerMetadata?: { tool?: string } } }).request?.providerMetadata?.tool === "AskUserQuestion"),
    );

    const request = (approvalEvent.event.detail as {
      request: {
        kind: string;
        questions: Array<{
          id: string;
          question: string;
          options?: Array<{ preview?: string; previewFormat?: string }>;
        }>;
      };
    }).request;
    expect(request.kind).toBe("structured_question");
    expect(request.questions.map((question) => question.question)).toEqual([
      "What should we do about the two task list views?",
      "Should the inline task list pin while tasks are active?",
    ]);
    expect(request.questions[0]?.options?.[0]).toMatchObject({
      preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
      previewFormat: "markdown",
    });

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      answers: {
        question_1: "Keep both, improve summary",
        question_2: "Yes, pin while active",
      },
    });

    await sendPromise;

    expect(permissionResult).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          "What should we do about the two task list views?": "Keep both, improve summary",
          "Should the inline task list pin while tasks are active?": "Yes, pin while active",
        },
      },
    });
  });

  it("keeps standalone ask_user declines explicit without emitting a fake cleanup tool_result", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Planning question",
      body: "Which part of the planning UI should we test first?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which part of the planning UI should we test first?",
        options: [
          { label: "Question flow", value: "question_flow" },
          { label: "Plan updates", value: "plan_updates" },
        ],
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Planning question";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "decline",
    });

    const result = await requestPromise;
    expect(result.decision).toBe("decline");
    expect(events.filter((event) => event.event.type === "tool_result")).toHaveLength(0);
  });

  it("maps freeform replies to the single pending question when only one answer is needed", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Single question",
      body: "Which area should we test first?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which area should we test first?",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Single question";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Question flow",
    });

    await expect(requestPromise).resolves.toMatchObject({
      decision: "accept",
      answers: { answer: ["Question flow"] },
      responseText: "Question flow",
    });
  });

  it("does not fan a single freeform reply out across multiple structured questions", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Multiple questions",
      body: "Tell me which plan we should use and whether to pin tasks.",
      questions: [
        {
          id: "plan_focus",
          header: "Plan focus",
          question: "What kind of planning scenario should I use?",
          allowsFreeform: true,
        },
        {
          id: "task_pinning",
          header: "Task pinning",
          question: "Should the inline task list stay pinned?",
          allowsFreeform: true,
        },
      ],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Multiple questions";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Start with the UI planning case.",
    });

    await expect(requestPromise).resolves.toMatchObject({
      decision: "accept",
      answers: { response: ["Start with the UI planning case."] },
      responseText: "Start with the UI planning case.",
    });
  });

  it("responds to native Codex requestUserInput declines with empty answers instead of interrupting the turn", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      codexApprovalPolicy: "untrusted",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Ask one planning question before coding.",
    }, { awaitDispatch: true });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "native-request-1",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-question-1",
        threadId: "thread-1",
        turnId: "turn-1",
        questions: [
          {
            id: "plan_focus",
            header: "Plan focus",
            question: "What kind of planning scenario should I use?",
            isOther: true,
            options: [
              { label: "UI planning" },
              { label: "Bug fix planning" },
            ],
          },
        ],
      },
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && event.event.itemId === "codex-question-1",
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "cancel",
    });

    expect(
      mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt"),
    ).toBe(false);
    expect(
      mockState.codexRequestPayloads.find((payload) => payload.id === "native-request-1"),
    ).toMatchObject({
      jsonrpc: "2.0",
      id: "native-request-1",
      result: {
        answers: {},
      },
    });
  });

  it("responds to Codex MCP elicitations with action/content payloads", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Wait for a structured MCP question.",
    }, { awaitDispatch: true });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "ade",
        message: "Confirm whether we should continue.",
        turnId: "turn-1",
        requestedSchema: {
          type: "object",
          properties: {
            confirmed: {
              type: "boolean",
              description: "Should ADE continue?",
            },
          },
        },
      },
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && (
          (event.event.detail as { request?: { title?: string } } | undefined)?.request?.title === "Question from ade"
        ),
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      answers: {
        confirmed: "true",
      },
    });

    const elicitationResponse = mockState.codexRequestPayloads.find((payload) => payload.id === "elicitation-1");
    expect(elicitationResponse?.result).toEqual({
      action: "accept",
      content: {
        confirmed: true,
      },
    });
  });

  it("initializes the Cursor runtime before validating the first turn", async () => {
    const events: AgentChatEventEnvelope[] = [];
    vi.mocked(resolveAdeMcpServerLaunch).mockClear();

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "auto",
      modelId: "cursor/auto",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Explain the failing test setup.",
    }, { awaitDispatch: true });

    const completedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "completed",
    );

    expect(completedEvent.sessionId).toBe(session.id);
    expect(vi.mocked(acquireCursorAcpConnection)).toHaveBeenCalledTimes(1);
    expect(mockState.cursorNewSessionCalls).toHaveLength(1);
    expect(mockState.cursorPromptCalls).toHaveLength(1);
    await vi.waitFor(() => {
      expect(vi.mocked(resolveAdeMcpServerLaunch)).toHaveBeenCalled();
    });
    // Cursor chat used the same shared MCP launch path, so we keep a separate
    // assertion to ensure future chat refactors do not regress just one
    // surface while leaving the others green.
    expectResolvedMcpLaunchesToUseStandardProxyFlow();
    expect(
      events.some((event) => event.event.type === "error" && event.event.message.includes("No runtime initialized")),
    ).toBe(false);
  });

  it("emits the Cursor user bubble before ACP warmup completes", async () => {
    const events: AgentChatEventEnvelope[] = [];
    type CursorNewSessionResult = {
      sessionId: string;
      modes: { currentModeId: string };
      models: {
        currentModelId: string;
        availableModels: Array<{ modelId: string; name: string }>;
      };
      configOptions: Array<Record<string, unknown>>;
    };
    let resolveNewSession: ((value: CursorNewSessionResult) => void) | null = null;

    vi.mocked(acquireCursorAcpConnection).mockImplementationOnce(async (args: Record<string, unknown>) => {
      mockState.cursorAcquireCalls.push(args);
      return {
        connection: {
          newSession: vi.fn(() => new Promise<CursorNewSessionResult>((resolve) => {
            resolveNewSession = resolve;
          })),
          loadSession: vi.fn(async () => ({
            modes: { currentModeId: "edit" },
            models: {
              currentModelId: "auto",
              availableModels: [{ modelId: "auto", name: "Auto" }],
            },
            configOptions: [],
          })),
          prompt: vi.fn(async () => ({
            stopReason: "end_turn",
            usage: { inputTokens: 3, outputTokens: 5 },
          })),
          cancel: vi.fn(),
          unstable_closeSession: vi.fn(),
        },
        bridge: {
          onPermission: null,
          onSessionUpdate: null,
          getRootPath: () => "",
          getDirtyFileText: null,
          onTerminalOutputDelta: null,
          flushTerminalOutput: null,
          onTerminalDisposed: null,
        },
        terminals: new Map(),
        terminalWorkLogBindings: new Map(),
        terminalOutputTimers: new Map(),
        dispose: vi.fn(),
      } as any;
    });

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "auto",
      modelId: "cursor/auto",
    });

    let sendResolved = false;
    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Start the work.",
    }, { awaitDispatch: true }).then(() => {
      sendResolved = true;
    });

    // Allow a few microticks for the optimistic UI events to be emitted.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    // The user_message and status events should be emitted optimistically
    // (before ACP warmup completes), even though awaitDispatch has NOT yet
    // resolved -- it now waits for the real prompt to be acknowledged.
    expect(sendResolved).toBe(false);
    expect(
      events.filter((event) => event.event.type === "user_message"),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) => event.event.type === "status" && event.event.turnStatus === "started",
      ),
    ).toBe(true);

    for (let i = 0; i < 20 && !resolveNewSession; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(resolveNewSession).toBeTruthy();

    const settleNewSession = resolveNewSession as unknown as (value: CursorNewSessionResult) => void;
    settleNewSession({
      sessionId: "cursor-acp-session-1",
      modes: { currentModeId: "edit" },
      models: {
        currentModelId: "auto",
        availableModels: [{ modelId: "auto", name: "Auto" }],
      },
      configOptions: [],
    });

    const completedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
      } => event.event.type === "done" && event.sessionId === session.id,
    );

    await sendPromise;

    // awaitDispatch should now have resolved (after the prompt completed).
    expect(sendResolved).toBe(true);
    expect(completedEvent.event.status).toBe("completed");
    expect(
      events.filter((event) => event.event.type === "user_message"),
    ).toHaveLength(1);
  });

  it("refreshes the Cursor session model from ACP after a turn completes", async () => {
    const events: AgentChatEventEnvelope[] = [];

    vi.mocked(acquireCursorAcpConnection).mockImplementationOnce(async (args: Record<string, unknown>) => {
      mockState.cursorAcquireCalls.push(args);
      return {
        connection: {
          newSession: vi.fn(async (params: Record<string, unknown>) => {
            mockState.cursorNewSessionCalls.push(params);
            mockState.cursorSessionCounter += 1;
            return {
              sessionId: `cursor-acp-session-${mockState.cursorSessionCounter}`,
              modes: { currentModeId: "edit" },
              models: {
                currentModelId: "claude-4-sonnet",
                availableModels: [
                  { modelId: "auto", name: "Auto" },
                  { modelId: "claude-4-sonnet", name: "Claude 4 Sonnet" },
                ],
              },
              configOptions: [],
            };
          }),
          prompt: vi.fn(async (params: Record<string, unknown>) => {
            mockState.cursorPromptCalls.push(params);
            return {
              stopReason: "end_turn",
              usage: { inputTokens: 2, outputTokens: 4 },
            };
          }),
          loadSession: vi.fn(async () => ({
            modes: { currentModeId: "edit" },
            models: {
              currentModelId: "auto",
              availableModels: [
                { modelId: "auto", name: "Auto" },
                { modelId: "claude-4-sonnet", name: "Claude 4 Sonnet" },
              ],
            },
            configOptions: [],
          })),
          cancel: vi.fn(),
          unstable_closeSession: vi.fn(),
        },
        bridge: {
          onPermission: null,
          onSessionUpdate: null,
          getRootPath: () => "",
          getDirtyFileText: null,
          onTerminalOutputDelta: null,
          flushTerminalOutput: null,
          onTerminalDisposed: null,
        },
        terminals: new Map(),
        terminalWorkLogBindings: new Map(),
        terminalOutputTimers: new Map(),
        dispose: vi.fn(),
      } as any;
    });

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "claude-4-sonnet",
      modelId: "cursor/claude-4-sonnet",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Confirm the active model.",
    }, { awaitDispatch: true });

    const doneEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
      } => event.event.type === "done" && event.sessionId === session.id,
    );
    const updated = await service.getSessionSummary(session.id);

    expect(updated?.model).toBe("auto");
    expect(updated?.modelId).toBe("cursor/auto");
    expect(doneEvent?.event.model).toBe("auto");
    expect(doneEvent?.event.modelId).toBe("cursor/auto");
  });

  it("keeps the selected Cursor model when ACP reports an invalid current model id", async () => {
    vi.mocked(acquireCursorAcpConnection).mockImplementationOnce(async (args: Record<string, unknown>) => {
      mockState.cursorAcquireCalls.push(args);
      return {
        connection: {
          newSession: vi.fn(async (params: Record<string, unknown>) => {
            mockState.cursorNewSessionCalls.push(params);
          mockState.cursorSessionCounter += 1;
          return {
            sessionId: `cursor-acp-session-${mockState.cursorSessionCounter}`,
            modes: { currentModeId: "edit" },
            models: {
              currentModelId: "default[]",
              availableModels: [
                { modelId: "default[]", name: "Default" },
                { modelId: "auto", name: "Auto" },
                { modelId: "claude-4-sonnet", name: "Claude 4 Sonnet" },
              ],
            },
              configOptions: [],
            };
          }),
          prompt: vi.fn(async (params: Record<string, unknown>) => {
            mockState.cursorPromptCalls.push(params);
            return {
              stopReason: "end_turn",
              usage: { inputTokens: 2, outputTokens: 4 },
            };
          }),
          cancel: vi.fn(),
          unstable_closeSession: vi.fn(),
        },
        bridge: {
          onPermission: null,
          onSessionUpdate: null,
          getRootPath: () => "",
          getDirtyFileText: null,
          onTerminalOutputDelta: null,
          flushTerminalOutput: null,
          onTerminalDisposed: null,
        },
        terminals: new Map(),
        terminalWorkLogBindings: new Map(),
        terminalOutputTimers: new Map(),
        dispose: vi.fn(),
      } as any;
    });

    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "auto",
      modelId: "cursor/auto",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Run the next step.",
    }, { awaitDispatch: true });

    const updated = await service.getSessionSummary(session.id);
    const persisted = readPersistedChatState(session.id);

    expect(updated?.model).toBe("auto");
    expect(updated?.modelId).toBe("cursor/auto");
    expect(persisted.model).toBe("auto");
    expect(persisted.modelId).toBe("cursor/auto");
  });

  it("prefers an explicit Cursor mode over legacy full-auto launch settings", async () => {
    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "auto",
      modelId: "cursor/auto",
      cursorModeId: "ask",
      unifiedPermissionMode: "full-auto",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Answer read-only.",
    }, { awaitDispatch: true });

    expect(mockState.cursorAcquireCalls).toHaveLength(1);
    expect(mockState.cursorAcquireCalls[0]?.launchSettings).toEqual({
      mode: "ask",
      sandbox: "enabled",
      force: false,
      approveMcps: false,
    });
  });
});
