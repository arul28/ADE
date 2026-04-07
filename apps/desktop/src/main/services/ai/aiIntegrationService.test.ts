import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  detectAllAuth: vi.fn(),
  detectCliAuthStatuses: vi.fn(),
  getCachedCliAuthStatuses: vi.fn(),
  resetLocalProviderDetectionCache: vi.fn(),
  verifyProviderApiKey: vi.fn(),
  executeUnified: vi.fn(),
  resumeUnified: vi.fn(),
  buildProviderConnections: vi.fn(),
  discoverLocalModels: vi.fn(),
  inspectLocalProvider: vi.fn(),
  clearCursorCliModelsCache: vi.fn(),
  discoverCursorCliModelDescriptors: vi.fn(),
  getApiKeyStoreStatus: vi.fn(),
  initModelsDevService: vi.fn(),
  probeClaudeRuntimeHealth: vi.fn(),
  resetClaudeRuntimeProbeCache: vi.fn(),
}));

vi.mock("./authDetector", () => ({
  detectAllAuth: (...args: unknown[]) => mockState.detectAllAuth(...args),
  detectCliAuthStatuses: (...args: unknown[]) => mockState.detectCliAuthStatuses(...args),
  getCachedCliAuthStatuses: (...args: unknown[]) => mockState.getCachedCliAuthStatuses(...args),
  resetLocalProviderDetectionCache: (...args: unknown[]) => mockState.resetLocalProviderDetectionCache(...args),
  verifyProviderApiKey: (...args: unknown[]) => mockState.verifyProviderApiKey(...args),
}));

vi.mock("./unifiedExecutor", () => ({
  executeUnified: (...args: unknown[]) => mockState.executeUnified(...args),
  resumeUnified: (...args: unknown[]) => mockState.resumeUnified(...args),
}));

vi.mock("./providerConnectionStatus", () => ({
  buildProviderConnections: (...args: unknown[]) => mockState.buildProviderConnections(...args),
}));

vi.mock("./localModelDiscovery", () => ({
  discoverLocalModels: (...args: unknown[]) => mockState.discoverLocalModels(...args),
  inspectLocalProvider: (...args: unknown[]) => mockState.inspectLocalProvider(...args),
}));

vi.mock("../chat/cursorModelsDiscovery", () => ({
  clearCursorCliModelsCache: (...args: unknown[]) => mockState.clearCursorCliModelsCache(...args),
  discoverCursorCliModelDescriptors: (...args: unknown[]) => mockState.discoverCursorCliModelDescriptors(...args),
}));

vi.mock("./apiKeyStore", () => ({
  getApiKeyStoreStatus: (...args: unknown[]) => mockState.getApiKeyStoreStatus(...args),
}));

vi.mock("./modelsDevService", () => ({
  initialize: (...args: unknown[]) => mockState.initModelsDevService(...args),
}));

vi.mock("./claudeRuntimeProbe", () => ({
  probeClaudeRuntimeHealth: (...args: unknown[]) => mockState.probeClaudeRuntimeHealth(...args),
  resetClaudeRuntimeProbeCache: (...args: unknown[]) => mockState.resetClaudeRuntimeProbeCache(...args),
}));

import { getLocalProviderDefaultEndpoint } from "../../../shared/modelRegistry";
import { createAiIntegrationService } from "./aiIntegrationService";

type ServiceFactoryOptions = {
  aiConfig?: Record<string, unknown>;
  dailyUsageCount?: number;
  availability?: { claude: boolean; codex: boolean; cursor?: boolean };
  providerMode?: "guest" | "subscription";
};

type DbRunCall = { sql: string; params: unknown[] };

function streamEvents(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

function makeProviderConnections(availability: { claude: boolean; codex: boolean; cursor: boolean }) {
  const checkedAt = "2025-01-01T00:00:00.000Z";
  return {
    claude: {
      provider: "claude",
      authAvailable: availability.claude,
      runtimeDetected: availability.claude,
      runtimeAvailable: availability.claude,
      sources: [],
      path: availability.claude ? "/usr/local/bin/claude" : null,
      blocker: availability.claude ? null : "Claude unavailable",
      lastCheckedAt: checkedAt,
    },
    codex: {
      provider: "codex",
      authAvailable: availability.codex,
      runtimeDetected: availability.codex,
      runtimeAvailable: availability.codex,
      sources: [],
      path: availability.codex ? "/usr/local/bin/codex" : null,
      blocker: availability.codex ? null : "Codex unavailable",
      lastCheckedAt: checkedAt,
    },
    cursor: {
      provider: "cursor",
      authAvailable: availability.cursor,
      runtimeDetected: availability.cursor,
      runtimeAvailable: availability.cursor,
      sources: [],
      path: availability.cursor ? "/usr/local/bin/agent" : null,
      blocker: availability.cursor ? null : "Cursor unavailable",
      lastCheckedAt: checkedAt,
    },
  };
}

function makeService(options: ServiceFactoryOptions = {}) {
  const runCalls: DbRunCall[] = [];
  const db = {
    get: vi.fn((sql: string) => {
      if (sql.includes("select count(*) as count")) {
        return { count: options.dailyUsageCount ?? 0 };
      }
      return null;
    }),
    all: vi.fn(() => []),
    run: vi.fn((sql: string, params: unknown[]) => {
      runCalls.push({ sql, params });
    })
  } as any;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as any;

  const snapshot = {
    effective: {
      providerMode: options.providerMode ?? "subscription",
      ai: options.aiConfig ?? {},
      providers: {}
    }
  };

  const projectConfigService = {
    get: vi.fn(() => snapshot)
  } as any;

  const availability = {
    claude: true,
    codex: true,
    cursor: false,
    ...(options.availability ?? {}),
  };
  const statuses = [
    {
      cli: "claude",
      installed: availability.claude,
      path: availability.claude ? "/usr/local/bin/claude" : null,
      authenticated: availability.claude,
      verified: true,
    },
    {
      cli: "codex",
      installed: availability.codex,
      path: availability.codex ? "/usr/local/bin/codex" : null,
      authenticated: availability.codex,
      verified: true,
    },
    {
      cli: "cursor",
      installed: availability.cursor,
      path: availability.cursor ? "/usr/local/bin/agent" : null,
      authenticated: availability.cursor,
      verified: true,
    },
  ];
  mockState.detectCliAuthStatuses.mockReturnValue(statuses);
  mockState.getCachedCliAuthStatuses.mockReturnValue(statuses);
  mockState.detectAllAuth.mockResolvedValue([
    ...(availability.claude
      ? [
          {
            type: "cli-subscription",
            cli: "claude",
            path: "/usr/local/bin/claude",
            authenticated: true,
            verified: true,
          },
        ]
      : []),
    ...(availability.codex
      ? [
          {
            type: "cli-subscription",
            cli: "codex",
            path: "/usr/local/bin/codex",
            authenticated: true,
            verified: true,
          },
        ]
      : []),
    ...(availability.cursor
      ? [
          {
            type: "cli-subscription",
            cli: "cursor",
            path: "/usr/local/bin/agent",
            authenticated: true,
            verified: true,
          },
        ]
      : []),
  ]);
  mockState.buildProviderConnections.mockResolvedValue(makeProviderConnections(availability));

  const service = createAiIntegrationService({
    db,
    logger,
    projectConfigService,
    projectRoot: "/tmp/project",
  });

  return { service, runCalls };
}

function usageInsertCalls(runCalls: DbRunCall[]): DbRunCall[] {
  return runCalls.filter((entry) => entry.sql.includes("insert into ai_usage_log"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.executeUnified.mockImplementation(() =>
    streamEvents([
      { type: "text", content: "unified response" },
      {
        type: "done",
        sessionId: "session-1",
        model: "anthropic/claude-sonnet-4-6",
        usage: { inputTokens: 123, outputTokens: 45 }
      }
    ])
  );
  mockState.resumeUnified.mockImplementation(() => streamEvents([]));
  mockState.discoverLocalModels.mockResolvedValue([]);
  mockState.inspectLocalProvider.mockImplementation(async (provider: string, endpoint: string) => ({
    provider,
    endpoint,
    reachable: false,
    health: "unreachable",
    loadedModels: [],
  }));
  mockState.clearCursorCliModelsCache.mockImplementation(() => undefined);
  mockState.discoverCursorCliModelDescriptors.mockResolvedValue([]);
  mockState.getApiKeyStoreStatus.mockReturnValue({
    secureStorageAvailable: true,
    legacyPlaintextDetected: false,
    decryptionFailed: false,
    encryptedStorePath: null,
    legacyPlaintextPath: null,
  });
  mockState.initModelsDevService.mockResolvedValue(new Map());
  mockState.probeClaudeRuntimeHealth.mockResolvedValue(undefined);
});

describe("aiIntegrationService", () => {
  it("routes executeTask through unified executor", async () => {
    const { service, runCalls } = makeService({
      aiConfig: { features: { mission_planning: true } },
    });

    const result = await service.executeTask({
      feature: "mission_planning",
      taskType: "planning",
      prompt: "Plan this mission",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-6"
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("unified response");
    expect(result.sessionId).toBe("session-1");
    expect(usageInsertCalls(runCalls)).toHaveLength(1);
  });

  it("preserves legacy defaults for missing AI feature toggles", () => {
    const { service } = makeService();
    const { service: enabledService } = makeService({
      aiConfig: {
        features: {
          commit_messages: true,
          terminal_summaries: true,
          pr_descriptions: true,
        },
      },
    });

    expect(service.getFeatureFlag("commit_messages")).toBe(false);
    expect(service.getFeatureFlag("terminal_summaries")).toBe(true);
    expect(service.getFeatureFlag("pr_descriptions")).toBe(true);
    expect(service.getFeatureFlag("orchestrator")).toBe(true);
    expect(enabledService.getFeatureFlag("commit_messages")).toBe(true);
    expect(enabledService.getFeatureFlag("terminal_summaries")).toBe(true);
    expect(enabledService.getFeatureFlag("pr_descriptions")).toBe(true);
  });

  it("routes generated commit messages through the commit_messages feature", async () => {
    const { service, runCalls } = makeService({
      aiConfig: {
        features: {
          commit_messages: true,
        },
      },
    });

    await service.generateCommitMessage({
      cwd: "/tmp",
      prompt: "Write a commit message",
      model: "anthropic/claude-haiku-4-5",
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(1);
    const usageCall = usageInsertCalls(runCalls)[0];
    expect(usageCall?.params[2]).toBe("commit_messages");
  });

  it("treats detected providers as subscription-capable even when config mode is guest", async () => {
    const { service } = makeService({
      providerMode: "guest",
      aiConfig: {
        features: {
          commit_messages: true,
        },
      },
      availability: { claude: true, codex: false },
    });

    await service.generateCommitMessage({
      cwd: "/tmp",
      prompt: "Write a commit message",
      model: "anthropic/claude-haiku-4-5",
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(1);
    await expect(service.getStatus()).resolves.toMatchObject({ mode: "subscription" });
  });

  it("runs the Claude runtime probe during forced status refresh when Claude CLI looks available", async () => {
    const { service } = makeService({
      availability: { claude: true, codex: false },
    });

    await service.getStatus({ force: true });

    expect(mockState.resetClaudeRuntimeProbeCache).toHaveBeenCalledTimes(1);
    expect(mockState.probeClaudeRuntimeHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/tmp/project",
        force: true,
      }),
    );
  });

  it("reports unreachable auto-detected local runtimes without undefined endpoint text", async () => {
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false, cursor: false },
      aiConfig: {
        localProviders: {
          ollama: {
            autoDetect: true,
          },
        },
      },
    });

    const status = await service.getStatus();
    const ollama = status.runtimeConnections?.ollama;

    expect(ollama).toMatchObject({
      source: "auto",
      endpoint: getLocalProviderDefaultEndpoint("ollama"),
      health: "unreachable",
    });
    expect(ollama?.blocker).toBe(`Ollama did not respond at ${getLocalProviderDefaultEndpoint("ollama")}.`);
    expect(ollama?.blocker).not.toContain("undefined");
  });

  it("preserves configured endpoint details when a local runtime stays unreachable", async () => {
    const configuredEndpoint = "http://127.0.0.1:11434/custom";
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false, cursor: false },
      aiConfig: {
        localProviders: {
          ollama: {
            endpoint: configuredEndpoint,
            autoDetect: true,
          },
        },
      },
    });

    const status = await service.getStatus();
    const ollama = status.runtimeConnections?.ollama;

    expect(ollama).toMatchObject({
      source: "config",
      endpoint: configuredEndpoint,
      health: "unreachable",
    });
    expect(ollama?.blocker).toBe(`Ollama is configured for ${configuredEndpoint}, but the runtime did not respond.`);
  });

  it("uses planning tools for mission planning tasks", async () => {
    const { service } = makeService({
      aiConfig: { features: { mission_planning: true } },
    });

    await service.executeTask({
      feature: "mission_planning",
      taskType: "mission_planning",
      prompt: "Plan this mission",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(1);
    const firstCall = mockState.executeUnified.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall.tools).toBe("planning");
  });

  it("resolves a default task model when model is omitted", async () => {
    const { service } = makeService({
      aiConfig: { features: { orchestrator: true } },
    });

    await service.executeTask({
      feature: "orchestrator",
      taskType: "implementation",
      prompt: "Implement feature",
      cwd: "/tmp"
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(1);
    const firstCall = mockState.executeUnified.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof firstCall.modelId).toBe("string");
    expect(String(firstCall.modelId).length).toBeGreaterThan(0);
  });

  it("resolves a default model for memory consolidation tasks when model is omitted", async () => {
    const { service } = makeService({
      aiConfig: { features: { memory_consolidation: true } },
    });

    await service.executeTask({
      feature: "memory_consolidation",
      taskType: "memory_consolidation",
      prompt: "Merge these memory entries",
      cwd: "/tmp",
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(1);
    const firstCall = mockState.executeUnified.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof firstCall.modelId).toBe("string");
    expect(String(firstCall.modelId)).toContain("claude");
  });

  it("uses planning tools for read-only orchestrator tasks and none for other read-only tasks", async () => {
    const { service } = makeService({
      aiConfig: { features: { orchestrator: true, terminal_summaries: true, initial_context: true } },
    });

    await service.executeTask({
      feature: "orchestrator",
      taskType: "planning",
      prompt: "Check worker status",
      cwd: "/tmp",
      model: "openai/gpt-5.4",
      permissionMode: "read-only",
    });

    await service.executeTask({
      feature: "terminal_summaries",
      taskType: "terminal_summary",
      prompt: "Summarize this terminal output",
      cwd: "/tmp",
      model: "openai/gpt-5.4",
      permissionMode: "read-only",
    });

    await service.executeTask({
      feature: "initial_context",
      taskType: "initial_context",
      prompt: "Generate bootstrap docs",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-6",
      permissionMode: "read-only",
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(3);
    const orchestratorCall = mockState.executeUnified.mock.calls[0]?.[0] as Record<string, unknown>;
    const summaryCall = mockState.executeUnified.mock.calls[1]?.[0] as Record<string, unknown>;
    const initialContextCall = mockState.executeUnified.mock.calls[2]?.[0] as Record<string, unknown>;
    expect(orchestratorCall.tools).toBe("planning");
    expect(summaryCall.tools).toBe("none");
    expect(initialContextCall.tools).toBe("none");
  });

  it("forwards memory context and compaction identifiers to the unified executor when provided", async () => {
    const { service } = makeService({
      aiConfig: { features: { orchestrator: true } },
    });
    const memoryService = {
      writeMemory: vi.fn(),
    } as any;
    const compactionFlushService = {
      beforeCompaction: vi.fn(),
    } as any;

    service.setCompactionFlushService(compactionFlushService);

    await service.executeTask({
      feature: "orchestrator",
      taskType: "implementation",
      prompt: "Implement with memory context",
      cwd: "/tmp",
      model: "openai/gpt-5.4",
      projectId: "project-1",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      memoryService,
    });

    expect(mockState.executeUnified).toHaveBeenCalledTimes(1);
    const firstCall = mockState.executeUnified.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall.projectId).toBe("project-1");
    expect(firstCall.runId).toBe("run-1");
    expect(firstCall.stepId).toBe("step-1");
    expect(firstCall.attemptId).toBe("attempt-1");
    expect(firstCall.memoryService).toBe(memoryService);
    expect(firstCall.enableCompaction).toBe(true);
    expect(firstCall.compactionFlushService).toBe(compactionFlushService);
  });

  it("fails in guest mode", async () => {
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false },
    });

    await expect(
      service.executeTask({
        feature: "orchestrator",
        taskType: "planning",
        prompt: "Plan",
        cwd: "/tmp"
      })
    ).rejects.toThrow(/No AI provider is available/i);
  });
});
