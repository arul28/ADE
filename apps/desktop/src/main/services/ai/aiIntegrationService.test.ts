import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  detectAllAuth: vi.fn(),
  detectCliAuthStatuses: vi.fn(),
  getCachedCliAuthStatuses: vi.fn(),
  verifyProviderApiKey: vi.fn(),
  executeUnified: vi.fn(),
  resumeUnified: vi.fn(),
  probeClaudeRuntimeHealth: vi.fn(),
  resetClaudeRuntimeProbeCache: vi.fn(),
}));

vi.mock("./authDetector", () => ({
  detectAllAuth: (...args: unknown[]) => mockState.detectAllAuth(...args),
  detectCliAuthStatuses: (...args: unknown[]) => mockState.detectCliAuthStatuses(...args),
  getCachedCliAuthStatuses: (...args: unknown[]) => mockState.getCachedCliAuthStatuses(...args),
  verifyProviderApiKey: (...args: unknown[]) => mockState.verifyProviderApiKey(...args),
}));

vi.mock("./unifiedExecutor", () => ({
  executeUnified: (...args: unknown[]) => mockState.executeUnified(...args),
  resumeUnified: (...args: unknown[]) => mockState.resumeUnified(...args),
}));

vi.mock("./claudeRuntimeProbe", () => ({
  probeClaudeRuntimeHealth: (...args: unknown[]) => mockState.probeClaudeRuntimeHealth(...args),
  resetClaudeRuntimeProbeCache: (...args: unknown[]) => mockState.resetClaudeRuntimeProbeCache(...args),
}));

import { createAiIntegrationService } from "./aiIntegrationService";

type ServiceFactoryOptions = {
  aiConfig?: Record<string, unknown>;
  dailyUsageCount?: number;
  availability?: { claude: boolean; codex: boolean };
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

  const availability = options.availability ?? { claude: true, codex: true };
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
  ]);

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
  mockState.probeClaudeRuntimeHealth.mockResolvedValue(undefined);
});

describe("aiIntegrationService", () => {
  it("routes executeTask through unified executor", async () => {
    const { service, runCalls } = makeService();

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

  it("treats commit_messages as opt-in until explicitly enabled", () => {
    const { service } = makeService();
    const { service: enabledService } = makeService({
      aiConfig: {
        features: {
          commit_messages: true,
        },
      },
    });

    expect(service.getFeatureFlag("commit_messages")).toBe(false);
    expect(enabledService.getFeatureFlag("commit_messages")).toBe(true);
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

  it("uses planning tools for mission planning tasks", async () => {
    const { service } = makeService();

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
    const { service } = makeService();

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
    const { service } = makeService();

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
    const { service } = makeService();

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

    expect(mockState.executeUnified).toHaveBeenCalledTimes(2);
    const orchestratorCall = mockState.executeUnified.mock.calls[0]?.[0] as Record<string, unknown>;
    const summaryCall = mockState.executeUnified.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(orchestratorCall.tools).toBe("planning");
    expect(summaryCall.tools).toBe("none");
  });

  it("forwards memory context and compaction identifiers to the unified executor when provided", async () => {
    const { service } = makeService();
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
