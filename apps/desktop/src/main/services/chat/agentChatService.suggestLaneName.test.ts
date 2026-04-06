import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateText, streamText } from "ai";
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted mock state (mirrored from agentChatService.test.ts)
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
// vi.mock — external dependencies (same as agentChatService.test.ts)
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
        write: vi.fn(() => true),
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
      on: vi.fn(),
      close: vi.fn(),
      [Symbol.asyncIterator]: vi.fn(),
    })),
  },
  createInterface: vi.fn(() => ({
    on: vi.fn(),
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
  acquireCursorAcpConnection: vi.fn(async () => ({
    connection: {
      newSession: vi.fn(async () => ({
        sessionId: "cursor-acp-session-1",
        modes: { currentModeId: "edit" },
        models: { currentModelId: "auto" },
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
  })),
  releaseCursorAcpConnection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import system under test (after mocks)
// ---------------------------------------------------------------------------
import { createAgentChatService } from "./agentChatService";
import { detectAllAuth } from "../ai/authDetector";
import * as providerResolver from "../ai/providerResolver";

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
  const lanes = [
    { id: "lane-1", name: "Primary", laneType: "primary", branchRef: "feature/primary", worktreePath: tmpRoot },
  ];
  return {
    getLaneBaseAndBranch: vi.fn(() => ({
      baseRef: "main",
      branchRef: "feature/primary",
      worktreePath: tmpRoot,
      laneType: "primary",
    })),
    list: vi.fn(async () => lanes),
    ensurePrimaryLane: vi.fn(async () => {}),
    create: vi.fn(async ({ name }: { name: string }) => {
      const lane = {
        id: `lane-${lanes.length + 1}`,
        name,
        description: null,
        laneType: "feature",
        branchRef: `feature/generated-lane-${lanes.length + 1}`,
        worktreePath: path.join(tmpRoot, `generated-lane-${lanes.length + 1}`),
        parentLaneId: "lane-1",
      };
      fs.mkdirSync(lane.worktreePath, { recursive: true });
      lanes.push(lane);
      return lane;
    }),
    getLane: vi.fn((laneId: string) => lanes.find((l) => l.id === laneId) ?? null),
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
    list: vi.fn(() => Array.from(sessions.values())),
    reopen: vi.fn(),
    end: vi.fn(),
    updateMeta: vi.fn(),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
    setSummary: vi.fn(),
    setResumeCommand: vi.fn(),
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
  return {
    syncFromPrData: vi.fn((prId: string) => ({
      prId,
      items: [],
      convergence: {
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
      },
      runtime: {
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
      },
    })),
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
    getConvergenceRuntime: vi.fn(() => null),
    saveConvergenceRuntime: vi.fn(),
    resetConvergenceRuntime: vi.fn(),
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

function createService() {
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
  });

  return { service, logger };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-name-test-"));
  fs.mkdirSync(path.join(tmpRoot, ".ade", "cache", "chat-sessions"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, ".ade", "transcripts", "chat"), { recursive: true });
  mockState.sessions.clear();
  mockState.uuidCounter = 0;
  vi.mocked(generateText).mockReset();
  vi.mocked(detectAllAuth).mockResolvedValue([]);
  vi.mocked(providerResolver.resolveModel).mockResolvedValue({} as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests — suggestLaneNameFromPrompt
// ---------------------------------------------------------------------------

describe("suggestLaneNameFromPrompt", () => {
  it("returns 'parallel-task' for an empty prompt", async () => {
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("parallel-task");
  });

  it("returns 'parallel-task' for a whitespace-only prompt", async () => {
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "   \t\n  ",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("parallel-task");
  });

  it("returns a slug from a short prompt via fallback (no auth = no models)", async () => {
    // detectAllAuth returns [] so getRegistryModels returns [] → fallback path
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the login bug",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("fix-the-login-bug");
  });

  it("takes only first 4 words of a long prompt", async () => {
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Refactor the authentication service to use JWT tokens",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("refactor-the-authentication-service");
  });

  it("strips special characters from the prompt slug", async () => {
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix bug #123 in module!",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    // "Fix" "bug" "#123" "in" → "fix-bug--123-in" → strip non-alphanumeric except hyphens → "fix-bug--123-in" → collapse hyphens → "fix-bug-123-in"
    expect(result).toBe("fix-bug-123-in");
  });

  it("truncates the fallback slug to 48 characters", async () => {
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "superlongwordthatexceedsfortyeightcharacterswhenalone secondword thirdword fourthword",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result.length).toBeLessThanOrEqual(48);
  });

  it("collapses multiple whitespace in the prompt", async () => {
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "  fix   the   bug   now   please  ",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    // First 4 words: fix, the, bug, now
    expect(result).toBe("fix-the-bug-now");
  });

  it("falls back when generateText throws an error", async () => {
    // Provide auth so models are available, but make generateText throw
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    vi.mocked(generateText).mockRejectedValue(new Error("API rate limited"));

    const { service, logger } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Write a test suite",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    // Should fall back to slug generation
    expect(result).toBe("write-a-test-suite");
    // Should have logged a warning
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.suggest_lane_name_failed",
      expect.objectContaining({ error: "API rate limited" }),
    );
  });

  it("uses AI-generated name when generateText succeeds", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    vi.mocked(generateText).mockResolvedValue({
      text: "Login Bug Fix",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the authentication login failure in the dashboard",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    // normalizeLaneBase: lowercase, strip non-alnum/space/hyphen, trim, spaces→hyphens, collapse hyphens, slice(0,60)
    expect(result).toBe("login-bug-fix");
  });

  it("normalizes AI-generated name: strips special chars and lowercases", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    vi.mocked(generateText).mockResolvedValue({
      text: "JWT Auth Refactor!",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Refactor auth to use JWT",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    // "JWT Auth Refactor!" → sanitizeAutoTitle → "JWT Auth Refactor" → normalizeLaneBase → "jwt-auth-refactor"
    expect(result).toBe("jwt-auth-refactor");
  });

  it("normalizes AI-generated name: truncates to 60 characters", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const longName = "a".repeat(70);
    vi.mocked(generateText).mockResolvedValue({
      text: longName,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Do a very long task",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("falls back when AI returns empty text after sanitization", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    // Return only emoji/special chars that sanitizeAutoTitle will strip
    vi.mocked(generateText).mockResolvedValue({
      text: "!!!",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Something useful",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    // sanitizeAutoTitle strips these → empty → fallback
    expect(result).toBe("something-useful");
  });

  it("handles null/undefined args fields gracefully", async () => {
    const { service } = createService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: null as any,
      modelId: null as any,
      laneId: null as any,
    });
    expect(result).toBe("parallel-task");
  });
});
