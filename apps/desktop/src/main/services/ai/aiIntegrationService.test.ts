import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ExecutorOpts } from "./agentExecutor";

const mockState = vi.hoisted(() => ({
  claudeExecute: vi.fn(),
  claudeResume: vi.fn(),
  codexExecute: vi.fn(),
  codexResume: vi.fn(),
  detectAllAuth: vi.fn(),
  detectCliAuthStatuses: vi.fn(),
  verifyProviderApiKey: vi.fn(),
}));

vi.mock("./claudeExecutor", () => ({
  createClaudeExecutor: () => ({
    provider: "claude" as const,
    execute: mockState.claudeExecute,
    resume: mockState.claudeResume
  })
}));

vi.mock("./codexExecutor", () => ({
  createCodexExecutor: () => ({
    provider: "codex" as const,
    execute: mockState.codexExecute,
    resume: mockState.codexResume
  })
}));

vi.mock("./authDetector", () => ({
  detectAllAuth: (...args: unknown[]) => mockState.detectAllAuth(...args),
  detectCliAuthStatuses: (...args: unknown[]) => mockState.detectCliAuthStatuses(...args),
  verifyProviderApiKey: (...args: unknown[]) => mockState.verifyProviderApiKey(...args),
}));

import { createAiIntegrationService } from "./aiIntegrationService";

type ServiceFactoryOptions = {
  aiConfig?: Record<string, unknown>;
  dailyUsageCount?: number;
  availability?: { claude: boolean; codex: boolean };
  providerMode?: "guest" | "subscription";
};

type DbRunCall = { sql: string; params: unknown[] };

function streamEvents(events: AgentEvent[]): AsyncIterable<AgentEvent> {
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
  mockState.detectCliAuthStatuses.mockReturnValue([
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
      cli: "gemini",
      installed: false,
      path: null,
      authenticated: false,
      verified: false,
    },
  ]);
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
  mockState.verifyProviderApiKey.mockResolvedValue({
    provider: "openai",
    ok: true,
    message: "Connection verified successfully.",
    statusCode: 200,
    verifiedAt: new Date().toISOString(),
  });

  const service = createAiIntegrationService({
    db,
    logger,
    projectConfigService
  });

  return { service, runCalls, db, logger, projectConfigService };
}

function usageInsertCalls(runCalls: DbRunCall[]): DbRunCall[] {
  return runCalls.filter((entry) => entry.sql.includes("insert into ai_usage_log"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.detectCliAuthStatuses.mockReturnValue([
    {
      cli: "claude",
      installed: true,
      path: "/usr/local/bin/claude",
      authenticated: true,
      verified: true,
    },
    {
      cli: "codex",
      installed: true,
      path: "/usr/local/bin/codex",
      authenticated: true,
      verified: true,
    },
    {
      cli: "gemini",
      installed: false,
      path: null,
      authenticated: false,
      verified: false,
    },
  ]);
  mockState.detectAllAuth.mockResolvedValue([
    {
      type: "cli-subscription",
      cli: "claude",
      path: "/usr/local/bin/claude",
      authenticated: true,
      verified: true,
    },
    {
      type: "cli-subscription",
      cli: "codex",
      path: "/usr/local/bin/codex",
      authenticated: true,
      verified: true,
    },
  ]);

  mockState.claudeExecute.mockImplementation((_prompt: string, opts: ExecutorOpts) =>
    streamEvents([
      { type: "text", content: "claude response" },
      {
        type: "done",
        sessionId: "claude-session",
        model: opts.model ?? "sonnet",
        usage: { inputTokens: 101, outputTokens: 47 }
      }
    ])
  );
  mockState.claudeResume.mockImplementation((_sessionId: string, _prompt: string, opts: ExecutorOpts) =>
    streamEvents([
      { type: "text", content: "claude resumed response" },
      {
        type: "done",
        sessionId: "claude-session-resumed",
        model: opts.model ?? "sonnet",
        usage: { inputTokens: 77, outputTokens: 21 }
      }
    ])
  );

  mockState.codexExecute.mockImplementation((_prompt: string, opts: ExecutorOpts) =>
    streamEvents([
      { type: "text", content: "codex response" },
      {
        type: "done",
        sessionId: "codex-session",
        model: opts.model ?? "gpt-5.3-codex",
        usage: { inputTokens: 88, outputTokens: 33 }
      }
    ])
  );
  mockState.codexResume.mockImplementation((_sessionId: string, _prompt: string, opts: ExecutorOpts) =>
    streamEvents([
      { type: "text", content: "codex resumed response" },
      {
        type: "done",
        sessionId: "codex-session-resumed",
        model: opts.model ?? "gpt-5.3-codex",
        usage: { inputTokens: 55, outputTokens: 19 }
      }
    ])
  );
});

describe("aiIntegrationService", () => {
  it("selects the correct executor based on task routing", async () => {
    const { service } = makeService({
      aiConfig: {
        taskRouting: {
          review: { provider: "codex" },
          narrative: { provider: "claude" }
        }
      }
    });

    await service.executeTask({
      feature: "narratives",
      taskType: "review",
      prompt: "review this",
      cwd: "/tmp"
    });

    await service.executeTask({
      feature: "narratives",
      taskType: "narrative",
      prompt: "summarize",
      cwd: "/tmp"
    });

    expect(mockState.codexExecute).toHaveBeenCalledTimes(1);
    expect(mockState.claudeExecute).toHaveBeenCalledTimes(1);
  });

  it("resumes provider-native sessions when sessionId is provided", async () => {
    const { service } = makeService();

    const codexResult = await service.executeTask({
      feature: "orchestrator",
      taskType: "implementation",
      prompt: "continue",
      cwd: "/tmp",
      provider: "codex",
      sessionId: "codex-thread-123"
    });
    expect(mockState.codexResume).toHaveBeenCalledTimes(1);
    expect(mockState.codexResume.mock.calls[0]?.[0]).toBe("codex-thread-123");
    expect(mockState.codexExecute).not.toHaveBeenCalled();
    expect(codexResult.sessionId).toBe("codex-session-resumed");

    const claudeResult = await service.executeTask({
      feature: "orchestrator",
      taskType: "review",
      prompt: "continue",
      cwd: "/tmp",
      provider: "claude",
      sessionId: "claude-session-123"
    });
    expect(mockState.claudeResume).toHaveBeenCalledTimes(1);
    expect(mockState.claudeResume.mock.calls[0]?.[0]).toBe("claude-session-123");
    expect(mockState.claudeExecute).not.toHaveBeenCalled();
    expect(claudeResult.sessionId).toBe("claude-session-resumed");
  });

  it("maps Claude and Codex permissions into ADE unified modes", async () => {
    const claudeCases: Array<{ configured: string; expected: ExecutorOpts["permissions"]["mode"] }> = [
      { configured: "plan", expected: "read-only" },
      { configured: "acceptEdits", expected: "edit" },
      { configured: "bypassPermissions", expected: "full-auto" }
    ];

    for (const testCase of claudeCases) {
      const { service } = makeService({
        aiConfig: {
          permissions: {
            claude: {
              permissionMode: testCase.configured
            }
          }
        }
      });

      await service.executeTask({
        feature: "narratives",
        taskType: "planning",
        prompt: "plan",
        cwd: "/tmp",
        provider: "claude"
      });

      const opts = mockState.claudeExecute.mock.calls.at(-1)?.[1] as ExecutorOpts;
      expect(opts.permissions.mode).toBe(testCase.expected);
      expect(opts.providerConfig?.claude?.permissionMode).toBe(testCase.configured);
    }

    {
      const { service } = makeService({
        aiConfig: {
          permissions: {
            claude: {
              permissionMode: "plan"
            }
          }
        }
      });
      await service.executeTask({
        feature: "narratives",
        taskType: "planning",
        prompt: "plan",
        cwd: "/tmp",
        provider: "claude"
      });
      const opts = mockState.claudeExecute.mock.calls.at(-1)?.[1] as ExecutorOpts;
      expect(opts.providerConfig?.claude?.settingSources).toBeUndefined();
    }

    {
      const { service } = makeService({
        aiConfig: {
          permissions: {
            claude: {
              permissionMode: "plan",
              maxBudgetUsd: 0
            }
          }
        }
      });
      await service.executeTask({
        feature: "narratives",
        taskType: "planning",
        prompt: "plan",
        cwd: "/tmp",
        provider: "claude"
      });
      const opts = mockState.claudeExecute.mock.calls.at(-1)?.[1] as ExecutorOpts;
      expect(opts.maxBudgetUsd).toBeUndefined();
      expect(opts.providerConfig?.claude?.maxBudgetUsd).toBeUndefined();
    }

    const codexCases: Array<{
      sandboxPermissions: "read-only" | "workspace-write" | "danger-full-access";
      approvalMode: "untrusted" | "on-request" | "never";
      expected: ExecutorOpts["permissions"]["mode"];
    }> = [
      { sandboxPermissions: "read-only", approvalMode: "untrusted", expected: "read-only" },
      { sandboxPermissions: "workspace-write", approvalMode: "on-request", expected: "edit" },
      { sandboxPermissions: "danger-full-access", approvalMode: "never", expected: "full-auto" }
    ];

    for (const testCase of codexCases) {
      const { service } = makeService({
        aiConfig: {
          permissions: {
            codex: {
              sandboxPermissions: testCase.sandboxPermissions,
              approvalMode: testCase.approvalMode
            }
          }
        }
      });

      await service.executeTask({
        feature: "conflict_proposals",
        taskType: "implementation",
        prompt: "implement",
        cwd: "/tmp",
        provider: "codex"
      });

      const opts = mockState.codexExecute.mock.calls.at(-1)?.[1] as ExecutorOpts;
      expect(opts.permissions.mode).toBe(testCase.expected);
      expect(opts.providerConfig?.codex?.sandboxPermissions).toBe(testCase.sandboxPermissions);
      expect(opts.providerConfig?.codex?.approvalMode).toBe(testCase.approvalMode);
    }
  });

  it("gracefully rejects in guest mode without invoking executors", async () => {
    const { service } = makeService({
      providerMode: "guest",
      availability: { claude: true, codex: true }
    });

    await expect(
      service.executeTask({
        feature: "narratives",
        taskType: "narrative",
        prompt: "summarize",
        cwd: "/tmp"
      })
    ).rejects.toThrow("No AI provider is available");

    expect(mockState.claudeExecute).not.toHaveBeenCalled();
    expect(mockState.codexExecute).not.toHaveBeenCalled();
  });

  it("enforces daily budget limits", async () => {
    const { service } = makeService({
      aiConfig: {
        budgets: {
          narratives: {
            dailyLimit: 1
          }
        }
      },
      dailyUsageCount: 1
    });

    await expect(
      service.executeTask({
        feature: "narratives",
        taskType: "narrative",
        prompt: "summarize",
        cwd: "/tmp"
      })
    ).rejects.toThrow("Daily AI budget reached");

    expect(mockState.claudeExecute).not.toHaveBeenCalled();
    expect(mockState.codexExecute).not.toHaveBeenCalled();
  });

  it("writes ai_usage_log entries for success and failure", async () => {
    mockState.codexExecute.mockImplementation(() =>
      streamEvents([
        { type: "error", message: "boom" }
      ])
    );

    const { service, runCalls, logger } = makeService();

    const success = await service.executeTask({
      feature: "narratives",
      taskType: "narrative",
      prompt: "ok",
      cwd: "/tmp",
      provider: "claude"
    });

    expect(success.provider).toBe("claude");

    await expect(
      service.executeTask({
        feature: "pr_descriptions",
        taskType: "implementation",
        prompt: "fail",
        cwd: "/tmp",
        provider: "codex"
      })
    ).rejects.toThrow("boom");

    const inserts = usageInsertCalls(runCalls);
    expect(inserts).toHaveLength(2);

    const successParams = inserts[0]?.params as unknown[];
    expect(successParams[2]).toBe("narratives");
    expect(successParams[3]).toBe("claude");
    expect(successParams[4]).toBe("haiku");
    expect(successParams[5]).toBe(101);
    expect(successParams[6]).toBe(47);
    expect(successParams[8]).toBe(1);

    const failureParams = inserts[1]?.params as unknown[];
    expect(failureParams[2]).toBe("pr_descriptions");
    expect(failureParams[3]).toBe("codex");
    expect(failureParams[4]).toBe("gpt-5.3-codex");
    expect(failureParams[8]).toBe(0);

    expect(logger.warn).toHaveBeenCalledWith(
      "ai.task.failed",
      expect.objectContaining({
        taskType: "implementation",
        provider: "codex",
        feature: "pr_descriptions",
        error: "boom"
      })
    );
  });

  it("enforces feature flags", async () => {
    const { service } = makeService({
      aiConfig: {
        features: {
          narratives: false
        }
      }
    });

    await expect(
      service.executeTask({
        feature: "narratives",
        taskType: "narrative",
        prompt: "summary",
        cwd: "/tmp"
      })
    ).rejects.toThrow("AI feature 'narratives' is disabled");

    expect(mockState.claudeExecute).not.toHaveBeenCalled();
    expect(mockState.codexExecute).not.toHaveBeenCalled();
  });

  it("verifies provider API keys using detected auth entries", async () => {
    mockState.detectAllAuth.mockResolvedValueOnce([
      {
        type: "api-key",
        provider: "openai",
        key: "sk-test",
        source: "store",
      },
    ]);
    mockState.verifyProviderApiKey.mockResolvedValueOnce({
      provider: "openai",
      ok: true,
      message: "Connection verified successfully.",
      endpoint: "https://api.openai.com/v1/models",
      statusCode: 200,
      verifiedAt: new Date().toISOString(),
    });

    const { service } = makeService();
    const result = await service.verifyApiKeyConnection("openai");

    expect(result.ok).toBe(true);
    expect(result.source).toBe("store");
    expect(mockState.verifyProviderApiKey).toHaveBeenCalledWith("openai", "sk-test");
  });

  it("returns one-shot outputs for all migrated task helpers", async () => {
    mockState.claudeExecute.mockImplementation((prompt: string, opts: ExecutorOpts) => {
      let structured: Record<string, unknown> | null = null;

      if (prompt.includes("CONFLICT")) {
        structured = { explanation: "Resolve by keeping lane A", diffPatch: "diff --git a/x b/x" };
      }
      if (prompt.includes("TERMINAL")) {
        structured = { summary: "Tests passed", nextAction: "Open PR" };
      }
      if (prompt.includes("MISSION")) {
        structured = {
          mission: { title: "Ship lane", objective: "Finalize implementation" },
          steps: [{ stepId: "s1", name: "Code", owner: "codex" }]
        };
      }
      if (prompt.includes("INITIAL_CONTEXT")) {
        structured = { prd: "# PRD", architecture: "# Architecture" };
      }

      return streamEvents([
        { type: "text", content: `ok:${prompt}` },
        ...(structured ? ([{ type: "structured_output", data: structured }] as AgentEvent[]) : []),
        {
          type: "done",
          sessionId: `session:${prompt}`,
          model: opts.model ?? "haiku",
          usage: { inputTokens: 12, outputTokens: 8 }
        }
      ]);
    });

    const { service } = makeService();

    const narrative = await service.generateNarrative({
      laneId: "lane-1",
      cwd: "/tmp",
      prompt: "NARRATIVE"
    });
    expect(narrative.text).toContain("ok:NARRATIVE");
    expect(narrative.structuredOutput).toBeNull();

    const conflict = await service.requestConflictProposal({
      laneId: "lane-1",
      cwd: "/tmp",
      prompt: "CONFLICT",
      jsonSchema: {
        type: "object",
        required: ["explanation", "diffPatch"],
        properties: {
          explanation: { type: "string" },
          diffPatch: { type: "string" }
        }
      }
    });
    expect(conflict.structuredOutput).toEqual(
      expect.objectContaining({
        explanation: expect.any(String),
        diffPatch: expect.any(String)
      })
    );

    const pr = await service.draftPrDescription({
      laneId: "lane-1",
      cwd: "/tmp",
      prompt: "PR_DESCRIPTION"
    });
    expect(pr.text).toContain("ok:PR_DESCRIPTION");
    expect(pr.structuredOutput).toBeNull();

    const terminal = await service.summarizeTerminal({
      cwd: "/tmp",
      prompt: "TERMINAL",
      jsonSchema: {
        type: "object",
        required: ["summary", "nextAction"],
        properties: {
          summary: { type: "string" },
          nextAction: { type: "string" }
        }
      }
    });
    expect(terminal.structuredOutput).toEqual(
      expect.objectContaining({
        summary: expect.any(String),
        nextAction: expect.any(String)
      })
    );

    const mission = await service.planMission({
      cwd: "/tmp",
      prompt: "MISSION",
      jsonSchema: {
        type: "object",
        required: ["mission", "steps"],
        properties: {
          mission: { type: "object" },
          steps: { type: "array" }
        }
      }
    });
    expect(mission.structuredOutput).toEqual(
      expect.objectContaining({
        mission: expect.any(Object),
        steps: expect.any(Array)
      })
    );

    const initial = await service.generateInitialContext({
      cwd: "/tmp",
      prompt: "INITIAL_CONTEXT",
      jsonSchema: {
        type: "object",
        required: ["prd", "architecture"],
        properties: {
          prd: { type: "string" },
          architecture: { type: "string" }
        }
      }
    });
    expect(initial.structuredOutput).toEqual(
      expect.objectContaining({
        prd: expect.any(String),
        architecture: expect.any(String)
      })
    );

    const oneShotFlags = mockState.claudeExecute.mock.calls.map((call) => (call[1] as ExecutorOpts).oneShot);
    expect(oneShotFlags.every((value) => value === true)).toBe(true);
  });
});
