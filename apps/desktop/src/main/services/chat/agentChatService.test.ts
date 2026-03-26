import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { generateText, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// vi.hoisted mock state
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  uuidCounter: 0,
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
      stdin: { write: vi.fn(), end: vi.fn(), writable: true },
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
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

vi.mock("../ai/providerResolver", () => ({
  normalizeCliMcpServers: vi.fn(() => ({})),
  resolveModel: vi.fn(async () => ({})),
  resolveProvider: vi.fn(),
}));

vi.mock("../ai/tools/universalTools", () => ({
  createUniversalToolSet: vi.fn(() => ({
    tools: {},
    prompts: [],
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

// ---------------------------------------------------------------------------
// Import system under test (after mocks)
// ---------------------------------------------------------------------------
import {
  buildComputerUseDirective,
  createAgentChatService,
} from "./agentChatService";
import { detectAllAuth } from "../ai/authDetector";
import * as providerResolver from "../ai/providerResolver";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import type { ComputerUseBackendStatus } from "../../../shared/types";

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
  return {
    getLaneBaseAndBranch: vi.fn((_laneId: string) => ({
      baseRef: "main",
      branchRef: "feature/test",
      worktreePath: tmpRoot,
      laneType: "feature",
    })),
    getLane: vi.fn(() => null),
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
    setResumeCommand: vi.fn((sessionId: string, resumeCommand: string | null) => {
      const row = sessions.get(sessionId);
      if (row) {
        row.resumeCommand = resumeCommand;
      }
    }),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
    setSummary: vi.fn(),
  } as any;
}

async function flushPromises(iterations = 4) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function getLatestSpawnProc() {
  const proc = vi.mocked(spawn).mock.results.at(-1)?.value as any;
  expect(proc).toBeTruthy();
  return proc;
}

function getLatestReader() {
  const reader = vi.mocked(readline.createInterface).mock.results.at(-1)?.value as any;
  expect(reader).toBeTruthy();
  return reader;
}

function getReaderLineHandler(reader: any): (line: string) => void {
  const lineCall = reader.on.mock.calls.find(([event]: [string]) => event === "line");
  expect(lineCall).toBeTruthy();
  return lineCall[1];
}

function writtenPayloads(proc: any): Array<Record<string, any>> {
  return proc.stdin.write.mock.calls.map(([payload]: [string]) => JSON.parse(String(payload).trim()));
}

async function waitForWrittenMethod(proc: any, method: string) {
  return waitForWrittenMethodCount(proc, method, 1);
}

async function waitForWrittenMethodCount(proc: any, method: string, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payloads = writtenPayloads(proc).filter((entry) => entry.method === method);
    if (payloads.length >= count) return payloads[count - 1];
    await flushPromises();
  }
  throw new Error(`Timed out waiting for request '${method}'. Saw methods: ${writtenPayloads(proc).map((entry) => entry.method).join(", ")}`);
}

async function completeCodexInitialize(proc: any, lineHandler: (line: string) => void) {
  const initialize = await waitForWrittenMethod(proc, "initialize");
  lineHandler(JSON.stringify({
    jsonrpc: "2.0",
    id: initialize.id,
    result: {},
  }));
  await flushPromises();
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

function createService(overrides: Record<string, unknown> = {}) {
  const logger = createLogger();
  const laneService = createMockLaneService();
  const sessionService = createMockSessionService();
  const projectConfigService = createMockProjectConfigService();
  const transcriptsDir = path.join(tmpRoot, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const service = createAgentChatService({
    projectRoot: tmpRoot,
    transcriptsDir,
    projectId: "test-project",
    laneService,
    sessionService,
    projectConfigService,
    logger: logger as any,
    appVersion: "0.0.1-test",
    ...overrides,
  });

  return { service, logger, laneService, sessionService, projectConfigService };
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
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
  vi.mocked(unstable_v2_createSession).mockReset();
  vi.mocked(unstable_v2_resumeSession).mockReset();
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

    it("stores the real runtime model name for Codex GPT-5.4 sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      });

      expect(session.modelId).toBe("openai/gpt-5.4-codex");
      expect(session.model).toBe("gpt-5.4");
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
      expect(persisted.version).toBe(1);
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

      await new Promise((resolve) => setTimeout(resolve, 25));
      const transcriptPath = mockState.sessions.get(result.session.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      const transcript = fs.readFileSync(String(transcriptPath), "utf8");
      expect(transcript).toContain("Chat handoff from previous session");
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

    it("skips memory search for trivial test pings", async () => {
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
        text: "this is a test",
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
            message: expect.stringContaining("Memory:"),
          }),
        }),
      );
    });

    it("loads bootstrap memory for non-trivial arbitrary turns even without targeted search", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 2, outputTokens: 2 } };
        })(),
      } as any);

      const memoryService = {
        search: vi.fn(async () => []),
      } as any;
      const memoryFilesService = {
        buildPromptContext: vi.fn(() => ({
          text: "ADE auto memory bootstrap (generated from promoted project memory):\n- Decision: keep SQLite as the canonical store.",
          bootstrapLoaded: true,
          topicFilesLoaded: [],
        })),
      } as any;
      const onEvent = vi.fn();
      const { service } = createService({
        memoryService,
        memoryFilesService,
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
        text: "Take a look at the release flow and tell me what stands out.",
      });

      expect(memoryFilesService.buildPromptContext).toHaveBeenCalled();
      expect(memoryService.search).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "memory",
            message: expect.stringContaining("loaded bootstrap"),
          }),
        }),
      );
    });

    it("injects generated auto memory bootstrap into coding turns", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 2, outputTokens: 2 } };
        })(),
      } as any);

      const memoryService = {
        search: vi.fn(async () => []),
      } as any;
      const memoryFilesService = {
        buildPromptContext: vi.fn(() => ({
          text: "ADE auto memory bootstrap (generated from promoted project memory):\n- Convention: keep SQLite as the memory source of truth.",
          bootstrapLoaded: true,
          topicFilesLoaded: ["conventions.md"],
        })),
      } as any;
      const onEvent = vi.fn();
      const { service } = createService({
        memoryService,
        memoryFilesService,
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
        text: "Fix the failing memory tests in the desktop app.",
      });

      expect(memoryFilesService.buildPromptContext).toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "memory",
            detail: expect.objectContaining({
              sections: expect.arrayContaining([
                expect.objectContaining({
                  title: "Auto memory files",
                  items: expect.arrayContaining([
                    expect.stringContaining(".ade/memory/MEMORY.md"),
                    expect.stringContaining("conventions.md"),
                  ]),
                }),
              ]),
            }),
          }),
        }),
      );
    });

    it("captures explicit user instructions into memory", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 2, outputTokens: 1 } };
        })(),
      } as any);

      const savedMemory = {
        id: "memory-saved-1",
        projectId: "test-project",
        scope: "project",
        scopeOwnerId: null,
        tier: 2,
        category: "convention",
        content: "Convention: we always use pnpm, not npm, in this repo.",
        importance: "high",
        sourceSessionId: "test-uuid-1",
        sourcePackKey: null,
        createdAt: "2026-03-25T10:00:00.000Z",
        updatedAt: "2026-03-25T10:00:00.000Z",
        lastAccessedAt: "2026-03-25T10:00:00.000Z",
        accessCount: 0,
        observationCount: 0,
        status: "promoted",
        agentId: "test-uuid-1",
        confidence: 1,
        promotedAt: "2026-03-25T10:00:00.000Z",
        sourceRunId: null,
        sourceType: "user",
        sourceId: "chat:auto-capture",
        fileScopePattern: null,
        pinned: false,
        accessScore: 0,
        compositeScore: 0.9,
        writeGateReason: null,
      };
      const memoryService = {
        search: vi.fn(async () => []),
        writeMemory: vi.fn(() => ({
          accepted: true,
          memory: savedMemory,
          deduped: false,
        })),
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
        text: "Please remember we always use pnpm, not npm, in this repo.",
      });

      expect(memoryService.writeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "project",
          category: "convention",
          sourceType: "user",
        }),
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "memory",
            message: expect.stringContaining("Captured explicit user instruction"),
          }),
        }),
      );
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
        unifiedPermissionMode: "full-auto",
      });

      expect(updated.unifiedPermissionMode).toBe("full-auto");
    });

    it("keeps the Codex wrapper id while updating the runtime model name", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        modelId: "openai/gpt-5.4-codex",
      });

      expect(updated.modelId).toBe("openai/gpt-5.4-codex");
      expect(updated.model).toBe("gpt-5.4");
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

    it("resets an idle Claude SDK session when permission mode changes", async () => {
      const close = vi.fn();
      vi.mocked(unstable_v2_createSession).mockReturnValue({
        send: vi.fn(async () => {}),
        stream: vi.fn(() => (async function* () {
          yield { type: "system", subtype: "init", session_id: "sdk-session-1" } as any;
          yield { type: "result" } as any;
        })()),
        close,
        sessionId: "sdk-session-1",
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await flushPromises(8);

      await service.updateSession({
        sessionId: session.id,
        claudePermissionMode: "bypassPermissions",
      });

      expect(close).toHaveBeenCalled();
    });

    it("rebinds the current Codex thread on the next turn after settings change", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      });

      const persistedPath = path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${session.id}.json`);
      const persisted = JSON.parse(fs.readFileSync(persistedPath, "utf8"));
      persisted.threadId = "thread-codex-1";
      fs.writeFileSync(persistedPath, JSON.stringify(persisted, null, 2), "utf8");

      const resumePromise = service.resumeSession({ sessionId: session.id });
      const proc = getLatestSpawnProc();
      const reader = getLatestReader();
      const lineHandler = getReaderLineHandler(reader);
      await completeCodexInitialize(proc, lineHandler);
      const initialThreadResume = await waitForWrittenMethodCount(proc, "thread/resume", 1);
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: initialThreadResume.id,
        result: {},
      }));
      await resumePromise;

      await service.updateSession({
        sessionId: session.id,
        codexSandbox: "danger-full-access",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "second turn",
      });

      await flushPromises();
      const threadResume = await waitForWrittenMethodCount(proc, "thread/resume", 2);
      expect(threadResume.params.threadId).toBe("thread-codex-1");
      expect(threadResume.params.sandbox).toBe("danger-full-access");

      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: threadResume.id,
        result: {},
      }));
      await flushPromises();

      const secondTurnStart = await waitForWrittenMethodCount(proc, "turn/start", 1);
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: secondTurnStart.id,
        result: { turn: { id: "turn-2" } },
      }));
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", status: "completed" } },
      }));
      await flushPromises(8);
    });
  });

  describe("codex runtime continuity", () => {
    it("captures thread identity from thread/started notifications", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      });

      const turnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "hello codex",
        timeoutMs: 15_000,
      });

      await flushPromises();
      const proc = getLatestSpawnProc();
      const reader = getLatestReader();
      const lineHandler = getReaderLineHandler(reader);
      await completeCodexInitialize(proc, lineHandler);

      const threadStart = await waitForWrittenMethod(proc, "thread/start");
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: threadStart.id,
        result: {},
      }));
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/started",
        params: { thread: { id: "thread-from-notification" } },
      }));

      await flushPromises();
      const turnStart = await waitForWrittenMethodCount(proc, "turn/start", 1);

      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: turnStart.id,
        result: { turn: { id: "turn-notify-1" } },
      }));
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-notify-1", status: "completed" } },
      }));

      const result = await turnPromise;
      expect(result.threadId).toBe("thread-from-notification");
      expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
        session.id,
        "chat:codex:thread-from-notification",
      );

      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${session.id}.json`), "utf8"),
      );
      expect(persisted.threadId).toBe("thread-from-notification");
    });

    it("captures thread identity from nested raw Codex agent-message payloads", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      });

      const firstTurnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "hello codex",
        timeoutMs: 15_000,
      });

      await flushPromises();
      const proc = getLatestSpawnProc();
      const reader = getLatestReader();
      const lineHandler = getReaderLineHandler(reader);
      await completeCodexInitialize(proc, lineHandler);

      const threadStart = await waitForWrittenMethod(proc, "thread/start");
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: threadStart.id,
        result: {},
      }));
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        method: "codex/event/agent_message_content_delta",
        params: {
          msg: {
            id: "agent-message-1",
            conversationId: "thread-from-raw-msg",
            content: "hello from nested raw event",
          },
        },
      }));

      await flushPromises();
      const firstTurnStart = await waitForWrittenMethodCount(proc, "turn/start", 1);
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: firstTurnStart.id,
        result: { turn: { id: "turn-raw-1" } },
      }));
      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-raw-1", status: "completed" } },
      }));

      const firstResult = await firstTurnPromise;
      expect(firstResult.threadId).toBe("thread-from-raw-msg");
      expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
        session.id,
        "chat:codex:thread-from-raw-msg",
      );
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${session.id}.json`), "utf8"),
      );
      expect(persisted.threadId).toBe("thread-from-raw-msg");
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
      const modelsPromise = service.getAvailableModels({ provider: "codex" });
      await flushPromises();

      const proc = getLatestSpawnProc();
      const reader = getLatestReader();
      const lineHandler = getReaderLineHandler(reader);
      await completeCodexInitialize(proc, lineHandler);
      const modelList = await waitForWrittenMethod(proc, "model/list");

      lineHandler(JSON.stringify({
        jsonrpc: "2.0",
        id: modelList.id,
        result: {
          data: [{
            id: "openai/gpt-5.4-codex",
            displayName: "GPT-5.4 Codex",
            isDefault: true,
          }],
        },
      }));

      const models = await modelsPromise;
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
});
