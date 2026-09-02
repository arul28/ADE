import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  detectAllAuth: vi.fn(),
  getCachedCliAuthStatuses: vi.fn(),
  resetLocalProviderDetectionCache: vi.fn(),
  verifyProviderApiKey: vi.fn(),
  buildProviderConnections: vi.fn(),
  inspectLocalProvider: vi.fn(),
  clearCursorCliModelsCache: vi.fn(),
  markCursorModelCachesStale: vi.fn(),
  discoverCursorCliModelDescriptors: vi.fn(),
  discoverCursorSdkModelDescriptors: vi.fn(),
  verifyExplicitCursorModelSelection: vi.fn(),
  probeCursorSdkModelDiscovery: vi.fn(),
  getApiKeyStoreStatus: vi.fn(),
  initModelsDevService: vi.fn(),
  probeClaudeRuntimeHealth: vi.fn(),
  resetClaudeRuntimeProbeCache: vi.fn(),
  runProviderTask: vi.fn(),
  clearOpenCodeInventoryCache: vi.fn(),
  peekOpenCodeInventoryCache: vi.fn(),
  probeOpenCodeProviderInventory: vi.fn(),
  loadPersistedOpenCodeInventory: vi.fn((..._args: unknown[]) => [] as unknown[]),
  getModelsDevLastFetchedAt: vi.fn((..._args: unknown[]) => null as number | null),
  clearOpenCodeBinaryCache: vi.fn(),
  resolveOpenCodeBinary: vi.fn(),
  probeAllAcpProviderAuth: vi.fn(),
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

vi.mock("./acpAuthProbe", () => ({
  probeAllAcpProviderAuth: (...args: unknown[]) => mockState.probeAllAcpProviderAuth(...args),
}));

vi.mock("./qwenUserSettings", () => ({
  loadQwenUserSettings: vi.fn(async () => ({
    authenticated: false,
    models: [],
    defaultModelId: null,
  })),
}));

vi.mock("./localModelDiscovery", () => ({
  inspectLocalProvider: (...args: unknown[]) => mockState.inspectLocalProvider(...args),
}));

vi.mock("../chat/cursorModelsDiscovery", async (importOriginal) => ({
  // The failure-message builder stays real: these tests assert the exact
  // sentence a rejected cloud launch shows, and that sentence is the contract.
  describeCursorSdkModelSelectionFailure:
    (await importOriginal<typeof import("../chat/cursorModelsDiscovery")>())
      .describeCursorSdkModelSelectionFailure,
  clearCursorCliModelsCache: (...args: unknown[]) => mockState.clearCursorCliModelsCache(...args),
  markCursorModelCachesStale: (...args: unknown[]) => mockState.markCursorModelCachesStale(...args),
  discoverCursorCliModelDescriptors: (...args: unknown[]) => mockState.discoverCursorCliModelDescriptors(...args),
  discoverCursorSdkModelDescriptors: (...args: unknown[]) => mockState.discoverCursorSdkModelDescriptors(...args),
  verifyExplicitCursorModelSelection: (...args: unknown[]) => mockState.verifyExplicitCursorModelSelection(...args),
  probeCursorSdkModelDiscovery: (...args: unknown[]) => mockState.probeCursorSdkModelDiscovery(...args),
}));

vi.mock("./apiKeyStore", () => ({
  getApiKeyStoreStatus: (...args: unknown[]) => mockState.getApiKeyStoreStatus(...args),
}));

vi.mock("./modelsDevService", () => ({
  initialize: (...args: unknown[]) => mockState.initModelsDevService(...args),
  getLastFetchedAt: (...args: unknown[]) => mockState.getModelsDevLastFetchedAt(...args),
}));

vi.mock("./claudeRuntimeProbe", () => ({
  probeClaudeRuntimeHealth: (...args: unknown[]) => mockState.probeClaudeRuntimeHealth(...args),
  resetClaudeRuntimeProbeCache: (...args: unknown[]) => mockState.resetClaudeRuntimeProbeCache(...args),
}));

vi.mock("./providerTaskRunner", () => ({
  runProviderTask: (...args: unknown[]) => mockState.runProviderTask(...args),
}));

const cursorCloudMocks = vi.hoisted(() => ({
  loadCursorSdk: vi.fn(),
  resolveCursorCloudCreateCloudExtras: vi.fn(),
}));

vi.mock("./cursorSdkLoader", () => ({
  loadCursorSdk: (...args: unknown[]) => cursorCloudMocks.loadCursorSdk(...args),
}));

vi.mock("../chat/cursorCloudCreateOptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat/cursorCloudCreateOptions")>();
  return {
    ...actual,
    resolveCursorCloudCreateCloudExtras: (
      ...args: Parameters<typeof actual.resolveCursorCloudCreateCloudExtras>
    ) => cursorCloudMocks.resolveCursorCloudCreateCloudExtras(...args),
  };
});

vi.mock("../opencode/openCodeInventory", () => ({
  clearOpenCodeInventoryCache: (...args: unknown[]) => mockState.clearOpenCodeInventoryCache(...args),
  peekOpenCodeInventoryCache: (...args: unknown[]) => mockState.peekOpenCodeInventoryCache(...args),
  probeOpenCodeProviderInventory: (...args: unknown[]) => mockState.probeOpenCodeProviderInventory(...args),
  loadPersistedOpenCodeInventory: (...args: unknown[]) => mockState.loadPersistedOpenCodeInventory(...args),
}));

vi.mock("../opencode/openCodeBinaryManager", () => ({
  clearOpenCodeBinaryCache: (...args: unknown[]) => mockState.clearOpenCodeBinaryCache(...args),
  resolveOpenCodeBinary: (...args: unknown[]) => mockState.resolveOpenCodeBinary(...args),
}));

import { createDynamicCursorCliModelDescriptor, getLocalProviderDefaultEndpoint } from "../../../shared/modelRegistry";
// The real builder, kept real by the module mock above: these tests assert the
// exact sentence a rejected cloud launch shows.
import { describeCursorSdkModelSelectionFailure } from "../chat/cursorModelsDiscovery";
import { createAiIntegrationService, missingFeatureModelMessage } from "./aiIntegrationService";

type ServiceFactoryOptions = {
  aiConfig?: Record<string, unknown>;
  dailyUsageCount?: number;
  availability?: { claude: boolean; codex: boolean; cursor?: boolean; droid?: boolean };
  providerMode?: "guest" | "subscription";
};

type DbRunCall = { sql: string; params: unknown[] };

function makeProviderConnections(availability: { claude: boolean; codex: boolean; cursor: boolean; droid: boolean }) {
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
    droid: {
      provider: "droid",
      authAvailable: availability.droid,
      runtimeDetected: availability.droid,
      runtimeAvailable: availability.droid,
      sources: [],
      path: availability.droid ? "/usr/local/bin/droid" : null,
      blocker: availability.droid ? null : "Droid unavailable",
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
    droid: false,
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
    {
      cli: "droid",
      installed: availability.droid,
      path: availability.droid ? "/usr/local/bin/droid" : null,
      authenticated: availability.droid,
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
    ...(availability.droid
      ? [{ type: "cli-subscription", cli: "droid", path: "/usr/local/bin/droid", authenticated: true, verified: true }]
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
  cursorCloudMocks.loadCursorSdk.mockReset();
  cursorCloudMocks.resolveCursorCloudCreateCloudExtras.mockReset();
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
  mockState.discoverCursorSdkModelDescriptors.mockResolvedValue([
    createDynamicCursorCliModelDescriptor("auto", "Auto"),
    createDynamicCursorCliModelDescriptor("composer-2", "Composer 2"),
  ]);
  // Null is "the caller chose no control", the state of every test that does
  // not set a reasoning effort or a fast mode of its own.
  mockState.verifyExplicitCursorModelSelection.mockResolvedValue(null);
  mockState.probeCursorSdkModelDiscovery.mockResolvedValue({
    rows: [
      { id: "auto", displayName: "Auto" },
      { id: "composer-2", displayName: "Composer 2" },
    ],
    failureKind: null,
    errorMessage: null,
  });
  mockState.getApiKeyStoreStatus.mockReturnValue({
    secureStorageAvailable: true,
    legacyPlaintextDetected: false,
    decryptionFailed: false,
    encryptedStorePath: null,
    legacyPlaintextPath: null,
  });
  mockState.initModelsDevService.mockResolvedValue(new Map());
  mockState.probeClaudeRuntimeHealth.mockResolvedValue(undefined);
  mockState.clearOpenCodeInventoryCache.mockImplementation(() => undefined);
  mockState.peekOpenCodeInventoryCache.mockReturnValue(null);
  mockState.probeOpenCodeProviderInventory.mockResolvedValue({
    modelIds: ["opencode/openai/gpt-5.4-mini"],
    providers: [{ id: "openai", name: "OpenAI", connected: true, modelCount: 1 }],
    error: null,
    descriptors: [],
  });
  mockState.clearOpenCodeBinaryCache.mockImplementation(() => undefined);
  mockState.resolveOpenCodeBinary.mockReturnValue({
    path: "/Users/admin/.opencode/bin/opencode",
    source: "user-installed",
  });
});

describe("aiIntegrationService", () => {
  it("routes executeTask through the provider task runner", async () => {
    const { service, runCalls } = makeService({
      aiConfig: { features: { initial_context: true } },
    });

    const result = await service.executeTask({
      feature: "initial_context",
      taskType: "planning",
      prompt: "Plan this task",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-5"
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
      model: "openai/gpt-5.4",
      sessionId: "carry-forward-session",
      permissionMode: "read-only",
    });

    expect(mockState.runProviderTask).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "carry-forward-session",
      descriptor: expect.objectContaining({ id: "openai/gpt-5.4" }),
      permissionMode: "read-only",
    }));
  });

  it("uses the feature model override when executeTask omits model", async () => {
    const { service } = makeService({
      aiConfig: {
        features: { orchestrator: true },
        featureModelOverrides: { orchestrator: "openai/gpt-5.4" },
      },
    });

    await service.executeTask({
      feature: "orchestrator",
      taskType: "implementation",
      prompt: "Implement feature",
      cwd: "/tmp"
    });

    expect(mockState.runProviderTask).toHaveBeenCalledTimes(1);
    const firstCall = mockState.runProviderTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall.descriptor).toMatchObject({ id: "openai/gpt-5.4" });
  });

  it("skips AI instead of picking a default model when no setting is configured", async () => {
    const { service } = makeService({
      aiConfig: { features: { orchestrator: true } },
    });

    await expect(
      service.executeTask({
        feature: "orchestrator",
        taskType: "implementation",
        prompt: "Implement feature",
        cwd: "/tmp"
      })
    ).rejects.toThrow(missingFeatureModelMessage("orchestrator"));
    expect(mockState.runProviderTask).not.toHaveBeenCalled();
  });

  it("requires an explicit model for session intelligence tasks", async () => {
    const { service } = makeService({
      aiConfig: {
        features: { terminal_summaries: true },
        featureModelOverrides: { terminal_summaries: "openai/gpt-5.4" },
      },
    });

    await expect(
      service.executeTask({
        feature: "terminal_summaries",
        taskType: "session_title",
        prompt: "Title this chat",
        cwd: "/tmp",
      })
    ).rejects.toThrow(/Session intelligence task 'session_title' requires an explicit model/);
    expect(mockState.runProviderTask).not.toHaveBeenCalled();
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

  it("surfaces LM Studio OpenAI-compatible models as loaded local runtime models", async () => {
    const modelId = "qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2";
    const endpoint = getLocalProviderDefaultEndpoint("lmstudio");
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false, cursor: false, droid: false },
    });

    mockState.detectAllAuth.mockResolvedValue([
      { type: "local", provider: "lmstudio", endpoint, endpointSource: "auto" },
    ]);
    mockState.inspectLocalProvider.mockImplementation(async (provider: string, inspectedEndpoint: string) => ({
      provider,
      endpoint: inspectedEndpoint,
      reachable: provider === "lmstudio",
      health: provider === "lmstudio" ? "ready" : "unreachable",
      loadedModels: provider === "lmstudio"
        ? [{
            provider: "lmstudio",
            modelId,
            displayName: modelId,
            discoverySource: "lmstudio-openai",
            loaded: true,
          }]
        : [],
    }));
    mockState.probeOpenCodeProviderInventory.mockResolvedValue({
        modelIds: [`opencode/lmstudio/${modelId}`],
        providers: [{ id: "lmstudio", name: "LM Studio", connected: true, modelCount: 1 }],
        error: null,
        descriptors: [],
    });

    const status = await service.getStatus({ refreshOpenCodeInventory: true });

    expect(mockState.probeOpenCodeProviderInventory).toHaveBeenCalledWith(expect.objectContaining({
      discoveredLocalModels: expect.arrayContaining([{ provider: "lmstudio", modelId }]),
    }));
    expect(status.runtimeConnections?.lmstudio?.loadedModelIds).toContain(`lmstudio/${modelId}`);
    expect(status.availableModelIds).toContain(`opencode/lmstudio/${modelId}`);
  });

  // Regression pin (quality gate): a transient probe failure on a forced
  // refresh must serve the persisted provider list flagged stale — not
  // collapse the settings chips to empty while keeping the error visible.
  it("serves the persisted provider list as stale when a forced probe fails", async () => {
    const { service } = makeService();
    const persisted = [{ id: "moonshotai", name: "Moonshot AI", connected: false, modelCount: 10 }];
    mockState.probeOpenCodeProviderInventory.mockResolvedValue({
      modelIds: [],
      providers: [],
      error: "OpenCode: launch-timeout: OpenCode server did not become ready in time.",
      descriptors: [],
    });
    mockState.loadPersistedOpenCodeInventory.mockReturnValueOnce(persisted);

    const status = await service.getStatus({ refreshOpenCodeInventory: true });

    expect(status.opencodeProviders).toEqual(persisted);
    expect(status.opencodeProvidersStale).toBe(true);
    expect(status.opencodeInventoryError).toContain("launch-timeout");
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

  it("skips OpenCode probe on cold getStatus — cold reads stay cheap", async () => {
    // Cold reads only peek the cache. Runtime catalog refreshes are owned by
    // agentChatService.getModelCatalog() and fire when a client opens a
    // dynamic runtime rail, not on every status read.
    const { service } = makeService();

    const status = await service.getStatus();

    expect(status.opencodeBinaryInstalled).toBe(true);
    expect(status.opencodeProviders).toEqual([]);
    expect(mockState.peekOpenCodeInventoryCache).toHaveBeenCalledTimes(1);
    expect(mockState.probeOpenCodeProviderInventory).not.toHaveBeenCalled();
  });

  it("uses peeked OpenCode inventory without re-probing when cache is warm", async () => {
    mockState.peekOpenCodeInventoryCache.mockReturnValue({
      modelIds: ["opencode/openai/gpt-5.4-mini"],
      providers: [{ id: "openai", name: "OpenAI", connected: true, modelCount: 1 }],
      error: null,
    });
    const { service } = makeService();

    const status = await service.getStatus();

    expect(status.availableModelIds).toContain("opencode/openai/gpt-5.4-mini");
    expect(mockState.peekOpenCodeInventoryCache).toHaveBeenCalledTimes(1);
    expect(mockState.probeOpenCodeProviderInventory).not.toHaveBeenCalled();
  });

  it("probes OpenCode inventory when explicitly refreshed", async () => {
    const { service } = makeService();

    const status = await service.getStatus({ refreshOpenCodeInventory: true });

    expect(mockState.probeOpenCodeProviderInventory).toHaveBeenCalledTimes(1);
    expect(status.opencodeProviders).toEqual([
      { id: "openai", name: "OpenAI", connected: true, modelCount: 1 },
    ]);
    expect(status.availableModelIds).toContain("opencode/openai/gpt-5.4-mini");
  });

  it("clears the OpenCode binary cache on forced status refresh", async () => {
    const { service } = makeService();

    await service.getStatus({ force: true });

    expect(mockState.clearOpenCodeBinaryCache).toHaveBeenCalledTimes(1);
  });

  it("keeps forced status refresh non-interactive for Claude", async () => {
    const { service } = makeService({
      availability: { claude: true, codex: false, cursor: false, droid: false },
    });

    await service.getStatus({ force: true });

    expect(mockState.probeClaudeRuntimeHealth).not.toHaveBeenCalled();
  });

  it("waits for an ACP auth verdict before publishing provider status", async () => {
    const { service } = makeService({
      availability: { claude: false, codex: false, cursor: false, droid: false },
    });
    mockState.getCachedCliAuthStatuses.mockReturnValue([
      {
        cli: "copilot",
        installed: true,
        path: "/usr/local/bin/copilot",
        authenticated: false,
        verified: false,
      },
    ]);
    mockState.detectAllAuth.mockResolvedValue([]);
    mockState.probeAllAcpProviderAuth.mockResolvedValue({
      copilot: { state: "ready", message: null },
    });
    const base = makeProviderConnections({ claude: false, codex: false, cursor: false, droid: false });
    mockState.buildProviderConnections.mockResolvedValue({
      ...base,
      copilot: {
        provider: "copilot",
        authAvailable: true,
        runtimeDetected: true,
        runtimeAvailable: true,
        usageAvailable: false,
        path: "/usr/local/bin/copilot",
        blocker: null,
        lastCheckedAt: "2025-01-01T00:00:00.000Z",
        sources: [],
      },
    });

    const status = await service.getStatus({ force: true });

    expect(mockState.probeAllAcpProviderAuth).toHaveBeenCalledWith(expect.objectContaining({
      providers: ["copilot"],
      cwd: "/tmp/project",
    }));
    expect(status.availableProviders.copilot).toBe(true);
    expect(status.models.copilot?.map((model) => model.id)).toEqual([
      "github-copilot/claude-sonnet-4.6",
      "github-copilot/claude-opus-4.6",
      "github-copilot/gpt-5.4",
      "github-copilot/gpt-5.3-codex",
    ]);
    expect(status.detectedAuth).toContainEqual(expect.objectContaining({
      type: "cli-subscription",
      cli: "copilot",
      authenticated: true,
      verified: true,
    }));
  });

  it("invalidates provider readiness caches after API key verification", async () => {
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false, cursor: false, droid: false },
    });

    const initialStatus = await service.getStatus();
    expect(initialStatus.detectedAuth?.some((entry) => entry.type === "api-key" && entry.provider === "cursor")).toBe(false);

    mockState.detectAllAuth.mockResolvedValue([
      { type: "api-key", provider: "cursor", key: "crsr_test", source: "store" },
    ]);
    mockState.buildProviderConnections.mockResolvedValue(makeProviderConnections({
      claude: false,
      codex: false,
      cursor: true,
      droid: false,
    }));
    mockState.verifyProviderApiKey.mockResolvedValue({
      provider: "cursor",
      ok: true,
      message: "Connection verified successfully.",
      endpoint: "Cursor.me",
      statusCode: null,
      verifiedAt: "2026-03-17T19:00:00.000Z",
    });

    const result = await service.verifyApiKeyConnection("cursor");
    expect(result).toMatchObject({
      provider: "cursor",
      ok: true,
      source: "store",
    });
    expect(JSON.stringify(result)).not.toContain("crsr_test");

    const refreshedStatus = await service.getStatus();
    expect(mockState.detectAllAuth.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(refreshedStatus.detectedAuth).toContainEqual({
      type: "api-key",
      provider: "cursor",
      source: "store",
    });
    expect(refreshedStatus.availableProviders.cursor).toBe(true);
    expect(refreshedStatus.availableModelIds).toContain("cursor/auto");
    // Verification ages the dynamic model caches without dropping
    // last-known-good rows; a full clear only happens on a key change.
    expect(mockState.markCursorModelCachesStale).toHaveBeenCalled();
    expect(mockState.clearCursorCliModelsCache).not.toHaveBeenCalled();
    expect(mockState.clearOpenCodeInventoryCache).toHaveBeenCalled();
  });

  it("does not verify Cursor when agent model access rejects the key", async () => {
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false, cursor: false, droid: false },
    });

    mockState.detectAllAuth.mockResolvedValue([
      { type: "api-key", provider: "cursor", key: "crsr_test", source: "store" },
    ]);
    mockState.verifyProviderApiKey.mockResolvedValue({
      provider: "cursor",
      ok: true,
      message: "Connection verified successfully.",
      endpoint: "Cursor.me",
      statusCode: null,
      verifiedAt: "2026-03-17T19:00:00.000Z",
    });
    mockState.probeCursorSdkModelDiscovery.mockResolvedValue({
      rows: [],
      failureKind: "auth",
      errorMessage: "Cursor model API returned HTTP 401.",
    });

    const result = await service.verifyApiKeyConnection("cursor");
    expect(result).toMatchObject({
      provider: "cursor",
      ok: false,
      source: "store",
    });
    expect(JSON.stringify(result)).not.toContain("crsr_test");
  });

  it("does not fail Cursor verification on non-auth model probe failures", async () => {
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: false, codex: false, cursor: false, droid: false },
    });

    mockState.detectAllAuth.mockResolvedValue([
      { type: "api-key", provider: "cursor", key: "crsr_test", source: "store" },
    ]);
    mockState.verifyProviderApiKey.mockResolvedValue({
      provider: "cursor",
      ok: true,
      message: "Connection verified successfully.",
      endpoint: "Cursor.me",
      statusCode: null,
      verifiedAt: "2026-03-17T19:00:00.000Z",
    });
    mockState.probeCursorSdkModelDiscovery.mockResolvedValue({
      rows: [],
      failureKind: "unavailable",
      errorMessage: "Cursor model API returned HTTP 503.",
    });

    const result = await service.verifyApiKeyConnection("cursor");
    expect(result).toMatchObject({
      provider: "cursor",
      ok: true,
      source: "store",
    });
    expect(JSON.stringify(result)).not.toContain("crsr_test");
  });

  it("passes envVars on Cursor Cloud Agent.create and does not send metadata", async () => {
    const { service } = makeService({
      availability: { claude: false, codex: false, cursor: true, droid: false },
    });
    mockState.detectAllAuth.mockResolvedValue([
      { type: "api-key", provider: "cursor", key: "crsr_test", source: "store" },
    ]);
    const send = vi.fn().mockResolvedValue({ id: "run-1", status: "RUNNING" });
    const create = vi.fn().mockResolvedValue({
      agentId: "agt_1",
      send,
    });
    cursorCloudMocks.loadCursorSdk.mockResolvedValue({ Agent: { create } });
    cursorCloudMocks.resolveCursorCloudCreateCloudExtras.mockReturnValue({
      sessionId: "sess-1",
      laneId: "lane-1",
      projectId: "proj-1",
      linearIssueId: "ADE-12",
      envVars: { NPM_TOKEN: "npm-secret" },
      extras: {
        envVars: { NPM_TOKEN: "npm-secret" },
      },
    });

    await service.createCursorCloudRun({
      promptText: "Fix the flaky test.",
      repoUrl: "https://github.com/acme/project.git",
      sessionId: "sess-1",
      laneId: "lane-1",
      linearIssueId: "ADE-12",
      secretNames: ["NPM_TOKEN"],
    });

    expect(cursorCloudMocks.resolveCursorCloudCreateCloudExtras).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        laneId: "lane-1",
        linearIssueId: "ADE-12",
        secretNames: ["NPM_TOKEN"],
      }),
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      cloud: expect.objectContaining({
        envVars: { NPM_TOKEN: "npm-secret" },
      }),
    }));
    const cloud = create.mock.calls[0]?.[0]?.cloud as Record<string, unknown>;
    expect(cloud).not.toHaveProperty("metadata");
    expect(cloud).not.toHaveProperty("webhook");
    expect(send).toHaveBeenCalled();
  });

  it("passes the selected Cursor model params to both cloud create and send", async () => {
    const { service } = makeService({
      availability: { claude: false, codex: false, cursor: true, droid: false },
    });
    mockState.detectAllAuth.mockResolvedValue([
      { type: "api-key", provider: "cursor", key: "crsr_test", source: "store" },
    ]);
    const send = vi.fn().mockResolvedValue({ id: "run-1", status: "RUNNING" });
    const create = vi.fn().mockResolvedValue({ agentId: "agt_1", send });
    cursorCloudMocks.loadCursorSdk.mockResolvedValue({ Agent: { create } });
    cursorCloudMocks.resolveCursorCloudCreateCloudExtras.mockReturnValue({
      sessionId: "sess-1",
      laneId: "lane-1",
      projectId: "proj-1",
      linearIssueId: null,
      envVars: {},
      extras: {},
    });
    const modelParams = [
      { id: "reasoning_effort", value: "xhigh" },
      { id: "speed", value: "standard" },
    ];
    mockState.verifyExplicitCursorModelSelection.mockResolvedValue(modelParams);

    await service.createCursorCloudRun({
      promptText: "Use the exact selected model settings.",
      repoUrl: "https://github.com/acme/project.git",
      modelId: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: false,
    });

    // One call that owns both the catalog probe and the resolve, so the caller
    // cannot depend on an ordering it has no way to state.
    expect(mockState.verifyExplicitCursorModelSelection).toHaveBeenCalledWith("crsr_test", {
      modelSdkId: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: false,
    });
    expect(create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      model: { id: "grok-4.6", params: modelParams },
    }));
    expect(send.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      model: { id: "grok-4.6", params: modelParams },
    }));
  });

  it("fails closed instead of letting Cursor choose a different cloud variant", async () => {
    const { service } = makeService({
      availability: { claude: false, codex: false, cursor: true, droid: false },
    });
    mockState.detectAllAuth.mockResolvedValue([
      { type: "api-key", provider: "cursor", key: "crsr_test", source: "store" },
    ]);
    const create = vi.fn();
    cursorCloudMocks.loadCursorSdk.mockResolvedValue({ Agent: { create } });
    cursorCloudMocks.resolveCursorCloudCreateCloudExtras.mockReturnValue({
      sessionId: "sess-1",
      laneId: "lane-1",
      projectId: "proj-1",
      linearIssueId: null,
      envVars: {},
      extras: {},
    });
    mockState.verifyExplicitCursorModelSelection.mockRejectedValue(new Error(
      describeCursorSdkModelSelectionFailure("grok-4.6", {
        status: "partial",
        params: [],
        unmet: ["reasoning"],
      }),
    ));

    await expect(service.createCursorCloudRun({
      promptText: "Do not silently change my settings.",
      repoUrl: "https://github.com/acme/project.git",
      modelId: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: false,
    })).rejects.toThrow("could not verify the selected model settings (reasoning effort)");
    expect(create).not.toHaveBeenCalled();
  });

  it("names the cause when the Cursor catalog itself could not be loaded", async () => {
    const { service } = makeService({
      availability: { claude: false, codex: false, cursor: true, droid: false },
    });
    mockState.detectAllAuth.mockResolvedValue([
      { type: "api-key", provider: "cursor", key: "crsr_test", source: "store" },
    ]);
    const create = vi.fn();
    cursorCloudMocks.loadCursorSdk.mockResolvedValue({ Agent: { create } });
    mockState.verifyExplicitCursorModelSelection.mockRejectedValue(new Error(
      describeCursorSdkModelSelectionFailure("grok-4.6", {
        status: "catalog-unavailable",
        reason: "request timed out",
      }),
    ));

    await expect(service.createCursorCloudRun({
      promptText: "Do not blame my selection for a network fault.",
      repoUrl: "https://github.com/acme/project.git",
      modelId: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: false,
    })).rejects.toThrow("Could not load Cursor's model catalog (request timed out). Try again.");
    expect(create).not.toHaveBeenCalled();
    // A launch the model check refuses must leave no trace, so the lane's
    // remembered secret names are never written.
    expect(cursorCloudMocks.resolveCursorCloudCreateCloudExtras).not.toHaveBeenCalled();
  });
});
