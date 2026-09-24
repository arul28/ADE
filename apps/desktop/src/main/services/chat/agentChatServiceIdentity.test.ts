import {
  SCHEDULED_WORK_STATE_KEY,
  beginIdentityConfirmHold,
  buildCodingAgentSystemPrompt,
  buildOpenCodePromptParts,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createCtoMemoryService,
  createCtoStateService,
  createLogger,
  createScheduledWorkDb,
  createService,
  fs,
  mapPermissionToClaude,
  mapPermissionToCodex,
  mockState,
  openKvDb,
  path,
  readPersistedChatState,
  resolveBuiltInBrowserActorCapability,
  runGit,
  spawn,
  startOpenCodeSession,
  storedWakeup,
  streamText,
  tmpRoot,
  waitFor,
  waitForCondition,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { beforeEach, describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("lane launch directives", () => {
    it("injects the selected lane worktree into the first opencode user turn only", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the repo and fix the launch bug.",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Now add tests.",
      });

      const promptCalls = vi.mocked(buildOpenCodePromptParts).mock.calls;
      const firstUserContent = String(promptCalls[0]?.[0]?.prompt ?? "");
      const secondUserContent = String(promptCalls[1]?.[0]?.prompt ?? "");
      const openCodeStartCalls = vi.mocked(startOpenCodeSession).mock.calls;
      const systemPromptCalls = vi.mocked(buildCodingAgentSystemPrompt).mock.calls;

      expect(openCodeStartCalls.length).toBeGreaterThan(0);
      expect(openCodeStartCalls[0]?.[0]).toEqual(expect.objectContaining({
        leaseKind: "shared",
      }));
      expect(firstUserContent).toContain("[ADE launch directive]");
      expect(firstUserContent).toContain(tmpRoot);
      expect(firstUserContent).toContain("Read-only inspection outside that worktree is allowed");
      expect(firstUserContent).toContain("mutating commands only inside that worktree");
      expect(systemPromptCalls.at(-1)?.[0]).toEqual(expect.objectContaining({
        runtime: "opencode",
      }));
      expect(secondUserContent).not.toContain("[ADE launch directive]");
      expect(secondUserContent).not.toContain("CLI controls ADE state");
    });

    it("gives OpenCode activity guidance an explicit per-chat CLI and runtime target", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      const cliPath = path.join(tmpRoot, "activity-cli", "ade");
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(cliPath, 0o755);
      const runtimeSocketPath = "/Users/admin/.ade-beta/sock/ade.sock";
      const staleRuntimeSocketPath = "/Users/admin/.ade/sock/ade.sock";
      const { service } = createService({
        runtimeSocketPath,
        getAdeCliAgentEnv: () => ({
          PATH: path.dirname(cliPath),
          ADE_CLI_PATH: cliPath,
          ADE_RUNTIME_SOCKET_PATH: staleRuntimeSocketPath,
          ADE_RPC_SOCKET_PATH: staleRuntimeSocketPath,
          ADE_RPC_URL: staleRuntimeSocketPath,
        }),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      await service.runSessionTurn({ sessionId: session.id, text: "Check the test state." });

      let promptBody: Record<string, unknown> | undefined;
      await vi.waitFor(() => {
        const openCodeState = [...mockState.openCodeSessions.values()].at(-1);
        promptBody = openCodeState?.promptBodies.at(-1) as Record<string, unknown> | undefined;
        expect(promptBody).toBeDefined();
      });
      const systemPromptArgs = vi.mocked(buildCodingAgentSystemPrompt).mock.calls.at(-1)?.[0];
      for (const selector of ["ADE_RPC_URL", "ADE_RPC_SOCKET_PATH", "ADE_RUNTIME_SOCKET_PATH"]) {
        expect(systemPromptArgs?.sessionActivityGuidance)
          .toContain(`${selector}='${runtimeSocketPath}'`);
      }
      expect(systemPromptArgs?.sessionActivityGuidance).toContain("ADE_DEFAULT_ROLE='agent'");
      expect(systemPromptArgs?.sessionActivityGuidance).toContain(`ADE_CHAT_SESSION_ID='${session.id}'`);
      expect(systemPromptArgs?.sessionActivityGuidance)
        .toContain(`'${cliPath}' chat activity testing --session '${session.id}'`);
      expect(systemPromptArgs?.sessionActivityGuidance).not.toContain(staleRuntimeSocketPath);
      await service.dispose({ sessionId: session.id });
    });

    it("withholds SDK activity guidance for an embedded runtime without RPC", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      const cliPath = path.join(tmpRoot, "activity-cli", "ade");
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(cliPath, 0o755);
      const { service } = createService({
        runtimeSocketPath: "/runtime/unserved.sock",
        sessionActivityReportingEnabled: false,
        getAdeCliAgentEnv: () => ({
          PATH: path.dirname(cliPath),
          ADE_CLI_PATH: cliPath,
          ADE_RUNTIME_SOCKET_PATH: "/runtime/stable.sock",
        }),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      await service.runSessionTurn({ sessionId: session.id, text: "Check the test state." });

      let promptBody: Record<string, unknown> | undefined;
      await vi.waitFor(() => {
        const openCodeState = [...mockState.openCodeSessions.values()].at(-1);
        promptBody = openCodeState?.promptBodies.at(-1) as Record<string, unknown> | undefined;
        expect(promptBody).toBeDefined();
      });
      const systemPromptArgs = vi.mocked(buildCodingAgentSystemPrompt).mock.calls.at(-1)?.[0];
      expect(systemPromptArgs?.sessionActivityGuidance).toBeNull();
      await service.dispose({ sessionId: session.id });
    });

    it("starts Codex sessions without ADE-owned tool server injection", async () => {
      const laneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(laneRootPath, { recursive: true });
      const bundledSkillRoot = path.join(tmpRoot, "codex-agent-skills");
      fs.mkdirSync(bundledSkillRoot, { recursive: true });

      const { service } = createService({
        getAdeCliAgentEnv: () => ({
          ...process.env,
          ADE_AGENT_SKILLS_DIRS: bundledSkillRoot,
        }),
      });
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and fix the lane launch bug.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "skills/extraRoots/set",
          params: { extraRoots: [bundledSkillRoot] },
        }),
        expect.objectContaining({
          method: "skills/list",
          params: expect.objectContaining({
            cwds: [expect.stringContaining("lane-2")],
            perCwdExtraUserRoots: [{
              cwd: expect.stringContaining("lane-2"),
              extraUserRoots: [bundledSkillRoot],
            }],
          }),
        }),
      ]));
      const startPayload = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(startPayload?.params).toMatchObject({
        cwd: expect.stringContaining("lane-2"),
        developerInstructions: "system prompt",
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as {
        input?: Array<{ text?: unknown }>;
        collaborationMode?: { settings?: { developer_instructions?: unknown } };
      } | undefined;
      const textInput = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(turnParams?.collaborationMode?.settings?.developer_instructions).toBe("system prompt");
      expect(textInput).not.toContain("CLI controls ADE state");
      expect(textInput).not.toContain("ade actions list --text");
      expect(textInput).toContain("Inspect the repo and fix the lane launch bug.");
    });

    it("keeps ADE skill roots and commands out of personal Codex sessions", async () => {
      const bundledSkillRoot = path.join(tmpRoot, "codex-agent-skills");
      fs.mkdirSync(bundledSkillRoot, { recursive: true });
      mockState.codexResponseOverrides.set("skills/list", (payload) => {
        const params = payload.params as { cwds?: unknown } | undefined;
        const cwd = Array.isArray(params?.cwds) ? params.cwds[0] : undefined;
        return {
          data: [{
            cwd,
            skills: [
              { name: "ade-proof-artifacts", description: "Capture ADE proof." },
              { name: "personal-helper", description: "Help with personal tasks." },
            ],
          }],
        };
      });

      const { service } = createService({
        getAdeCliAgentEnv: () => ({
          ...process.env,
          ADE_AGENT_SKILLS_DIRS: bundledSkillRoot,
        }),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        surface: "personal",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Help me organize my week.",
      });

      await vi.waitFor(() => {
        expect(service.getSlashCommands({ sessionId: session.id }))
          .toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "/personal-helper" }),
          ]));
      });

      expect(mockState.codexRequestPayloads.some((payload) =>
        payload.method === "skills/extraRoots/set"
      )).toBe(false);
      const skillsListPayload = mockState.codexRequestPayloads.find(
        (payload) => payload.method === "skills/list",
      );
      expect(skillsListPayload?.params).toEqual({
        cwds: [expect.any(String)],
        forceReload: true,
      });
      expect(JSON.stringify(skillsListPayload?.params)).not.toContain(bundledSkillRoot);
      expect(service.getSlashCommands({ sessionId: session.id })
        .some((command) => /^\/ade(?:-|$)/i.test(command.name))).toBe(false);
    });

    it.each([
      ["append", "append", true],
      ["replace", "replace", false],
    ] as const)(
      "carries host instructions to Codex developerInstructions on %s",
      async (_label, mode, keepsAdeText) => {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
          surface: "personal",
          instructions: { mode, text: "You are the Halyard assistant." },
        } as never);

        await service.sendMessage({ sessionId: session.id, text: "Hello." });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start"))
            .toBe(true);
        });
        const startPayload = mockState.codexRequestPayloads.find(
          (payload) => payload.method === "thread/start",
        );
        const instructions = String(
          (startPayload?.params as { developerInstructions?: unknown } | undefined)
            ?.developerInstructions ?? "",
        );
        expect(instructions).toContain("You are the Halyard assistant.");
        expect(instructions.includes("ADE personal chat")).toBe(keepsAdeText);
      },
    );

    it("passes the selected Codex reasoning effort per thread, not on the process", async () => {
      const laneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(laneRootPath, { recursive: true });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "low",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and report status.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      // Reasoning effort is a per-chat choice, so it must ride the thread and
      // never the process: `-c` is the highest config layer (above the user's
      // ~/.codex/config.toml and their per-project .codex/config.toml) and a
      // spawn arg would apply to every thread on this app-server.
      expect(spawn).toHaveBeenCalledWith("codex", ["app-server"], expect.any(Object));
      const spawnArgs = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined;
      expect(spawnArgs?.join(" ")).not.toContain("model_reasoning_effort");

      const startPayload = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const startParams = startPayload?.params as {
        config?: { model_reasoning_effort?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(startParams?.config?.model_reasoning_effort).toBe("low");
      expect(startParams?.effort).toBeUndefined();
      expect(startParams?.reasoningEffort).toBeUndefined();
      expect(startParams?.reasoning_effort).toBeUndefined();
    });

    it("routes new Codex chats to GPT-6 Astra with its low default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "",
      });

      expect(session).toMatchObject({
        model: "gpt-6-astra",
        modelId: "openai/gpt-6-astra",
        reasoningEffort: "low",
      });
      await service.sendMessage({ sessionId: session.id, text: "Reply only OK." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        model: "gpt-6-astra",
        config: { model_reasoning_effort: "low" },
      });
      const turnStart = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect(turnStart?.params).toMatchObject({
        model: "gpt-6-astra",
        effort: "low",
      });
    });

    it("routes new Codex chats to GPT-5.6 Sol with its low default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });

      expect(session).toMatchObject({
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
        reasoningEffort: "low",
      });
      await service.sendMessage({ sessionId: session.id, text: "Reply only OK." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        model: "gpt-5.6-sol",
        config: { model_reasoning_effort: "low" },
      });
      const turnStart = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect(turnStart?.params).toMatchObject({
        model: "gpt-5.6-sol",
        effort: "low",
      });
    });

    it("sends literal Ultra effort for Sol without aliasing it to xhigh", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
        reasoningEffort: "ultra",
      });

      await service.sendMessage({ sessionId: session.id, text: "Inspect the repo." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect((threadStart?.params as { config?: { model_reasoning_effort?: unknown } })?.config?.model_reasoning_effort).toBe("ultra");
      const turnStart = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStart?.params as { effort?: unknown })?.effort).toBe("ultra");
    });

    it("spawns Codex with ADE CLI agent env injected", async () => {
      const laneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(laneRootPath, { recursive: true });
      const getAdeCliAgentEnv = vi.fn(() => ({
        PATH: "/tmp/ade-cli/bin",
        ADE_CLI_PATH: "/tmp/ade-cli/bin/ade",
        ADE_CLI_BIN_DIR: "/tmp/ade-cli/bin",
      }));

      const { service } = createService({ getAdeCliAgentEnv });
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run doctor and inspect lane status.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      expect(getAdeCliAgentEnv).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(
        "codex",
        ["app-server"],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: "/tmp/ade-cli/bin",
            ADE_CLI_PATH: "/tmp/ade-cli/bin/ade",
            ADE_CLI_BIN_DIR: "/tmp/ade-cli/bin",
            ADE_DEFAULT_ROLE: "agent",
          }),
        }),
      );
      const spawnCall = vi.mocked(spawn).mock.calls.find((call) =>
        call[0] === "codex" && Array.isArray(call[1]) && call[1].includes("app-server")
      );
      const spawnArgs = spawnCall?.[1] as string[] | undefined;
      expect(spawnArgs).toBeDefined();
      expect(spawnArgs).not.toContain("--disable");
      expect(spawnArgs).not.toContain("browser_use");
      expect(spawnArgs).not.toContain("computer_use");
    });

    it("routes Codex activity reports through the runtime that owns the chat", async () => {
      const cliPath = path.join(tmpRoot, "activity-cli", "ade");
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(cliPath, 0o755);
      const runtimeSocketPath = "/Users/admin/.ade-beta/sock/ade.sock";
      const staleRuntimeSocketPath = "/Users/admin/.ade/sock/ade.sock";
      const getAdeCliAgentEnv = vi.fn(() => ({
        PATH: path.dirname(cliPath),
        ADE_CLI_PATH: cliPath,
        ADE_RUNTIME_SOCKET_PATH: staleRuntimeSocketPath,
        ADE_RPC_SOCKET_PATH: staleRuntimeSocketPath,
        ADE_RPC_URL: staleRuntimeSocketPath,
      }));
      const { service } = createService({ getAdeCliAgentEnv, runtimeSocketPath });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      try {
        await service.sendMessage(
          { sessionId: session.id, text: "Run the checks." },
          { awaitDispatch: true },
        );

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        });

        const spawnCall = vi.mocked(spawn).mock.calls.find((call) =>
          call[0] === "codex" && Array.isArray(call[1]) && call[1].includes("app-server")
        );
        const spawnEnv = (spawnCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        expect(spawnEnv).toMatchObject({
          ADE_RPC_URL: runtimeSocketPath,
          ADE_RPC_SOCKET_PATH: runtimeSocketPath,
          ADE_RUNTIME_SOCKET_PATH: runtimeSocketPath,
        });
      } finally {
        await service.dispose({ sessionId: session.id });
      }
    });

    it("passes raw CLI access env to the Cursor SDK pool for worker sanitization", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const getAdeCliAgentEnv = vi.fn(() => ({
        PATH: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin:/usr/bin",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_CLI_PATH: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta",
        ADE_CLI_BIN_DIR: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin",
        ADE_CLI_ENTRY_PATH: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_JS: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_INSTALL_NAME: "ade-beta",
      }));

      const { service } = createService({ getAdeCliAgentEnv });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run locally.",
      }, { awaitDispatch: true });

      expect(getAdeCliAgentEnv).toHaveBeenCalled();
      const baseEnv = mockState.cursorSdkAcquireCalls.at(-1)?.baseEnv as NodeJS.ProcessEnv | undefined;
      expect(baseEnv).toEqual(expect.objectContaining({
        ADE_CLI_PATH: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta",
        ADE_CLI_BIN_DIR: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_CLI_ENTRY_PATH: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_JS: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_INSTALL_NAME: "ade-beta",
        ADE_DEFAULT_ROLE: "agent",
        ADE_CHAT_SESSION_ID: session.id,
        ADE_LANE_ID: "lane-1",
        ADE_PROJECT_ROOT: tmpRoot,
      }));
      const actorToken = baseEnv?.ADE_BROWSER_ACTOR_TOKEN;
      expect(resolveBuiltInBrowserActorCapability(actorToken)).toMatchObject({
        chatSessionId: session.id,
        laneId: "lane-1",
        projectRoot: tmpRoot,
      });

      await service.dispose({ sessionId: session.id });

      expect(resolveBuiltInBrowserActorCapability(actorToken)).toBeNull();
    });

    it("targets Cursor SDK activity reports at the service runtime and disables them without an exact socket", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const cliPath = path.join(tmpRoot, "activity-cli", "ade");
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(cliPath, 0o755);
      const runtimeSocketPath = "/Users/admin/.ade-beta/sock/ade.sock";
      const getAdeCliAgentEnv = vi.fn(() => ({
        PATH: path.dirname(cliPath),
        ADE_CLI_PATH: cliPath,
        // The service's socket is authoritative if a launcher carries stale env.
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade/sock/ade.sock",
      }));

      const { service } = createService({ getAdeCliAgentEnv, runtimeSocketPath });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({ sessionId: session.id, text: "Run locally." }, { awaitDispatch: true });

      expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(expect.objectContaining({
        activityRuntimeSocketPath: runtimeSocketPath,
      }));
      expect(String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? ""))
        .toContain(`chat activity testing --session '${session.id}'`);
      await service.dispose({ sessionId: session.id });

      mockState.cursorSdkAcquireCalls = [];
      mockState.cursorSdkSendCalls = [];
      const fallbackSocketPath = "/runtime/fallback.sock";
      const { service: fallbackService } = createService({
        runtimeSocketPath: "   ",
        getAdeCliAgentEnv: () => ({
          PATH: path.dirname(cliPath),
          ADE_CLI_PATH: cliPath,
          ADE_RUNTIME_SOCKET_PATH: fallbackSocketPath,
        }),
      });
      const fallbackSession = await fallbackService.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await fallbackService.sendMessage({ sessionId: fallbackSession.id, text: "Run locally." }, { awaitDispatch: true });

      expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(expect.objectContaining({
        activityRuntimeSocketPath: fallbackSocketPath,
      }));
      await fallbackService.dispose({ sessionId: fallbackSession.id });

      mockState.cursorSdkAcquireCalls = [];
      mockState.cursorSdkSendCalls = [];
      const { service: noSocketService } = createService({
        getAdeCliAgentEnv: () => ({ PATH: path.dirname(cliPath), ADE_CLI_PATH: cliPath }),
      });
      const noSocketSession = await noSocketService.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await noSocketService.sendMessage({ sessionId: noSocketSession.id, text: "Run locally." }, { awaitDispatch: true });

      expect(mockState.cursorSdkAcquireCalls.at(-1)).not.toHaveProperty("activityRuntimeSocketPath");
      expect(String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? ""))
        .not.toContain("chat activity testing --session");
      await noSocketService.dispose({ sessionId: noSocketSession.id });
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.provider).toBe("opencode");
    });

    it("lists chat sessions even when newer shell sessions exceed the terminal list cap", async () => {
      const { service, sessionService } = createService();

      const chat = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
      });

      for (let i = 0; i < 505; i++) {
        sessionService.create({
          sessionId: `shell-session-${i}`,
          laneId: "lane-1",
          toolType: "shell",
          title: `Shell ${i}`,
          startedAt: new Date(Date.UTC(2026, 2, 17, 0, 10, i)).toISOString(),
        });
      }

      const sessions = await service.listSessions("lane-1");
      expect(sessions.map((session) => session.sessionId)).toContain(chat.id);
      expect(sessionService.list).toHaveBeenLastCalledWith(expect.objectContaining({
        laneId: "lane-1",
        limit: 500,
        toolTypes: expect.arrayContaining(["codex-chat", "claude-chat", "opencode-chat", "cursor", "droid-chat"]),
      }));
    });

    it("scopes a CTO confirm hold to the session that is on the call", async () => {
      // The file-wide mapPermissionToClaude mock collapses every mode to
      // "plan", which would hide the pinned full-auto entirely.
      vi.mocked(mapPermissionToClaude).mockImplementation((mode) => {
        if (mode === "full-auto") return "bypassPermissions";
        if (mode === "edit") return "acceptEdits";
        if (mode === "default") return "default";
        return "plan";
      });
      const { service } = createService();
      const onCall = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
        identityKey: "cto",
      });
      const elsewhere = await service.createSession({
        laneId: "lane-2",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
        identityKey: "cto",
      });
      expect(onCall.permissionMode).toBe("full-auto");
      expect(elsewhere.permissionMode).toBe("full-auto");

      const release = beginIdentityConfirmHold(onCall.id);
      try {
        // One brain hosts every open project. A call on one CTO chat must not
        // make a CTO chat in another project ask before it writes.
        const held = await service.updateSession({
          sessionId: onCall.id,
          permissionMode: "full-auto",
        });
        const free = await service.updateSession({
          sessionId: elsewhere.id,
          permissionMode: "full-auto",
        });
        expect(held.permissionMode).toBe("default");
        expect(free.permissionMode).toBe("full-auto");
      } finally {
        release();
      }

      const afterCall = await service.updateSession({
        sessionId: onCall.id,
        permissionMode: "full-auto",
      });
      expect(afterCall.permissionMode).toBe("full-auto");
    });

    it("excludes identity sessions by default", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "automation",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(0);

      const sessionsWithAutomation = await service.listSessions(undefined, { includeAutomation: true });
      expect(sessionsWithAutomation.length).toBe(1);
    });

    it("keeps archived sessions by default and can filter them out", async () => {
      const { service } = createService();

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      await service.archiveSession({ sessionId: session.id });

      const sessions = await service.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.archivedAt).toEqual(expect.any(String));

      await expect(service.listSessions(undefined, { includeArchived: false })).resolves.toEqual([]);
    });

    it("does not expose completion summaries as the session summary before the chat is ended", async () => {
      const { service } = createService();

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        completion: {
          status: "completed",
          summary: "Wrapped up the first pass and proposed a follow-up.",
        },
      });

      const sessions = await service.listSessions();
      expect(sessions[0]?.summary).toBeNull();
    });

    it("hydrates requestedCwd, cursorConfigValues, and awaitingInput from persisted summaries", async () => {
      const { service, sessionService } = createService();
      sessionService.create({
        sessionId: "restored-cursor-session",
        laneId: "lane-1",
        toolType: "cursor",
        title: "Restored Cursor chat",
        startedAt: "2026-03-25T00:00:00.000Z",
      });

      writePersistedChatState("restored-cursor-session", {
        version: 2,
        sessionId: "restored-cursor-session",
        laneId: "lane-1",
        provider: "cursor",
        model: "auto",
        modelId: "cursor/auto",
        cursorModeId: "ask",
        cursorConfigValues: {
          voice: true,
          temperature: 0.5,
          notes: "mobile",
        },
        awaitingInput: true,
        requestedCwd: "apps/ios/ADE",
        updatedAt: "2026-03-25T00:00:05.000Z",
      });

      await expect(service.listSessions()).resolves.toMatchObject([
        expect.objectContaining({
          sessionId: "restored-cursor-session",
          cursorModeId: "ask",
          cursorConfigValues: {
            voice: true,
            temperature: 0.5,
            notes: "mobile",
          },
          awaitingInput: true,
          requestedCwd: "apps/ios/ADE",
        }),
      ]);
    });

    it("keeps lifecycle projection when one session's scheduled-work summary is malformed", async () => {
      let brokenSessionId = "";
      const scheduledWorkScheduler = {
        start: vi.fn(async () => undefined),
        dispose: vi.fn(),
        upsert: vi.fn(async () => { throw new Error("not used"); }),
        cancel: vi.fn(async () => null),
        setSchedulePaused: vi.fn(async () => null),
        setSessionPaused: vi.fn(async () => undefined),
        refreshGlobalPause: vi.fn(async () => undefined),
        list: vi.fn(() => []),
        isSessionPaused: vi.fn(() => false),
        nextWakeAt: vi.fn((sessionId: string) => {
          if (sessionId === brokenSessionId) throw new Error("malformed scheduled-work row");
          return null;
        }),
        claimNativeFire: vi.fn(() => null),
        recordTurnStarted: vi.fn(async () => undefined),
        recordTurnFinished: vi.fn(async () => undefined),
      };
      const { service, logger } = createService({
        createScheduledWorkScheduler: () => scheduledWorkScheduler,
      });

      const broken = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
      });
      brokenSessionId = broken.id;
      const healthy = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      writePersistedChatState(broken.id, {
        ...readPersistedChatState(broken.id),
        awaitingInput: true,
      });

      await expect(service.listSessions()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: broken.id,
          awaitingInput: true,
          scheduledWork: [],
          nextWakeAt: null,
        }),
        expect.objectContaining({
          sessionId: healthy.id,
        }),
      ]));
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.scheduled_work_summary_failed",
        expect.objectContaining({
          sessionId: broken.id,
          error: "malformed scheduled-work row",
        }),
      );
    });
  });

  describe("ensureIdentitySession", () => {
    it("hosts canonical identity sessions on the primary lane", async () => {
      // With no stored preference the CTO now starts on Claude rather than on
      // OpenCode, which it could never steer mid-turn. The file-wide
      // mapPermissionToClaude mock collapses every mode to "plan", so map it
      // properly here or the pinned full-auto is unobservable.
      vi.mocked(mapPermissionToClaude).mockImplementation((mode) => {
        if (mode === "full-auto") return "bypassPermissions";
        if (mode === "edit") return "acceptEdits";
        if (mode === "default") return "default";
        return "plan";
      });
      const { service } = createService();

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(session.laneId).toBe("lane-1");
      expect(session.provider).toBe("claude");
      expect(session.permissionMode).toBe("full-auto");
    });

    it("reuses a foreign-lane CTO session and rebinds it onto the canonical lane", async () => {
      // The CTO is a single project-level thread (D5): a session left on a
      // non-canonical lane must be reused and rebound to the canonical lane
      // rather than forking a second parallel thread.
      const { service, sessionService } = createService();

      const legacy = await service.createSession({
        laneId: "lane-2",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        identityKey: "cto",
      });

      const canonical = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(canonical.id).toBe(legacy.id);
      expect(canonical.laneId).toBe("lane-1");
      expect(sessionService.get(legacy.id)?.laneId).toBe("lane-1");
      expect(sessionService.get(legacy.id)?.status).not.toBe("ended");

      const reused = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(reused.id).toBe(canonical.id);
      expect(reused.laneId).toBe("lane-1");
    });

    it("pins CTO execution state to the primary lane even when a foreign lane is requested", async () => {
      vi.mocked(runGit).mockImplementation(async (_args, opts) => ({
        stdout: String(opts?.cwd ?? "").includes(path.join(tmpRoot, "lane-2")) ? "lane-2-sha\n" : "lane-1-sha\n",
        stderr: "",
        exitCode: 0,
      }));

      const { service, sessionService } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(sessionService.setHeadShaStart).toHaveBeenLastCalledWith(session.id, "lane-1-sha");
    });

    it("ignores native provider permission overrides for pinned identities on create", async () => {
      const { service } = createService();
      // Callers over IPC could previously pass through `claudePermissionMode:
      // "plan"` to keep a CTO session from ever running automatically — the
      // identity pin must strip these so full-auto still wins.
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-4-7",
        modelId: "claude-sonnet-4-7",
        identityKey: "cto",
        claudePermissionMode: "plan",
        interactionMode: "plan",
      });

      // `plan` must never be persisted on the claude native fields for a
      // pinned identity — otherwise the runtime will ignore full-auto at turn
      // start. We do not assert on the synthesized permissionMode here because
      // the top-level mock for mapPermissionToClaude collapses to "plan" in
      // this test file; the native fields are the real source of truth the
      // runtime consults.
      expect(session.claudePermissionMode).not.toBe("plan");
      expect(session.interactionMode).not.toBe("plan");
    });

    it("ignores native codex permission overrides for the CTO identity on create", async () => {
      // Locally map modes so full-auto => danger-full-access / never and the
      // default mapping (used when no permissionMode is passed) stays on the
      // on-request / read-only baseline. This lets us prove the IPC-provided
      // `codexApprovalPolicy: "untrusted"` / `codexSandbox: "read-only"` never
      // land on the session — the full-auto derivation is used instead.
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
        modelId: "gpt-5-codex",
        identityKey: "cto",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
      });

      expect(session.codexApprovalPolicy).toBe("never");
      expect(session.codexSandbox).toBe("danger-full-access");
    });

    it("ignores native permission overrides for pinned identities on update", async () => {
      const { service } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });
      const claudeBefore = session.claudePermissionMode;
      const opencodeBefore = session.opencodePermissionMode;

      const updated = await service.updateSession({
        sessionId: session.id,
        claudePermissionMode: "plan",
        interactionMode: "plan",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        opencodePermissionMode: "plan",
      });

      // None of the stricter native modes should have landed on the session.
      expect(updated.interactionMode).not.toBe("plan");
      if (claudeBefore !== undefined) {
        expect(updated.claudePermissionMode).toBe(claudeBefore);
      }
      if (opencodeBefore !== undefined) {
        expect(updated.opencodePermissionMode).toBe(opencodeBefore);
      }
      expect(updated.codexApprovalPolicy).not.toBe("untrusted");
      expect(updated.codexSandbox).not.toBe("read-only");
    });
  });

  describe("CTO memory + model-switch-safe thread", () => {
    async function createCtoServices({ seedIntro = false }: { seedIntro?: boolean } = {}) {
      const adeDir = path.join(tmpRoot, ".ade");
      fs.mkdirSync(adeDir, { recursive: true });
      const db = await openKvDb(path.join(adeDir, "ade.db"), createLogger() as any);
      const ctoMemoryService = createCtoMemoryService({ adeDir });
      const ctoStateService = createCtoStateService({
        db,
        projectId: "project-test",
        adeDir,
        ctoMemoryService,
      });
      if (seedIntro) {
        // The opening turn is dispatched for real, so it needs a runtime stream.
        vi.mocked(streamText).mockReturnValue({
          fullStream: (async function* () {
            yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
          })(),
        } as any);
      } else {
        // Creating a CTO session dispatches its opening turn. Tests that are not
        // about the intro must opt out: the send is fire-and-forget, so it would
        // otherwise outlive the test and hit a `streamText` mock that beforeEach
        // has already reset — surfacing as an unhandled rejection.
        ctoStateService.completeOnboardingStep("intro");
      }
      return { db, ctoStateService, ctoMemoryService };
    }

    /**
     * The escape hatch from a wedged thread. The owner's CTO chat crossed its
     * context limit by ordinary accumulation over twenty sessions, every turn
     * failed with "Prompt is too long", and the fallback compaction refused —
     * so the only way out is a new thread that does not arrive amnesiac.
     */
    it("starts a fresh CTO thread while identity, memory and History all survive", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });

      ctoStateService.updateIdentity({ name: "Ada" });
      ctoMemoryService.appendMemoryFact("We ship on Fridays.");
      const first = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });

      const result = await service.startFreshIdentitySession({ identityKey: "cto", laneId: "lane-1" });

      // A NEW conversation, and the old one named rather than forgotten.
      expect(result.session.id).not.toBe(first.id);
      expect(result.previousSessionId).toBe(first.id);
      expect(result.session.identityKey).toBe("cto");

      // Nothing the CTO remembers was touched.
      expect(ctoStateService.getIdentity().name).toBe("Ada");
      expect(ctoMemoryService.readMemory()).toContain("We ship on Fridays.");

      // The retired thread lands in History with its own row.
      expect(ctoStateService.getSessionLogs(20).some((entry) => entry.sessionId === first.id)).toBe(true);

      // And the next ensure resolves to the NEW thread, not the retired one.
      const next = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      expect(next.id).toBe(result.session.id);

      db.close();
    });

    it("distils the outgoing thread into durable memory without asking a model", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const first = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      const result = await service.startFreshIdentitySession({ identityKey: "cto", laneId: "lane-1" });

      // No provider was reachable in this fixture, and that is the point: the
      // thread this feature exists for cannot take the turn that would write
      // its own note, so the deterministic distillation is the one that has to
      // work — and it did.
      expect(result.handoff).toMatchObject({ written: true, source: "deterministic" });

      // The note is durable, dated, and names the thread it came from.
      const memory = ctoMemoryService.readMemory();
      expect(memory).toContain("hand-off from retired CTO thread");
      expect(memory).toContain(first.id);

      // And the rolling working summary the next thread reads first was
      // refreshed from the same text.
      expect(ctoMemoryService.getSnapshot().threadState).toContain("Work still scheduled");

      db.close();
    });

    it("persists a CTO model switch back into identity model preferences", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });

      await service.updateSession({
        sessionId: session.id,
        modelId: "openai/gpt-5.5",
      });

      const prefs = ctoStateService.getIdentity().modelPreferences;
      expect(prefs?.modelId).toBe("openai/gpt-5.5");
      expect(prefs?.provider).toBe("codex");

      db.close();
    });

    it("clears the stored preference when the CTO lands on a provider that cannot steer a live turn", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });

      // OpenCode stages every mid-turn message, which is the one thing a CTO
      // thread cannot live with. The write is normalized away rather than kept,
      // so the surface falls back to its picker instead of silently running on
      // a model that would hold every child report until the turn ends.
      await service.updateSession({
        sessionId: session.id,
        modelId: "opencode/openai/gpt-5.2",
      });

      expect(ctoStateService.getIdentity().modelPreferences).toBeNull();

      db.close();
    });

    it("keeps CTO full access when a model switch crosses providers", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      try {
        const { service } = createService({ ctoStateService, ctoMemoryService });
        const session = await service.ensureIdentitySession({
          identityKey: "cto",
          laneId: "lane-1",
        });

        const updated = await service.updateSession({
          sessionId: session.id,
          modelId: "openai/gpt-5.5",
        });

        expect(updated.provider).toBe("codex");
        expect(updated.permissionMode).toBe("full-auto");
        expect(updated.codexApprovalPolicy).toBe("never");
        expect(updated.codexSandbox).toBe("danger-full-access");
        expect(ctoStateService.getIdentity().modelPreferences?.modelId).toBe("openai/gpt-5.5");
      } finally {
        db.close();
      }
    });

    it("injects durable memory into the CTO reconstruction context", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      ctoMemoryService.appendMemoryFact("The build long-pole is the Windows runner.");
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });

      // ensureIdentitySession refreshes the reconstruction context; the durable
      // memory fact must be present so it survives a fresh provider thread.
      const reconstruction = ctoStateService.buildReconstructionContext(8);
      expect(reconstruction).toContain("Durable memory (MEMORY.md)");
      expect(reconstruction).toContain("The build long-pole is the Windows runner.");
      expect(session.identityKey).toBe("cto");

      db.close();
    });

    /**
     * The CTO prefix is two halves with very different lifetimes, and only one
     * of them is worth re-sending. The immutable half (doctrine, the ADE
     * architecture document, the capability manifest) is ~21 KB that a live
     * provider thread already holds; re-staging it every turn grew a real CTO
     * thread from 46k to 237k input tokens in 18 turns and tripped Codex
     * auto-compaction mid-voice-call.
     */
    /**
     * One Claude SDK double for every test in this block, typed at the seam
     * rather than cast to `any` at each site: the handle shape is the contract
     * these tests depend on, and three hand-rolled copies of it drift.
     */
    function installClaudeSdkDouble(args: {
      sessionId: string;
      send: ReturnType<typeof vi.fn>;
      stream: ReturnType<typeof vi.fn>;
    }): void {
      const sdkHandle = {
        send: args.send,
        stream: args.stream,
        close: vi.fn(),
        sessionId: args.sessionId,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReturnType<typeof claudeSdkCreateSessionCompat>;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);
    }

    function mockClaudeCtoSdk() {
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-cto-prefix", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          session_id: "sdk-cto-prefix",
          message: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      installClaudeSdkDouble({ sessionId: "sdk-cto-prefix", send, stream });
      return send;
    }

    it("stages the CTO's immutable prefix once per provider thread and the volatile half every turn", async () => {
      const send = mockClaudeCtoSdk();
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });
      const turn = async (text: string): Promise<string> => {
        send.mockClear();
        await service.sendMessage({ sessionId: session.id, text });
        await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
        return String(send.mock.calls.at(-1)?.[0] ?? "");
      };

      const first = await turn("What is on fire?");
      expect(first).toContain("CTO Runtime Identity");
      expect(first).toContain("Immutable ADE doctrine");
      expect(first).toContain("ADE environment knowledge");
      expect(first).toContain("ADE Architecture");
      expect(first).toContain("CTO Context");

      // Turn two talks to the same Claude SDK session, which holds all of the
      // above verbatim. Only the perishable half rides again.
      const second = await turn("And now?");
      expect(second).not.toContain("CTO Runtime Identity");
      expect(second).not.toContain("Immutable ADE doctrine");
      expect(second).not.toContain("ADE Architecture");
      expect(second).toContain("CTO Context");
      expect(Buffer.byteLength(second)).toBeLessThan(Buffer.byteLength(first) / 2);

      // The other way the block goes stale is the prompt changing under a live
      // thread. That must re-stage on the very next turn rather than wait for a
      // rotation that may never come.
      ctoStateService.updateIdentity({ name: "Ada" });
      const third = await turn("Who are you?");
      expect(third).toContain("CTO Runtime Identity");
      expect(third).toContain("You are Ada.");

      const fourth = await turn("Carry on.");
      expect(fourth).not.toContain("CTO Runtime Identity");
      expect(fourth).toContain("CTO Context");

      service.forceDisposeAll();
      db.close();
    });

    it("re-stages the CTO's immutable prefix onto a thread that has never seen it", async () => {
      const send = mockClaudeCtoSdk();
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });
      const turn = async (sessionId: string, text: string): Promise<string> => {
        send.mockClear();
        await service.sendMessage({ sessionId, text });
        await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
        return String(send.mock.calls.at(-1)?.[0] ?? "");
      };

      expect(await turn(session.id, "First.")).toContain("CTO Runtime Identity");
      expect(await turn(session.id, "Second.")).not.toContain("CTO Runtime Identity");

      // A rotated thread is a model that has been told nothing. The
      // reconstruction context has to be complete again.
      const fresh = await service.startFreshIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      expect(fresh.session.id).not.toBe(session.id);
      const afterRotation = await turn(fresh.session.id, "Still there?");
      expect(afterRotation).toContain("CTO Runtime Identity");
      expect(afterRotation).toContain("ADE Architecture");
      expect(afterRotation).toContain("CTO Context");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * The doc claims the static block re-stages on "rotation, handoff, resume
     * onto a new thread, provider/model switch, fresh session". Rotation is
     * pinned above; these pin the rest, because every one of them is a claim
     * about a thread that has been told nothing, and an unpinned claim about a
     * ~21 KB block is how the CTO silently loses its own role on a provider.
     */
    it("re-stages the CTO's immutable prefix after a provider handoff", async () => {
      const send = mockClaudeCtoSdk();
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      send.mockClear();
      await service.sendMessage({ sessionId: session.id, text: "First." });
      await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
      expect(String(send.mock.calls.at(-1)?.[0] ?? "")).toContain("CTO Runtime Identity");

      send.mockClear();
      await service.sendMessage({ sessionId: session.id, text: "Second." });
      await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
      expect(String(send.mock.calls.at(-1)?.[0] ?? "")).not.toContain("CTO Runtime Identity");

      // The handoff moves the same ADE chat onto a codex thread that has never
      // heard a word of it — including the doctrine that makes it the CTO.
      mockState.codexRequestPayloads = [];
      await service.updateSession({ sessionId: session.id, modelId: "openai/gpt-5.5" });
      await service.sendMessage({ sessionId: session.id, text: "Still there?" });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStart = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const handedOff = JSON.stringify(turnStart?.params ?? {});
      expect(handedOff).toContain("CTO Runtime Identity");
      expect(handedOff).toContain("ADE Architecture");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * A restart wipes the in-memory staging, and the resumed chat may or may
     * not land on the same provider thread. Re-sending ~21 KB once after a
     * restart is the cheap side of that bet; leaving a thread believing it was
     * told its own doctrine is not.
     */
    it("re-stages the CTO's immutable prefix on a resume after a restart", async () => {
      const send = mockClaudeCtoSdk();
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      send.mockClear();
      await service.sendMessage({ sessionId: session.id, text: "First." });
      await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
      expect(String(send.mock.calls.at(-1)?.[0] ?? "")).toContain("CTO Runtime Identity");
      send.mockClear();
      await service.sendMessage({ sessionId: session.id, text: "Second." });
      await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
      expect(String(send.mock.calls.at(-1)?.[0] ?? "")).not.toContain("CTO Runtime Identity");
      service.forceDisposeAll();

      const resumed = createService({ ctoStateService, ctoMemoryService }).service;
      await resumed.resumeSession({ sessionId: session.id });
      send.mockClear();
      await resumed.runSessionTurn({ sessionId: session.id, text: "After the restart.", timeoutMs: 15_000 });
      const afterResume = String(send.mock.calls.at(-1)?.[0] ?? "");
      expect(afterResume).toContain("CTO Runtime Identity");
      expect(afterResume).toContain("CTO Context");

      resumed.forceDisposeAll();
      db.close();
    });

    /**
     * A same-provider model switch that keeps the SDK session is NOT a new
     * thread: the model on the other end still holds the doctrine verbatim, so
     * the block stays put. This is pinned because the obvious reading of "model
     * switch re-stages" would have it re-sent on every reasoning-tier change.
     */
    it("keeps the CTO's immutable prefix off a model switch that keeps the thread", async () => {
      const send = mockClaudeCtoSdk();
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      send.mockClear();
      await service.sendMessage({ sessionId: session.id, text: "First." });
      await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
      expect(String(send.mock.calls.at(-1)?.[0] ?? "")).toContain("CTO Runtime Identity");

      await service.updateSession({ sessionId: session.id, modelId: "anthropic/claude-opus-4-8" });
      send.mockClear();
      await service.sendMessage({ sessionId: session.id, text: "After the switch." });
      // The switch also fires an initialization probe on the same handle, so the
      // turn is found by its text rather than by being the last call.
      await vi.waitFor(() => {
        expect(send.mock.calls.some((call) => String(call[0] ?? "").includes("After the switch."))).toBe(true);
      });
      const afterSwitch = String(
        send.mock.calls.map((call) => String(call[0] ?? "")).find((text) => text.includes("After the switch.")) ?? "",
      );
      expect(afterSwitch).toContain("CTO Context");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * A provider-side conversation reset opens a brand-new Claude conversation
     * under the SAME runtime handle. Nothing the staging looks at moves — the
     * handle is the thread's identity of last resort — so the doctrine that
     * makes this thread the CTO was never re-sent, and it went on answering as
     * a generic coding agent with nothing in the product saying so.
     */
    it("re-stages the CTO's immutable prefix after a provider-side conversation reset", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let emitConversationReset = false;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-cto-reset-1", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (emitConversationReset) {
          emitConversationReset = false;
          // Claude discarded the conversation and named its replacement.
          yield { type: "conversation_reset", new_conversation_id: "sdk-cto-reset-2" };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          session_id: "sdk-cto-reset-1",
          message: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      installClaudeSdkDouble({ sessionId: "sdk-cto-reset-1", send, stream });

      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });
      const turn = async (text: string): Promise<string> => {
        send.mockClear();
        await service.sendMessage({ sessionId: session.id, text });
        await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
        return String(send.mock.calls.at(-1)?.[0] ?? "");
      };

      expect(await turn("What is on fire?")).toContain("CTO Runtime Identity");
      expect(await turn("And now?")).not.toContain("CTO Runtime Identity");

      // This turn is the one the provider resets under.
      emitConversationReset = true;
      await turn("Carry on.");
      await vi.waitFor(() => { expect(emitConversationReset).toBe(false); });

      const afterReset = await turn("Who are you?");
      expect(afterReset).toContain("CTO Runtime Identity");
      expect(afterReset).toContain("ADE Architecture");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * The other way a Claude thread ends under us: not a reset the provider
     * announces, but a resume onto a thread that is simply gone. The recovery
     * clears the SDK session id and the next send opens a brand new
     * conversation — which has been told none of the doctrine.
     */
    it("re-stages the CTO's immutable prefix after Claude's thread goes missing", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let failWithMissingThread = false;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-cto-missing", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (failWithMissingThread) {
          failWithMissingThread = false;
          throw new Error("No conversation found with session ID sdk-cto-missing");
        }
        yield {
          type: "assistant",
          session_id: "sdk-cto-missing",
          message: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      installClaudeSdkDouble({ sessionId: "sdk-cto-missing", send, stream });

      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });
      const turn = async (text: string): Promise<string> => {
        send.mockClear();
        await service.sendMessage({ sessionId: session.id, text });
        await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
        return String(send.mock.calls.at(-1)?.[0] ?? "");
      };

      expect(await turn("What is on fire?")).toContain("CTO Runtime Identity");
      expect(await turn("And now?")).not.toContain("CTO Runtime Identity");

      // The turn the thread goes missing under. It fails, and the recovery runs.
      failWithMissingThread = true;
      try {
        await service.sendMessage({ sessionId: session.id, text: "Carry on." });
      } catch {
        // The failure is the point; the recovery is what is under test.
      }
      await vi.waitFor(() => { expect(failWithMissingThread).toBe(false); });

      // The chat is now parked on a recovery card; reconnecting is what the
      // user presses. Whatever thread that lands on has heard nothing.
      await service.recoverContinuity({ sessionId: session.id, mode: "retry_original" });

      const afterRecovery = await turn("Who are you?");
      expect(afterRecovery).toContain("CTO Runtime Identity");
      expect(afterRecovery).toContain("ADE Architecture");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * Droid can hand back a DIFFERENT session id on a re-ready of a runtime
     * that otherwise survived — same handle, new conversation on the other end.
     * Nothing else watches the id, so nothing else would notice.
     */
    it("re-stages the CTO's immutable prefix when Droid re-readies onto a new session id", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
        identityKey: "cto",
      });
      const turn = async (text: string): Promise<string> => {
        const before = mockState.droidPromptCalls.length;
        await service.sendMessage({ sessionId: session.id, text });
        await vi.waitFor(() => {
          expect(mockState.droidPromptCalls.length).toBeGreaterThan(before);
        });
        return String(mockState.droidPromptCalls.at(-1)?.promptText ?? "");
      };

      expect(await turn("What is on fire?")).toContain("CTO Runtime Identity");
      expect(await turn("And now?")).not.toContain("CTO Runtime Identity");

      // Same pooled connection, new conversation id.
      const pooled = mockState.droidPooled;
      pooled.bridge.onReady?.({
        sessionId: "droid-sdk-session-re-readied",
        currentModelId: pooled.currentModelId,
        availableModels: [],
      });

      expect(await turn("Who are you?")).toContain("CTO Runtime Identity");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * The tail rule, on the provider whose thread id lives on the session
     * rather than in a runtime handle. A live intact codex thread holds the
     * conversation verbatim; replaying 40 turns of it every send is what walks
     * a long CTO thread into auto-compaction.
     */
    it("sends no conversation tail to a live intact codex thread", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        identityKey: "cto",
      });

      mockState.codexRequestPayloads = [];
      const turnStarts = () => mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start");
      // The mock names turns `turn-<n>`; settling one is what lets the next
      // send start a turn of its own rather than steer into the live one.
      const settleCodexTurn = (index: number): void => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { turn: { id: `turn-${index}`, status: "completed" } },
        });
      };

      await service.sendMessage({ sessionId: session.id, text: "What is on fire?" });
      await vi.waitFor(() => { expect(turnStarts().length).toBeGreaterThanOrEqual(1); });
      settleCodexTurn(mockState.codexTurnCounter);

      // Turn two is the one send that can still carry the tail: the thread was
      // armed while it had no name and turn one had no conversation to put in
      // it, and arming is sticky until a send actually delivers the section.
      await service.sendMessage({ sessionId: session.id, text: "And now?" });
      await vi.waitFor(() => { expect(turnStarts().length).toBeGreaterThanOrEqual(2); });
      settleCodexTurn(mockState.codexTurnCounter);

      await service.sendMessage({ sessionId: session.id, text: "Carry on." });
      await vi.waitFor(() => { expect(turnStarts().length).toBeGreaterThanOrEqual(3); });
      const third = JSON.stringify(turnStarts()[2]?.params ?? {});
      expect(third).toContain("Carry on.");
      expect(third).not.toContain("Recent Conversation Tail");
      // And the doctrine does not ride again either — same thread, same rule.
      expect(third).not.toContain("CTO Runtime Identity");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * `runSessionTurn` is the headless path, and the CTO voice's `ask_cto`
     * turns run on it. It used to skip `refreshCtoLiveStateForTurn` entirely,
     * so a voice turn reached the model with whatever live state the last
     * interactive send left behind — and with no reconstruction context at all
     * once that send had consumed it. Stale lanes/PRs/dirty flags are worse
     * than none here, because the doctrine tells the CTO not to re-derive them.
     */
    it("refreshes the CTO's live state on the headless turn path too", async () => {
      const send = mockClaudeCtoSdk();
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const refreshLiveState = vi.spyOn(ctoStateService, "refreshLiveState");
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      // Turn one goes through the interactive path and stages everything.
      send.mockClear();
      await service.sendMessage({ sessionId: session.id, text: "What is on fire?" });
      await vi.waitFor(() => { expect(send).toHaveBeenCalled(); });
      expect(String(send.mock.calls.at(-1)?.[0] ?? "")).toContain("CTO Runtime Identity");

      // Turn two is headless, on the same intact thread.
      refreshLiveState.mockClear();
      send.mockClear();
      await service.runSessionTurn({ sessionId: session.id, text: "And now?", timeoutMs: 15_000 });
      const headless = String(send.mock.calls.at(-1)?.[0] ?? "");

      expect(refreshLiveState).toHaveBeenCalled();
      // The volatile half rides the headless turn exactly as it rides an
      // interactive one.
      expect(headless).toContain("CTO Context");
      expect(headless).toContain("Current working context");
      // And the thread is intact, so the immutable half does not ride again.
      expect(headless).not.toContain("CTO Runtime Identity");
      expect(headless).not.toContain("ADE Architecture");

      service.forceDisposeAll();
      db.close();
    });

    /**
     * The tempting shortcut is "codex already gets the doctrine in its
     * developer instructions, so skip the thread item entirely". It does not:
     * `buildCodexDeveloperInstructions` builds the generic coding-agent prompt,
     * and the CTO doctrine and capability manifest exist in exactly one place —
     * the static context block. Dropping it for codex would have silently taken
     * the CTO's whole role away on that provider.
     */
    it("does not carry the CTO doctrine in codex developer instructions", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        identityKey: "cto",
      });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({ sessionId: session.id, text: "What is on fire?" });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const developerInstructions = String(
        (threadStart?.params as Record<string, unknown> | undefined)?.developerInstructions ?? "",
      );
      expect(developerInstructions.length).toBeGreaterThan(0);
      expect(developerInstructions).not.toContain("Immutable ADE doctrine");
      expect(developerInstructions).not.toContain("ADE operator tools");

      const turnStart = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect(JSON.stringify(turnStart?.params ?? {})).toContain("CTO Runtime Identity");

      service.forceDisposeAll();
      db.close();
    });

    // A freshly created CTO thread used to open on a blank screen. It now seeds
    // one real, visible first turn. The flag lives in onboarding state so it
    // survives restarts and cannot fire twice.
    it("seeds a visible intro turn when the CTO thread is first created", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices({ seedIntro: true });
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const session = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });

      await waitForCondition(
        () => ctoStateService.getOnboardingState().completedSteps.includes("intro"),
        "CTO intro turn to be seeded",
      );

      // The turn is a real, visible user message — not a fabricated assistant
      // entry — so it must show up in the transcript as the user's own text.
      const { entries } = await service.getChatTranscript({ sessionId: session.id });
      const introTurns = entries.filter(
        (entry) => entry.role === "user" && entry.text.includes("Introduce yourself"),
      );
      expect(introTurns).toHaveLength(1);

      db.close();
    });

    it("does not re-seed the intro turn when an existing CTO thread is reused", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices({ seedIntro: true });
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const first = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      await waitForCondition(
        () => ctoStateService.getOnboardingState().completedSteps.includes("intro"),
        "CTO intro turn to be seeded",
      );

      const reused = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      expect(reused.id).toBe(first.id);

      // Assert on dispatched turns, not the onboarding marker:
      // completeOnboardingStep is idempotent, so a marker count would hold even
      // if a second intro were sent. A reused thread already has content, so a
      // second opening turn would land mid-conversation.
      const { entries } = await service.getChatTranscript({ sessionId: reused.id });
      const introTurns = entries.filter(
        (entry) => entry.role === "user" && entry.text.includes("Introduce yourself"),
      );
      expect(introTurns).toHaveLength(1);

      db.close();
    });

    /**
     * A scheduler stand-in that actually stores rows, so "was a second job
     * created?" is answerable from state rather than from a call count alone.
     */
    function createRecordingScheduler() {
      const rows: Array<Record<string, unknown>> = [];
      return {
        rows,
        start: vi.fn(async () => undefined),
        dispose: vi.fn(),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          rows.push(row);
          return { ...row, status: "scheduled", pausedFlag: false, lateFlag: false };
        }),
        cancel: vi.fn(async (id: string) => {
          const index = rows.findIndex((row) => row.id === id);
          return index === -1 ? null : rows.splice(index, 1)[0];
        }),
        setSchedulePaused: vi.fn(async (id: string, paused: boolean) => {
          const row = rows.find((entry) => entry.id === id);
          if (!row) return null;
          row.status = paused ? "paused" : "scheduled";
          row.pausedFlag = paused;
          return row;
        }),
        setSessionPaused: vi.fn(async () => undefined),
        refreshGlobalPause: vi.fn(async () => undefined),
        list: vi.fn(() => rows),
        isSessionPaused: vi.fn(() => false),
        nextWakeAt: vi.fn(() => null),
        claimNativeFire: vi.fn(() => null),
        recordTurnStarted: vi.fn(async () => undefined),
        recordTurnFinished: vi.fn(async () => undefined),
      };
    }

    it("arms one nightly memory gardener on first CTO use and announces it", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const scheduler = createRecordingScheduler();
      const { service } = createService({
        ctoStateService,
        ctoMemoryService,
        createScheduledWorkScheduler: () => scheduler,
      });

      const session = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });

      expect(scheduler.upsert).toHaveBeenCalledTimes(1);
      expect(scheduler.rows[0]).toMatchObject({
        sessionId: session.id,
        kind: "cron",
        cron: "30 3 * * *",
        reason: "Nightly memory gardening",
        durable: true,
      });
      // No TTL: a job that cancelled itself after a week would be worse than
      // no job at all.
      expect(scheduler.rows[0].expiresAt).toBeUndefined();
      expect(String(scheduler.rows[0].prompt)).toContain("Nightly memory gardening");

      // It is pausable from Chat Info, which reads the same scheduler rows.
      const state = await service.getScheduledWorkState({ sessionId: session.id });
      expect(state.items.map((item) => item.title)).toContain("Nightly memory gardening");

      // One system line naming the job, in the CTO thread.
      const history = await service.getChatEventHistory(session.id, { maxEvents: 50 });
      const notices = history.events.filter((entry) =>
        entry.event.type === "system_notice"
        && entry.event.message.includes("Nightly memory gardening"));
      expect(notices).toHaveLength(1);

      db.close();
    });

    it("never arms a second gardener when the CTO thread is reopened", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const scheduler = createRecordingScheduler();
      const { service } = createService({
        ctoStateService,
        ctoMemoryService,
        createScheduledWorkScheduler: () => scheduler,
      });

      const first = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      const reused = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-2" });

      expect(reused.id).toBe(first.id);
      expect(scheduler.upsert).toHaveBeenCalledTimes(1);
      expect(scheduler.rows).toHaveLength(1);

      db.close();
    });

    // The whole reason the marker is the idempotency key rather than the row's
    // presence: a presence check would quietly overrule the user.
    it("respects a paused or deleted gardener instead of silently re-arming it", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const scheduler = createRecordingScheduler();
      const { service } = createService({
        ctoStateService,
        ctoMemoryService,
        createScheduledWorkScheduler: () => scheduler,
      });

      const session = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      const scheduleId = String(scheduler.rows[0].id);

      // The user pauses it from Chat Info.
      await scheduler.setSchedulePaused(scheduleId, true);
      await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      expect(scheduler.upsert).toHaveBeenCalledTimes(1);
      expect(scheduler.rows[0].status).toBe("paused");

      // The user deletes it outright.
      await scheduler.cancel(scheduleId);
      expect(scheduler.rows).toHaveLength(0);
      await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      expect(scheduler.upsert).toHaveBeenCalledTimes(1);
      expect(scheduler.rows).toHaveLength(0);
      expect(session.identityKey).toBe("cto");

      db.close();
    });

    // The CTO chat is filtered out of every session roster, so it never reaches
    // `terminalAttention` or the dock badge. `getCtoAttention` is the only thing
    // standing between a hidden thread and a silently unanswered question.
    describe("getCtoAttention", () => {
      it("reports idle without creating a CTO session or a primary lane", async () => {
        const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
        const { service, sessionService } = createService({ ctoStateService, ctoMemoryService });

        const before = sessionService.list({}).length;
        const attention = await service.getCtoAttention();

        expect(attention).toEqual({ status: "idle", awaitingInput: false, since: null });
        // The invariant that matters: drawing a badge must not materialize a
        // lane and a chat session as a side effect.
        expect(sessionService.list({}).length).toBe(before);

        db.close();
      });

      it("reports awaiting input when the CTO thread raises a hand", async () => {
        const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
        const { service, sessionService } = createService({ ctoStateService, ctoMemoryService });
        const session = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });

        expect(await service.getCtoAttention()).toEqual({ status: "idle", awaitingInput: false, since: null });

        // `ade chat ask` raises a hand on the backing session row — a separate
        // signal from the chat-level `awaitingInput` waiter, and the one a
        // hidden thread would otherwise have no way to surface.
        const row = sessionService.get(session.id)!;
        expect(row, "CTO session row").toBeTruthy();
        row.attentionRequestedAt = new Date().toISOString();
        const attention = await service.getCtoAttention();

        expect(attention.status).toBe("awaiting-input");
        expect(attention.awaitingInput).toBe(true);
        expect(attention.since).toBeTruthy();

        db.close();
      });

      it("clears once the hand-raise is resolved", async () => {
        const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
        const { service, sessionService } = createService({ ctoStateService, ctoMemoryService });
        const session = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });

        const row = sessionService.get(session.id)!;
        expect(row, "CTO session row").toBeTruthy();
        row.attentionRequestedAt = new Date().toISOString();
        expect((await service.getCtoAttention()).awaitingInput).toBe(true);

        row.attentionRequestedAt = null;
        const attention = await service.getCtoAttention();

        expect(attention.status).toBe("idle");
        expect(attention.awaitingInput).toBe(false);
        expect(attention.since).toBeNull();

        db.close();
      });

      it("reports unknown instead of falsely clearing when the session scan fails", async () => {
        const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
        const { service, sessionService } = createService({ ctoStateService, ctoMemoryService });
        vi.spyOn(sessionService, "list").mockImplementationOnce(() => {
          throw new Error("temporary session store failure");
        });

        await expect(service.getCtoAttention()).resolves.toEqual({
          status: "unknown",
          awaitingInput: false,
          since: null,
        });

        db.close();
      });
    });
  });

  describe("identity continuity", () => {
    it("replays persisted continuity context after resuming an identity session", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall <= 2) {
          yield {
            type: "system",
            subtype: "init",
            session_id: `sdk-session-${streamCall}`,
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
            content: [{ type: "text", text: "Acknowledged" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      const sdkHandle = {
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, {
        ...persisted,
        continuitySummary: "- Keep runtime cache state machine-local.",
        continuitySummaryUpdatedAt: new Date().toISOString(),
        recentConversationEntries: [
          { role: "user", text: "What lane should frontend use?" },
          { role: "assistant", text: "Use the primary-hosted coordinator first." },
        ],
      });

      const resumed = createService().service;
      await resumed.resumeSession({ sessionId: session.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
      send.mockClear();

      const result = await resumed.runSessionTurn({
        sessionId: session.id,
        text: "What should we do next?",
        timeoutMs: 15_000,
      });

      expect(result.sessionId).toBe(session.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Continuity Summary"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Keep runtime cache state machine-local."));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("User: What lane should frontend use?"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Assistant: Use the primary-hosted coordinator first."));
    });

    it("reconstructs recent conversation tail for non-identity Claude sessions after resume", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-non-identity",
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
          session_id: "sdk-session-non-identity",
          message: {
            content: [{ type: "text", text: "We should keep the lane state intact." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      const sdkHandle = {
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-non-identity",
        setPermissionMode,
      } as any;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, {
        ...persisted,
        recentConversationEntries: [
          { role: "user", text: "Can you keep the lane warm?" },
          { role: "assistant", text: "Yes, I will keep the lane session alive." },
        ],
      });

      const resumed = createService().service;
      await resumed.resumeSession({ sessionId: session.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
      send.mockClear();

      const result = await resumed.runSessionTurn({
        sessionId: session.id,
        text: "What changed?",
        timeoutMs: 15_000,
      });

      expect(result.sessionId).toBe(session.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Recent Conversation Tail"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("User: Can you keep the lane warm?"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Assistant: Yes, I will keep the lane session alive."));
      expect(send).not.toHaveBeenCalledWith(expect.stringContaining("Continuity Summary"));

      // The tail is re-orientation for a thread that never saw those turns. The
      // SDK session is unchanged now, so it holds the conversation verbatim and
      // replaying the tail again is pure duplicated input tokens.
      send.mockClear();
      await resumed.runSessionTurn({
        sessionId: session.id,
        text: "And now?",
        timeoutMs: 15_000,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalledWith(expect.stringContaining("Recent Conversation Tail"));
    });

    it("recreates Claude sessions fresh when a resumed SDK session rejects bypassPermissions", async () => {
      let initialStreamCall = 0;
      const initialSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          initialStreamCall += 1;
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-initial",
            slash_commands: [],
          };
          if (initialStreamCall > 1) {
            yield {
              type: "assistant",
              session_id: "sdk-initial",
              message: {
                content: [{ type: "text", text: "Primed" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
          }
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-initial",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(initialSession as any);

      const scheduledWork = createScheduledWorkDb();
      const { service, sessionService } = createService({ db: scheduledWork.db });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "prime",
        timeoutMs: 15_000,
      });
      const persistedAfterPrime = readPersistedChatState(session.id);
      expect(persistedAfterPrime.lastLaneDirectiveKey).toBeTruthy();
      await service.dispose({ sessionId: session.id });
      sessionService.reopen(session.id);

      writePersistedChatState(session.id, {
        ...persistedAfterPrime,
        sdkSessionId: "sdk-stale",
        lastLaneDirectiveKey: persistedAfterPrime.lastLaneDirectiveKey,
        claudePermissionMode: "bypassPermissions",
        permissionMode: "full-auto",
      });
      scheduledWork.db.setJson(SCHEDULED_WORK_STATE_KEY, {
        version: 1,
        schedules: [storedWakeup(session.id, {
          provider: "claude",
          providerSessionId: "sdk-stale",
          providerScheduleId: "provider-stale-wakeup",
          durable: true,
        })],
        pausedSessionIds: [],
      });

      const staleSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(),
        close: vi.fn(),
        sessionId: "sdk-stale",
        setPermissionMode: vi.fn().mockRejectedValue(new Error("mode rejected")),
      };
      const freshSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-fresh",
            slash_commands: [],
          };
          yield {
            type: "assistant",
            session_id: "sdk-fresh",
            message: {
              content: [{ type: "text", text: "Recovered" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-fresh",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(claudeSdkResumeSessionCompat).mockReset();
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(staleSession as any);
      vi.mocked(claudeSdkCreateSessionCompat).mockReset();
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(freshSession as any);

      const resumed = createService({ db: scheduledWork.db }).service;
      await resumed.resumeSession({ sessionId: session.id });
      const result = await resumed.runSessionTurn({
        sessionId: session.id,
        text: "continue",
        timeoutMs: 15_000,
      });

      expect(result.outputText).toContain("Recovered");
      expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(
        "sdk-stale",
        expect.objectContaining({ resume: "sdk-stale" }),
      );
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalledWith(expect.objectContaining({
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      }));
      expect(staleSession.close).toHaveBeenCalled();
      expect(freshSession.send).toHaveBeenCalled();
      expect(readPersistedChatState(session.id).sdkSessionId).toBe("sdk-fresh");
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          providerSessionId: "sdk-stale",
          status: "paused",
          pausedFlag: true,
        }),
      ]);
    });

    it("persists a continuity snapshot and requires explicit recovery after identity session reset errors", async () => {
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const recoverySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let primaryStreamCall = 0;
      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
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
            session_id: "sdk-session-1",
            message: {
              content: [{ type: "text", text: "Partial answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          throw new Error("session expired");
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      const recoverySession = {
        send: recoverySend,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-2",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-2",
        setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat)
        .mockReturnValueOnce(primarySession as any)
        .mockReturnValueOnce(recoverySession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Please keep the runtime bridge state private.",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const persisted = readPersistedChatState(session.id);
      expect(result.outputText).toContain("Partial answer");
      expect(persisted.sdkSessionId).toBeUndefined();
      expect(persisted.continuityRecovery).toMatchObject({
        state: "required",
        reason: "thread_missing",
        provider: "claude",
        originalThreadId: expect.any(String),
      });
      expect(persisted.continuitySummary).toContain("Recent continuity snapshot:");
      expect(persisted.continuitySummary).toContain("User: Please keep the runtime bridge state private.");
      expect(persisted.continuitySummary).toContain("Assistant: Partial answer");
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
      expect(recoverySend).not.toHaveBeenCalled();
    });

    it("keeps continuity compaction scoped to identity sessions", async () => {
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const recoverySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let primaryStreamCall = 0;
      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
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
            session_id: "sdk-session-1",
            message: {
              content: [{ type: "text", text: "Partial answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          throw new Error("session expired");
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      const recoverySession = {
        send: recoverySend,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-2",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-2",
        setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat)
        .mockReturnValueOnce(primarySession as any)
        .mockReturnValueOnce(recoverySession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Please keep the bridge state private.",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const persisted = readPersistedChatState(session.id);
      expect(result.outputText).toContain("Partial answer");
      expect(persisted.continuitySummary).toBeUndefined();
      expect(persisted.continuityRecovery).toMatchObject({ state: "required", provider: "claude" });
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
      expect(recoverySend).not.toHaveBeenCalled();
    });
  });
});
