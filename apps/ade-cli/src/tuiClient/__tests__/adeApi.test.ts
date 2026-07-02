import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import { archiveChatSession, cancelSteerMessage, createChatSession, DEFAULT_CODEX_REASONING_EFFORT, deleteChatSession, dispatchSteerMessage, discoverProjectSlashCommands, editSteerMessage, getAvailableModels, getChatHistoryPage, latestGoal, latestTokenStats, listChatSessions, listLaneDiffStats, listPrsByLane, listTerminalSessions, resumeTerminalSession, runDefaultLaneSetup, sendChatMessage, signalTerminal, startClaudeTerminalSession, steerChatMessage, unarchiveChatSession } from "../adeApi";
import type { AdeCodeConnection } from "../types";

const tmpPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const tmpPath of tmpPaths.splice(0)) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  }
});

function makeTmpRoot(prefix: string): string {
  const tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpPaths.push(tmpPath);
  return tmpPath;
}

function envelope(
  sequence: number,
  event: AgentChatEventEnvelope["event"],
): AgentChatEventEnvelope {
  return {
    sessionId: "s1",
    timestamp: `2026-01-01T12:00:0${sequence}.000Z`,
    sequence,
    event,
  };
}

describe("listLaneDiffStats", () => {
  it("calls the bulk diff stats ADE action with lane ids", async () => {
    const calls: Array<{ domain: string; action: string; args: Record<string, unknown> | undefined }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return { "lane-1": { additions: 12, deletions: 4, files: 3 } };
      },
    } as unknown as AdeCodeConnection;

    const result = await listLaneDiffStats(connection, ["lane-1"]);

    expect(calls).toEqual([
      {
        domain: "diff",
        action: "listLaneDiffStats",
        args: { laneIds: ["lane-1"] },
      },
    ]);
    expect(result["lane-1"]).toEqual({ additions: 12, deletions: 4, files: 3 });
  });
});

describe("runDefaultLaneSetup", () => {
  it("applies the configured default template when it still exists", async () => {
    const calls: Array<{ domain: string; action: string; args: Record<string, unknown> | undefined }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        if (action === "listTemplates") return [{ id: "tpl-1", name: "Default" }];
        if (action === "getDefaultTemplate") return "tpl-1";
        if (action === "applyTemplate") {
          return { laneId: "lane-1", steps: [], startedAt: "2026-01-01T00:00:00.000Z", overallStatus: "completed" };
        }
        throw new Error(`unexpected action ${action}`);
      },
    } as unknown as AdeCodeConnection;

    const result = await runDefaultLaneSetup(connection, "lane-1");

    expect(result.templateId).toBe("tpl-1");
    expect(result.progress.overallStatus).toBe("completed");
    expect(calls).toEqual([
      { domain: "lane", action: "listTemplates", args: undefined },
      { domain: "lane", action: "getDefaultTemplate", args: undefined },
      { domain: "lane", action: "applyTemplate", args: { laneId: "lane-1", templateId: "tpl-1" } },
    ]);
  });

  it("falls back to lane init when the saved default template is gone", async () => {
    const calls: Array<{ domain: string; action: string; args: Record<string, unknown> | undefined }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        if (action === "listTemplates") return [{ id: "other", name: "Other" }];
        if (action === "getDefaultTemplate") return "missing";
        if (action === "initEnv") {
          return { laneId: "lane-1", steps: [], startedAt: "2026-01-01T00:00:00.000Z", overallStatus: "completed" };
        }
        throw new Error(`unexpected action ${action}`);
      },
    } as unknown as AdeCodeConnection;

    const result = await runDefaultLaneSetup(connection, "lane-1");

    expect(result.templateId).toBeNull();
    expect(result.progress.overallStatus).toBe("completed");
    expect(calls).toEqual([
      { domain: "lane", action: "listTemplates", args: undefined },
      { domain: "lane", action: "getDefaultTemplate", args: undefined },
      { domain: "lane", action: "initEnv", args: { laneId: "lane-1" } },
    ]);
  });
});

describe("getChatHistoryPage", () => {
  it("calls the positional chat history page action and passes maxBytes only when set", async () => {
    const calls: Array<{ domain: string; action: string; argsList: unknown[] }> = [];
    const connection = {
      actionList: async (domain: string, action: string, argsList: unknown[]) => {
        calls.push({ domain, action, argsList });
        return { sessionId: "s1", events: [envelope(1, { type: "text", text: "hi" })], startOffset: 128, hasMore: true, sessionFound: true };
      },
    } as unknown as AdeCodeConnection;

    const page = await getChatHistoryPage(connection, "s1", 4096);
    await getChatHistoryPage(connection, "s1", 4096, 65_536);

    expect(calls).toEqual([
      { domain: "chat", action: "getChatEventHistoryPage", argsList: ["s1", { beforeOffset: 4096 }] },
      { domain: "chat", action: "getChatEventHistoryPage", argsList: ["s1", { beforeOffset: 4096, maxBytes: 65_536 }] },
    ]);
    expect(page.startOffset).toBe(128);
    expect(page.hasMore).toBe(true);
    expect(page.events).toHaveLength(1);
  });

  it("normalizes a null result into a terminal empty page", async () => {
    const connection = {
      actionList: async () => null,
    } as unknown as AdeCodeConnection;

    const page = await getChatHistoryPage(connection, "s1", 4096);

    expect(page).toEqual({ sessionId: "s1", events: [], startOffset: 0, hasMore: false, sessionFound: false });
  });

  it("normalizes malformed page fields so the scroll-back loop terminates", async () => {
    const connection = {
      actionList: async () => ({ sessionId: "s1", events: null, startOffset: Number.NaN, hasMore: "yes", sessionFound: true }),
    } as unknown as AdeCodeConnection;

    const page = await getChatHistoryPage(connection, "s1", 4096);

    expect(page.events).toEqual([]);
    expect(page.startOffset).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.sessionFound).toBe(true);
  });
});

describe("chat session archive helpers", () => {
  it("lists chats with archived sessions hidden by default", async () => {
    const calls: Array<{ domain: string; action: string; args: Record<string, unknown> | undefined }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return [];
      },
    } as unknown as AdeCodeConnection;

    await listChatSessions(connection);
    await listChatSessions(connection, "lane-1", { includeArchived: true });

    expect(calls).toEqual([
      { domain: "chat", action: "listSessions", args: { includeArchived: false } },
      { domain: "chat", action: "listSessions", args: { laneId: "lane-1", includeArchived: true } },
    ]);
  });

  it("calls archive, unarchive, and delete chat actions with session ids", async () => {
    const calls: Array<{ domain: string; action: string; args: Record<string, unknown> | undefined }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
      },
    } as unknown as AdeCodeConnection;

    await archiveChatSession(connection, "chat-1");
    await unarchiveChatSession(connection, "chat-2");
    await deleteChatSession(connection, "chat-3");

    expect(calls).toEqual([
      { domain: "chat", action: "archiveSession", args: { sessionId: "chat-1" } },
      { domain: "chat", action: "unarchiveSession", args: { sessionId: "chat-2" } },
      { domain: "chat", action: "deleteSession", args: { sessionId: "chat-3" } },
    ]);
  });
});

describe("latestTokenStats", () => {
  it("tracks streaming state, context percentage, token counts, and cost", () => {
    const events = [
      envelope(1, { type: "status", turnStatus: "started" }),
      envelope(2, {
        type: "tokens",
        turnId: "turn-1",
        inputTokens: 2_000,
        outputTokens: 500,
        contextWindow: 10_000,
      } as AgentChatEventEnvelope["event"]),
      envelope(3, {
        type: "done",
        turnId: "turn-1",
        status: "completed",
        usage: { inputTokens: 2_100, outputTokens: 700 },
        costUsd: 0.42,
      }),
    ];

    expect(latestTokenStats(events)).toEqual({
      percent: 28,
      streaming: false,
      inputTokens: 2_100,
      outputTokens: 700,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      contextWindow: 10_000,
      costUsd: 0.42,
      rateLimit: null,
    });
  });

  it("falls back to the active model contextWindow when the event omits one", () => {
    const events = [
      envelope(1, { type: "status", turnStatus: "started" }),
      envelope(2, {
        type: "done",
        turnId: "turn-1",
        status: "completed",
        usage: { inputTokens: 40_000, outputTokens: 10_000 },
        costUsd: 0.12,
      }),
    ];

    expect(latestTokenStats(events, 200_000)).toEqual({
      percent: 25,
      streaming: false,
      inputTokens: 40_000,
      outputTokens: 10_000,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      contextWindow: 200_000,
      costUsd: 0.12,
      rateLimit: null,
    });
  });

  it("returns null percent when no contextWindow is available", () => {
    const events = [
      envelope(1, {
        type: "done",
        turnId: "turn-1",
        status: "completed",
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ];
    expect(latestTokenStats(events).percent).toBeNull();
  });

  it("reads cachedInputTokens / cacheReadTokens from both tokens and codex_token_usage events", () => {
    const events = [
      envelope(1, {
        type: "tokens",
        turnId: "turn-1",
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 450,
        contextWindow: 10_000,
      } as AgentChatEventEnvelope["event"]),
      envelope(2, {
        type: "codex_token_usage",
        usage: {
          last: { inputTokens: 2_300, outputTokens: 1_100, cacheReadTokens: 600 },
          modelContextWindow: 10_000,
        },
      } as AgentChatEventEnvelope["event"]),
    ];
    const stats = latestTokenStats(events);
    expect(stats.cacheReadTokens).toBe(600);
    expect(stats.inputTokens).toBe(2_300);
    expect(stats.outputTokens).toBe(1_100);
  });

  it("reads cachedInputTokens from done usage events", () => {
    const events = [
      envelope(1, {
        type: "done",
        turnId: "turn-1",
        status: "completed",
        usage: { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 350 },
      } as AgentChatEventEnvelope["event"]),
    ];
    const stats = latestTokenStats(events);
    expect(stats.cacheReadTokens).toBe(350);
  });
});

describe("latestGoal", () => {
  it("tracks the most recent updated goal and respects clears", () => {
    expect(latestGoal([
      envelope(1, {
        type: "codex_goal_updated",
        goal: { objective: "Refactor middleware", status: "active", tokensUsed: 100, tokenBudget: 5_000 },
      } as AgentChatEventEnvelope["event"]),
    ])?.objective).toBe("Refactor middleware");

    expect(latestGoal([
      envelope(1, {
        type: "codex_goal_updated",
        goal: { objective: "Old goal", status: "active" },
      } as AgentChatEventEnvelope["event"]),
      envelope(2, { type: "codex_goal_cleared" } as AgentChatEventEnvelope["event"]),
    ])).toBeNull();
  });
});

describe("discoverProjectSlashCommands", () => {
  it("prefers project .claude command metadata over same-named global Codex prompts", () => {
    const projectRoot = makeTmpRoot("ade-code-project-commands-");
    const homeRoot = makeTmpRoot("ade-code-home-prompts-");
    vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
    const commandsDir = path.join(projectRoot, ".claude", "commands");
    const promptsDir = path.join(homeRoot, ".codex", "prompts");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "automate.md"), [
      "---",
      "description: Project ADE automate",
      "---",
      "",
      "Run project automate.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(promptsDir, "automate.md"), "# Global Codex automate\n");

    const commands = discoverProjectSlashCommands(projectRoot);
    expect(commands.filter((command) => command.name.toLowerCase() === "/automate")).toHaveLength(1);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "/automate",
        description: "Project ADE automate",
      }),
    ]));
  });

  it("hides login commands regardless of project command filename casing", () => {
    const projectRoot = makeTmpRoot("ade-code-login-command-");
    const commandsDir = path.join(projectRoot, ".claude", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "Login.md"), [
      "---",
      "description: Case variant login",
      "---",
      "",
      "Login.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(commandsDir, "ship.md"), "Ship.\n");

    const commands = discoverProjectSlashCommands(projectRoot);
    expect(commands.some((command) => command.name.toLowerCase() === "/login")).toBe(false);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "/ship" }),
    ]));
  });

  it("includes Cursor command files and subagents", () => {
    const projectRoot = makeTmpRoot("ade-code-cursor-command-");
    const commandsDir = path.join(projectRoot, ".cursor", "commands");
    const agentsDir = path.join(projectRoot, ".cursor", "agents");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "review-code.md"), "Review code.\n");
    fs.writeFileSync(path.join(agentsDir, "verifier.md"), [
      "---",
      "description: Verify the change",
      "---",
      "",
      "Verify.",
      "",
    ].join("\n"));

    const commands = discoverProjectSlashCommands(projectRoot);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "/review-code", description: "Review code." }),
      expect.objectContaining({ name: "/verifier", description: "Verify the change" }),
    ]));
  });
});

describe("getAvailableModels", () => {
  it("activates dynamic Cursor model discovery for TUI model lists", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: vi.fn(async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return [];
      }),
    } as any;

    await getAvailableModels(connection, "cursor");

    expect(calls).toEqual([
      {
        domain: "chat",
        action: "getAvailableModels",
        // TUI chats run cursor through the SDK, so only that source is probed
        // synchronously; the CLI flavor revalidates in the background on the host.
        args: { provider: "cursor", activateRuntime: true, cursorSource: "sdk" },
      },
    ]);
  });
});

describe("createChatSession", () => {
  it("defaults Codex chats to GPT-5.5 low reasoning", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return {
          id: "chat-1",
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        };
      },
    } as unknown as AdeCodeConnection;

    await createChatSession({ connection, laneId: "lane-1" });

    expect(calls).toEqual([
      expect.objectContaining({
        domain: "chat",
        action: "createSession",
        args: expect.objectContaining({
          provider: "codex",
          model: "gpt-5.5",
          modelId: "openai/gpt-5.5",
          reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
          surface: "work",
        }),
      }),
    ]);
  });

  it("passes native model controls when creating chats", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return {
          id: "chat-1",
          laneId: "lane-1",
          provider: args?.provider,
          model: args?.model,
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        };
      },
    } as unknown as AdeCodeConnection;

    await createChatSession({
      connection,
      laneId: "lane-1",
      provider: "codex",
      modelId: "openai/gpt-5.5",
      reasoningEffort: "high",
      fastMode: true,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });

    expect(calls[0]?.args).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-5.5",
      modelId: "openai/gpt-5.5",
      reasoningEffort: "high",
      fastMode: true,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    }));
  });

  it("passes fast mode when creating Cursor chats", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return {
          id: "chat-1",
          laneId: "lane-1",
          provider: args?.provider,
          model: args?.model,
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        };
      },
    } as unknown as AdeCodeConnection;

    await createChatSession({
      connection,
      laneId: "lane-1",
      provider: "cursor",
      modelId: "cursor/composer-2.5",
      fastMode: true,
    });

    expect(calls[0]?.args).toEqual(expect.objectContaining({
      provider: "cursor",
      model: "composer-2.5",
      modelId: "cursor/composer-2.5",
      fastMode: true,
    }));
  });
});

describe("startClaudeTerminalSession", () => {
  it("passes Claude model reasoning and permission controls to start_cli_session", async () => {
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const connection = {
      tool: async (name: string, args?: Record<string, unknown>) => {
        calls.push({ name, args });
        return {
          sessionId: "term-1",
          terminalId: "term-1",
          session: null,
        };
      },
    } as unknown as AdeCodeConnection;

    await startClaudeTerminalSession({
      connection,
      laneId: "lane-1",
      title: "Claude smoke",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "low",
      permissionMode: "auto",
      initialInput: "Hello",
      cols: 100,
      rows: 28,
    });

    expect(calls).toEqual([
      {
        name: "start_cli_session",
        args: expect.objectContaining({
          laneId: "lane-1",
          provider: "claude",
          title: "Claude smoke",
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "low",
          permissionMode: "auto",
          initialInput: "Hello",
          cols: 100,
          rows: 28,
          tracked: true,
        }),
      },
    ]);
  });
});

describe("resumeTerminalSession", () => {
  it("routes no-prompt terminal resumes through the PTY action domain", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return {
          sessionId: "term-1",
          ptyId: "pty-1",
          pid: 123,
          session: null,
          resumed: true,
          reusedExistingRuntime: false,
        };
      },
    } as unknown as AdeCodeConnection;

    await expect(resumeTerminalSession({
      connection,
      sessionId: "term-1",
      cols: 100,
      rows: 28,
    })).resolves.toMatchObject({ sessionId: "term-1", resumed: true });

    expect(calls).toEqual([
      {
        domain: "pty",
        action: "resumeSession",
        args: { sessionId: "term-1", cols: 100, rows: 28 },
      },
    ]);
  });
});

describe("listPrsByLane", () => {
  it("passes through the bulk PR lane action", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return [
          {
            laneId: "lane-1",
            number: 168,
            state: "open",
            checksPassed: 4,
            checksTotal: 6,
          },
        ];
      },
    } as unknown as AdeCodeConnection;

    await expect(listPrsByLane(connection)).resolves.toEqual([
      {
        laneId: "lane-1",
        number: 168,
        state: "open",
        checksPassed: 4,
        checksTotal: 6,
      },
    ]);

    expect(calls).toEqual([{ domain: "pr", action: "listPrsByLane", args: {} }]);
  });
});

describe("signalTerminal", () => {
  it("routes terminal signals through the terminal action domain", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
      },
    } as unknown as AdeCodeConnection;

    await signalTerminal(connection, "terminal-1", "SIGTERM");

    expect(calls).toEqual([
      {
        domain: "terminal",
        action: "signal",
        args: { terminalId: "terminal-1", signal: "SIGTERM" },
      },
    ]);
  });
});

describe("listTerminalSessions", () => {
  it("only exposes Claude Code CLI sessions in the ADE code TUI", async () => {
    const calls: Array<{ domain: string; action: string; args?: Record<string, unknown> }> = [];
    const sessions = [
      { terminalId: "claude-1", toolType: "claude" },
      { terminalId: "claude-orch-1", toolType: "claude-orchestrated" },
      { terminalId: "legacy-claude-1", toolType: "shell", resumeMetadata: { provider: "claude" } },
      { terminalId: "legacy-claude-command-1", toolType: "shell", resumeCommand: "claude --resume session-1" },
      { terminalId: "codex-1", toolType: "codex" },
      { terminalId: "codex-orch-1", toolType: "codex-orchestrated" },
      { terminalId: "legacy-codex-1", toolType: "shell", resumeMetadata: { provider: "codex" } },
      { terminalId: "chat-claude-1", toolType: "claude-chat" },
      { terminalId: "chat-codex-1", toolType: "codex-chat" },
      { terminalId: "cursor-1", toolType: "cursor" },
      { terminalId: "shell-1", toolType: "shell" },
    ];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return sessions;
      },
    } as unknown as AdeCodeConnection;

    const result = await listTerminalSessions(connection, "lane-1");

    expect(calls).toEqual([
      {
        domain: "terminal",
        action: "list",
        args: { laneId: "lane-1", limit: 200 },
      },
    ]);
    expect(result.map((session) => session.terminalId)).toEqual([
      "claude-1",
      "claude-orch-1",
      "legacy-claude-1",
      "legacy-claude-command-1",
    ]);
  });
});

describe("sendChatMessage", () => {
  it("forwards chat text unchanged and waits until the shared runtime has accepted the turn", async () => {
    const calls: Array<{ domain: string; action: string; argsList: unknown[] }> = [];
    const connection = {
      actionList: async (domain: string, action: string, argsList: unknown[]) => {
        calls.push({ domain, action, argsList });
      },
    } as unknown as AdeCodeConnection;

    await sendChatMessage(connection, "chat-1", "hello");

    expect(calls).toEqual([
      {
        domain: "chat",
        action: "sendMessage",
        argsList: [
          { sessionId: "chat-1", text: "hello" },
          { awaitDispatch: true },
        ],
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("control plane for ADE state");
    expect(JSON.stringify(calls)).not.toContain("ade actions list --text");
  });
});

describe("steer helpers", () => {
  it("routes steer, edit, cancel, and dispatch actions through the shared chat domain", async () => {
    const calls: Array<{ domain: string; action: string; args: Record<string, unknown> }> = [];
    const connection = {
      action: async (domain: string, action: string, args: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        if (action === "steer") return { steerId: "steer-1", queued: true };
        if (action === "dispatchSteer") return { dispatchedAt: 123 };
        return undefined;
      },
    } as unknown as AdeCodeConnection;

    await expect(steerChatMessage(connection, "chat-1", "while busy")).resolves.toEqual({ steerId: "steer-1", queued: true });
    await editSteerMessage(connection, "chat-1", "steer-1", "updated");
    await cancelSteerMessage(connection, "chat-1", "steer-1");
    await expect(dispatchSteerMessage(connection, "chat-1", "steer-1", "inline")).resolves.toEqual({ dispatchedAt: 123 });

    expect(calls).toEqual([
      { domain: "chat", action: "steer", args: { sessionId: "chat-1", text: "while busy" } },
      { domain: "chat", action: "editSteer", args: { sessionId: "chat-1", steerId: "steer-1", text: "updated" } },
      { domain: "chat", action: "cancelSteer", args: { sessionId: "chat-1", steerId: "steer-1" } },
      { domain: "chat", action: "dispatchSteer", args: { sessionId: "chat-1", steerId: "steer-1", mode: "inline" } },
    ]);
  });
});
