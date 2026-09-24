import {
  AgentChatEventEnvelope,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createClaudeStreamFixture,
  createService,
  detectAllAuth,
  fs,
  installAutoTitleAuth,
  installAutoTitleClaudeStream,
  makeDefaultClaudeSession,
  mockState,
  path,
  query,
  readPersistedChatState,
  renameSession,
  startOpenCodeSession,
  streamText,
  tmpRoot,
  waitFor,
  waitForEvent,
  waitForSessionTitle,
} from "./agentChatServiceTestFixture";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("getSlashCommands", () => {
    it("returns empty array for unknown session", async () => {
      const { service } = createService();
      const commands = service.getSlashCommands({ sessionId: "unknown-id" });
      expect(commands).toEqual([]);
    });

    it("returns Claude commands for a draft lane before a chat session exists", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "shipLane.md"), [
        "---",
        "description: Ship the active lane",
        "---",
        "",
        "Ship lane.",
        "",
      ].join("\n"));
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "claude" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/agents");
      expect(names).toContain("/output-style");
      expect(names).not.toContain("/exit");
      expect(names).not.toContain("/quit");
      expect(names).not.toContain("/statusline");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/shipLane",
          description: "Ship the active lane",
          source: "sdk",
        }),
      ]));
      expect(names).not.toContain("/login");
    });

    it("returns Codex commands for a draft lane before a chat session exists", async () => {
      const promptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, "audit.md"), "Audit recent work.");
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "codex" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/permissions");
      expect(names).toContain("/review");
      expect(names).toContain("/shell");
      expect(names).toContain("/memory");
      expect(names).toContain("/memory-reset");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/audit",
          description: "Audit recent work.",
          source: "sdk",
        }),
      ]));
      expect(names).not.toContain("/apps");
    });

    it("returns local and filesystem-backed skill commands for an opencode session", async () => {
      const skillDir = path.join(tmpRoot, ".agents", "skills", "deploy-helper");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
        "---",
        "name: deploy-helper",
        "description: Use this skill for deployment help",
        "---",
        "",
        "Deploy safely.",
        "",
      ].join("\n"));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands.length).toBeGreaterThanOrEqual(1);

      const clearCmd = commands.find((c: any) => c.name === "/clear");
      expect(clearCmd).toBeDefined();
      expect(clearCmd!.source).toBe("local");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/deploy-helper",
          description: "Use this skill for deployment help",
          source: "sdk",
        }),
      ]));
    });

    it("returns Claude and Codex prompt commands plus /clear for a droid lane", async () => {
      const claudeCommandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(claudeCommandsDir, { recursive: true });
      fs.writeFileSync(path.join(claudeCommandsDir, "deploy.md"), [
        "---",
        "description: Deploy the active branch",
        "---",
        "",
        "Deploy.",
        "",
      ].join("\n"));
      const codexPromptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(codexPromptsDir, { recursive: true });
      fs.writeFileSync(path.join(codexPromptsDir, "triage.md"), "Triage the inbox.");
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "droid" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/clear");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/deploy",
          description: "Deploy the active branch",
          source: "sdk",
        }),
        expect.objectContaining({
          name: "/triage",
          description: "Triage the inbox.",
          source: "sdk",
        }),
      ]));
    });

    it("returns Cursor commands, subagents, skills, and /clear for a Cursor lane", async () => {
      const commandDir = path.join(tmpRoot, ".cursor", "commands");
      const agentsDir = path.join(tmpRoot, ".cursor", "agents");
      const skillDir = path.join(tmpRoot, ".cursor", "skills", "sdk-audit");
      fs.mkdirSync(commandDir, { recursive: true });
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(commandDir, "write-tests.md"), [
        "---",
        "description: Write Cursor-backed tests",
        "---",
        "",
        "Write tests.",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(agentsDir, "verifier.md"), [
        "---",
        "description: Verify the implementation",
        "---",
        "",
        "Verify work.",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
        "---",
        "name: sdk-audit",
        "description: Audit the Cursor SDK wiring",
        "---",
        "",
        "Audit Cursor.",
        "",
      ].join("\n"));
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "cursor" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/clear");
      expect(names).toContain("/explore");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/write-tests",
          description: "Write Cursor-backed tests",
          source: "sdk",
        }),
        expect.objectContaining({
          name: "/verifier",
          description: "Verify the implementation",
          source: "sdk",
        }),
        expect.objectContaining({
          name: "/sdk-audit",
          description: "Audit the Cursor SDK wiring",
          source: "sdk",
        }),
      ]));
    });

    it("returns the same slash command set for a live droid session", async () => {
      const codexPromptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(codexPromptsDir, { recursive: true });
      fs.writeFileSync(path.join(codexPromptsDir, "summarize.md"), "Summarize this lane.");
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/clear");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/summarize",
          description: "Summarize this lane.",
          source: "sdk",
        }),
      ]));
    });

    it("does not advertise /login as a Claude SDK command", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeUndefined();
    });

    it("filters SDK terminal_slash_commands extras from a live Claude session palette", async () => {
      let warmupComplete = false;
      const stream = vi.fn(() => (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-terminal-slash",
          slash_commands: ["/compact", "/exit", "/foo-cli"],
          terminal_slash_commands: ["/foo-cli"],
        };
        warmupComplete = true;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-terminal-slash",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const names = service.getSlashCommands({ sessionId: session.id }).map((command) => command.name);
      expect(names).toContain("/compact");
      expect(names).not.toContain("/exit");
      expect(names).not.toContain("/quit");
      expect(names).not.toContain("/statusline");
      expect(names).not.toContain("/foo-cli");
    });

    it("advertises the ADE-hosted Claude output-style command", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/output-style",
          source: "sdk",
        }),
      ]));
    });

    it("removes dead-listed Codex slash commands from the palette", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const names = commands.map((c) => c.name);
      // §A.6 leftovers (removed handlers/IPC)
      expect(names).not.toContain("/fork");
      expect(names).not.toContain("/resume");
      expect(names).not.toContain("/rollback");
      expect(names).not.toContain("/unarchive");
      // Codex-CLI-only surfaces with no ADE consumer
      expect(names).not.toContain("/apps");
      expect(names).not.toContain("/plugins");
      expect(names).not.toContain("/ps");
      expect(names).not.toContain("/stop");
      // Duplicate ADE composer/lane flows
      expect(names).not.toContain("/mention");
      expect(names).not.toContain("/new");
      // TUI-only configuration
      expect(names).not.toContain("/statusline");
      expect(names).not.toContain("/title");
      // Destructive runtime side-effect; ADE owns /quit
      expect(names).not.toContain("/exit");
      // /inject was added by F.2
      expect(names).toContain("/inject");
    });

    it("includes project Claude Code command files before SDK init completes", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "automate.md"), [
        "---",
        "description: Generate test coverage",
        "argument-hint: [area]",
        "---",
        "",
        "Generate tests for $ARGUMENTS.",
        "",
      ].join("\n"));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/automate",
          description: "Generate test coverage",
          argumentHint: "[area]",
          source: "sdk",
        }),
      ]));
    });

    it("does not let a filesystem /login command replace provider auth guidance", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "login.md"), [
        "---",
        "description: Project login override",
        "---",
        "",
        "This should not replace ADE's login command.",
        "",
      ].join("\n"));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeUndefined();
    });

    it("does not include /login for opencode sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeUndefined();
    });

    it("includes Codex prompt files before the app server reports dynamic commands", async () => {
      const promptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, "audit.md"), "Audit recent work.");

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/audit",
          description: "Audit recent work.",
          source: "sdk",
        }),
      ]));
    });

    it("advertises Codex CLI parity slash command hints for Codex sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/fast",
          argumentHint: "[on|off|status]",
          source: "local",
        }),
        expect.objectContaining({
          name: "/plan",
          argumentHint: "[prompt]",
          source: "local",
        }),
        expect.objectContaining({
          name: "/goal",
          argumentHint: "[pause|resume|clear|<objective>]",
          source: "local",
        }),
      ]));
    });

    it("includes project Claude command files for Codex-backed sessions", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      const promptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "shipLane.md"), [
        "---",
        "description: Ship the active lane",
        "---",
        "",
        "Ship lane.",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(promptsDir, "shipLane.md"), "# Codex ship lane prompt\n");

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands.filter((command: any) => command.name.toLowerCase() === "/shiplane")).toHaveLength(1);
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/shipLane",
          description: "Ship the active lane",
          source: "sdk",
        }),
      ]));
    });
  });

  describe("Claude output styles", () => {
    it("lists built-in and project-local output styles for a Claude session", async () => {
      const stylesDir = path.join(tmpRoot, ".claude", "output-styles");
      fs.mkdirSync(stylesDir, { recursive: true });
      fs.writeFileSync(path.join(stylesDir, "reviewer.md"), [
        "---",
        "name: Reviewer",
        "description: Review first",
        "---",
        "",
        "Review first.",
        "",
      ].join("\n"));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      expect(service.listClaudeOutputStyles({ sessionId: session.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Default", source: "builtin" }),
        expect.objectContaining({ name: "Reviewer", source: "project", description: "Review first" }),
      ]));
    });

    it("persists and applies an output style to a live Claude query", async () => {
      const applyFlagSettings = vi.fn(async () => undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        applyFlagSettings,
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.sendMessage({ sessionId: session.id, text: "hello" });
      const updated = await service.setClaudeOutputStyle({ sessionId: session.id, outputStyle: "Learning" });

      expect(updated.claudeOutputStyle).toBe("Learning");
      expect(applyFlagSettings).toHaveBeenCalledWith({ outputStyle: "Learning" });
      expect(JSON.parse(fs.readFileSync(path.join(tmpRoot, ".claude", "settings.local.json"), "utf8"))).toMatchObject({
        outputStyle: "Learning",
      });
    });
  });

  describe("Claude context usage", () => {
    it("normalizes used and free context categories against the full context window", async () => {
      const getContextUsage = vi.fn(async () => ({
        categories: [
          { name: "System", tokens: 10_000 },
          { name: "Messages", tokens: 30_000 },
        ],
        totalTokens: 40_000,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 20,
        gridRows: [],
        model: "claude-sonnet",
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        getContextUsage,
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.sendMessage({ sessionId: session.id, text: "hello" });
      const usage = await service.getContextUsage({ sessionId: session.id });

      expect(getContextUsage).toHaveBeenCalled();
      expect(usage?.categories).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "System", percentage: 5 }),
        expect.objectContaining({ name: "Messages", percentage: 15 }),
        expect.objectContaining({ name: "Free", percentage: 80 }),
      ]));
      expect(usage?.percentage).toBe(20);
    });
  });

  describe("Claude plugins", () => {
    it("lists discovered local Claude plugins", async () => {
      const pluginRoot = path.join(tmpRoot, ".claude", "plugins", "team-tools", "review-plugin");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "review-plugin",
        description: "Review helpers",
      }));
      fs.writeFileSync(path.join(tmpRoot, ".claude", "settings.json"), JSON.stringify({
        enabledPlugins: { "review-plugin@local": true },
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      expect(service.listClaudePlugins({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          name: "review-plugin",
          description: "Review helpers",
          path: fs.realpathSync(pluginRoot),
        }),
      ]);
    });

    it("reloads plugins through the live Claude query", async () => {
      const reloadPlugins = vi.fn(async () => ({
        plugins: [{ name: "review-plugin", path: "/tmp/review-plugin" }],
        commands: [{ name: "review-plugin:audit", description: "Audit" }],
        agents: [{ name: "reviewer", description: "Review code" }],
        error_count: 0,
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        reloadPlugins,
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.sendMessage({ sessionId: session.id, text: "hello" });
      const result = await service.reloadClaudePlugins({ sessionId: session.id });

      expect(reloadPlugins).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        plugins: [expect.objectContaining({ name: "review-plugin", path: "/tmp/review-plugin" })],
        commands: [expect.objectContaining({ name: "review-plugin:audit", description: "Audit" })],
        agents: [expect.objectContaining({ name: "reviewer", description: "Review code" })],
        errorCount: 0,
      }));
      expect(service.getSlashCommands({ sessionId: session.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "/review-plugin:audit", description: "Audit" }),
      ]));
    });
  });

  it("sends Claude provider slash commands as the raw SDK prompt", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-slash-command",
          slash_commands: ["/automate"],
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        return;
      }
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-slash-command",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/automate chat slash commands",
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenLastCalledWith("/automate chat slash commands");
    });
  });

  it("does not forward Claude /login into the Agent SDK", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream: vi.fn(() => (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-login-command",
          slash_commands: ["/login"],
        };
      })()),
      close: vi.fn(),
      sessionId: "sdk-session-login-command",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await expect(service.sendMessage({
      sessionId: session.id,
      text: "/login",
    })).rejects.toThrow("/login is not an SDK-dispatchable command");
    expect(send).not.toHaveBeenCalledWith("/login");
  });

  it("expands project Claude command files before sending to the SDK", async () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "audit.md"), [
      "---",
      "description: Audit recent work",
      "---",
      "",
      "Audit the work you just did.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));

    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-project-slash-command",
          slash_commands: [],
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        return;
      }
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-project-slash-command",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/audit command menus",
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenLastCalledWith("Audit the work you just did.\n\nFocus: command menus");
    });
  });

  it("expands Codex prompt files before sending to the app server", async () => {
    const promptsDir = path.join(tmpRoot, ".codex", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "audit.md"), [
      "Audit the Codex chat work.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/audit command menus",
    });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });
    const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start") as any;
    expect(turnStartRequest.params.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: "Audit the Codex chat work.\n\nFocus: command menus",
      }),
    ]));
  });

  it("expands project Claude command files before sending to Codex", async () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands");
    const promptsDir = path.join(tmpRoot, ".codex", "prompts");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "audit.md"), [
      "---",
      "description: Audit recent work",
      "---",
      "",
      "Audit the work.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(promptsDir, "audit.md"), [
      "Audit the Codex prompt.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      modelId: "openai/gpt-5.5",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/audit command rendering",
    }, { awaitDispatch: true });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });
    const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start") as any;
    expect(turnStartRequest.params.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: "Audit the work.\n\nFocus: command rendering",
      }),
    ]));
  });

  it("keeps built-in Codex slash commands routed to the app server", async () => {
    const promptsDir = path.join(tmpRoot, ".codex", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "review.md"), "This project prompt must not replace built-in review.");
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription", cli: "claude", authenticated: true },
    ] as any);

    const { service, aiIntegrationService } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/review",
    }, { awaitDispatch: true });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "review/start")).toBe(true);
    });
    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
  });

  describe("Codex 0.149 app-server composer commands", () => {
    const pin149 = () => {
      mockState.codexResponseOverrides.set("initialize", { userAgent: "codex/0.149.1" });
    };

    const setupQueuedCodexTurn = async () => {
      pin149();
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
        text: "Keep this turn active.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item: { id: "compact-1", type: "contextCompaction" } },
      });
      return { service, session, events };
    };

    it("sends ! and /shell drafts through thread/shellCommand", async () => {
      pin149();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "!git status --short",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/shellCommand")).toBe(true);
      });
      const shell = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/shellCommand");
      expect(shell?.params).toEqual(expect.objectContaining({
        command: "git status --short",
      }));
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("adopts the thread/shellCommand turn so the composer can settle", async () => {
      pin149();
      mockState.codexResponseOverrides.set("thread/shellCommand", { turn: { id: "shell-turn-1" } });
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
        text: "!pwd",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "shell-turn-1", status: "completed" } },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "done"
          && event.event.turnId === "shell-turn-1",
        )).toBe(true);
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Continue after the shell command.",
      }, { awaitDispatch: true });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });

    it("settles idle user shell when thread/shellCommand has no turn id", async () => {
      pin149();
      mockState.codexResponseOverrides.set("thread/shellCommand", {});
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "!pwd",
      }, { awaitDispatch: true });
      await service.sendMessage({
        sessionId: session.id,
        text: "Continue after the shell command.",
      }, { awaitDispatch: true });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });

    it("does not reset memory until /memory-reset confirm", async () => {
      pin149();
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
        text: "/memory-reset",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "memory/reset")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && String(event.event.message).includes("/memory-reset confirm"),
      )).toBe(true);

      await service.sendMessage({
        sessionId: session.id,
        text: "/memory-reset confirm",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "memory/reset")).toBe(true);
    });

    it("sets memory mode with /memory on", async () => {
      pin149();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/memory on",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) =>
        payload.method === "thread/memoryMode/set"
        && (payload.params as { mode?: string }).mode === "enabled",
      )).toBe(true);
    });

    it("queues a follow-up during compaction instead of steering", async () => {
      pin149();
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
        text: "Keep this turn active.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: { id: "compact-1", type: "contextCompaction" },
        },
      });

      const queued = await service.steer({
        sessionId: session.id,
        text: "are u still alive",
      });
      expect(queued.queued).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/queue/add")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);

      const coalesced = await service.steer({
        sessionId: session.id,
        text: "are u still alive",
      });
      expect(coalesced.queued).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Duplicate check-in ignored.",
      )).toBe(true);
    });

    it("cancels a queued Codex message and clears the staged chip", async () => {
      const { service, session, events } = await setupQueuedCodexTurn();

      const { steerId } = await service.steer({ sessionId: session.id, text: "check in" });
      await service.cancelSteer({ sessionId: session.id, steerId });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/queue/delete")).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Queued message cancelled."
        && event.event.steerId === steerId,
      )).toBe(true);
    });

    it("recovers the Codex queue submission id when the in-memory mapping is missing", async () => {
      // `queuedSubmissionBySteerId` lives only on the runtime object, so a
      // restart, a rehydration, or a remote-handled cancel arrives with it
      // empty while the transcript still renders the staged chip. The server
      // is the durable half of the mapping.
      const { service, session } = await setupQueuedCodexTurn();

      // A queue/add that reports no id leaves the runtime with no mapping —
      // the same state a restart or a rehydrated session produces — while the
      // server still holds the submission under the steerId ADE sent it as.
      mockState.codexResponseOverrides.set("thread/queue/add", (payload) => ({
        queuedSubmission: {
          clientUserMessageId: (payload.params as { clientUserMessageId?: string }).clientUserMessageId,
        },
      }));
      const { steerId } = await service.steer({ sessionId: session.id, text: "check in" });
      mockState.codexResponseOverrides.set("thread/queue/list", {
        queuedSubmissions: [{ id: "recovered-submission", clientUserMessageId: steerId }],
      });

      await service.cancelSteer({ sessionId: session.id, steerId, requireQueued: true });

      expect(mockState.codexRequestPayloads.some((payload) =>
        payload.method === "thread/queue/delete"
        && (payload.params as { id?: string }).id === "recovered-submission",
      )).toBe(true);
    });

    it("raises instead of reporting a cancellation Codex refused", async () => {
      // Swallowing this cleared the chip while the submission stayed queued and
      // still ran — a false success, which is worse than a visible failure.
      const { service, session, events } = await setupQueuedCodexTurn();

      const { steerId } = await service.steer({ sessionId: session.id, text: "check in" });
      mockState.codexResponseOverrides.set("thread/queue/delete", {
        error: { code: -32000, message: "queue is locked" },
      });

      await expect(service.cancelSteer({ sessionId: session.id, steerId })).rejects.toThrow("queue is locked");
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Queued message cancelled."
        && event.event.steerId === steerId,
      )).toBe(false);
    });

    it("keeps the staged Codex message when queue recovery itself fails", async () => {
      const { service, session, events } = await setupQueuedCodexTurn();

      mockState.codexResponseOverrides.set("thread/queue/add", (payload) => ({
        queuedSubmission: {
          clientUserMessageId: (payload.params as { clientUserMessageId?: string }).clientUserMessageId,
        },
      }));
      const { steerId } = await service.steer({ sessionId: session.id, text: "check in" });
      mockState.codexResponseOverrides.set("thread/queue/list", {
        error: { code: -32000, message: "queue temporarily unavailable" },
      });

      await expect(service.cancelSteer({ sessionId: session.id, steerId })).rejects.toThrow(
        "Could not inspect Codex's queued messages: queue temporarily unavailable",
      );
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Queued message cancelled."
        && event.event.steerId === steerId,
      )).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/queue/delete")).toBe(false);
    });

    it("clears an unrecoverable staged Codex message instead of silently doing nothing", async () => {
      const { service, session, events } = await setupQueuedCodexTurn();

      // Mapping never recorded AND the server queue is empty: nothing can
      // deliver this message, so the chip has to clear rather than sit there
      // with a button that does nothing every time it is pressed.
      mockState.codexResponseOverrides.set("thread/queue/add", (payload) => ({
        queuedSubmission: {
          clientUserMessageId: (payload.params as { clientUserMessageId?: string }).clientUserMessageId,
        },
      }));
      const { steerId } = await service.steer({ sessionId: session.id, text: "check in" });

      await service.cancelSteer({ sessionId: session.id, steerId });

      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Queued message cancelled."
        && event.event.steerId === steerId,
      )).toBe(true);
      await expect(
        service.cancelSteer({ sessionId: session.id, steerId, requireQueued: true }),
      ).rejects.toThrow("no longer queued");
    });

    it("runs mid-turn ! commands as user shell instead of steer", async () => {
      pin149();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Keep this turn active.",
      }, { awaitDispatch: true });

      await service.steer({
        sessionId: session.id,
        text: "!pwd",
      });

      expect(mockState.codexRequestPayloads.some((payload) =>
        payload.method === "thread/shellCommand"
        && (payload.params as { command?: string }).command === "pwd",
      )).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);
    });

    it("keeps the parent turn active when a mid-turn user shell fails", async () => {
      pin149();
      mockState.codexResponseOverrides.set("thread/shellCommand", {
        error: { code: -32000, message: "shell failed" },
      });
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
        text: "Keep this turn active.",
      }, { awaitDispatch: true });

      await service.sendMessage({
        sessionId: session.id,
        text: "!pwd",
      }, { awaitDispatch: true });
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && String(event.event.message).includes("user shell failed"),
      )).toBe(true);
      await expect(service.sendMessage({
        sessionId: session.id,
        text: "Continue the original turn.",
      }, { awaitDispatch: true })).rejects.toThrow(/turn is already active/i);
    });

    it("sends revalidated effort when switching Codex models on a live thread", async () => {
      pin149();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
        reasoningEffort: "high",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Keep this thread live.",
      }, { awaitDispatch: true });

      await service.updateSession({
        sessionId: session.id,
        modelId: "openai/gpt-5.6-sol",
      });
      const settings = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/settings/update");
      expect(settings?.params).toEqual(expect.objectContaining({
        effort: expect.any(String),
      }));
    });

    it("fail-opens compaction when the turn is interrupted", async () => {
      pin149();
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
        text: "Keep this turn active.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: { id: "compact-stall", type: "contextCompaction" },
        },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          (event.event.type === "context_compact" || event.event.type === "codex_context_compaction")
          && event.event.state === "started",
        )).toBe(true);
      });

      await service.interrupt({ sessionId: session.id });
      expect(events.some((event) =>
        (event.event.type === "context_compact" || event.event.type === "codex_context_compaction")
        && event.event.state === "failed"
        && event.event.failReason === "interrupted",
      )).toBe(true);
    });

    it("fail-opens compaction after a stall", async () => {
      pin149();
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
        text: "Keep this turn active.",
      }, { awaitDispatch: true });
      vi.useFakeTimers();
      try {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { id: "compact-timeout", type: "contextCompaction" },
          },
        });
        let started = false;
        for (let i = 0; i < 20 && !started; i += 1) {
          await Promise.resolve();
          started = events.some((event) =>
            (event.event.type === "context_compact" || event.event.type === "codex_context_compaction")
            && event.event.state === "started"
            && event.event.compactionId === "compact-timeout",
          );
        }
        expect(started).toBe(true);
        await vi.advanceTimersByTimeAsync(180_000);
      } finally {
        vi.useRealTimers();
      }
      expect(events.some((event) =>
        (event.event.type === "context_compact" || event.event.type === "codex_context_compaction")
        && event.event.compactionId === "compact-timeout"
        && event.event.state === "failed"
        && event.event.failReason === "timed_out",
      )).toBe(true);
    });
  });

  describe("runtime-native chat titles", () => {
    it("adopts Codex app-server thread names from lifecycle responses", async () => {
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-runtime-title", name: "Runtime Naming Investigation" },
      }));
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({ sessionId: session.id, text: "Check session names." });

      await waitForSessionTitle(sessionService, session.id, "Runtime Naming Investigation");
      expect(sessionService.get(session.id)?.manuallyNamed).toBe(false);
    });

    it("allows a later runtime title after an explicit non-manual title write", async () => {
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-runtime-title-reset", name: "Initial Runtime Title" },
      }));
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({ sessionId: session.id, text: "Use the initial runtime title." });
      await waitForSessionTitle(sessionService, session.id, "Initial Runtime Title");

      await service.updateSession({
        sessionId: session.id,
        title: "ADE Reset",
        manuallyNamed: false,
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: { threadId: "thread-runtime-title-reset", name: "Runtime Title After Reset" },
      });

      await waitForSessionTitle(sessionService, session.id, "Runtime Title After Reset");
    });

    it("adopts Codex thread/name/updated notifications without overwriting manual names", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({ sessionId: session.id, text: "Name this from runtime." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: { threadId: "thread-1", threadName: "Captured Runtime Title" },
      });
      await waitForSessionTitle(sessionService, session.id, "Captured Runtime Title");

      await service.updateSession({ sessionId: session.id, title: "Manual Title", manuallyNamed: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: { threadId: "thread-1", name: "Should Not Win" },
      });
      await waitForSessionTitle(sessionService, session.id, "Manual Title");
    });

    it("lets OpenCode session.updated titles beat ADE AI fallback", async () => {
      streamText.mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      });
      mockState.openCodeTitleForNextPrompt = "OpenCode Native Title";
      const { service, sessionService, aiIntegrationService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.sendMessage({ sessionId: session.id, text: "Use runtime title." }, { awaitDispatch: true });

      await waitForSessionTitle(sessionService, session.id, "OpenCode Native Title");
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
      expect(vi.mocked(startOpenCodeSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ title: null }),
      );
    });

    it("adopts Droid SDK session_title_updated titles", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      await service.sendMessage({ sessionId: session.id, text: "Use SDK title." }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(typeof mockState.droidPooled.bridge.onEvent).toBe("function");
      }, { timeout: 1_000 });
      mockState.droidPooled.bridge.onEvent?.({
        type: "session_title_updated",
        title: "Droid Native Title",
      });

      await waitForSessionTitle(sessionService, session.id, "Droid Native Title");
    });

    it("turns a Droid context sample that trails done into a meter reading without touching the finished turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      await service.sendMessage({ sessionId: session.id, text: "Do it." }, { awaitDispatch: true });
      const done = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } => event.event.type === "done",
      );
      expect(done.event.status).toBe("completed");
      // A Stop after the run settled has nothing to flip.
      await service.interrupt({ sessionId: session.id });

      // The worker's background `droid.get_context_stats` read lands after done.
      mockState.droidPooled.bridge.onEvent?.({
        type: "context_stats",
        contextStats: { used: 900, remaining: 1_100, limit: 2_000, accuracy: "exact", updatedAt: "2026-09-23T12:00:00.000Z" },
      });
      const usage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "context_usage" }>;
        } => event.event.type === "context_usage",
      );
      expect(usage.event.usage).toMatchObject({ totalTokens: 900, maxTokens: 2_000 });
      expect(events.filter((event) => event.event.type === "done")).toHaveLength(1);
      expect(events.some((event) =>
        event.event.type === "status" && event.event.turnStatus === "interrupted")).toBe(false);
    });

    it("never takes a trailing Droid context sample as the next turn's dispatch ack, and keeps it on its own turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      await service.sendMessage({ sessionId: session.id, text: "First." }, { awaitDispatch: true });
      const firstDone = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } => event.event.type === "done",
      );
      const firstTurnId = firstDone.event.turnId;
      expect(mockState.droidPromptCalls[0]?.turnId).toBe(firstTurnId);

      let releaseTurn: () => void = () => {};
      mockState.droidPromptGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      let dispatched = false;
      const second = service.sendMessage({ sessionId: session.id, text: "Second." }, { awaitBackendDispatch: true })
        .then(() => { dispatched = true; });
      await vi.waitFor(() => expect(mockState.droidPromptCalls).toHaveLength(2));
      const secondTurnId = mockState.droidPromptCalls[1]?.turnId;
      expect(typeof secondTurnId).toBe("string");
      expect(secondTurnId).not.toBe(firstTurnId);

      // Turn one's trailing sample lands while turn two waits on Droid.
      mockState.droidPooled.bridge.onEvent?.({
        type: "context_stats",
        contextStats: { used: 900, remaining: 1_100, limit: 2_000, accuracy: "exact", updatedAt: "2026-09-23T12:00:00.000Z" },
        turnId: firstTurnId,
      });
      const usage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "context_usage" }>;
        } => event.event.type === "context_usage",
      );
      expect(usage.event.turnId).toBe(firstTurnId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(dispatched).toBe(false);

      // A real stream event from turn two is the acknowledgement.
      mockState.droidPooled.bridge.onEvent?.({ type: "working_state_changed", state: "streaming_assistant_message" });
      await vi.waitFor(() => expect(dispatched).toBe(true));
      releaseTurn();
      await second;
    });
  });

  // --------------------------------------------------------------------------
  // updateSession
  // --------------------------------------------------------------------------

  describe("updateSession", () => {
    it("does not let a stale Claude title sync overwrite a newer rename", async () => {
      const { service, sessionService, session } = await createClaudeStreamFixture({
        sdkSessionId: "sdk-session-title-race",
        messages: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "Ready" }], usage: { input_tokens: 1, output_tokens: 1 } },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-session-title-race",
          },
        ],
      });

      let releaseGenerated!: () => void;
      const generatedGate = new Promise<void>((resolve) => { releaseGenerated = resolve; });
      let markGeneratedStarted!: () => void;
      const generatedStarted = new Promise<void>((resolve) => { markGeneratedStarted = resolve; });
      const renameTitles: string[] = [];
      vi.mocked(renameSession)
        .mockImplementationOnce(async (_sessionId, title) => {
          renameTitles.push(title);
          markGeneratedStarted();
          await generatedGate;
        })
        .mockImplementationOnce(async (_sessionId, title) => {
          renameTitles.push(title);
        });

      const generated = service.updateSession({
        sessionId: session.id,
        title: "Generated Title",
        manuallyNamed: true,
      });
      await generatedStarted;

      const manual = service.updateSession({
        sessionId: session.id,
        title: "User Title",
        manuallyNamed: true,
      });
      await vi.waitFor(() => expect(sessionService.get(session.id)?.title).toBe("User Title"));

      releaseGenerated();
      await Promise.all([generated, manual]);

      expect(renameTitles).toEqual(["Generated Title", "User Title"]);
      expect(sessionService.getClaudeSessionPointerByChatSessionId(session.id)?.title).toBe("User Title");
    });

    it("broadcasts a session_meta_updated event with mode fields on a mode change", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      events.length = 0;

      await service.updateSession({
        sessionId: session.id,
        opencodePermissionMode: "plan",
      });

      const metaEvent = events
        .map((envelope) => envelope.event)
        .find((event): event is Extract<typeof event, { type: "session_meta_updated" }> =>
          event.type === "session_meta_updated");
      expect(metaEvent).toBeDefined();
      expect(metaEvent?.opencodePermissionMode).toBe("plan");
    });

    it("replays the full transcript when switching to an out-of-family model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Seamless replay-fork on model change.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(session.status).toBe("idle");
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        modelId: "openai/gpt-5.5",
      });
      const persisted = readPersistedChatState(updated.id);

      expect(updated.provider).toBe("codex");
      expect(persisted.pendingTranscriptReplay).toContain("Seamless replay-fork on model change.");
      expect(persisted.pendingTranscriptReplay).toContain("verbatim replay");
    });

    it("changes only the model when switching models with independent settings selected", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
        reasoningEffort: "high",
        fastMode: true,
        permissionMode: "plan",
        codexApprovalPolicy: "on-failure",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      });
      const before = {
        reasoningEffort: session.reasoningEffort,
        permissionMode: session.permissionMode,
        codexApprovalPolicy: session.codexApprovalPolicy,
        codexSandbox: session.codexSandbox,
        codexConfigSource: session.codexConfigSource,
      };

      const updated = await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-5",
      });

      expect(updated.provider).toBe("claude");
      expect(updated.modelId).toBe("anthropic/claude-sonnet-5");
      expect(updated).toMatchObject(before);
      // Fast is the one control that belongs to the model: Sonnet has no fast
      // tier, so the switch clears it.
      expect(updated.fastMode).not.toBe(true);
    });

    it("does not broadcast mode fields when no mode field is updated", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      events.length = 0;

      await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "high",
      });

      const metaEventsWithMode = events
        .map((envelope) => envelope.event)
        .filter((event) => event.type === "session_meta_updated")
        .filter((event) => "opencodePermissionMode" in event
          || "permissionMode" in event
          || "codexApprovalPolicy" in event
          || "cursorModeId" in event);
      expect(metaEventsWithMode).toHaveLength(0);
    });

    it("updates the session title", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      expect(updated.permissionMode).toBe("full-auto");
    });

    it("manuallyNamed suppresses auto-titling after sendMessage", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
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

      const { service, sessionService, aiIntegrationService } = createService({
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

      // Give auto-title / idle status-line a chance to fire (void promises)
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(sessionService.get(session.id)?.title).toBe("My Title");
      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalled();
      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Write a short statusLine"),
          systemPrompt: expect.stringContaining("Copy these current values unchanged: chatTitle, laneName"),
        }),
      );
    });

    it("does not clobber a manual rename that lands while auto-titling is in flight", async () => {
      const events: AgentChatEventEnvelope[] = [];
      installAutoTitleClaudeStream();
      installAutoTitleAuth();

      let renameDuringNaming: Promise<unknown> | null = null;
      const { service, sessionService, aiIntegrationService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      // The naming request only resolves after the user has renamed the chat,
      // which is exactly the race that used to overwrite their title and clear
      // the manuallyNamed flag.
      aiIntegrationService.summarizeTerminal.mockImplementation(async () => {
        if (renameDuringNaming) return { text: "Model Picked That" } as never;
        renameDuringNaming = service.updateSession({
          sessionId: session.id,
          title: "User Picked This",
          manuallyNamed: true,
        });
        await renameDuringNaming;
        return { text: "Model Picked That" } as never;
      });

      await service.sendMessage({ sessionId: session.id, text: "Build me a new feature" });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope => event.event.type === "done");
      await waitFor(() => Boolean(renameDuringNaming));
      await renameDuringNaming;
      // Wait for the clobber itself rather than a fixed delay: pre-fix code
      // writes the model title as soon as the naming call resolves, so this
      // returns immediately when the regression is present and costs a bounded
      // wait when it is not.
      await waitFor(() => sessionService.get(session.id)?.title === "Model Picked That", 1_000);

      expect(renameDuringNaming, "auto-title never ran, so the race was not exercised").not.toBeNull();
      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalled();
      expect(sessionService.get(session.id)?.title).toBe("User Picked This");
      expect(sessionService.get(session.id)?.manuallyNamed).toBe(true);
      expect(sessionService.updateMeta).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Model Picked That" }),
      );
    });

    it("falls back to a deterministic title when every naming model fails", async () => {
      const events: AgentChatEventEnvelope[] = [];
      installAutoTitleClaudeStream();
      installAutoTitleAuth();

      const { service, sessionService, aiIntegrationService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      // A provider-level failure condemns each provider in turn, so the chain
      // runs out of models — the chat must still never sit on "Claude Chat".
      aiIntegrationService.summarizeTerminal.mockRejectedValue(
        new Error("The model is not supported when using Codex with a ChatGPT account."),
      );

      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.sendMessage({ sessionId: session.id, text: "Rewrite the lane naming fallback chain" });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope => event.event.type === "done");
      await waitFor(() => (sessionService.get(session.id)?.title ?? "") !== "Claude Chat");

      const title = sessionService.get(session.id)?.title ?? "";
      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalled();
      expect(title).not.toBe("Claude Chat");
      expect(title.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(2);
      expect(title.toLowerCase()).toContain("lane");
    });
  });

  describe("regenerateSessionMetadata", () => {
    const generatedMetadata = {
      chatTitle: "Refresh Session Metadata",
      laneName: "Metadata Refresh",
      statusLine: "Regenerating visible session details",
    };

    it("lets an explicit request replace a manual title and updates all three fields", async () => {
      installAutoTitleAuth();
      const { service, sessionService, laneService, aiIntegrationService } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      await service.updateSession({
        sessionId: session.id,
        title: "The user's chosen title",
        manuallyNamed: true,
      });
      aiIntegrationService.summarizeTerminal.mockResolvedValue({
        text: JSON.stringify(generatedMetadata),
        structuredOutput: generatedMetadata,
      } as never);

      const result = await service.regenerateSessionMetadata({ sessionId: session.id });

      expect(result.applied).toEqual(["title", "statusLine", "laneName"]);
      expect(result.skipped).toEqual([]);
      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(1);
      expect(sessionService.updateMeta).toHaveBeenLastCalledWith({
        sessionId: session.id,
        title: generatedMetadata.chatTitle,
        manuallyNamed: true,
      });
      expect(sessionService.setStatusNote).toHaveBeenCalledWith(session.id, generatedMetadata.statusLine);
      expect(laneService.rename).toHaveBeenCalledWith({
        laneId: "lane-2",
        name: generatedMetadata.laneName,
      });
      expect(sessionService.get(session.id)).toMatchObject({
        title: generatedMetadata.chatTitle,
        manuallyNamed: true,
        statusNote: generatedMetadata.statusLine,
      });
    });

    it("applies a usable title when the model leaves the status line empty", async () => {
      installAutoTitleAuth();
      const { service, sessionService, aiIntegrationService } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      const sparseMetadata = { ...generatedMetadata, statusLine: "" };
      aiIntegrationService.summarizeTerminal.mockResolvedValue({
        text: JSON.stringify(sparseMetadata),
        structuredOutput: sparseMetadata,
      } as never);

      const result = await service.regenerateSessionMetadata({
        sessionId: session.id,
        fields: ["title", "statusLine"],
      });

      expect(result.applied).toEqual(["title"]);
      expect(result.skipped).toEqual(["statusLine"]);
      expect(sessionService.get(session.id)?.title).toBe(generatedMetadata.chatTitle);
      expect(sessionService.setStatusNote).not.toHaveBeenCalled();
    });

    it("keeps a same-text manual rename made while generation is in flight", async () => {
      installAutoTitleAuth();
      const { service, sessionService, laneService, aiIntegrationService } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      const existingTitle = sessionService.get(session.id)?.title;
      expect(existingTitle).toBeTruthy();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      aiIntegrationService.summarizeTerminal.mockImplementation(async () => {
        await gate;
        return {
          text: JSON.stringify(generatedMetadata),
          structuredOutput: generatedMetadata,
        } as never;
      });

      const regeneration = service.regenerateSessionMetadata({ sessionId: session.id });
      await vi.waitFor(() => expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(1));
      await service.updateSession({
        sessionId: session.id,
        title: existingTitle!,
        manuallyNamed: true,
      });
      release();

      const result = await regeneration;

      expect(result.applied).toEqual(["statusLine", "laneName"]);
      expect(result.skipped).toEqual(["title"]);
      expect(sessionService.get(session.id)).toMatchObject({
        title: existingTitle,
        manuallyNamed: true,
        statusNote: generatedMetadata.statusLine,
      });
      expect(sessionService.updateMeta).not.toHaveBeenCalledWith(expect.objectContaining({
        title: generatedMetadata.chatTitle,
      }));
      expect(laneService.rename).toHaveBeenCalledWith({ laneId: "lane-2", name: generatedMetadata.laneName });
    });

    it("does not let a newer request apply a stale lane name", async () => {
      installAutoTitleAuth();
      const { service, laneService, aiIntegrationService } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      const staleMetadata = { ...generatedMetadata, laneName: "Stale Lane Name" };
      const freshMetadata = { ...generatedMetadata, laneName: "Fresh Lane Name" };
      let aiCall = 0;
      let releaseFirstModel!: () => void;
      const firstModelGate = new Promise<void>((resolve) => { releaseFirstModel = resolve; });
      let releaseStaleLaneLookup!: () => void;
      const staleLaneLookup = new Promise<void>((resolve) => { releaseStaleLaneLookup = resolve; });
      let summaryCall = 0;
      const originalGetSummary = laneService.getSummary;
      laneService.getSummary = vi.fn(async (laneId: string) => {
        summaryCall += 1;
        if (summaryCall === 2) await staleLaneLookup;
        return await originalGetSummary(laneId);
      });
      aiIntegrationService.summarizeTerminal.mockImplementation(async () => {
        aiCall += 1;
        if (aiCall === 1) await firstModelGate;
        const metadata = aiCall === 1 ? staleMetadata : freshMetadata;
        return { text: JSON.stringify(metadata), structuredOutput: metadata } as never;
      });

      const staleRequest = service.regenerateSessionMetadata({ sessionId: session.id, fields: ["laneName"] });
      await vi.waitFor(() => expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(1));
      releaseFirstModel();
      await vi.waitFor(() => expect(summaryCall).toBe(2));

      const freshRequest = service.regenerateSessionMetadata({ sessionId: session.id, fields: ["laneName"] });
      await expect(freshRequest).resolves.toMatchObject({ applied: ["laneName"], skipped: [] });
      releaseStaleLaneLookup();

      await expect(staleRequest).resolves.toMatchObject({ applied: [], skipped: ["laneName"] });
      expect(laneService.rename).toHaveBeenCalledTimes(1);
      expect(laneService.rename).toHaveBeenCalledWith({ laneId: "lane-2", name: freshMetadata.laneName });
    });
  });

  // --------------------------------------------------------------------------
  // dispose and disposeAll
  // --------------------------------------------------------------------------
});
