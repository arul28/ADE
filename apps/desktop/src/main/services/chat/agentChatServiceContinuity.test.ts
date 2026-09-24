import {
  AgentChatEventEnvelope,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  codexComputerUseClientCandidates,
  createScheduledWorkDb,
  createService,
  detectAllAuth,
  fs,
  gzipSync,
  injectFsFault,
  mockState,
  os,
  parseAgentChatTranscript,
  path,
  readPersistedChatState,
  readThreadPointerLedger,
  startup,
  storedWakeup,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

describe("suggestLaneNameFromPrompt", () => {
  function createProjectConfigServiceWithTitleOptions(
    options: { titleGenerationEnabled?: boolean; titleModelId?: string | null; legacyTitleModelId?: string } = {},
  ) {
    const titleOptions: Record<string, unknown> = {};
    if (typeof options.titleGenerationEnabled === "boolean") titleOptions.enabled = options.titleGenerationEnabled;
    if (options.titleModelId !== undefined) titleOptions.modelId = options.titleModelId;
    const sessionIntelligence = Object.keys(titleOptions).length ? { titles: titleOptions } : {};
    return {
      get: vi.fn(() => ({
        effective: {
          ai: {
            permissions: {
              cli: { mode: "edit" },
              inProcess: { mode: "edit" },
            },
            chat: {
              ...(options.legacyTitleModelId ? { autoTitleModelId: options.legacyTitleModelId } : {}),
            },
            sessionIntelligence,
          },
        },
      })),
      getAll: vi.fn(() => ({})),
      set: vi.fn(),
    } as any;
  }

  function createSuggestService(options: { titleGenerationEnabled?: boolean; titleModelId?: string | null; legacyTitleModelId?: string } = {}) {
    return createService({
      projectConfigService: createProjectConfigServiceWithTitleOptions(options),
    });
  }

  it("returns 'parallel-task' for an empty prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("parallel-task");
  });

  it("returns 'parallel-task' for a whitespace-only prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "   \t\n  ",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("parallel-task");
  });

  it("returns a slug from a short prompt via fallback (no auth = no models)", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the login bug",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("fix-login-bug");
  });

  it("takes the first 5 meaningful words of a long prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Refactor the authentication service to use JWT tokens",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("refactor-authentication-service-jwt-tokens");
  });

  it("strips special characters from the prompt slug", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix bug #123 in module!",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("fix-bug-123-module");
  });

  it("truncates the fallback slug to 48 characters", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "superlongwordthatexceedsfortyeightcharacterswhenalone secondword thirdword fourthword",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result.length).toBeLessThanOrEqual(48);
  });

  it("collapses multiple whitespace in the prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "  fix   the   bug   now   please  ",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("fix-bug-now");
  });

  it("falls back when the model runtime throws an error", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);

    const { service, logger, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockRejectedValue(new Error("API rate limited"));
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Write a test suite",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("write-test-suite");
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.suggest_lane_name_failed",
      expect.objectContaining({ error: "API rate limited" }),
    );
  });

  it("still names with AI when title generation is disabled in Settings", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);

    const { service, aiIntegrationService } = createSuggestService({ titleGenerationEnabled: false });
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: "Login Bug Fix",
      inputTokens: 10,
      outputTokens: 5,
    } as any);
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the authentication login failure in the dashboard",
      modelId: "anthropic/claude-haiku-4-5",
      provider: "claude",
      laneId: "lane-1",
      fallbackName: "chat-20260514-010203",
    });

    expect(result).toBe("login-bug-fix");
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalled();
  });

  it("preserves the generated suffix when the prompt fallback is generic", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "!!!",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
      fallbackName: "chat-20260514-010203",
    });

    expect(result).toBe("parallel-task-20260514-010203");
  });

  it("uses AI-generated name when the model runtime succeeds", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: "Login Bug Fix",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the authentication login failure in the dashboard",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("login-bug-fix");
  });

  it("prefers the cheap helper for the ADE provider over the requested session model", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService({ titleModelId: "openai/gpt-5.4-mini" });
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: "Auto Create Lane Fix",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix auto create lane routing and naming",
      modelId: "openai/gpt-5.5",
      provider: "codex",
      laneId: "lane-1",
      fallbackName: "chat-20260514-010203",
    });

    expect(result).toBe("auto-create-lane-fix");
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "openai/gpt-5.6-luna",
      taskType: "session_title",
    }));
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a legacy title model when session intelligence model is explicitly cleared", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService({
      titleModelId: null,
      legacyTitleModelId: "openai/gpt-5.4-mini",
    });
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: "Fallback Title",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix null model clearing for background jobs",
      modelId: "anthropic/claude-sonnet-5",
      laneId: "lane-1",
    });

    expect(result).toBe("fallback-title");
    expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(expect.objectContaining({
      model: "openai/gpt-5.4-mini",
    }));
    expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(expect.objectContaining({
      model: "anthropic/claude-haiku-4-5",
    }));
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "anthropic/claude-sonnet-5",
    }));
  });

  it("normalizes AI-generated name: strips special chars and lowercases", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: "JWT Auth Refactor!",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Refactor auth to use JWT",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("jwt-auth-refactor");
  });

  it("normalizes AI-generated name: truncates to 60 characters", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const longName = "a".repeat(70);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: longName,
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Do a very long task",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("trims edge hyphens after AI title truncation", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: `${"a".repeat(55)}- tail`,
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Trim the generated lane name",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("a".repeat(55));
  });

  it("falls back when AI returns empty text after sanitization", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: "!!!",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Something useful",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("something-useful");
  });

  it("handles null/undefined args fields gracefully", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: null as any,
      modelId: null as any,
      laneId: null as any,
    });
    expect(result).toBe("parallel-task");
  });

  it("generates one structured lane and branch identity with low reasoning", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({
        laneTitle: "Naming Auto Created Lanes",
        branchFragment: "naming-auto-created-lanes",
      }),
      inputTokens: 10,
      outputTokens: 8,
    } as any);

    const result = await service.generateAutoLaneIdentity({
      prompt: "Can we discuss how ADE names auto-created lanes?",
      modelId: "openai/gpt-5.4",
      laneId: "lane-1",
      fallbackName: "Naming Auto Created Lanes",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(result).toMatchObject({
      laneTitle: "Naming Auto Created Lanes",
      branchFragment: "naming-auto-created-lanes",
      source: "ai",
    });
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(1);
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      model: "openai/gpt-5.4",
      reasoningEffort: "low",
    }));
  });

  it("preserves a valid title when structured branch output is invalid", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({ laneTitle: "Claude OAuth Login", branchFragment: "refs/heads/NOPE" }),
    } as any);

    const result = await service.generateAutoLaneIdentity({
      prompt: "The Claude auth login button hangs after OAuth redirects.",
      modelId: "openai/gpt-5.4",
      laneId: "lane-1",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(result.laneTitle).toBe("Claude OAuth Login");
    expect(result.branchFragment).toBe("claude-oauth-login");
  });

  it("does not let a mentioned lane's branch fragment override this prompt's title", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({
        laneTitle: "Ok Something Super Weird Happened",
        branchFragment: "chat-mention-tags",
      }),
    } as any);

    const result = await service.generateAutoLaneIdentity({
      prompt: "ok something super weird happened. why is Chat Mention Tags showing pr 1068?",
      modelId: "openai/gpt-5.4",
      laneId: "lane-1",
      fallbackName: "Ok Something Super Weird Happened",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(result.laneTitle).toBe("Ok Something Super Weird Happened");
    expect(result.branchFragment).toBe("ok-something-super-weird-happened");
    expect(result.source).toBe("ai");
  });

  it("clamps an over-long AI identity instead of discarding it for a slug", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    // Six words is guidance for the model, not a gate: a seven-word answer is
    // trimmed, never thrown away in favour of the deterministic slug.
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({
        laneTitle: "Rework Session Naming Fallback Chain For Chats",
        branchFragment: "rework-session-naming-fallback-chain-for-chats",
      }),
    } as any);

    const result = await service.generateAutoLaneIdentity({
      prompt: "Rework the session naming fallback chain",
      modelId: "openai/gpt-5.4",
      laneId: "lane-1",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(result.source).toBe("ai");
    expect(result.laneTitle).toBe("Rework Session Naming Fallback Chain For");
    expect(result.branchFragment).toBe("rework-session-naming-fallback-chain-for");
  });

  it("retries the next model when structured fields are unusable, then falls back deterministically", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({ laneTitle: "Fix", branchFragment: "refs/heads/NOPE" }),
    } as any);

    const result = await service.generateAutoLaneIdentity({
      prompt: "The Claude auth login button hangs after OAuth redirects.",
      modelId: "openai/gpt-5.4",
      laneId: "lane-1",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(result).toMatchObject({
      laneTitle: "Claude Auth Login Button Hangs",
      branchFragment: "claude-auth-login-button-hangs",
      source: "deterministic",
    });
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "openai/gpt-5.4",
    }));
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(1);
  });

  it("uses the launched chat model when the cheap helper answers unusably", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService({ titleModelId: "openai/gpt-5.4-mini" });
    vi.mocked(aiIntegrationService.summarizeTerminal)
      .mockResolvedValueOnce({
        text: JSON.stringify({ laneTitle: "Fix", branchFragment: "refs/heads/NOPE" }),
      } as any)
      .mockResolvedValueOnce({
        text: JSON.stringify({ laneTitle: "Claude OAuth Login", branchFragment: "claude-oauth-login" }),
      } as any);

    const result = await service.generateAutoLaneIdentity({
      prompt: "The Claude auth login button hangs after OAuth redirects.",
      modelId: "openai/gpt-5.4",
      provider: "codex",
      laneId: "lane-1",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(result).toMatchObject({
      laneTitle: "Claude OAuth Login",
      branchFragment: "claude-oauth-login",
      source: "ai",
    });
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "openai/gpt-5.6-luna",
    }));
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: "openai/gpt-5.4",
    }));
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(2);
  });

  it("uses the cheap helper before the launched model", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService({ titleModelId: "openai/gpt-5.4-mini" });
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({ laneTitle: "Lane Naming", branchFragment: "lane-naming" }),
    } as any);

    await service.generateAutoLaneIdentity({
      prompt: "Rename automatic lanes",
      modelId: "openai/gpt-5.4",
      provider: "codex",
      laneId: "lane-1",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "openai/gpt-5.6-luna",
    }));
  });

  it("uses the launched chat model when no title model is configured", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({ laneTitle: "Lane Naming", branchFragment: "lane-naming" }),
    } as any);

    await service.generateAutoLaneIdentity({
      prompt: "Rename automatic lanes",
      modelId: "openai/gpt-5.4",
      chatModelId: "openai/gpt-5.4",
      laneId: "lane-1",
      temporaryBranch: "ade/1a2b3c4d",
    });

    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "openai/gpt-5.4",
    }));
  });

  it("passes bounded existing image attachments to capable naming providers", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const imagePath = path.join(tmpRoot, "settings.png");
    fs.writeFileSync(imagePath, "png");
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: JSON.stringify({ laneTitle: "Settings Panel Spacing", branchFragment: "settings-panel-spacing" }),
    } as any);

    await service.generateAutoLaneIdentity({
      prompt: "Please fix this spacing",
      modelId: "openai/gpt-5.4",
      laneId: "lane-1",
      temporaryBranch: "ade/1a2b3c4d",
      attachments: [
        { type: "image", path: imagePath },
        { type: "file", path: path.join(tmpRoot, "large.zip") },
      ],
    });

    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      imagePaths: [fs.realpathSync(imagePath)],
    }));
  });
});

// These tests poll the real filesystem for a write the service performs
// asynchronously with no completion receipt to await. vitest's default
// `vi.waitFor` budget is one second, which is simply too tight for that I/O
// inside a 1150-test file under parallel load — it was the second-largest
// source of flakes here. The bound below is explicit and generous; a genuine
// regression still fails the assertion, just later.
describe("durable chat metadata and transcript continuity", () => {
  const chatSessionsDir = () => path.join(tmpRoot, ".ade", "cache", "chat-sessions");
  const metadataPath = (sessionId: string) => path.join(chatSessionsDir(), `${sessionId}.json`);
  const ledgerPath = () => path.join(chatSessionsDir(), "thread-pointers.jsonl");

  async function completeCodexTurn(turnPromise: Promise<unknown>, text = "done"): Promise<void> {
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    }, { timeout: 10_000, interval: 25 });
    const turnNumber = mockState.codexTurnCounter;
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { turn: { id: `turn-${turnNumber}`, status: "inProgress" } },
    });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { turnId: `turn-${turnNumber}`, delta: text },
    });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: `turn-${turnNumber}`, status: "completed" } },
    });
    await turnPromise;
  }

  it("preserves prior metadata on ENOSPC and succeeds on the next persist", async () => {
    const first = createService();
    const session = await first.service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    first.service.forceDisposeAll();
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      threadId: "thread-resumed",
    });

    const { service, logger } = createService();
    await service.resumeSession({ sessionId: session.id });
    const before = fs.readFileSync(metadataPath(session.id));
    const renameFault = injectFsFault({
      op: "renameSync",
      matchPath: (candidate) => path.resolve(candidate) === path.resolve(metadataPath(session.id)),
    });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "thread/deleted",
      params: { threadId: "thread-resumed" },
    });
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.persist_failed",
        expect.objectContaining({ sessionId: session.id, lkgUpdated: true }),
      );
    }, { timeout: 10_000, interval: 25 });
    expect(fs.readFileSync(metadataPath(session.id))).toEqual(before);
    expect(readPersistedChatState(session.id).threadId).toBe("thread-resumed");
    expect(fs.readdirSync(chatSessionsDir()).filter((name) => name.includes(".tmp-"))).toEqual([]);

    renameFault.restore();
    await service.updateSession({ sessionId: session.id, title: "Persist after ENOSPC" });
    expect(readPersistedChatState(session.id).threadId).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(`${metadataPath(session.id)}.lkg`, "utf8")).threadId).toBe("thread-resumed");
  });

  it("recovers a corrupt primary from the lkg and logs the recovery", async () => {
    const first = createService();
    const session = await first.service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    first.service.forceDisposeAll();
    const recoveredState = {
      ...readPersistedChatState(session.id),
      threadId: "thread-from-lkg",
    };
    fs.writeFileSync(`${metadataPath(session.id)}.lkg`, JSON.stringify(recoveredState, null, 2));
    fs.writeFileSync(metadataPath(session.id), "{");

    const { service, logger } = createService();
    const resumed = await service.resumeSession({ sessionId: session.id });
    expect(resumed.threadId).toBe("thread-from-lkg");
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.persisted_state_recovered_lkg",
      { sessionId: session.id },
    );
  });

  it("records pointer changes, avoids restart duplicates, and compacts above 64 KiB", async () => {
    const first = createService();
    const session = await first.service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    const firstTurn = first.service.runSessionTurn({ sessionId: session.id, text: "start a thread" });
    await vi.waitFor(() => {
      expect(readThreadPointerLedger(chatSessionsDir()).get(session.id)?.pointer).toBe("thread-1");
    }, { timeout: 10_000, interval: 25 });
    await completeCodexTurn(firstTurn);
    first.service.forceDisposeAll();
    const lineCountBeforeRestart = fs.readFileSync(ledgerPath(), "utf8").trim().split("\n").length;

    const second = createService();
    await second.service.resumeSession({ sessionId: session.id });
    expect(fs.readFileSync(ledgerPath(), "utf8").trim().split("\n")).toHaveLength(lineCountBeforeRestart);

    const oldEntry = {
      sessionId: "older-session",
      provider: "codex",
      pointer: "old",
      prevPointer: null,
      reason: "persist_change",
      at: "2026-01-01T00:00:00.000Z",
    };
    const newEntry = { ...oldEntry, pointer: "new", prevPointer: "old", at: "2026-01-02T00:00:00.000Z" };
    fs.appendFileSync(
      ledgerPath(),
      `${JSON.stringify(oldEntry)}\n${JSON.stringify(newEntry)}\n${"x".repeat(70 * 1024)}\n`,
    );
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "thread/deleted",
      params: { threadId: "thread-1" },
    });
    await vi.waitFor(() => {
      expect(fs.statSync(ledgerPath()).size).toBeLessThanOrEqual(64 * 1024);
      expect(readThreadPointerLedger(chatSessionsDir()).get(session.id)?.pointer).toBeNull();
    }, { timeout: 10_000, interval: 25 });
    expect(readThreadPointerLedger(chatSessionsDir()).get("older-session")?.pointer).toBe("new");
  });

  it("isolates a truncated transcript tail before the next user event", async () => {
    const { service, logger } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    const transcriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
    const prefix: AgentChatEventEnvelope = {
      sessionId: session.id,
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "valid prefix" },
    };
    const fragment = "{\"id\":\"truncated";
    fs.writeFileSync(transcriptFile, `${JSON.stringify(prefix)}\n${fragment}`, "utf8");

    const turn = service.runSessionTurn({ sessionId: session.id, text: "fresh user event" });
    await vi.waitFor(() => {
      const raw = fs.readFileSync(transcriptFile, "utf8");
      expect(raw).toContain(`${fragment}\n{`);
      expect(raw).toContain("fresh user event");
    }, { timeout: 10_000, interval: 25 });
    await completeCodexTurn(turn, "fresh response");

    const raw = fs.readFileSync(transcriptFile, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(JSON.parse(lines[0]!)).toEqual(prefix);
    expect(lines[1]).toBe(fragment);
    expect(JSON.parse(lines[2]!).event).toMatchObject({ type: "user_message", text: "fresh user event" });
    const actualTranscript = await vi.importActual<typeof import("../../../shared/chatTranscript")>("../../../shared/chatTranscript");
    const parsed = actualTranscript.parseAgentChatTranscript(raw);
    expect(parsed).toEqual(expect.arrayContaining([
      expect.objectContaining({ timestamp: prefix.timestamp, event: expect.objectContaining({ text: "valid prefix" }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: "user_message", text: "fresh user event" }) }),
    ]));
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.transcript_tail_healed",
      { path: path.resolve(transcriptFile), priorSize: Buffer.byteLength(`${JSON.stringify(prefix)}\n${fragment}`) },
    );
  });
});

describe("explicit provider-thread continuity recovery", () => {
  const metadataPath = (sessionId: string) => path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${sessionId}.json`);
  const ledgerPath = () => path.join(tmpRoot, ".ade", "cache", "chat-sessions", "thread-pointers.jsonl");
  const transcriptPath = (sessionId: string) => path.join(tmpRoot, ".ade", "transcripts", "chat", `${sessionId}.jsonl`);

  // Rollout-probe classification must not depend on the machine's real
  // ~/.codex tree: an empty CODEX_HOME gives a deterministic completed
  // probe (definitive absence); tests that want "local history exists"
  // write a rollout fixture with writeCodexRolloutFixture.
  let codexHomeDir: string | null = null;
  beforeEach(() => {
    codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-home-"));
    process.env.CODEX_HOME = codexHomeDir;
  });
  afterEach(() => {
    if (codexHomeDir) {
      fs.rmSync(codexHomeDir, { recursive: true, force: true });
      codexHomeDir = null;
    }
  });

  function writeCodexRolloutFixture(threadId: string): string {
    const rolloutDir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "12");
    fs.mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = path.join(rolloutDir, `rollout-2026-07-12T01-00-00-${threadId}.jsonl`);
    fs.writeFileSync(rolloutPath, `${JSON.stringify({ type: "session_meta" })}\n`, "utf8");
    return rolloutPath;
  }

  async function createPersistedCodexThread() {
    const first = createService();
    const session = await first.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
    const turn = first.service.runSessionTurn({ sessionId: session.id, text: "Keep the original thread." });
    await vi.waitFor(() => expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true));
    mockState.emitCodexPayload({ jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } });
    mockState.emitCodexPayload({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await turn;
    first.service.forceDisposeAll();
    mockState.codexRequestPayloads = [];
    return session;
  }

  it("preserves the pointer and emits a failed turn plus recovery notice when resume reports not found", async () => {
    const session = await createPersistedCodexThread();
    // The provider claims the thread is gone but local history still exists,
    // so classification must not trust the deletion (reason "unknown").
    writeCodexRolloutFixture("thread-1");
    const resumeCommand = mockState.sessions.get(session.id)?.resumeCommand;
    mockState.codexResponseOverrides.set("thread/resume", { error: { code: -32000, message: "thread not found" } });
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });

    await expect(service.sendMessage({ sessionId: session.id, text: "Continue." }, { awaitDispatch: true }))
      .rejects.toThrow("Could not resume the original Codex thread");
    await vi.waitFor(() => expect(events.some((entry) => entry.event.type === "done" && entry.event.status === "failed")).toBe(true));

    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
    expect(readPersistedChatState(session.id)).toMatchObject({
      threadId: "thread-1",
      continuityRecovery: { state: "required", reason: "unknown", originalThreadId: "thread-1" },
    });
    expect(mockState.sessions.get(session.id)?.resumeCommand).toBe(resumeCommand);
    expect(events.some((entry) => entry.event.type === "system_notice"
      && typeof entry.event.detail === "object"
      && entry.event.detail?.kind === "continuity_recovery")).toBe(true);
  });

  it("keeps MCP startup failures retryable without continuity recovery", async () => {
    const session = await createPersistedCodexThread();
    mockState.codexResponseOverrides.set("thread/resume", { error: { code: -32000, message: "MCP server startup failed" } });
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });

    await expect(service.sendMessage({ sessionId: session.id, text: "Retry later." }, { awaitDispatch: true })).rejects.toThrow();
    await vi.waitFor(() => expect(events.some((entry) => entry.event.type === "error")).toBe(true));

    expect(readPersistedChatState(session.id).continuityRecovery).toBeUndefined();
    expect(readPersistedChatState(session.id).threadId).toBe("thread-1");
    expect(events.find((entry) => entry.event.type === "error")?.event).toMatchObject({
      errorInfo: { resumeFailure: { kind: "provider_environment" } },
    });
  });

  it("fails new turns fast while recovery is required without contacting the provider", async () => {
    const session = await createPersistedCodexThread();
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery: {
        state: "required",
        reason: "thread_missing",
        provider: "codex",
        originalThreadId: "thread-1",
        at: new Date().toISOString(),
      },
    });
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    mockState.codexRequestPayloads = [];

    await expect(service.sendMessage({ sessionId: session.id, text: "Do not dispatch." }))
      .rejects.toMatchObject({ code: "continuity_recovery_required" });

    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start" || payload.method === "thread/resume")).toBe(false);
    expect(events.some((entry) => entry.event.type === "system_notice" && entry.event.message.includes("original AI thread"))).toBe(true);
  });

  it("retries the original pointer explicitly and clears recovery on success", async () => {
    const session = await createPersistedCodexThread();
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery: {
        state: "required",
        reason: "unknown",
        provider: "codex",
        originalThreadId: "thread-1",
        at: new Date().toISOString(),
      },
    });
    mockState.codexResponseOverrides.set("thread/resume", () => ({ thread: { id: "thread-1" } }));
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });

    await expect(service.recoverContinuity({ sessionId: session.id, mode: "retry_original" }))
      .resolves.toEqual(expect.objectContaining({ ok: true, mode: "retry_original", threadId: "thread-1" }));
    expect(readPersistedChatState(session.id).continuityRecovery).toBeUndefined();
    expect(events.some((entry) => entry.event.type === "system_notice" && entry.event.message === "Reconnected to the original thread.")).toBe(true);
  });

  it("rejects a concurrent continuity recovery for the same session", async () => {
    const session = await createPersistedCodexThread();
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery: {
        state: "required",
        reason: "unknown",
        provider: "codex",
        originalThreadId: "thread-1",
        at: new Date().toISOString(),
      },
    });
    mockState.codexResponseOverrides.set("thread/resume", { thread: { id: "thread-1" } });
    mockState.delayedCodexMethods.add("thread/resume");
    const { service } = createService();

    const first = service.recoverContinuity({ sessionId: session.id, mode: "retry_original" });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/resume")).toHaveLength(1);
    });

    await expect(service.recoverContinuity({ sessionId: session.id, mode: "retry_original" }))
      .resolves.toEqual({ ok: false, mode: "retry_original", reason: "recovery_failed" });
    expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/resume")).toHaveLength(1);

    mockState.pendingCodexResponses.splice(0).forEach((respond) => respond());
    await expect(first).resolves.toEqual(expect.objectContaining({ ok: true, mode: "retry_original" }));
  });

  it("leaves required recovery untouched when disk pressure blocks history reconstruction", async () => {
    const session = await createPersistedCodexThread();
    const continuityRecovery = {
      state: "required" as const,
      reason: "thread_missing" as const,
      provider: "codex" as const,
      originalThreadId: "thread-1",
      at: new Date().toISOString(),
    };
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery,
    });
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      diskPressureMonitor: {
        canPerform: vi.fn(() => ({
          allowed: false,
          state: "exhausted",
          code: "disk_full",
          message: "Your computer is almost out of storage. ADE paused new agent work to protect your chats and projects. Free up space, then resume.",
        })),
      },
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    mockState.codexRequestPayloads = [];

    await expect(service.recoverContinuity({ sessionId: session.id, mode: "recover_from_history" }))
      .resolves.toEqual({ ok: false, mode: "recover_from_history", reason: "recovery_failed" });

    expect(readPersistedChatState(session.id)).toMatchObject({
      threadId: "thread-1",
      continuityRecovery,
    });
    expect(mockState.codexRequestPayloads).toEqual([]);
    expect(events.filter((entry) => entry.event.type === "system_notice"
      && typeof entry.event.detail === "object"
      && entry.event.detail?.kind === "disk_pressure")).toHaveLength(1);
  });

  it("restores required recovery and the original pointer when capsule dispatch rejects", async () => {
    const session = await createPersistedCodexThread();
    const continuityRecovery = {
      state: "required" as const,
      reason: "thread_missing" as const,
      provider: "codex" as const,
      originalThreadId: "thread-1",
      at: new Date().toISOString(),
    };
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery,
    });
    const { service, sessionService } = createService();
    const originalResumeCommand = sessionService.get(session.id)?.resumeCommand;
    mockState.codexRequestPayloads = [];
    mockState.codexResponseOverrides.set("turn/start", {
      error: { code: -32000, message: "capsule dispatch rejected" },
    });

    await expect(service.recoverContinuity({ sessionId: session.id, mode: "recover_from_history" }))
      .resolves.toEqual({ ok: false, mode: "recover_from_history", reason: "recovery_failed" });

    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    expect(readPersistedChatState(session.id)).toMatchObject({
      threadId: "thread-1",
      continuityRecovery,
    });
    expect(readThreadPointerLedger(path.dirname(metadataPath(session.id))).get(session.id)?.pointer).toBe("thread-1");
    expect(sessionService.get(session.id)?.resumeCommand).toBe(originalResumeCommand);
  });

  it("reconstructs a bounded hidden history capsule in the same chat", async () => {
    const session = await createPersistedCodexThread();
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery: {
        state: "required",
        reason: "thread_missing",
        provider: "codex",
        originalThreadId: "thread-1",
        at: new Date().toISOString(),
      },
    });
    const actualTranscript = await vi.importActual<typeof import("../../../shared/chatTranscript")>("../../../shared/chatTranscript");
    vi.mocked(parseAgentChatTranscript).mockImplementation(actualTranscript.parseAgentChatTranscript);
    const envelope = (sequence: number, event: Record<string, unknown>) => JSON.stringify({
      sessionId: session.id,
      sequence,
      timestamp: new Date(1_760_000_000_000 + sequence).toISOString(),
      event,
    });
    fs.writeFileSync(transcriptPath(session.id), [
      envelope(1, { type: "user_message", text: "Original task" }),
      `{"oversized":"${"x".repeat(3 * 1024 * 1024)}"}`,
      envelope(2, { type: "user_message", text: "Most recent request" }),
      envelope(3, { type: "todo_update", items: [{ id: "one", description: "Keep continuity", status: "in_progress" }] }),
    ].join("\n") + "\n");
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    mockState.codexRequestPayloads = [];

    const result = await service.recoverContinuity({ sessionId: session.id, mode: "recover_from_history" });

    expect(result).toMatchObject({ ok: true, mode: "recover_from_history", threadId: "thread-2" });
    expect(Buffer.byteLength(result.capsulePreview ?? "", "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(readPersistedChatState(session.id).continuityRecovery).toMatchObject({
      state: "reconstructed",
      originalThreadId: "thread-1",
      reconstructedThreadId: "thread-2",
    });
    expect(events.some((entry) => entry.event.type === "user_message"
      && entry.event.displayText === "Rebuilt this chat's AI thread from ADE history."
      && entry.event.metadata?.hideFullPrompt === true)).toBe(true);
    expect(readThreadPointerLedger(path.dirname(metadataPath(session.id))).get(session.id)).toMatchObject({
      pointer: "thread-2",
      prevPointer: "thread-1",
    });
  });

  it("decompresses a gzipped transcript when building the recovery capsule", async () => {
    const session = await createPersistedCodexThread();
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery: {
        state: "required",
        reason: "thread_missing",
        provider: "codex",
        originalThreadId: "thread-1",
        at: new Date().toISOString(),
      },
    });
    const actualTranscript = await vi.importActual<typeof import("../../../shared/chatTranscript")>("../../../shared/chatTranscript");
    vi.mocked(parseAgentChatTranscript).mockImplementation(actualTranscript.parseAgentChatTranscript);
    const envelope = (sequence: number, event: Record<string, unknown>) => JSON.stringify({
      sessionId: session.id,
      sequence,
      timestamp: new Date(1_760_000_000_000 + sequence).toISOString(),
      event,
    });
    // Compress the transcript and remove the plain file, as the sweep would,
    // so only the .gz remains for the capsule to read.
    const plain = transcriptPath(session.id);
    fs.mkdirSync(path.dirname(plain), { recursive: true });
    fs.rmSync(plain, { force: true });
    fs.writeFileSync(`${plain}.gz`, gzipSync([
      envelope(1, { type: "user_message", text: "Compressed original task" }),
      envelope(2, { type: "text", text: "Assistant reply worth keeping" }),
    ].join("\n") + "\n"));
    const { service } = createService();
    mockState.codexRequestPayloads = [];

    const result = await service.recoverContinuity({ sessionId: session.id, mode: "recover_from_history" });

    expect(result).toMatchObject({ ok: true, mode: "recover_from_history" });
    // The capsule must carry the original task from the compressed history,
    // not be empty because the gzip bytes failed to parse.
    expect(result.capsulePreview).toContain("Compressed original task");
  });

  it("creates a distinct same-lane chat and records the recovery relationship", async () => {
    const session = await createPersistedCodexThread();
    writePersistedChatState(session.id, {
      ...readPersistedChatState(session.id),
      continuityRecovery: {
        state: "required",
        reason: "thread_missing",
        provider: "codex",
        originalThreadId: "thread-1",
        at: new Date().toISOString(),
      },
    });
    const events: AgentChatEventEnvelope[] = [];
    const scheduledWork = createScheduledWorkDb({
      version: 1,
      schedules: [storedWakeup(session.id, {
        durable: true,
        provider: "claude",
        providerScheduleId: "provider-old-chat",
      })],
      pausedSessionIds: [],
    });
    const { service } = createService({
      db: scheduledWork.db,
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const result = await service.recoverContinuity({ sessionId: session.id, mode: "start_new_chat" });
    expect(result.ok).toBe(true);
    expect(result.newSessionId).not.toBe(session.id);
    expect(readPersistedChatState(result.newSessionId!).recoveredFromSessionId).toBe(session.id);
    expect(readPersistedChatState(session.id).continuityRecovery).toMatchObject({
      state: "required",
      supersededBySessionId: result.newSessionId,
    });
    expect(scheduledWork.readState()?.schedules).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        status: "paused",
        pausedFlag: true,
        providerScheduleId: "provider-old-chat",
      }),
    ]);
    await expect(service.listScheduledWork({ sessionId: result.newSessionId })).resolves.toEqual([]);
    expect(events.some((entry) => entry.sessionId === session.id
      && entry.event.type === "system_notice"
      && typeof entry.event.detail === "object"
      && entry.event.detail?.spawnedSession?.sessionId === result.newSessionId)).toBe(true);
  });

  it("moves a stale Claude SDK pointer into continuity recovery and records the prior pointer", async () => {
    let streamCall = 0;
    const handle = {
      send: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-stale", slash_commands: [] };
          return;
        }
        throw new Error("session not found");
      })()),
      close: vi.fn(),
      sessionId: "sdk-stale",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(handle as any);
    vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(handle as any);
    const { service } = createService();
    const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "claude-sonnet-5" });
    await vi.waitFor(() => expect(readPersistedChatState(session.id).sdkSessionId).toBeTruthy());
    const originalSdkSessionId = readPersistedChatState(session.id).sdkSessionId as string;

    await service.sendMessage({ sessionId: session.id, text: "Continue the Claude task." });
    await vi.waitFor(() => expect(readPersistedChatState(session.id).continuityRecovery).toMatchObject({
      state: "required",
      provider: "claude",
      originalThreadId: originalSdkSessionId,
    }));

    expect(readPersistedChatState(session.id).sdkSessionId).toBeUndefined();
    expect(readThreadPointerLedger(path.dirname(metadataPath(session.id))).get(session.id)).toMatchObject({
      pointer: null,
      prevPointer: originalSdkSessionId,
    });
  });

  it("reconciles missing metadata from ledger, resume command, transcript, or marks recovery required", async () => {
    const actualTranscript = await vi.importActual<typeof import("../../../shared/chatTranscript")>("../../../shared/chatTranscript");
    vi.mocked(parseAgentChatTranscript).mockImplementation(actualTranscript.parseAgentChatTranscript);
    const { service, sessionService } = createService();
    const sessions = await Promise.all(["ledger", "resume", "transcript", "none"].map((title) =>
      service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4", title })));
    service.forceDisposeAll();
    const [ledger, resume, transcript, none] = sessions;
    for (const session of sessions) {
      fs.rmSync(metadataPath(session.id), { force: true });
      fs.rmSync(`${metadataPath(session.id)}.lkg`, { force: true });
    }
    fs.writeFileSync(ledgerPath(), `${JSON.stringify({
      sessionId: ledger.id, provider: "codex", pointer: "thread-ledger", prevPointer: null,
      reason: "persist_change", at: new Date().toISOString(),
    })}\n`);
    sessionService.setResumeCommand(resume.id, "chat:codex:thread-resume");
    sessionService.setResumeCommand(transcript.id, null);
    sessionService.setResumeCommand(none.id, "chat:codex:   ");
    fs.writeFileSync(transcriptPath(transcript.id), `${JSON.stringify({
      sessionId: transcript.id,
      timestamp: new Date().toISOString(),
      event: { type: "codex_token_usage", usage: { threadId: "thread-transcript" } },
    })}\n`);

    service.reconcileThreadPointerFromRedundantSources(ledger.id);
    service.reconcileThreadPointerFromRedundantSources(resume.id);
    service.reconcileThreadPointerFromRedundantSources(transcript.id);
    service.reconcileThreadPointerFromRedundantSources(none.id);

    expect(readPersistedChatState(ledger.id).threadId).toBe("thread-ledger");
    expect(readPersistedChatState(resume.id).threadId).toBe("thread-resume");
    expect(readPersistedChatState(transcript.id).threadId).toBe("thread-transcript");
    expect(readPersistedChatState(none.id).continuityRecovery).toMatchObject({ state: "required", reason: "unknown" });

    const acp = await service.createSession({
      laneId: "lane-1",
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
      title: "Qwen chat",
    });
    fs.rmSync(metadataPath(acp.id), { force: true });
    fs.rmSync(metadataPath(acp.id) + ".lkg", { force: true });
    sessionService.setResumeCommand(acp.id, "chat:qwen:" + acp.id);
    service.reconcileThreadPointerFromRedundantSources(acp.id);
    expect(readPersistedChatState(acp.id).acpSessionId).toBeUndefined();
    expect(readPersistedChatState(acp.id).continuityRecovery).toMatchObject({
      state: "required",
      reason: "unknown",
      provider: "qwen",
    });
  });
});

// ---------------------------------------------------------------------------
// Caller MCP isolation (strictMcpConfig)
//
// A user-configured MCP server (filesystem, shell, git, …) is exactly what an
// embedder asking for strict mode wants withheld. Each test pins the MCP
// configuration ADE actually sends when strict mode is on.
// ---------------------------------------------------------------------------

describe("caller MCP isolation", () => {
  // Same overlay, different caller: the ADE SDK injects servers into an
  // ordinary chat. Codex has no "replace the config" mode, so both the caller's
  // servers and strict mode's per-server disables ride the same table.
  it("Codex: merges caller-injected MCP servers into the thread config overlay", async () => {
    const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;
    const { service } = createService({
      resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      resolveCodexConfiguredMcpServerNames: () => ["filesystem"],
    });

    const chat = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      mcpServers: {
        embedderHttp: { type: "http", url: "https://example.test/mcp", headers: { "x-key": "v" } },
        embedderStdio: { type: "stdio", command: "node", args: ["server.js"] },
      },
    });
    await service.sendMessage({ sessionId: chat.id, text: "Do the work." });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((p) => p.method === "thread/start")).toBe(true);
    });

    const start = mockState.codexRequestPayloads.find((p) => p.method === "thread/start") as any;
    // Without strict mode, `filesystem` is untouched: the user's own Codex
    // config keeps loading exactly as it did before this feature.
    expect(start?.params?.config?.mcp_servers).toEqual({
      computer_use: { command: signedClient, args: ["mcp"], enabled: true },
      embedderHttp: { url: "https://example.test/mcp", http_headers: { "x-key": "v" }, enabled: true },
      embedderStdio: { command: "node", args: ["server.js"], enabled: true },
    });
  });

  it("Codex: strict mode disables the user's configured servers but not the caller's", async () => {
    const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;
    const { service } = createService({
      resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      resolveCodexConfiguredMcpServerNames: () => ["filesystem", "embedder"],
    });

    const chat = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
      strictMcpConfig: true,
    });
    await service.sendMessage({ sessionId: chat.id, text: "Do the work." });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((p) => p.method === "thread/start")).toBe(true);
    });

    const start = mockState.codexRequestPayloads.find((p) => p.method === "thread/start") as any;
    // `embedder` is in BOTH lists — the user configured a server by that name
    // and the caller injected one. The caller's definition has to win, or
    // strict mode would disable the very server it was asked to add.
    expect(start?.params?.config?.mcp_servers).toEqual({
      computer_use: { command: signedClient, args: ["mcp"], enabled: true },
      filesystem: { enabled: false },
      embedder: { url: "https://example.test/mcp", enabled: true },
    });
  });

  // `computer_use` is BOTH an ADE-managed server and a name that appears in the
  // user's config.toml mcp_servers table. That made it the one name where merge
  // order mattered, and the order was wrong: strict mode disabled ADE's own
  // Computer Use, because the strict overrides were spread after it.
  it("Codex: ADE's computer_use survives strict mode and a colliding caller name", async () => {
    const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;
    const { service } = createService({
      resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      // The user's config.toml declares computer_use, so strict mode would
      // otherwise emit `computer_use: { enabled: false }`.
      resolveCodexConfiguredMcpServerNames: () => ["filesystem", "computer_use"],
    });

    const chat = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
      strictMcpConfig: true,
    });
    await service.sendMessage({ sessionId: chat.id, text: "Do the work." });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((p) => p.method === "thread/start")).toBe(true);
    });

    const start = mockState.codexRequestPayloads.find((p) => p.method === "thread/start") as any;
    const servers = start?.params?.config?.mcp_servers;
    // ADE's own server wins over both the strict override and any caller entry.
    expect(servers.computer_use).toEqual({ command: signedClient, args: ["mcp"], enabled: true });
    // The user's other servers are still disabled — strict mode still works.
    expect(servers.filesystem).toEqual({ enabled: false });
    expect(servers.embedder).toMatchObject({ enabled: true });
  });

});

// ---------------------------------------------------------------------------
// Host sleep
//
// The incident: a MacBook slept mid-turn, the in-flight API call died, and the
// transcript reported `Claude API retry 1/10: unknown` — while ADE already knew
// the machine was suspending. These cover the three things that must now hold:
// one chip per sleep that resolves itself, retries held rather than burned, and
// a genuine API failure left completely alone.
// ---------------------------------------------------------------------------
describe("host sleep narration", () => {
  /** A power source the test drives by hand, standing in for Electron's. */
  function fakeHostPowerSource() {
    const listeners = new Set<(event: any) => void>();
    let sleepState: "awake" | "asleep" = "awake";
    // Stamped from the same clock the tracker reads, exactly as a real monitor
    // does: `asleep` is age-bounded against this, and a stamp frozen at a fake
    // epoch would read as a stuck, long-stale announcement.
    let sleepStateAt = Date.now();
    return {
      source: {
        getPower: () => null,
        getSleepState: () => sleepState,
        getSleepStateAt: () => sleepStateAt,
        getSuspendGapMs: () => null,
        subscribe: (listener: (event: any) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      } as any,
      suspend(at = 1_000, stateAt = Date.now()) {
        sleepState = "asleep";
        sleepStateAt = stateAt;
        for (const listener of [...listeners]) listener({ kind: "suspend", at, announced: true });
      },
      resume(at = 241_000, gapMs: number | null = 240_000, stateAt = Date.now()) {
        sleepState = "awake";
        sleepStateAt = stateAt;
        for (const listener of [...listeners]) listener({ kind: "resume", at, gapMs, announced: true });
      },
    };
  }

  /**
   * A Claude stream that parks mid-turn so the test can suspend the host at a
   * moment when a turn is genuinely in flight, then parks again so it can wake
   * it before the turn finishes.
   */
  function installParkedClaudeStream(retry: Record<string, unknown>) {
    let releaseBeforeRetry = (): void => {};
    let releaseBeforeResult = (): void => {};
    const beforeRetry = new Promise<void>((resolve) => {
      releaseBeforeRetry = resolve;
    });
    const beforeResult = new Promise<void>((resolve) => {
      releaseBeforeResult = resolve;
    });
    const reached = { retry: false, result: false };

    const send = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        return;
      }
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Running tests…" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      await beforeRetry;
      yield { type: "system", subtype: "api_retry", session_id: "sdk-session-sleep", ...retry };
      reached.retry = true;
      await beforeResult;
      reached.result = true;
      yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close,
      sessionId: "sdk-session-sleep",
    } as any);
    vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
      send,
      stream,
      close,
      sessionId: "sdk-session-sleep",
    } as any);

    return { releaseBeforeRetry, releaseBeforeResult, reached };
  }

  const noticesOf = (onEvent: ReturnType<typeof vi.fn>) => onEvent.mock.calls
    .map((call) => call[0])
    .filter((envelope: any) => envelope?.event?.type === "system_notice")
    .map((envelope: any) => envelope.event);

  const turnStarted = (onEvent: ReturnType<typeof vi.fn>) => onEvent.mock.calls
    .some((call) => {
      const event = (call[0] as any)?.event;
      return event?.type === "status" && event.turnStatus === "started";
    });

  it("shows one chip that resolves in place, and holds the retry the sleep caused", async () => {
    const power = fakeHostPowerSource();
    const parked = installParkedClaudeStream({
      error: "unknown",
      attempt: 1,
      max_retries: 10,
    });

    const onEvent = vi.fn();
    const { service, logger } = createService({ onEvent, hostPowerSource: power.source });
    try {
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "run the tests",
        timeoutMs: 15_000,
      });
      await waitFor(() => turnStarted(onEvent));

      power.suspend();
      const paused = noticesOf(onEvent).filter((event: any) => event.status === "host_asleep");
      expect(paused).toHaveLength(1);
      expect(paused[0].message).toBe("Paused — computer asleep");

      // Let the suspend-caused retry arrive while the machine is down.
      parked.releaseBeforeRetry();
      await waitFor(() => parked.reached.retry);

      expect(noticesOf(onEvent).filter((event: any) =>
        typeof event.message === "string" && event.message.startsWith("Claude API retry"),
      )).toHaveLength(0);
      expect(onEvent.mock.calls.filter((call) => (call[0] as any)?.event?.type === "api_retry"))
        .toHaveLength(0);
      // The retry really did arrive and really was held — without this the
      // two assertions above would also pass on a stream that never retried.
      expect(logger.info).toHaveBeenCalledWith(
        "agent_chat.api_retry_held_for_host_suspend",
        expect.objectContaining({ providerCause: "unknown", sleepState: "asleep" }),
      );
      // Still ONE chip — the held retry must not add a second artifact.
      expect(noticesOf(onEvent).filter((event: any) => event.status === "host_asleep")).toHaveLength(1);

      power.resume();
      parked.releaseBeforeResult();
      await turn;

      const asleep = noticesOf(onEvent).filter((event: any) => event.status === "host_asleep");
      const awake = noticesOf(onEvent).filter((event: any) => event.status === "host_awake");
      expect(asleep).toHaveLength(1);
      expect(awake).toHaveLength(1);
      expect(awake[0].message).toBe("Resumed · paused 4m");
      // Same identity is what folds the two halves onto one transcript row.
      expect(awake[0].detail.hostSleep.sleepId).toBe(asleep[0].detail.hostSleep.sleepId);
      // And the turn itself still finished after the wake.
      expect(onEvent.mock.calls.some((call) => (call[0] as any)?.event?.type === "done")).toBe(true);
    } finally {
      await service.disposeAll();
    }
  });

  it("leaves a genuine API failure retrying and reporting its real cause", async () => {
    const power = fakeHostPowerSource();
    const parked = installParkedClaudeStream({
      error: "overloaded",
      error_status: 529,
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 2_000,
    });

    const onEvent = vi.fn();
    const { service } = createService({ onEvent, hostPowerSource: power.source });
    try {
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "run the tests",
        timeoutMs: 15_000,
      });
      await waitFor(() => turnStarted(onEvent));

      // Even with the host asleep, an error the API itself named is the truth.
      power.suspend();
      parked.releaseBeforeRetry();
      await waitFor(() => parked.reached.retry);
      parked.releaseBeforeResult();
      await turn;

      expect(onEvent.mock.calls.some((call) => {
        const event = (call[0] as any)?.event;
        return event?.type === "activity"
          && event.activity === "working"
          && event.detail === "Retrying Claude · attempt 1 of 10 · retrying in 2s";
      })).toBe(true);
      expect(onEvent.mock.calls.filter((call) => (call[0] as any)?.event?.type === "api_retry"))
        .toHaveLength(1);
    } finally {
      await service.disposeAll();
    }
  });

  it("leaves an idle chat alone when the machine sleeps", async () => {
    const power = fakeHostPowerSource();
    const onEvent = vi.fn();
    const { service } = createService({ onEvent, hostPowerSource: power.source });
    try {
      await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      power.suspend();
      power.resume();
      expect(noticesOf(onEvent).filter((event: any) =>
        event.status === "host_asleep" || event.status === "host_awake",
      )).toHaveLength(0);
    } finally {
      await service.disposeAll();
    }
  });
});

describe("claude output style listing", () => {
  it("does not persist an output style just because the list was shown", async () => {
    // Listing styles used to write the resolved name onto the session and
    // persist it. Every later option build then treated that cache as a real
    // selection, so ADE sent outputStyle at flag tier and suppressed Claude's
    // own resolution — the override this branch exists to stop.
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
    });

    await service.sendMessage({ sessionId: session.id, text: "/output-style" });

    expect(readPersistedChatState(session.id).claudeOutputStyle ?? null).toBeNull();
    expect((await service.getSessionSummary(session.id))?.claudeOutputStyle ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ACP providers (qwen, kimi, grok, copilot)
// ---------------------------------------------------------------------------
//
// These drive the real ACP host: the scripted agent is a fake child process, so
// the framing, the request correlation and the permission round-trip under test
// are the production ones. Only the operating system process is replaced.
