import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  detectAllAuth: vi.fn(),
  getCachedCliAuthStatuses: vi.fn(),
  resetLocalProviderDetectionCache: vi.fn(),
  verifyProviderApiKey: vi.fn(),
  buildProviderConnections: vi.fn(),
  inspectLocalProvider: vi.fn(),
  clearCursorCliModelsCache: vi.fn(),
  discoverCursorCliModelDescriptors: vi.fn(),
  getApiKeyStoreStatus: vi.fn(),
  initModelsDevService: vi.fn(),
  probeClaudeRuntimeHealth: vi.fn(),
  resetClaudeRuntimeProbeCache: vi.fn(),
  runProviderTask: vi.fn(),
}));

vi.mock("./authDetector", () => ({
  detectAllAuth: (...args: unknown[]) => mockState.detectAllAuth(...args),
  getCachedCliAuthStatuses: (...args: unknown[]) => mockState.getCachedCliAuthStatuses(...args),
  resetLocalProviderDetectionCache: (...args: unknown[]) => mockState.resetLocalProviderDetectionCache(...args),
  verifyProviderApiKey: (...args: unknown[]) => mockState.verifyProviderApiKey(...args),
}));

vi.mock("./providerConnectionStatus", () => ({
  buildProviderConnections: (...args: unknown[]) => mockState.buildProviderConnections(...args),
}));

vi.mock("./localModelDiscovery", () => ({
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

vi.mock("./providerTaskRunner", () => ({
  runProviderTask: (...args: unknown[]) => mockState.runProviderTask(...args),
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
  mockState.getCachedCliAuthStatuses.mockReturnValue(statuses);
  mockState.detectAllAuth.mockResolvedValue([
    ...(availability.claude
      ? [{ type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true }]
      : []),
    ...(availability.codex
      ? [{ type: "cli-subscription", cli: "codex", path: "/usr/local/bin/codex", authenticated: true, verified: true }]
      : []),
    ...(availability.cursor
      ? [{ type: "cli-subscription", cli: "cursor", path: "/usr/local/bin/agent", authenticated: true, verified: true }]
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
  mockState.runProviderTask.mockResolvedValue({
    text: "provider response",
    structuredOutput: null,
    sessionId: "session-1",
  });
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
  it("routes executeTask through the provider task runner", async () => {
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

    expect(mockState.runProviderTask).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("provider response");
    expect(result.sessionId).toBe("session-1");
    expect(usageInsertCalls(runCalls)).toHaveLength(1);
  });

  it("passes through the resolved descriptor and session id", async () => {
    const { service } = makeService({
      aiConfig: { features: { orchestrator: true } },
    });

    await service.executeTask({
      feature: "orchestrator",
      taskType: "review",
      prompt: "Evaluate this step",
      cwd: "/tmp",
      model: "openai/gpt-5.4-codex",
      sessionId: "carry-forward-session",
      permissionMode: "read-only",
    });

    expect(mockState.runProviderTask).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "carry-forward-session",
      descriptor: expect.objectContaining({ id: "openai/gpt-5.4-codex" }),
      permissionMode: "read-only",
    }));
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

    expect(mockState.runProviderTask).toHaveBeenCalledTimes(1);
    const firstCall = mockState.runProviderTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall.descriptor).toMatchObject({ id: expect.any(String) });
  });

  it("fails in guest mode when no providers are available", async () => {
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false, cursor: false },
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

  it("reports unreachable configured local runtimes clearly", async () => {
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

  it("reports auto-detected local runtime blockers without undefined endpoints", async () => {
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

    expect(ollama?.endpoint).toBe(getLocalProviderDefaultEndpoint("ollama"));
    expect(ollama?.blocker).toBe(`Ollama did not respond at ${getLocalProviderDefaultEndpoint("ollama")}.`);
  });

  it("coalesces concurrent getStatus calls for the same request shape", async () => {
    const { service } = makeService();
    let resolveAuth: ((value: Array<Record<string, unknown>>) => void) | null = null;
    const authPromise = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveAuth = resolve;
    });
    mockState.detectAllAuth.mockReturnValue(authPromise);

    const first = service.getStatus();
    const second = service.getStatus();

    expect(mockState.detectAllAuth).toHaveBeenCalledTimes(1);

    expect(resolveAuth).not.toBeNull();
    resolveAuth!([
      { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
      { type: "cli-subscription", cli: "codex", path: "/usr/local/bin/codex", authenticated: true, verified: true },
    ]);

    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    expect(mockState.buildProviderConnections).toHaveBeenCalledTimes(1);
    expect(secondStatus).toEqual(firstStatus);
  });
});
