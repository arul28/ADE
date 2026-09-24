import {
  AgentChatEventEnvelope,
  EventEmitter,
  buildCodingAgentSystemPrompt,
  claudeInputText,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  claudeSdkSession,
  clearOpenCodeInventoryCache,
  createAgentChatService,
  createDynamicOpenCodeModelDescriptor,
  createDynamicPiModelDescriptor,
  createMockSessionService,
  createSdkMcpServer,
  createService,
  createTurnUsageLedger,
  createTurnUsageLedgerStore,
  detectAllAuth,
  detectCliAuthStatuses,
  fs,
  getDefaultModelDescriptor,
  installClaudeResponseFixture,
  isOpenCodeExternalDirectoryInsideAdeRoot,
  loadExternalSessionEvents,
  loadQwenUserSettings,
  makeDefaultClaudeSession,
  makeLaneLinearIssue,
  makeLinearIssueContextAttachment,
  mapPermissionToCodex,
  mockState,
  os,
  path,
  peekOpenCodeInventoryCache,
  probeOpenCodeProviderInventory,
  query,
  readPersistedChatState,
  replaceDynamicOpenCodeModelDescriptors,
  replaceDynamicPiModelDescriptors,
  runClaudeStreamFixture,
  spawn,
  startOpenCodeSession,
  startup,
  streamText,
  tagSession,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  waitForEvent,
  writePersistedChatState,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

async function settleDirectiveBookkeeping(): Promise<void> {
  // `runSessionTurn`'s collector resolves on the turn's `done` event, which is
  // emitted inside the provider run; the directive keys are marked when that run
  // returns. A macrotask yield lets the run's promise chain finish so the next
  // send sees the marked key. Not a wall-clock wait — nothing is being timed.
  await new Promise<void>((resolve) => setImmediate(resolve));
}


describe("createAgentChatService", () => {
  it("uses the injected GitHub service to enrich smart-link previews", async () => {
    const getIssue = vi.fn().mockResolvedValue({ title: "Keep desktop previews consistent" });
    const { service } = createService({ githubService: { getIssue } });

    await expect(service.resolveSmartLinkPreview({
      url: "https://github.com/arul28/ADE/pull/987654321",
    })).resolves.toMatchObject({
      kind: "github_pr",
      title: "Keep desktop previews consistent",
    });
    expect(getIssue).toHaveBeenCalledWith("arul28", "ADE", 987654321);
    service.forceDisposeAll();
  });

  describe("disk pressure enforcement", () => {
    it("fails an exhausted send without starting a provider turn", async () => {
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
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({ sessionId: session.id, text: "Start new work." });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start" || payload.method === "turn/start")).toBe(false);
      expect(events.find((entry) => entry.event.type === "error")?.event).toMatchObject({
        message: expect.stringContaining("almost out of storage"),
        errorInfo: { code: "disk_full" },
      });
      expect(events.some((entry) => entry.event.type === "status" && entry.event.turnStatus === "failed")).toBe(true);
      expect(events.some((entry) => entry.event.type === "done" && entry.event.status === "failed")).toBe(true);
      expect(events.filter((entry) => entry.event.type === "system_notice")).toHaveLength(1);
      expect(events.find((entry) => entry.event.type === "system_notice")?.event).toMatchObject({
        detail: { kind: "disk_pressure", state: "exhausted" },
      });
      service.forceDisposeAll();
    });

    it("blocks an exhausted send that would route to a steer on an active chat", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const canPerform = vi.fn(() => ({
        allowed: false,
        state: "exhausted" as const,
        code: "disk_full" as const,
        message: "Your computer is almost out of storage. ADE paused new agent work to protect your chats and projects. Free up space, then resume.",
      }));
      const { service } = createService({
        diskPressureMonitor: { canPerform },
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      // Make the session look active so routeActiveToSteer would otherwise
      // convert the send into a steer() that bypasses the disk gate.
      void service.runSessionTurn({ sessionId: session.id, text: "Kick off a long turn." }).catch(() => undefined);
      await vi.waitFor(() => expect(mockState.codexRequestPayloads.some((p) => p.method === "turn/start")).toBe(true));
      mockState.codexRequestPayloads = [];

      const result = await service.sendMessage(
        { sessionId: session.id, text: "Squeeze in more." },
        { routeActiveToSteer: true },
      );

      // The gate ran before routing, so no steer was issued and no new
      // provider work started.
      expect(result).toBeUndefined();
      expect(mockState.codexRequestPayloads.some((p) => p.method === "turn/start" || p.method === "turn/steer")).toBe(false);
      expect(events.some((entry) => entry.event.type === "system_notice"
        && typeof entry.event.detail === "object"
        && (entry.event.detail as { kind?: string }).kind === "disk_pressure")).toBe(true);
      service.forceDisposeAll();
    });

    it("does not steer /compact on an active Codex chat", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      void service.runSessionTurn({ sessionId: session.id, text: "Kick off a long turn." }).catch(() => undefined);
      await vi.waitFor(() => expect(mockState.codexRequestPayloads.some((p) => p.method === "turn/start")).toBe(true));
      mockState.codexRequestPayloads = [];

      await expect(service.sendMessage(
        { sessionId: session.id, text: "/compact" },
        { routeActiveToSteer: true },
      )).rejects.toThrow(/already active/i);
      expect(mockState.codexRequestPayloads.some((p) => p.method === "turn/steer" || p.method === "thread/compact/start")).toBe(false);
      service.forceDisposeAll();
    });

    it.each([
      ["warning monitor", { canPerform: vi.fn(() => ({ allowed: true, state: "warning" })) }],
      ["absent monitor", undefined],
    ])("lets a send proceed with an %s", async (_label, diskPressureMonitor) => {
      const { service } = createService({ diskPressureMonitor });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({ sessionId: session.id, text: "Proceed normally." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      service.forceDisposeAll();
    });
  });

  it("returns an object with all expected methods", () => {
    const { service } = createService();
    expect(service.createSession).toBeTypeOf("function");
    expect(service.importExternalChatSession).toBeTypeOf("function");
    expect(service.handoffSession).toBeTypeOf("function");
    expect(service.prepareCrossMachineHandoff).toBeTypeOf("function");
    expect(service.preflightCrossMachineDestination).toBeTypeOf("function");
    expect(service.fastForwardCrossMachineHandoffLane).toBeTypeOf("function");
    expect(service.acceptCrossMachineHandoff).toBeTypeOf("function");
    expect(service.markCrossMachineHandoff).toBeTypeOf("function");
    expect(service.emitAdeCard).toBeTypeOf("function");
    expect(service.sendMessage).toBeTypeOf("function");
    expect(service.steer).toBeTypeOf("function");
    expect(service.interrupt).toBeTypeOf("function");
    expect(service.resumeSession).toBeTypeOf("function");
    expect(service.listSessions).toBeTypeOf("function");
    expect(service.getSessionSummary).toBeTypeOf("function");
    expect(service.getTurnStatus).toBeTypeOf("function");
    expect(service.getChatTranscript).toBeTypeOf("function");
    expect(service.getChatTranscriptPage).toBeTypeOf("function");
    expect(service.ensureIdentitySession).toBeTypeOf("function");
    expect(service.approveToolUse).toBeTypeOf("function");
    expect(service.getAvailableModels).toBeTypeOf("function");
    expect(service.getSlashCommands).toBeTypeOf("function");
    expect(service.dispose).toBeTypeOf("function");
    expect(service.deleteSession).toBeTypeOf("function");
    expect(service.disposeAll).toBeTypeOf("function");
    expect(service.updateSession).toBeTypeOf("function");
    expect(service.warmupModel).toBeTypeOf("function");
    expect(service.listSubagents).toBeTypeOf("function");
    expect(service.getSessionCapabilities).toBeTypeOf("function");
    expect(service.cleanupStaleAttachments).toBeTypeOf("function");
    expect(service.setComputerUseArtifactBrokerService).toBeTypeOf("function");
  });

  it("reports a persisted terminal turn through the content-free settlement hook", async () => {
    installClaudeResponseFixture({
      sdkSessionId: "sdk-turn-settled",
      responseText: "Finished successfully.",
    });
    const onTurnSettled = vi.fn();
    const { service } = createService({ onTurnSettled });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "sonnet",
      surface: "work",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Complete the task.",
    });

    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    const settled = onTurnSettled.mock.calls[0]?.[0];
    expect(settled).toEqual({
      sessionId: session.id,
      turnId: expect.any(String),
      status: "completed",
      provider: "claude",
      sessionSurface: "work",
    });
    expect(Object.keys(settled).sort()).toEqual([
      "provider",
      "sessionId",
      "sessionSurface",
      "status",
      "turnId",
    ]);
    service.forceDisposeAll();
  });

  it("writes each settled turn to the usage ledger once, with the events it saw", async () => {
    installClaudeResponseFixture({
      sdkSessionId: "sdk-turn-ledger",
      responseText: "Finished successfully.",
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-turn-ledger-"));
    try {
      const store = createTurnUsageLedgerStore({ dir });
      const ledger = createTurnUsageLedger({ store });
      const observe = vi.spyOn(ledger, "observe");
      const { service } = createService({ turnUsageLedger: ledger });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        surface: "work",
      });

      await service.runSessionTurn({ sessionId: session.id, text: "Complete the task." });

      expect(observe).toHaveBeenCalled();
      // The harness mocks `node:readline` for the Codex app-server; the
      // ledger reads its month file line by line, so it gets a real reader.
      const readline = await import("node:readline");
      const createLineReader = (options: { input: AsyncIterable<string | Buffer> }) => ({
        on: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncIterator]: () => (async function* () {
          const chunks: string[] = [];
          for await (const chunk of options.input) chunks.push(String(chunk));
          for (const line of chunks.join("").split(/\r?\n/u)) yield line;
        })(),
      });
      vi.mocked(readline.createInterface).mockImplementationOnce(createLineReader as any);
      vi.mocked((readline as any).default.createInterface).mockImplementationOnce(createLineReader as any);
      const rows = await store.readTurns();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: session.id,
        provider: "claude",
        status: "completed",
        laneId: "lane-1",
        surface: "work",
      });
      expect(rows[0]?.key).toBe(`${session.id}:${rows[0]?.turnId}`);
      expect(rows[0]?.startedAt).toBeTruthy();
      service.forceDisposeAll();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // computer-use directive cadence
  // --------------------------------------------------------------------------

  describe("computer-use directive cadence", () => {
    const availableBackendStatus = {
      backends: [{
        name: "agent-browser",
        available: true,
        state: "installed",
        detail: "installed",
        supportedKinds: ["screenshot"],
      }],
      localFallback: { available: false },
    };

    function installAvailableBroker(service: ReturnType<typeof createService>["service"]): void {
      service.setComputerUseArtifactBrokerService({
        getBackendStatus: vi.fn(() => availableBackendStatus),
        listArtifacts: vi.fn(() => []),
        ingest: vi.fn(),
      } as any);
    }

    it("delivers the directive once, then suppresses it while the capability set holds", async () => {
      // The gate is a fingerprint of the rendered directive, and it is marked at
      // the dispatch commitment point — not in `prepareSendMessage` and not in
      // the local `/fast` handler. This is the regression guard for the bug
      // where the key was written only by `/fast`: a normal send never marked
      // it (so the directive rode every turn, the exact cost this gate exists to
      // remove) and a `/fast` first message suppressed it for the whole session.
      const fixture = installClaudeResponseFixture({ sdkSessionId: "sdk-cu-cadence", responseText: "ok" });
      const { service } = createService();
      installAvailableBroker(service);
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      await service.runSessionTurn({ sessionId: session.id, text: "first" });
      await settleDirectiveBookkeeping();
      await service.runSessionTurn({ sessionId: session.id, text: "second" });

      const prompts = fixture.send.mock.calls.map(([message]) => claudeInputText(message));
      const carryingDirective = prompts.filter((text) => text.includes("## Computer Use"));
      expect(carryingDirective).toHaveLength(1);
      expect(prompts.at(-1) ?? "").not.toContain("## Computer Use");
      service.forceDisposeAll();
    });

    it("does not let a local `/fast` suppress the directive for later real turns", async () => {
      const fixture = installClaudeResponseFixture({ sdkSessionId: "sdk-cu-fast", responseText: "ok" });
      const { service } = createService();
      installAvailableBroker(service);
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      // `/fast` is handled entirely locally: it never hands `promptText` — the
      // carrier of the directive — to a provider, so it must not mark the key.
      await service.sendMessage({ sessionId: session.id, text: "/fast on" });
      await service.runSessionTurn({ sessionId: session.id, text: "real turn" });

      const prompts = fixture.send.mock.calls.map(([message]) => claudeInputText(message));
      expect(prompts.some((text) => text.includes("## Computer Use"))).toBe(true);
      service.forceDisposeAll();
    });

    it("sends Droid's nearest effort for Ultracode instead of none", async () => {
      // Droid has no Ultracode tier; dropping the value left the previous
      // turn's effort in force.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "claude-fable-5-1",
        modelId: "droid/claude-fable-5-1",
        reasoningEffort: "ultracode",
      });
      expect(session.reasoningEffort).toBe("ultracode");
      await service.sendMessage({ sessionId: session.id, text: "Plan the migration." }, { awaitDispatch: true });
      await vi.waitFor(() => { expect(mockState.droidPromptCalls.length).toBe(1); });
      expect(mockState.droidPromptCalls[0]?.settings).toMatchObject({
        modelId: "claude-fable-5-1",
        reasoningEffort: "xhigh",
      });
      service.forceDisposeAll();
    });

    it("does not let a provider slash-command turn consume the directive", async () => {
      // A provider slash-command turn replaces the user text with the command's
      // own markdown and never runs `composeLaunchDirectives`, so the directive
      // is not in that turn's prompt. The key must be null for it, or it would
      // be marked delivered without delivery and suppressed for what follows.
      const { service } = createService();
      installAvailableBroker(service);
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      await service.sendMessage({ sessionId: session.id, text: "/somecommand" }, { awaitDispatch: true });
      await vi.waitFor(() => { expect(mockState.droidPromptCalls.length).toBe(1); });
      await settleDirectiveBookkeeping();
      await service.sendMessage({ sessionId: session.id, text: "real turn" }, { awaitDispatch: true });
      await vi.waitFor(() => { expect(mockState.droidPromptCalls.length).toBe(2); });

      expect(JSON.stringify(mockState.droidPromptCalls[0])).not.toContain("## Computer Use");
      expect(JSON.stringify(mockState.droidPromptCalls[1])).toContain("## Computer Use");
      service.forceDisposeAll();
    });
  });

  // --------------------------------------------------------------------------
  // lane Apple device hint (`<ade-lane-tools>`) cadence
  // --------------------------------------------------------------------------

  describe("lane Apple device hint cadence", () => {
    const HINT_OPEN = "<ade-lane-tools>";

    function laneDeviceLookup(initial: { udid: string; name: string } | null) {
      let device = initial;
      const lookup = vi.fn((_laneId: string) => device);
      return {
        lookup,
        set(next: { udid: string; name: string } | null) {
          device = next;
        },
      };
    }

    it("names the device on the first turn only, and again when the bound udid changes", async () => {
      const fixture = installClaudeResponseFixture({ sdkSessionId: "sdk-apple-hint", responseText: "ok" });
      const events: AgentChatEventEnvelope[] = [];
      const device = laneDeviceLookup({ udid: "UDID-AAA", name: "iPhone 17 Pro" });
      const { service } = createService({
        lookupLaneAppleDevice: device.lookup,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      await service.runSessionTurn({ sessionId: session.id, text: "record opening safari" });
      await settleDirectiveBookkeeping();
      await service.runSessionTurn({ sessionId: session.id, text: "second" });
      await settleDirectiveBookkeeping();
      device.set({ udid: "UDID-BBB", name: "iPad Air" });
      await service.runSessionTurn({ sessionId: session.id, text: "third" });

      expect(device.lookup).toHaveBeenCalledWith("lane-1");
      const prompts = fixture.send.mock.calls.map(([message]) => claudeInputText(message));
      const first = prompts.find((text) => text.includes("record opening safari")) ?? "";
      const second = prompts.find((text) => text.includes("second")) ?? "";
      const third = prompts.find((text) => text.includes("third")) ?? "";
      expect(first).toContain(HINT_OPEN);
      expect(first).toContain("iPhone 17 Pro (UDID-AAA)");
      expect(first).toContain("\"$ADE_CLI_PATH\" apple record-start");
      expect(second).not.toContain(HINT_OPEN);
      expect(third).toContain(HINT_OPEN);
      expect(third).toContain("iPad Air (UDID-BBB)");

      // The transcript keeps the user's own words: the block rides the
      // provider-bound prompt only.
      const userRows = events
        .filter((entry) => entry.sessionId === session.id && entry.event.type === "user_message")
        .map((entry) => entry.event as { text?: string; displayText?: string });
      expect(userRows.map((row) => row.text)).toEqual(["record opening safari", "second", "third"]);
      expect(JSON.stringify(userRows)).not.toContain(HINT_OPEN);
      service.forceDisposeAll();
    });

    it("sends nothing when the lane has no device", async () => {
      const fixture = installClaudeResponseFixture({ sdkSessionId: "sdk-apple-none", responseText: "ok" });
      const device = laneDeviceLookup(null);
      const { service } = createService({ lookupLaneAppleDevice: device.lookup });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      await service.runSessionTurn({ sessionId: session.id, text: "hello" });

      expect(device.lookup).toHaveBeenCalled();
      const prompts = fixture.send.mock.calls.map(([message]) => claudeInputText(message));
      expect(prompts.some((text) => text.includes("hello"))).toBe(true);
      expect(prompts.some((text) => text.includes(HINT_OPEN))).toBe(false);
      service.forceDisposeAll();
    });

    it("never fails the send when the device lookup throws", async () => {
      const fixture = installClaudeResponseFixture({ sdkSessionId: "sdk-apple-throw", responseText: "ok" });
      const lookup = vi.fn(() => {
        throw new Error("no such table: lane_apple_devices");
      });
      const { service, logger } = createService({ lookupLaneAppleDevice: lookup });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      await service.runSessionTurn({ sessionId: session.id, text: "still sends" });

      const prompts = fixture.send.mock.calls.map(([message]) => claudeInputText(message));
      expect(prompts.some((text) => text.includes("still sends"))).toBe(true);
      expect(prompts.some((text) => text.includes(HINT_OPEN))).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.lane_apple_device_lookup_failed",
        expect.objectContaining({ laneId: "lane-1" }),
      );
      service.forceDisposeAll();
    });

    it("reaches a provider with no system-prompt channel (Droid) the same way", async () => {
      const device = laneDeviceLookup({ udid: "UDID-DROID", name: "iPhone 17" });
      const { service } = createService({ lookupLaneAppleDevice: device.lookup });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      await service.sendMessage({ sessionId: session.id, text: "first" }, { awaitDispatch: true });
      await vi.waitFor(() => { expect(mockState.droidPromptCalls.length).toBe(1); });
      await settleDirectiveBookkeeping();
      await service.sendMessage({ sessionId: session.id, text: "second" }, { awaitDispatch: true });
      await vi.waitFor(() => { expect(mockState.droidPromptCalls.length).toBe(2); });

      expect(JSON.stringify(mockState.droidPromptCalls[0])).toContain("iPhone 17 (UDID-DROID)");
      expect(JSON.stringify(mockState.droidPromptCalls[1])).not.toContain(HINT_OPEN);
      service.forceDisposeAll();
    });
  });

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  describe("createSession", () => {
    it("creates a opencode session with valid model", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session).toBeDefined();
      expect(session.id).toBe("test-uuid-1");
      expect(session.laneId).toBe("lane-1");
      expect(session.provider).toBe("opencode");
      expect(session.status).toBe("idle");
      expect(session.completion).toBeNull();
      expect(sessionService.create).toHaveBeenCalledTimes(1);
    });

    it("persists Copilot chats with Copilot identity and repairs legacy Codex rows", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "copilot",
        model: "gpt-5.4",
        modelId: "github-copilot/gpt-5.4",
      });

      expect(sessionService.create).toHaveBeenCalledWith(expect.objectContaining({
        toolType: "copilot-chat",
        resumeCommand: `chat:copilot:${session.id}`,
      }));

      sessionService.updateMeta({
        sessionId: session.id,
        toolType: "codex-chat",
        resumeCommand: "chat:codex",
      });
      await service.getSessionSummary(session.id);

      expect(sessionService.get(session.id)).toEqual(expect.objectContaining({
        toolType: "copilot-chat",
        resumeCommand: `chat:copilot:${session.id}`,
      }));
    });

    it("persists create-time goals into the backing session row", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        goal: "Run quality, tests, ship, merge, and release.",
      });

      expect(session.goal).toBe("Run quality, tests, ship, merge, and release.");
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          goal: "Run quality, tests, ship, merge, and release.",
        }),
      );
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        goal: "Run quality, tests, ship, merge, and release.",
      });
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

    it("imports a same-cwd Claude external chat with persisted resume identity and visible history", async () => {
      const externalSessionId = "11111111-2222-3333-4444-555555555555";
      const claudeConfigRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(tmpHomeRoot, ".claude");
      const claudeProjectDir = path.join(
        claudeConfigRoot,
        "projects",
        tmpRoot.replace(/[^A-Za-z0-9]/g, "-"),
      );
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeProjectDir, `${externalSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "user",
            uuid: "user-1",
            timestamp: "2026-07-06T10:00:00.000Z",
            cwd: tmpRoot,
            sessionId: externalSessionId,
            message: { role: "user", content: [{ type: "text", text: "Please inspect the failing test." }] },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            timestamp: "2026-07-06T10:00:02.000Z",
            cwd: tmpRoot,
            sessionId: externalSessionId,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "I will check the focused test output." },
                { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test" } },
              ],
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const { service, sessionService } = createService();
      const result = await service.importExternalChatSession({
        provider: "claude",
        externalSessionId,
        laneId: "lane-1",
        cwd: tmpRoot,
        fork: false,
      });

      const persisted = readPersistedChatState(result.chatSessionId);
      expect(result.chatSummary).toMatchObject({
        sessionId: result.chatSessionId,
        laneId: "lane-1",
        provider: "claude",
        title: "Please inspect the failing test",
      });
      expect(persisted.sdkSessionId).toBe(externalSessionId);
      expect(persisted.claudeBackgroundResumeSessionId).toBe(externalSessionId);
      expect(persisted.importedFrom).toMatchObject({
        provider: "claude",
        sessionId: externalSessionId,
        mode: "continue",
      });
      expect(typeof persisted.importedFrom.importedAt).toBe("number");
      expect(sessionService.getClaudeSessionPointerByChatSessionId(result.chatSessionId)).toMatchObject({
        sessionId: externalSessionId,
        laneId: "lane-1",
        chatSessionId: result.chatSessionId,
      });
      expect(sessionService.get(result.chatSessionId)?.title).toBe("Please inspect the failing test");

      const history = await service.getChatEventHistory(result.chatSessionId, { maxEvents: 10 });
      // The turn did tool work, so it is closed with a `done` event: finished
      // tool calls show only in a turn's done summary.
      expect(history.events.map((envelope) => envelope.event.type)).toEqual([
        "system_notice",
        "user_message",
        "text",
        "tool_call",
        "done",
      ]);
      expect(history.events[0]!.event).toMatchObject({ type: "system_notice", message: "Session imported from claude CLI (11111111)" });
      expect(history.events[1]!.event).toMatchObject({ type: "user_message", text: "Please inspect the failing test." });
      expect(history.events[2]!.event).toMatchObject({ type: "text", text: "I will check the focused test output." });
      await expect(service.getSessionSummary(result.chatSessionId)).resolves.toMatchObject({
        importedFrom: {
          provider: "claude",
          sessionId: externalSessionId,
        },
      });
    });

    it("rejects a cross-provider replay import whose transcript has no messages", async () => {
      const externalSessionId = "99999999-8888-7777-6666-555555555555";
      const claudeConfigRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(tmpHomeRoot, ".claude");
      const claudeProjectDir = path.join(
        claudeConfigRoot,
        "projects",
        tmpRoot.replace(/[^A-Za-z0-9]/g, "-"),
      );
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      fs.writeFileSync(path.join(claudeProjectDir, `${externalSessionId}.jsonl`), "\n", "utf8");

      const { service, sessionService } = createService();

      await expect(service.importExternalChatSession({
        provider: "claude",
        externalSessionId,
        laneId: "lane-1",
        cwd: tmpRoot,
        fork: false,
        model: "openai/gpt-5.5",
      })).rejects.toThrow(/has no messages to replay/i);

      expect(sessionService.get("test-uuid-1")).toBeNull();
    });

    it("forks a same-cwd Claude chat import into a new SDK session id", async () => {
      const externalSessionId = "12121212-3434-4343-8343-565656565656";
      const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const claudeConfigRoot = path.join(tmpHomeRoot, ".claude");
      process.env.CLAUDE_CONFIG_DIR = claudeConfigRoot;
      try {
        const sourcePath = path.join(
          claudeConfigRoot,
          "projects",
          tmpRoot.replace(/[^A-Za-z0-9]/g, "-"),
          `${externalSessionId}.jsonl`,
        );
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(
          sourcePath,
          [
            JSON.stringify({
              type: "user",
              uuid: "user-1",
              timestamp: "2026-07-06T10:00:00.000Z",
              cwd: tmpRoot,
              sessionId: externalSessionId,
              message: { role: "user", content: [{ type: "text", text: "Fork this without mutating the source." }] },
            }),
          ].join("\n") + "\n",
          "utf8",
        );
        const sourceBefore = fs.readFileSync(sourcePath, "utf8");
        const readline = await import("node:readline");
        const createLineReader = (options: { input: AsyncIterable<string | Buffer> }) => ({
          on: vi.fn(),
          close: vi.fn(),
          [Symbol.asyncIterator]: () => (async function* () {
            const chunks: string[] = [];
            for await (const chunk of options.input) chunks.push(String(chunk));
            for (const line of chunks.join("").split(/\r?\n/u)) yield line;
          })(),
        });
        vi.mocked(readline.createInterface).mockImplementationOnce(createLineReader as any);
        vi.mocked((readline as any).default.createInterface).mockImplementationOnce(createLineReader as any);
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "claude",
          externalSessionId,
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: true,
        });

        const persisted = readPersistedChatState(result.chatSessionId);
        expect(persisted.sdkSessionId).not.toBe(externalSessionId);
        expect(persisted.importedFrom).toMatchObject({ sessionId: externalSessionId, mode: "fork" });
        expect(persisted.claudeBackgroundResumeSessionId).toBe(persisted.sdkSessionId);
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBefore);
        const projectsDir = path.join(claudeConfigRoot, "projects");
        const forkedPath = fs.readdirSync(projectsDir)
          .flatMap((entry) => {
            const projectDir = path.join(projectsDir, entry);
            return fs.statSync(projectDir).isDirectory()
              ? fs.readdirSync(projectDir).map((fileName) => path.join(projectDir, fileName))
              : [];
          })
          .find((candidate) => path.basename(candidate) === `${persisted.sdkSessionId}.jsonl`);
        expect(forkedPath).toBeTruthy();
        const forkedRows = fs.readFileSync(forkedPath!, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
        expect(forkedRows[0]).toMatchObject({
          cwd: fs.realpathSync(tmpRoot),
          sessionId: persisted.sdkSessionId,
        });
      } finally {
        if (previousClaudeConfigDir === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        }
      }
    });

    it("preserves the source Claude JSONL when a failed cross-cwd chat import follows transplant", async () => {
      const externalSessionId = "22222222-3333-4333-8333-666666666666";
      const sourceCwd = path.join(tmpHomeRoot, "source-project");
      const claudeConfigRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(tmpHomeRoot, ".claude");
      const sourcePath = path.join(
        claudeConfigRoot,
        "projects",
        sourceCwd.replace(/[^A-Za-z0-9]/g, "-"),
        `${externalSessionId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(
        sourcePath,
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-07-06T10:00:00.000Z",
          cwd: sourceCwd,
          sessionId: externalSessionId,
          message: { role: "user", content: [{ type: "text", text: "Keep my original transcript." }] },
        }) + "\n",
        "utf8",
      );
      const failingSessionService = createMockSessionService();
      vi.mocked(failingSessionService.create).mockImplementationOnce(() => {
        throw new Error("create failed after transplant");
      });
      const readline = await import("node:readline");
      const createLineReader = (options: { input: AsyncIterable<string | Buffer> }) => ({
        on: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncIterator]: () => (async function* () {
          const chunks: string[] = [];
          for await (const chunk of options.input) chunks.push(String(chunk));
          for (const line of chunks.join("").split(/\r?\n/u)) yield line;
        })(),
      });
      vi.mocked(readline.createInterface).mockImplementationOnce(createLineReader as any);
      vi.mocked((readline as any).default.createInterface).mockImplementationOnce(createLineReader as any);
      const { service } = createService({ sessionService: failingSessionService });

      await expect(service.importExternalChatSession({
        provider: "claude",
        externalSessionId,
        laneId: "lane-1",
        cwd: sourceCwd,
        fork: false,
      })).rejects.toThrow("create failed after transplant");

      expect(fs.existsSync(sourcePath)).toBe(true);
    });

    it("archives a forked Codex provider thread when a chat import fails after fork", async () => {
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-1" },
      }));
      mockState.codexResponseOverrides.set("thread/read", (payload) => {
        const params = payload.params as { threadId?: unknown } | undefined;
        if (params?.threadId === "source-thread-1") {
          return { thread: { id: "source-thread-1", turns: [] } };
        }
        return {};
      });
      const { service, sessionService } = createService();

      await expect(service.importExternalChatSession({
        provider: "codex",
        externalSessionId: "source-thread-1",
        laneId: "lane-1",
        cwd: tmpRoot,
        fork: true,
      })).rejects.toThrow(/was not found by thread\/read/i);

      expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "thread/archive",
          params: { threadId: "forked-thread-1" },
        }),
      ]));
      expect(sessionService.get("test-uuid-1")).toBeNull();
    });

    it("reacquires a Codex runtime to archive a forked provider thread when the import runtime cannot clean up", async () => {
      let archiveAttempts = 0;
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-2" },
      }));
      mockState.codexResponseOverrides.set("thread/read", (payload) => {
        const params = payload.params as { threadId?: unknown } | undefined;
        if (params?.threadId === "source-thread-2") {
          return { thread: { id: "source-thread-2", turns: [] } };
        }
        return {};
      });
      mockState.codexResponseOverrides.set("thread/archive", () => {
        archiveAttempts += 1;
        if (archiveAttempts === 1) {
          return { error: { code: -32000, message: "dead runtime" } };
        }
        return {};
      });
      const { service, logger, sessionService } = createService();

      await expect(service.importExternalChatSession({
        provider: "codex",
        externalSessionId: "source-thread-2",
        laneId: "lane-1",
        cwd: tmpRoot,
        fork: true,
      })).rejects.toThrow(/was not found by thread\/read/i);

      const initializeRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "initialize");
      const archiveRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/archive");
      expect(initializeRequests).toHaveLength(2);
      expect(archiveRequests).toEqual([
        expect.objectContaining({ params: { threadId: "forked-thread-2" } }),
        expect.objectContaining({ params: { threadId: "forked-thread-2" } }),
      ]);
      expect(logger.warn).not.toHaveBeenCalledWith(
        "agent_chat.external_import_codex_fork_cleanup_leaked",
        expect.anything(),
      );
      expect(sessionService.get("test-uuid-1")).toBeNull();
    });

    describe("external sessions from every provider", () => {
      const importEvents = (chatSessionId: string, texts: { user: string; assistant: string }) => ({
        events: [
          {
            sessionId: chatSessionId,
            timestamp: "2026-09-23T10:00:00.000Z",
            event: { type: "system_notice" as const, noticeKind: "info" as const, message: "Session imported from grok CLI (ext-1)" },
          },
          {
            sessionId: chatSessionId,
            timestamp: "2026-09-23T10:00:01.000Z",
            event: { type: "user_message" as const, text: texts.user },
          },
          {
            sessionId: chatSessionId,
            timestamp: "2026-09-23T10:00:02.000Z",
            event: { type: "text" as const, text: texts.assistant },
          },
        ],
        hasOlder: false,
        olderCursor: null,
        truncated: false,
      });

      it("opens a Grok session as a Grok chat in another lane by replaying its history", async () => {
        vi.mocked(loadExternalSessionEvents).mockResolvedValueOnce(
          importEvents("import-preview", { user: "Map the sync flow.", assistant: "The relay owns the cursor." }),
        );
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "grok",
          externalSessionId: "grok-session-1",
          laneId: "lane-2",
          cwd: tmpRoot,
          fork: true,
        });

        expect(vi.mocked(loadExternalSessionEvents)).toHaveBeenCalledWith(expect.objectContaining({
          provider: "grok",
          sessionId: "grok-session-1",
          record: null,
          laneId: "lane-2",
          purpose: "import",
        }));
        expect(result.chatSummary).toMatchObject({
          laneId: "lane-2",
          provider: "grok",
          modelId: getDefaultModelDescriptor("grok")!.id,
          title: "Map the sync flow",
        });
        // Nothing was cut, so there is no truncation to disclose.
        expect(result.replayFork).toBeUndefined();
        expect(result.providerTargetId).toBe("grok-session-1");
        const persisted = readPersistedChatState(result.chatSessionId);
        expect(persisted.importedFrom).toMatchObject({ provider: "grok", sessionId: "grok-session-1", mode: "fork" });
        expect(persisted.acpSessionId).toBeUndefined();
        expect(persisted.pendingTranscriptReplay).toContain("Map the sync flow.");
        expect(persisted.pendingTranscriptReplay).toContain("The relay owns the cursor.");
        const history = await service.getChatEventHistory(result.chatSessionId, { maxEvents: 10 });
        expect(history.events.map((envelope) => envelope.event.type)).toEqual(["system_notice", "user_message", "text"]);
        expect(history.events.every((envelope) => envelope.sessionId === result.chatSessionId)).toBe(true);
      });

      it("copies onto the model the source session recorded when it belongs to the family", async () => {
        const recorded = getDefaultModelDescriptor("droid")!;
        vi.mocked(loadExternalSessionEvents).mockResolvedValueOnce(
          importEvents("import-preview", { user: "Fix the flaky test.", assistant: "Done." }),
        );
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "droid",
          externalSessionId: "droid-session-1",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: true,
          sourceModel: recorded.providerModelId,
        });

        expect(result.chatSummary).toMatchObject({ provider: "droid", modelId: recorded.id });
        const persisted = readPersistedChatState(result.chatSessionId);
        expect(persisted.droidSdkSessionId).toBeUndefined();
        expect(persisted.importedFrom).toMatchObject({ provider: "droid", mode: "fork" });
        expect(persisted.pendingTranscriptReplay).toContain("Fix the flaky test.");
      });

      it("refuses a copy with nothing to replay and leaves no chat behind", async () => {
        const { service, sessionService } = createService();

        await expect(service.importExternalChatSession({
          provider: "kimi",
          externalSessionId: "kimi-session-empty",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: true,
        })).rejects.toThrow(/has no messages to replay/i);

        expect(sessionService.get("test-uuid-1")).toBeNull();
      });

      it("continues a Droid session in place: the chat resumes the external session id", async () => {
        vi.mocked(loadExternalSessionEvents).mockResolvedValueOnce(
          importEvents("import-preview", { user: "Keep going on the parser.", assistant: "On it." }),
        );
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "droid",
          externalSessionId: "droid-external-1",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: false,
        });

        const persisted = readPersistedChatState(result.chatSessionId);
        expect(result.providerTargetId).toBe("droid-external-1");
        expect(persisted.droidSdkSessionId).toBe("droid-external-1");
        expect(persisted.importedFrom).toMatchObject({ provider: "droid", sessionId: "droid-external-1", mode: "continue" });
        expect(persisted.pendingTranscriptReplay ?? null).toBeNull();
        const history = await service.getChatEventHistory(result.chatSessionId, { maxEvents: 10 });
        expect(history.events.map((envelope) => envelope.event.type)).toEqual(["system_notice", "user_message", "text"]);

        await service.warmupModel({ sessionId: result.chatSessionId, modelId: result.chatSummary.modelId! });
        expect(mockState.droidAcquireCalls.at(-1)?.resumeSessionId).toBe("droid-external-1");
        service.forceDisposeAll();
      });

      it("continues an OpenCode session in place: the runtime opens the external session id", async () => {
        vi.mocked(loadExternalSessionEvents).mockResolvedValueOnce(
          importEvents("import-preview", { user: "Refactor the store.", assistant: "Starting." }),
        );
        streamText.mockReturnValue({
          fullStream: (async function* () {
            yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
          })(),
        });
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "opencode",
          externalSessionId: "ses_external1",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: false,
          model: "opencode/anthropic/claude-sonnet-5",
        });

        const persisted = readPersistedChatState(result.chatSessionId);
        expect(persisted.providerSessionId).toBe("ses_external1");
        expect(persisted.importedFrom).toMatchObject({ provider: "opencode", mode: "continue" });

        await service.sendMessage({ sessionId: result.chatSessionId, text: "Continue." }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(vi.mocked(startOpenCodeSession).mock.calls.at(-1)?.[0]).toEqual(
            expect.objectContaining({ sessionId: "ses_external1", directory: fs.realpathSync(tmpRoot) }),
          );
        });
        service.forceDisposeAll();
      });

      it("continues a Pi session in place by seeding its session id", async () => {
        const piDescriptor = createDynamicPiModelDescriptor("local", "import-continue");
        replaceDynamicPiModelDescriptors([piDescriptor]);
        vi.mocked(loadExternalSessionEvents).mockResolvedValueOnce(
          importEvents("import-preview", { user: "Add the migration.", assistant: "Added." }),
        );
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "pi",
          externalSessionId: "pi-external-1",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: false,
          sourceModel: piDescriptor.id,
          sourceReasoningEffort: "high",
        });

        const persisted = readPersistedChatState(result.chatSessionId);
        expect(result.chatSummary).toMatchObject({ provider: "pi", modelId: piDescriptor.id, reasoningEffort: "high" });
        expect(persisted.piSessionId).toBe("pi-external-1");
        expect(persisted.importedFrom).toMatchObject({ provider: "pi", mode: "continue" });
      });

      it("continues a Copilot session in place by seeding its ACP session id", async () => {
        vi.mocked(loadExternalSessionEvents).mockResolvedValueOnce(
          importEvents("import-preview", { user: "Count the lines.", assistant: "35" }),
        );
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "copilot",
          externalSessionId: "42f148ac-e59c-442f-ab18-520fc7b6081b",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: false,
        });

        const persisted = readPersistedChatState(result.chatSessionId);
        expect(result.chatSummary).toMatchObject({ provider: "copilot" });
        expect(persisted.acpSessionId).toBe("42f148ac-e59c-442f-ab18-520fc7b6081b");
        expect(persisted.importedFrom).toMatchObject({ provider: "copilot", mode: "continue" });
      });

      it("refuses to continue a provider whose own session an ADE chat cannot reopen", async () => {
        const { service, sessionService } = createService();

        await expect(service.importExternalChatSession({
          provider: "grok",
          externalSessionId: "grok-session-2",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: false,
        })).rejects.toThrow("Grok sessions can't be continued as an ADE chat. Open a copy instead.");
        await expect(service.importExternalChatSession({
          provider: "cursor",
          externalSessionId: "cursor-session-1",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: false,
        })).rejects.toThrow("Cursor sessions can't be continued as an ADE chat. Open a copy instead.");

        expect(vi.mocked(loadExternalSessionEvents)).not.toHaveBeenCalled();
        expect(sessionService.get("test-uuid-1")).toBeNull();
      });

      it("refuses to continue a session from another folder or on another family's model", async () => {
        const { service, sessionService } = createService();

        await expect(service.importExternalChatSession({
          provider: "droid",
          externalSessionId: "droid-external-2",
          laneId: "lane-1",
          cwd: path.join(tmpRoot, "lane-2"),
          fork: false,
        })).rejects.toThrow(/only be continued in the lane folder they ran in/);
        await expect(service.importExternalChatSession({
          provider: "droid",
          externalSessionId: "droid-external-2",
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: false,
          model: "anthropic/claude-sonnet-5",
        })).rejects.toThrow(/only be continued on a Droid model/);

        expect(sessionService.get("test-uuid-1")).toBeNull();
      });
    });

    it("derives the runtime model from modelId when raw action callers omit model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: undefined,
        modelId: "anthropic/claude-sonnet-5",
      } as any);

      expect(session.provider).toBe("claude");
      expect(session.modelId).toBe("anthropic/claude-sonnet-5");
      expect(session.model).toBe("claude-sonnet-5");
    });

    it("maps retired Claude Opus 4.7 1M aliases onto Opus 5", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-7[1m]",
      });

      expect(session.modelId).toBe("anthropic/claude-opus-5");
      expect(session.model).toBe("claude-opus-5");
    });

    it.each([
      { reportedModel: "opus", usageModel: "claude-opus-4-8", expectedModel: "claude-opus-5" },
      { reportedModel: "claude-opus-4-7-1m", usageModel: "claude-opus-4-7-1m", expectedModel: "claude-opus-5" },
    ])("preserves the Claude Opus 5 modelId in done events when the SDK reports $reportedModel", async ({
      reportedModel,
      usageModel,
      expectedModel,
    }) => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-opus-4-8",
              model: reportedModel,
              slash_commands: [],
            };
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-opus-4-8",
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: { [usageModel]: { input_tokens: 1, output_tokens: 1 } },
            };
            return;
          }
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-opus-4-8",
            model: reportedModel,
            slash_commands: [],
          };
          yield {
            type: "assistant",
            message: {
              model: reportedModel,
              content: [{ type: "text", text: "Done" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-opus-4-8",
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: { [usageModel]: { input_tokens: 1, output_tokens: 1 } },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-opus-4-8",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Report the selected model.",
      });

      const doneEvent = events.filter((event) => event.event.type === "done").at(-1);
      expect(doneEvent?.event.type).toBe("done");
      expect((doneEvent!.event as any).model).toBe(expectedModel);
      expect((doneEvent!.event as any).modelId).toBe("anthropic/claude-opus-5");
    });

    it("maps retired Claude Opus 4.7 1M sessions onto Opus 5 even when the SDK reports bare Opus 4.7", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-opus-4-7-1m",
              model: "claude-opus-4-7",
              slash_commands: [],
            };
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-opus-4-7-1m",
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: { "claude-opus-4-7": { input_tokens: 1, output_tokens: 1 } },
            };
            return;
          }
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-opus-4-7-1m",
            model: "claude-opus-4-7",
            slash_commands: [],
          };
          yield {
            type: "assistant",
            message: {
              model: "claude-opus-4-7",
              content: [{ type: "text", text: "Done" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-opus-4-7-1m",
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: { "claude-opus-4-7": { input_tokens: 1, output_tokens: 1 } },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-opus-4-7-1m",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-7[1m]",
        modelId: "anthropic/claude-opus-4-7-1m",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Report the selected model.",
      });

      const doneEvent = events.filter((event) => event.event.type === "done").at(-1);
      expect(doneEvent?.event.type).toBe("done");
      expect((doneEvent!.event as any).model).toBe("claude-opus-5");
      expect((doneEvent!.event as any).modelId).toBe("anthropic/claude-opus-5");
    });

    it("suppresses Claude EDE diagnostics without hiding real result errors", async () => {
      const diagnostic = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";
      const diagnosticOnlyEvents = await runClaudeStreamFixture({
        sdkSessionId: "sdk-ede-diagnostic-only",
        messages: [{
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [diagnostic],
          session_id: "sdk-ede-diagnostic-only",
        }],
      });

      expect(diagnosticOnlyEvents.filter((event) => event.event.type === "error")).toEqual([]);
      expect(diagnosticOnlyEvents.findLast((event) => event.event.type === "done")?.event).toMatchObject({
        type: "done",
        status: "completed",
      });

      const mixedEvents = await runClaudeStreamFixture({
        sdkSessionId: "sdk-ede-diagnostic-mixed",
        messages: [{
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [diagnostic, "Real Claude failure"],
          session_id: "sdk-ede-diagnostic-mixed",
        }],
      });
      const mixedErrors = mixedEvents
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "error" }> => event.type === "error")
        .map((event) => event.message);

      expect(mixedErrors).toEqual(["Real Claude failure"]);
      expect(mixedErrors.join("\n")).not.toContain("[ede_diagnostic]");
    });

    it("fast-fails a logged-out Claude turn into the inline re-login card", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            // Startup warmup stream — healthy.
            yield { type: "system", subtype: "init", session_id: "sdk-auth", model: "claude-opus-4-8", slash_commands: [] };
            yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-auth" };
            return;
          }
          // The SDK reports a logged-out session as an assistant message carrying
          // error="authentication_failed", with the 401 surfaced as plain text.
          yield { type: "system", subtype: "init", session_id: "sdk-auth", model: "claude-opus-4-8", slash_commands: [] };
          yield {
            type: "assistant",
            error: "authentication_failed",
            message: {
              model: "claude-opus-4-8",
              content: [{ type: "text", text: "Failed to authenticate. API Error: 401 Invalid authentication credentials" }],
            },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-auth",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await service.runSessionTurn({ sessionId: session.id, text: "use context skill" });

      // The raw 401 is not surfaced as a plain assistant bubble.
      const authText = events.find(
        (event) => event.event.type === "text"
          && /invalid authentication credentials/i.test((event.event as any).text ?? ""),
      );
      expect(authText).toBeUndefined();

      // A single "logged out" notice replaces the "retry 1/10 … 10/10" storm.
      const notice = events.find(
        (event) => event.event.type === "system_notice"
          && /logged out/i.test((event.event as any).message ?? ""),
      );
      expect(notice).toBeTruthy();

      // The error carries the agentCli signal that renders the inline re-login card.
      const errorEvent = events.find(
        (event) => event.event.type === "error"
          && (event.event as any).errorInfo?.agentCli?.category === "unauthenticated",
      );
      expect(errorEvent).toBeTruthy();
      expect((errorEvent!.event as any).errorInfo.agentCli.agent).toBe("claude");

      const failedDone = events.filter((event) => event.event.type === "done").at(-1);
      expect((failedDone!.event as any).status).toBe("failed");
    });

    it("honors an explicit initial chat title", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        title: "  Pearl UI Audit  ",
      });

      expect(sessionService.get(session.id)?.title).toBe("Pearl UI Audit");
      expect(sessionService.get(session.id)?.manuallyNamed).toBe(true);
    });

    it("appends ADE tooling guidance to Claude SDK sessions", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-guidance",
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toContain("system prompt");
      expect(opts?.systemPrompt?.append).toContain(
        `This ADE chat session is \`${session.id}\`. Pass \`--session ${session.id}\` to its status commands.`,
      );
    });

    it("rebuilds the Claude query with the per-turn reasoning effort, not the stale warm-query effort (FIX 3)", async () => {
      // Regression: the session pre-warmed a query baked with the create-time
      // effort (medium). A later turn requesting xhigh updated the session field
      // but ensureClaudeQuery reused the stale warm query, so Claude ran medium.
      const send = vi.fn().mockResolvedValue(undefined);
      const makeSession = (sdkSessionId: string) => ({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sdkSessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: sdkSessionId,
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(makeSession("sdk-effort") as any);

      const { service } = createService();
      // opus supports the xhigh tier; sonnet does not, which would clamp the
      // requested effort and mask the regression.
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });

      // The pre-warm built a query with the create-time (medium) effort.
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      const warmOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { effort?: string } | undefined;
      expect(warmOpts?.effort).toBe("medium");

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Do the deep work.",
        reasoningEffort: "xhigh",
        timeoutMs: 15_000,
      });

      // The stale warm query was discarded and a fresh query built with xhigh.
      const efforts = [
        ...vi.mocked(claudeSdkCreateSessionCompat).mock.calls
          .map((call) => (call[0] as { effort?: string } | undefined)?.effort),
        ...vi.mocked(claudeSdkResumeSessionCompat).mock.calls
          .map((call) => (call[1] as { effort?: string } | undefined)?.effort),
      ]
        .filter((value): value is string => typeof value === "string");
      expect(efforts).toContain("xhigh");
      expect(session.id).toBeDefined();
    });

    it("injects the ade-linear directive into the Claude system prompt when the session has attached issues (FIX 4)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-linear-directive",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-linear-directive",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service, laneService } = createService();
      const issue = makeLaneLinearIssue();
      // opus supports xhigh, so the per-turn effort bump below invalidates the
      // create-time warm query (built before the attach) and forces a fresh
      // query build that now resolves the attached issue into the directive.
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });
      // Let the create-time warm query settle (built before the attach, so with
      // no directive) — the turn must then invalidate and rebuild it.
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
      });
      laneService.attachLinearIssueToSession({
        chatSessionId: session.id,
        issues: [issue],
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Continue the tracked work.",
        reasoningEffort: "xhigh",
        timeoutMs: 15_000,
      });

      const appended = [
        ...vi.mocked(claudeSdkCreateSessionCompat).mock.calls
          .map((call) => (call[0] as { systemPrompt?: { append?: string } } | undefined)?.systemPrompt?.append ?? ""),
        ...vi.mocked(claudeSdkResumeSessionCompat).mock.calls
          .map((call) => (call[1] as { systemPrompt?: { append?: string } } | undefined)?.systemPrompt?.append ?? ""),
      ]
        .join("\n");
      expect(appended).toContain("Linear-tracked work");
      expect(appended).toContain("ADE-123");
      expect(appended).toContain("ade linear");
      expect(appended).toContain("Prefer `ade linear`");
      expect(appended).toContain("ade-deeplinks");
    });

    it("keeps ADE tooling guidance out of Claude SDK user turns", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-session-user-guidance",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-user-guidance",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the repo and report the chat wiring.",
        timeoutMs: 15_000,
      });

      const userTurnPayload = send.mock.calls
        .map((call) => String(call[0] ?? ""))
        .find((payload) => payload.includes("Inspect the repo and report the chat wiring."));

      expect(userTurnPayload).toContain("[ADE launch directive]");
      expect(userTurnPayload).not.toContain("CLI controls ADE state");
      expect(userTurnPayload).not.toContain("ade actions list --text");
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toContain("system prompt");
    });

    it("keeps Claude SDK setting sources and skills enabled without output-style plugins", async () => {
      const bundledSkillRoot = path.join(tmpRoot, "bundled-agent-skills");
      const repositorySkillRoot = path.join(tmpRoot, "lane-repository-agent-skills");
      fs.mkdirSync(path.join(bundledSkillRoot, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repositorySkillRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(bundledSkillRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "ade", skills: "." }),
      );
      fs.writeFileSync(
        path.join(repositorySkillRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "shadowed-repository-plugin", hooks: "./hooks.json" }),
      );
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-skills",
      } as any);

      const { service } = createService({
        getAdeCliAgentEnv: () => ({
          ...process.env,
          ADE_AGENT_SKILLS_DIRS: [repositorySkillRoot, bundledSkillRoot].join(path.delimiter),
          ADE_BUNDLED_AGENT_SKILLS_DIR: bundledSkillRoot,
        }),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        includeHookEvents?: boolean;
        promptSuggestions?: boolean;
        perTaskStopAffordance?: boolean;
        autoContinueAtUsageLimit?: boolean;
        settingSources?: string[];
        settings?: {
          enabledPlugins?: Record<string, boolean>;
          outputStyle?: string;
          fastMode?: boolean;
          dialogExpiry?: string;
        };
        skills?: string;
        plugins?: Array<{ type?: string; path?: string }>;
      } | undefined;
      expect(opts?.settingSources).toEqual(expect.arrayContaining(["user", "project"]));
      expect(opts?.skills).toBe("all");
      expect(opts?.plugins).toEqual(expect.arrayContaining([
        { type: "local", path: fs.realpathSync(bundledSkillRoot) },
      ]));
      expect(opts?.plugins).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: repositorySkillRoot }),
      ]));
      expect(opts?.includeHookEvents).toBe(true);
      expect(opts?.promptSuggestions).toBe(true);
      expect(opts?.perTaskStopAffordance).toBe(true);
      // Never passed: it is a Claude Settings key, not a query Option. Sending
      // it made the SDK reject the turn with a 429 instead of honouring it.
      expect(opts?.autoContinueAtUsageLimit).toBeUndefined();
      // No settings file names a style here, so ADE must not name one either:
      // its settings land at flag tier, above every file the SDK reads, so an
      // "outputStyle" key would override the user's global selection.
      expect(opts?.settings).not.toHaveProperty("outputStyle");
      expect(opts?.settings).toEqual(expect.objectContaining({
        // ADE's own default, which applies only while no settings file states one.
        workflowSizeGuideline: "medium",
        fastMode: false,
        dialogExpiry: "never",
        enabledPlugins: expect.objectContaining({
          "learning-output-style@claude-code-plugins": false,
          "learning-output-style@claude-plugins-official": false,
          "explanatory-output-style@claude-code-plugins": false,
          "explanatory-output-style@claude-plugins-official": false,
        }),
      }));
    });

    it("passes the user's global output style through instead of pinning Default", async () => {
      // The regression this guards: ADE substituted "Default" for "nothing is
      // set" and passed it at flag tier, so a style configured in the user's
      // settings.json never took effect in any ADE chat.
      const userClaudeDir = path.join(tmpRoot, "user-claude-config");
      fs.mkdirSync(path.join(userClaudeDir, "output-styles"), { recursive: true });
      fs.writeFileSync(
        path.join(userClaudeDir, "output-styles", "asd-ste100.md"),
        ["---", "name: ASD-STE100", "description: Simplified Technical English", "---", "", "Write short sentences.", ""].join("\n"),
      );
      fs.writeFileSync(
        path.join(userClaudeDir, "settings.json"),
        JSON.stringify({ outputStyle: "ASD-STE100", workflowSizeGuideline: "large" }),
      );
      const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = userClaudeDir;

      try {
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send: vi.fn(),
          stream: vi.fn(async function* () {
            return;
          }),
          close: vi.fn(),
          sessionId: "sdk-session-user-output-style",
        } as any);

        const { service } = createService();
        await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

        await vi.waitFor(() => {
          expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
        });

        const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
          settings?: { outputStyle?: string; workflowSizeGuideline?: string };
        } | undefined;
        expect(opts?.settings?.outputStyle).toBe("ASD-STE100");
        // A user-stated guideline replaces ADE's default rather than losing to it.
        expect(opts?.settings).not.toHaveProperty("workflowSizeGuideline");
      } finally {
        if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
    });

    it("passes Claude fast mode through SDK flag settings for Opus sessions", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-fast",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        fastMode: true,
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        settings?: { fastMode?: boolean };
      } | undefined;
      expect(opts?.settings?.fastMode).toBe(true);
    });

    it("uses updated Claude fast mode on the next SDK query", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await service.updateSession({
        sessionId: session.id,
        fastMode: true,
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start the Claude query.",
      }, { awaitDispatch: true });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        settings?: { fastMode?: boolean };
      } | undefined;
      expect(opts?.settings?.fastMode).toBe(true);
    });

    it("preserves Claude fast mode when switching to a fast-capable Claude model", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        fastMode: true,
      });

      // Opus 5 also supports fast mode, so the toggle should survive the switch.
      await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-opus-4-8",
      });

      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
    });

    it("clears Claude fast mode when switching to a non-fast Claude model", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        fastMode: true,
      });

      // Fast is a tier of one model. Sonnet has none, so the switch clears it
      // rather than leaving it hidden until a later fast-capable model.
      await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-5",
      });

      expect((await service.getSessionSummary(session.id))?.fastMode).not.toBe(true);
      expect(readPersistedChatState(session.id).fastMode).not.toBe(true);
    });

    it("handles Claude /fast commands inline and persists the ADE fast setting", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockClear();

      await service.sendMessage({
        sessionId: session.id,
        text: "/fast on",
      }, { awaitDispatch: true });

      expect(claudeSdkCreateSessionCompat).not.toHaveBeenCalled();
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Fast mode is on."
      )).toBe(true);
    });

    it("passes discovered local Claude plugins to SDK sessions", async () => {
      const pluginRoot = path.join(tmpRoot, ".claude", "plugins", "ade-tools", "review-pack");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "review-pack",
      }));
      fs.writeFileSync(path.join(tmpRoot, ".claude", "settings.json"), JSON.stringify({
        enabledPlugins: { "review-pack@local": true },
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-plugins",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        plugins?: Array<{ type?: string; path?: string }>;
      } | undefined;
      expect(opts?.plugins).toContainEqual({
        type: "local",
        path: fs.realpathSync(pluginRoot),
      });
    });

    it("loads user/project MCP servers in normal chats (no managed-only lock)", async () => {
      fs.writeFileSync(path.join(tmpRoot, ".mcp.json"), JSON.stringify({
        mcpServers: {
          projectTools: {
            command: "node",
            args: ["mcp-server.js"],
          },
        },
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-mcp",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        managedSettings?: Record<string, unknown>;
        settingSources?: string[];
        strictMcpConfig?: boolean;
      } | undefined;
      expect(opts).toBeTruthy();
      // Project/user setting sources stay enabled so the SDK reads the user's
      // configured MCP servers (.mcp.json / ~/.claude.json) — same as a terminal session.
      expect(opts?.settingSources).toEqual(expect.arrayContaining(["project"]));
      // ADE does not inject mcpServers into a normal chat,
      // and it no longer locks MCP to managed-only — so the user's servers can load.
      expect(opts).not.toHaveProperty("mcpServers");
      expect(opts?.managedSettings).toBeUndefined();
      // Inverse of the lightweight test: strictMcpConfig must NOT leak into normal
      // chats, or it would silently re-block the user's MCP servers we just enabled.
      expect(opts?.strictMcpConfig).toBeUndefined();
    });

    // The ADE SDK's whole per-thread MCP feature lands here: a caller's servers
    // have to reach the Claude query, and reach it *alongside* whatever ADE
    // already injects rather than replacing it.
    it("passes caller-injected MCP servers to the Claude query", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-caller-mcp",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: {
          embedderHttp: { type: "http", url: "https://example.test/mcp", headers: { "x-key": "v" } },
          embedderStdio: { type: "stdio", command: "node", args: ["server.js"], env: { A: "1" } },
        },
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        mcpServers?: Record<string, unknown>;
        strictMcpConfig?: boolean;
        settingSources?: string[];
      } | undefined;
      expect(opts?.mcpServers).toEqual({
        embedderHttp: { type: "http", url: "https://example.test/mcp", headers: { "x-key": "v" } },
        embedderStdio: { type: "stdio", command: "node", args: ["server.js"], env: { A: "1" } },
      });
      // Injecting servers is not the same as isolating the chat: without the
      // explicit flag the user's own MCP config must still load.
      expect(opts?.strictMcpConfig).toBeUndefined();
      expect(opts?.settingSources).toEqual(expect.arrayContaining(["project"]));
    });

    it("sets strictMcpConfig when the caller asks to exclude the user's MCP config", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-strict-mcp",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
        strictMcpConfig: true,
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        mcpServers?: Record<string, unknown>;
        strictMcpConfig?: boolean;
        settingSources?: string[];
      } | undefined;
      expect(opts?.strictMcpConfig).toBe(true);
      // strictMcpConfig is what withholds ~/.claude.json and .mcp.json. The
      // caller's own server must survive it, and settingSources must NOT be
      // trimmed — the user's rules, commands, and output styles are not MCP and
      // are not what the caller asked to exclude.
      expect(opts?.mcpServers).toHaveProperty("embedder");
      expect(opts?.settingSources).toEqual(expect.arrayContaining(["project"]));
    });

    it("hands Droid the exact server shapes its strict schema accepts", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
        mcpServers: {
          embedderStdio: { type: "stdio", command: "node", args: ["server.js"], env: { A: "1" } },
          embedderHttp: { type: "http", url: "https://example.test/mcp", headers: { "x-key": "v" } },
        },
      });
      await service.warmupModel({
        sessionId: session.id,
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      // Droid validates InitializeSessionRequestParams with a STRICT zod union:
      // the stdio variant has no `type` key and http headers are an array of
      // { name, value } pairs. ADE spread its own shape in, so every injected
      // server failed validation and the chat never started.
      expect(mockState.droidAcquireCalls.at(-1)?.mcpServers).toEqual([
        { name: "embedderStdio", command: "node", args: ["server.js"], env: { A: "1" } },
        {
          type: "http",
          name: "embedderHttp",
          url: "https://example.test/mcp",
          headers: [{ name: "x-key", value: "v" }],
        },
      ]);
    });

    it("refuses a Codex chat carrying an sse server it has no client for", async () => {
      const { service } = createService();
      // Codex's config table has `command` and `url`, and `url` is streamable
      // HTTP. Handing it an sse server connects over the wrong protocol — the
      // same silent under-delivery the Pi refusal exists to prevent.
      await expect(service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        mcpServers: {
          events: { type: "sse", url: "https://example.test/sse" },
          fine: { type: "http", url: "https://example.test/mcp" },
        },
      })).rejects.toThrow(/'events'/);
      expect(await service.listSessions("lane-1")).toEqual([]);

      // The same server on a provider that speaks SSE is untouched.
      const ok = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: { events: { type: "sse", url: "https://example.test/sse" } },
      });
      expect(ok.mcpServers).toEqual({ events: { type: "sse", url: "https://example.test/sse" } });
    });

    it("treats an empty mcpServers map as no request at all", async () => {
      const { service } = createService();
      // The refusal used to gate on raw truthiness, and `{}` is truthy — so a
      // caller asking for no servers was refused on Pi for under-delivering
      // nothing.
      const piDescriptor = createDynamicPiModelDescriptor("local", "empty-mcp");
      replaceDynamicPiModelDescriptors([piDescriptor]);
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "pi",
        model: piDescriptor.id,
        modelId: piDescriptor.id as never,
        mcpServers: {},
      });
      expect(session).not.toHaveProperty("mcpServers");
      expect(session).not.toHaveProperty("mcpCapability");
    });

    it("persists the Pi model a switch picks while no Pi runtime is live", async () => {
      const { service } = createService();
      const first = createDynamicPiModelDescriptor("anthropic", "claude-sonnet-5");
      const next = createDynamicPiModelDescriptor("openai", "gpt-5.4");
      replaceDynamicPiModelDescriptors([first, next]);
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "pi",
        model: first.id,
        modelId: first.id as never,
      });
      // The chat resumes a Pi session file on its next launch.
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        piSessionId: "pi-session-1",
        piProviderId: "anthropic",
        piModelId: "claude-sonnet-5",
      });

      await service.updateSession({ sessionId: session.id, modelId: next.id as never });

      // Writing the previous file's ids back made the next launch resume on
      // the old model while ADE showed the new one.
      expect(readPersistedChatState(session.id)).toMatchObject({
        modelId: next.id,
        piSessionId: "pi-session-1",
        piProviderId: "openai",
        piModelId: "gpt-5.4",
      });
    });

    it("reports delivery without claiming strict mode when strict was never requested", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
      });
      // Reporting Codex's strict residual here described an enforcement ADE was
      // never asked to perform: the user's own MCP config loads by design.
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.mcpCapability).toMatchObject({
        strictRequested: false,
        residual: null,
        delivered: true,
      });
      expect(summary?.mcpCapability?.mechanism).not.toContain("enabled = false");
      expect(summary).not.toHaveProperty("strictMcpConfig");
    });

    it("lets an embedder keep the user's MCP config on a lightweight personal chat", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-strict-false",
      } as any);

      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        // Every SDK/personal chat runs on this profile, and the profile forces
        // strictMcpConfig — so the SDK's `loadUserMcpServers: true` (wire:
        // strictMcpConfig false) was accepted and then silently overridden.
        sessionProfile: "light",
        surface: "personal",
        strictMcpConfig: false,
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        strictMcpConfig?: boolean;
      } | undefined;
      expect(opts?.strictMcpConfig).toBeUndefined();

      // The preference is persisted, so a resumed chat rebuilds the same
      // surface. Collapsing `false` to absent would silently re-strict it.
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.strictMcpConfig).toBe(false);
      const { service: restarted } = createService();
      expect((await restarted.getSessionSummary(created.id))?.strictMcpConfig).toBe(false);
    });

    it("keeps a lightweight chat strict when the caller states no preference", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-strict-default",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        sessionProfile: "light",
        surface: "personal",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        strictMcpConfig?: boolean;
      } | undefined;
      // Absent is not `false`: the profile still decides, and it decides strict.
      expect(opts?.strictMcpConfig).toBe(true);
    });

    it("reports the MCP capability on the session summary, not just in memory", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
        strictMcpConfig: true,
      });
      const expected = {
        level: "enforced",
        mechanism: expect.stringContaining("strictMcpConfig"),
        residual: null,
        delivered: true,
        strictRequested: true,
      };
      // The report is what an embedder reads to learn whether its request was
      // honored in full. Claude's strictMcpConfig is a real switch, so this is
      // the one provider that may claim "enforced".
      expect(created.mcpCapability).toEqual(expected);

      // Asserting only on the live session object is what let this ship broken:
      // every external caller (personalChats.call create/getSummary/list, the
      // renderer, mobile) reads the SUMMARY, which is built by a different
      // builder. A field that reaches one and not the other is invisible on the
      // wire, so the summary is the assertion that actually protects the SDK.
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.mcpCapability).toEqual(expected);
      expect(summary?.strictMcpConfig).toBe(true);
      expect(summary?.mcpServers).toEqual({
        embedder: { type: "http", url: "https://example.test/mcp" },
      });

      const listed = (await service.listSessions("lane-1")).find((row) => row.sessionId === created.id);
      expect(listed?.mcpCapability).toEqual(expected);
    });

    it("reports a strict-only request as delivered — there was nothing to drop", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        // Strict mode with no servers of its own is a legitimate request:
        // isolate this chat from the user's MCP config. Gating `delivered` on
        // the presence of servers reported `false` here, which reads to a
        // caller as "your request failed" on a perfectly enforced session.
        strictMcpConfig: true,
      });
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.mcpCapability).toEqual({
        level: "enforced",
        mechanism: expect.stringContaining("strictMcpConfig"),
        residual: null,
        delivered: true,
        strictRequested: true,
      });
      expect(summary?.strictMcpConfig).toBe(true);
      expect(summary).not.toHaveProperty("mcpServers");
    });

    it("recomputes the MCP report when a model switch crosses providers", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
        strictMcpConfig: true,
      });
      expect(created.mcpCapability).toMatchObject({ level: "enforced" });

      await service.updateSession({ sessionId: created.id, modelId: "gpt-5.4" as never });

      // Carrying Claude's "enforced" onto a Codex session would claim a
      // guarantee ADE is no longer keeping — Codex strict mode is best-effort
      // and has a residual the embedder must be told about.
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.provider).toBe("codex");
      expect(summary?.mcpCapability).toMatchObject({
        level: "best-effort",
        delivered: true,
      });
      expect(summary?.mcpCapability?.residual).toBeTruthy();
      expect(summary?.modelHandoffHistory).toEqual([
        expect.objectContaining({
          fromProvider: "claude",
          toProvider: "codex",
          fromModelId: expect.any(String),
          toModelId: expect.any(String),
        }),
      ]);
      expect(events.map((event) => event.event)).toContainEqual(
        expect.objectContaining({
          type: "model_handoff",
          fromProvider: "claude",
          toProvider: "codex",
        }),
      );

      const { service: restarted } = createService();
      await expect(restarted.getSessionSummary(created.id)).resolves.toMatchObject({
        modelHandoffHistory: summary?.modelHandoffHistory,
      });
    });

    it("does not record a handoff when the model switch stays inside one provider", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.updateSession({
        sessionId: created.id,
        modelId: "anthropic/claude-opus-5" as never,
      });

      // The chip means "a different agent picked this thread up". Opus and
      // Sonnet are the same agent, so emitting a handoff here produced the
      // nonsense card "Claude -> Claude" in the transcript.
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.provider).toBe("claude");
      expect(summary?.modelId).toBe("anthropic/claude-opus-5");
      expect(summary?.modelHandoffHistory ?? []).toEqual([]);
      expect(events.map((event) => event.event)).not.toContainEqual(
        expect.objectContaining({ type: "model_handoff" }),
      );
    });

    it("refuses a model switch onto a provider that cannot carry the injected servers", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
      });
      // Registers a Pi model so the switch has a real cross-provider target;
      // Pi is the only provider with no MCP surface at all.
      // Uses the registry's own factory: `replaceDynamicPiModelDescriptors`
      // silently ignores anything whose providerRoute is not "pi-sdk", so a
      // hand-rolled descriptor would register as nothing and the assertion
      // below would pass for the wrong reason.
      const piDescriptor = createDynamicPiModelDescriptor("local", "test");
      replaceDynamicPiModelDescriptors([piDescriptor]);

      // Without this the switch was a way around the create-time refusal:
      // the chat would land on Pi with its injected servers silently gone.
      await expect(service.updateSession({
        sessionId: created.id,
        modelId: piDescriptor.id as never,
      })).rejects.toThrow(/injected MCP servers/);
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.provider).toBe("claude");
    });

    it("leaves a plain chat's model switch untouched by MCP logic", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.updateSession({ sessionId: created.id, modelId: "gpt-5.4" as never });
      const summary = await service.getSessionSummary(created.id);
      expect(summary?.provider).toBe("codex");
      // A chat that never asked for MCP must not acquire a report by switching.
      expect(summary).not.toHaveProperty("mcpCapability");
    });

    it("carries the MCP report across a restart, rebuilt from persisted state", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: { embedder: { type: "stdio", command: "node", args: ["s.js"] } },
        strictMcpConfig: true,
      });

      // A reopened thread must report the same guarantee it was created with.
      // Without persistence the summary would fall back to "no MCP requested",
      // which reads to a caller as a silently weakened isolation promise.
      const { service: restarted } = createService();
      const summary = await restarted.getSessionSummary(created.id);
      expect(summary?.strictMcpConfig).toBe(true);
      expect(summary?.mcpServers).toEqual({
        embedder: { type: "stdio", command: "node", args: ["s.js"] },
      });
      expect(summary?.mcpCapability).toMatchObject({ level: "enforced", delivered: true });
    });

    it("refuses to create a chat whose provider cannot accept the injected MCP servers", async () => {
      const { service } = createService();
      // Pi's SDK exposes no MCP configuration at all. Creating the chat anyway
      // hands the caller a thread that silently lacks the tools it asked for —
      // a confidently-wrong-answer bug with no signal. Refusing is the honest
      // outcome, and it happens before any session row is written.
      await expect(service.createSession({
        laneId: "lane-1",
        provider: "pi",
        model: "pi-model",
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
      })).rejects.toThrow(/cannot accept injected MCP servers/);
      expect(await service.listSessions("lane-1")).toEqual([]);
    });

    it("refuses a create whose mcpServers are partly invalid, rather than under-delivering", async () => {
      const { service } = createService();
      // Silently dropping the bad entry would hand back a chat missing a tool
      // the caller believes it has — the same silent under-delivery the Pi
      // refusal exists to prevent, one layer down.
      await expect(service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: {
          good: { type: "http", url: "https://example.test/mcp" },
          bad: { type: "http", url: "not-a-url" },
        },
      } as never)).rejects.toThrow(/bad/);
      expect(await service.listSessions("lane-1")).toEqual([]);
    });

    it("refuses a caller server whose name collides with an ADE-managed one", async () => {
      const { service } = createService();
      await expect(service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        mcpServers: { "ade-cto": { type: "http", url: "https://example.test/mcp" } },
      } as never)).rejects.toThrow(/reserved/);
    });

    it("leaves a chat that requests no MCP servers completely untouched", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      // A chat that never asked for injected MCP must not gain a single field,
      // or every existing chat's persisted state and provider options drift.
      expect(session).not.toHaveProperty("mcpServers");
      expect(session).not.toHaveProperty("strictMcpConfig");
      expect(session).not.toHaveProperty("mcpCapability");

      // Same invariant on the wire: an absent report is how a caller knows no
      // MCP was requested, so an empty-but-present field would be a false
      // positive for every chat ADE has ever created.
      const summary = await service.getSessionSummary(session.id);
      expect(summary).not.toHaveProperty("mcpServers");
      expect(summary).not.toHaveProperty("strictMcpConfig");
      expect(summary).not.toHaveProperty("mcpCapability");
    });

    // The CTO's operator tools used to exist only in the prompt manifest and the
    // tool-name preview — the bodies were never registered on a live session, so
    // the CTO was told it had tools it could not call.
    it("registers the CTO operator tools on a live Claude CTO session", async () => {
      const { service } = createService();
      const session = await service.ensureIdentitySession({ identityKey: "cto", laneId: "lane-1" });
      await service.updateSession({ sessionId: session.id, modelId: "anthropic/claude-sonnet-5" });
      await service.sendMessage({ sessionId: session.id, text: "status?" });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
      const server = opts?.mcpServers?.["ade-cto"];
      expect(server?.type).toBe("sdk");
      expect(createSdkMcpServer).toHaveBeenCalledWith(expect.objectContaining({
        name: "ade-cto",
        timeout: 120_000,
      }));
      const toolNames = Object.keys(server?.instance?._registeredTools ?? {});
      expect(toolNames).toContain("spawnChat");

      // Built from the LIVE session, not the `preview:<lane>` pseudo-session the
      // prompt manifest uses — that distinction is the whole bug this fixes.
      const { createCtoOperatorTools } = await import("../ai/tools/ctoOperatorTools");
      expect(vi.mocked(createCtoOperatorTools)).toHaveBeenCalledWith(
        expect.objectContaining({ currentSessionId: session.id, defaultLaneId: "lane-1" }),
      );

      // The CTO is a daily-driver chat: it must NOT get a strict-MCP session's
      // managed-only MCP lockdown, which would strip the user's own servers.
      expect(opts?.managedSettings?.allowManagedMcpServersOnly).toBeUndefined();
    });

    it("does not register CTO tools on an ordinary chat", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "",
        modelId: "anthropic/claude-sonnet-5",
      });
      await service.sendMessage({ sessionId: created.id, text: "hello" });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
      expect(opts?.mcpServers?.["ade-cto"]).toBeUndefined();
    });

    it("keeps lightweight sessions lean by ignoring on-disk MCP config (strictMcpConfig)", async () => {
      fs.writeFileSync(path.join(tmpRoot, ".mcp.json"), JSON.stringify({
        mcpServers: {
          projectTools: {
            command: "node",
            args: ["mcp-server.js"],
          },
        },
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-light-mcp",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        sessionProfile: "light",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        strictMcpConfig?: boolean;
        managedSettings?: Record<string, unknown>;
        settingSources?: string[];
      } | undefined;
      expect(opts).toBeTruthy();
      // Lightweight side-jobs (auto-title / lane-naming) don't get settingSources,
      // and the SDK loads all MCP sources when unconstrained — so strictMcpConfig must
      // be set to keep them from spawning the user's whole MCP fleet for a trivial job.
      expect(opts?.settingSources).toBeUndefined();
      expect(opts?.strictMcpConfig).toBe(true);
      expect(opts?.managedSettings).toBeUndefined();
    });

    describe("host instructions and settingSources on a personal Claude session", () => {
      const openPersonalClaudeSession = async (
        extra: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(claudeSdkSession("sdk-session-host-config") as any);
        const { service } = createService();
        await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
          surface: "personal",
          sessionProfile: "light",
          ...extra,
        } as never);
        await vi.waitFor(() => {
          expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
        });
        return vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as Record<string, unknown>;
      };

      // Every existing embedder passes nothing. `settingSources` must still be
      // explicit, because an omitted option and an empty array are not
      // documented to be the same thing in the Agent SDK.
      it("defaults to the ADE prompt and an empty settingSources list", async () => {
        const opts = await openPersonalClaudeSession({});
        expect(opts.systemPrompt).toContain("ADE personal chat");
        expect(opts.settingSources).toEqual([]);
      });

      it.each([
        ["none", []],
        ["project", ["project"]],
        ["user", ["user"]],
        ["all", ["user", "project", "local"]],
      ] as const)("maps settingSources %s to %j", async (value, expected) => {
        const opts = await openPersonalClaudeSession({ settingSources: value });
        expect(opts.settingSources).toEqual(expected);
      });

      it("appends host instructions after ADE's own prompt", async () => {
        const opts = await openPersonalClaudeSession({
          instructions: { mode: "append", text: "The project codeword is HALYARD." },
        });
        const prompt = opts.systemPrompt as string;
        expect(typeof prompt).toBe("string");
        expect(prompt).toContain("ADE personal chat");
        expect(prompt.endsWith("The project codeword is HALYARD.")).toBe(true);
      });

      it("accepts a bare string as an append", async () => {
        const opts = await openPersonalClaudeSession({ instructions: "The codeword is HALYARD." });
        const prompt = opts.systemPrompt as string;
        expect(prompt).toContain("ADE personal chat");
        expect(prompt.endsWith("The codeword is HALYARD.")).toBe(true);
      });

      // A host-branded assistant must never learn that ADE exists.
      it("drops ADE's prompt entirely for replace", async () => {
        const opts = await openPersonalClaudeSession({
          instructions: { mode: "replace", text: "You are the Halyard assistant." },
        });
        expect(opts.systemPrompt).toBe("You are the Halyard assistant.");
        expect(opts.systemPrompt as string).not.toContain("ADE personal chat");
      });

      it("reports what the provider did on the session summary", async () => {
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(claudeSdkSession("sdk-session-host-config-report") as any);
        const { service } = createService();
        const created = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
          surface: "personal",
          sessionProfile: "light",
          instructions: { mode: "replace", text: "You are the Halyard assistant." },
          settingSources: "project",
        } as never);
        const summary = await service.getSessionSummary(created.id);
        expect(summary?.instructionsCapability).toMatchObject({ level: "applied", mode: "replace" });
        expect(summary?.settingSourcesCapability).toMatchObject({ level: "applied", value: "project" });
      });

      // Absent means "never requested", exactly as mcpCapability does. A caller
      // that asked for nothing must not read a report about nothing.
      it("omits both capability reports when nothing was requested", async () => {
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(claudeSdkSession("sdk-session-host-config-absent") as any);
        const { service } = createService();
        const created = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
          surface: "personal",
          sessionProfile: "light",
        } as never);
        const summary = await service.getSessionSummary(created.id);
        expect(summary?.instructionsCapability).toBeUndefined();
        expect(summary?.settingSourcesCapability).toBeUndefined();
      });

      // The regression this whole feature has to not cause: an embedder that
      // passes no cwd keeps writing files exactly where it always did. The
      // previous version of this test built a path, never passed it anywhere,
      // and then asserted the result differed from it — which no implementation
      // could fail. Assert the resolved lane root instead. `realpathSync`
      // because the harness's temp root sits under `/var`, which is a symlink
      // to `/private/var` on macOS, and the lane launch context canonicalizes.
      it("leaves the lane root alone when no host cwd was requested", async () => {
        const baseline = await openPersonalClaudeSession({});
        expect(baseline.cwd).toBe(fs.realpathSync(tmpRoot));
      });

      it("runs the provider in the host cwd when one was requested", async () => {
        const baseline = await openPersonalClaudeSession({});
        const hostCwd = path.join(tmpRoot, "host-workspace");
        fs.mkdirSync(hostCwd, { recursive: true });
        const opts = await openPersonalClaudeSession({ requestedCwd: hostCwd });
        expect(opts.cwd).toBe(hostCwd);
        expect(opts.cwd).not.toBe(baseline.cwd);
      });

      // A work chat's lane worktree is a git invariant; a host cwd must never
      // move it, or the chat produces diffs against the wrong tree.
      it("ignores a requested cwd on a work session", async () => {
        const hostCwd = path.join(tmpRoot, "host-workspace-work");
        fs.mkdirSync(hostCwd, { recursive: true });
        const openWorkSession = async (extra: Record<string, unknown>) => {
          vi.mocked(claudeSdkCreateSessionCompat)
            .mockReturnValue(claudeSdkSession("sdk-session-host-cwd-work") as any);
          const { service } = createService();
          await service.createSession({
            laneId: "lane-1",
            provider: "claude",
            model: "sonnet",
            ...extra,
          });
          await vi.waitFor(() => {
            expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
          });
          return vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        };
        const baseline = await openWorkSession({});
        const withCwd = await openWorkSession({ requestedCwd: hostCwd });
        expect(withCwd.cwd).toBe(baseline.cwd);
        expect(withCwd.cwd).not.toBe(hostCwd);
      });

      // The `else if (!lightweight)` branch is untouched by this feature.
      it("leaves a full work session on the preset prompt and all three layers", async () => {
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(claudeSdkSession("sdk-session-host-config-work") as any);
        const { service } = createService();
        await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await vi.waitFor(() => {
          expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
        });
        const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        expect(opts.settingSources).toEqual(["user", "project", "local"]);
        expect(opts.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
      });
    });

    it("passes Claude subprocess spawns through the reaper", async () => {
      const spawnedProcess = { pid: 4321 };
      const claudeSubprocessReaper = {
        register: vi.fn(),
        spawnClaudeCodeProcess: vi.fn(() => spawnedProcess),
        reapForSession: vi.fn(),
        reapAll: vi.fn(),
        liveRecords: vi.fn(() => []),
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-reaper",
      } as any);

      const { service } = createService({ claudeSubprocessReaper });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        spawnClaudeCodeProcess?: (options: Record<string, unknown>) => unknown;
      } | undefined;
      const abortController = new AbortController();
      const result = opts?.spawnClaudeCodeProcess?.({
        command: "claude",
        args: ["--model", "sonnet"],
        cwd: tmpRoot,
        env: {},
        signal: abortController.signal,
      });

      expect(result).toBe(spawnedProcess);
      expect(claudeSubprocessReaper.spawnClaudeCodeProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "claude",
          args: ["--model", "sonnet"],
        }),
        expect.objectContaining({
          sessionId: session.id,
          laneId: "lane-1",
          cwd: expect.any(String),
        }),
      );

      await service.dispose({ sessionId: session.id });
      expect(claudeSubprocessReaper.reapForSession).toHaveBeenCalledWith(
        session.id,
        "ended_session",
      );
    });

    it("appends only the slash commands and skills Claude cannot discover itself", async () => {
      // `.claude/` is Claude Code's own root and this session sets
      // `settingSources: ["user","project","local"]`, so Claude already lists
      // these two. Repeating them spent system-prompt budget to say what the
      // model was about to be told anyway.
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "zz-native-cmd.md"), [
        "---",
        "description: Claude Code reads this command root itself",
        "---",
        "",
        "Audit the recent changes.",
        "",
      ].join("\n"));
      const claudeSkillDir = path.join(tmpRoot, ".claude", "skills", "native-only");
      fs.mkdirSync(claudeSkillDir, { recursive: true });
      fs.writeFileSync(path.join(claudeSkillDir, "SKILL.md"), [
        "---",
        "name: native-only",
        "description: Claude Code finds this one without ADE",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"));
      // `.agents/` is NOT a Claude-native root — verified against the shipped
      // binary — so this one only reaches the model because ADE lists it.
      const agentsSkillDir = path.join(tmpRoot, ".agents", "skills", "ade-injected-only");
      fs.mkdirSync(agentsSkillDir, { recursive: true });
      fs.writeFileSync(path.join(agentsSkillDir, "SKILL.md"), [
        "---",
        "name: ade-injected-only",
        "description: Only ADE can tell Claude about this one",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"));

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-slash-commands",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      const append = opts?.systemPrompt?.append ?? "";
      expect(append).toContain("## Project slash commands");
      expect(append).toContain("pre-expands the file's body");
      expect(append).toContain("/ade-injected-only — Only ADE can tell Claude about this one");
      expect(append).not.toContain("/zz-native-cmd");
      expect(append).not.toContain("/native-only");
    });

    it("clips an over-long skill description instead of letting it set the prompt size", async () => {
      const agentsSkillDir = path.join(tmpRoot, ".agents", "skills", "verbose-skill");
      fs.mkdirSync(agentsSkillDir, { recursive: true });
      fs.writeFileSync(path.join(agentsSkillDir, "SKILL.md"), [
        "---",
        "name: verbose-skill",
        `description: ${"x".repeat(5000)}`,
        "---",
        "",
        "Body.",
        "",
      ].join("\n"));

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-verbose-skill",
      } as any);

      const { service } = createService();
      await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      const append = opts?.systemPrompt?.append ?? "";
      expect(append).toContain("/verbose-skill");
      expect(append).not.toContain("x".repeat(2000));
      expect(append).toContain("…");
    });

    it("lists bundled ADE skills when no lane command files exist", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-no-slash-commands",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toBeTruthy();
      expect(opts?.systemPrompt?.append).toContain("## Project slash commands and skills");
      expect(opts?.systemPrompt?.append).toContain("/ade-cli-control-plane");
      expect(opts?.systemPrompt?.append).toContain("/ade-linear");
      expect(opts?.systemPrompt?.append).not.toContain("Commands (file-backed prompts):");
    });

    it("does not re-list lane commands Claude Code reads for itself", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      for (let index = 0; index < 25; index += 1) {
        fs.writeFileSync(path.join(commandsDir, `cmd-${String(index).padStart(2, "0")}.md`), [
          "---",
          `description: Command ${index}`,
          "---",
          "",
          `Run command ${index}.`,
          "",
        ].join("\n"));
      }

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-many-slash-commands",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      const append = opts?.systemPrompt?.append ?? "";
      // All 25 live in the lane's own `.claude/commands`, which Claude Code
      // reads for itself, so none of them belongs in ADE's listing — the cap
      // that used to hide five of them never had to run. The cap itself is
      // covered directly in claudeSlashCommandDiscovery.test.ts.
      expect(append).not.toContain("/cmd-00");
      expect(append).not.toContain("/cmd-19");
      expect(append).not.toContain("/cmd-24");
      expect(append).not.toContain("more command(s) hidden to keep startup context lean");
    });

    it("does not attach ADE-owned tool definitions to Claude SDK sessions", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-tool-allow",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        allowedTools?: string[];
      } | undefined;
      expect(opts?.allowedTools).toBeUndefined();
    });

    it("requests markdown previews for Claude AskUserQuestion by default", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-ask-user-preview",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        toolConfig?: { askUserQuestion?: { previewFormat?: string } };
      } | undefined;
      expect(opts?.toolConfig?.askUserQuestion?.previewFormat).toBe("markdown");
    });

    it("migrates legacy Claude plan mode into interaction mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      expect(session.interactionMode).toBe("plan");
      expect(session.claudePermissionMode).toBe("default");
      expect(session.permissionMode).toBe("plan");
    });

    it("sets sessionProfile to workflow by default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.sessionProfile).toBe("workflow");
    });

    it("respects custom sessionProfile", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        sessionProfile: "light",
      });

      expect(session.sessionProfile).toBe("light");
    });

    it("normalizes reasoning effort for opencode provider", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        reasoningEffort: "  HIGH  ",
      });

      expect(session.reasoningEffort).toBe("high");
    });

    it("sets surface to work by default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        sessionProfile: "light",
      });

      expect(session.surface).toBe("work");
    });

    it("sets surface to automation when specified", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "automation",
      });

      expect(session.surface).toBe("automation");
    });

    it("throws when opencode provider has no known model ID", async () => {
      const { service } = createService();
      await expect(
        service.createSession({
          laneId: "lane-1",
          provider: "opencode",
          model: "nonexistent-model-xyz",
        }),
      ).rejects.toThrow(/model/i);
    });

    it("attaches identityKey when provided", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        identityKey: "cto",
      });

      expect(session.identityKey).toBe("cto");
    });

    it("persists chat state to disk after creation", async () => {
      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const chatSessionsDir = path.join(tmpRoot, ".ade", "cache", "chat-sessions");
      const metaFiles = fs.readdirSync(chatSessionsDir).filter((f) => f.endsWith(".json"));
      expect(metaFiles.length).toBeGreaterThanOrEqual(1);

      const persisted = JSON.parse(fs.readFileSync(path.join(chatSessionsDir, metaFiles[0]!), "utf8"));
      expect(persisted.version).toBe(2);
      expect(persisted.provider).toBe("opencode");
    });

    it("preserves the personal surface when reconstructing a persisted session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "personal",
      });

      await service.dispose({ sessionId: session.id });
      await service.updateSession({ sessionId: session.id, title: "Reopened personal chat" });

      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        sessionId: session.id,
        surface: "personal",
      });
      expect(readPersistedChatState(session.id).surface).toBe("personal");
    });

    // The resume case from issue 1205: reopening a thread by key sends no first
    // message, so if the persona is not persisted nothing carries it back.
    it("re-applies host instructions and settingSources after a reconstruct", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "personal",
        instructions: { mode: "replace", text: "You are the Halyard assistant." },
        settingSources: "project",
      } as never);

      const persisted = readPersistedChatState(session.id);
      expect(persisted.instructions)
        .toEqual({ mode: "replace", text: "You are the Halyard assistant." });
      expect(persisted.settingSources).toBe("project");

      await service.dispose({ sessionId: session.id });
      await service.updateSession({ sessionId: session.id, title: "Reopened branded chat" });

      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        instructions: { mode: "replace", text: "You are the Halyard assistant." },
        settingSources: "project",
        instructionsCapability: { level: "applied", mode: "replace" },
        // OpenCode has no configuration-layer switch, so the honest answer is
        // "ignored" — reporting "applied" because the value round-tripped would
        // describe a load ADE is not performing.
        settingSourcesCapability: { level: "ignored", value: "project" },
      });
    });

    // The same defect, one field group over, and this one predates host
    // instructions: the row-based rehydrate rebuilt the session without the
    // caller-MCP trio, and that object is what the next persist writes back.
    // So an SDK chat kept its injected servers for exactly as long as nobody
    // renamed it, and then lost them and its capability report to disk.
    it("keeps caller MCP servers, the strict flag, and the capability report across a reconstruct", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        surface: "personal",
        sessionProfile: "light",
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
        // Explicitly false, not absent: a lightweight session is strict by
        // default, so this is the value most likely to be collapsed away.
        strictMcpConfig: false,
      });

      const beforeReconstruct = readPersistedChatState(session.id);
      expect(beforeReconstruct.mcpServers)
        .toEqual({ embedder: { type: "http", url: "https://example.test/mcp" } });
      expect(beforeReconstruct.strictMcpConfig).toBe(false);
      expect(beforeReconstruct.mcpCapability).toMatchObject({ level: "enforced" });

      await service.dispose({ sessionId: session.id });
      // One update is all it takes: this is the persist that used to write the
      // rehydrated session back over the good record.
      await service.updateSession({ sessionId: session.id, title: "Reopened MCP chat" });

      const afterReconstruct = readPersistedChatState(session.id);
      expect(afterReconstruct.mcpServers)
        .toEqual({ embedder: { type: "http", url: "https://example.test/mcp" } });
      expect(afterReconstruct.strictMcpConfig).toBe(false);
      expect(afterReconstruct.mcpCapability).toMatchObject({
        level: "enforced",
        strictRequested: false,
      });

      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
        strictMcpConfig: false,
        mcpCapability: { level: "enforced" },
      });
    });

    // A capability report is a claim about THIS provider. Copying the persisted
    // verdict forward lets a stale one outlive the provider it described — a
    // chat moved from Claude to Droid would keep reporting "applied on a real
    // system-prompt channel" forever. Both rehydrate paths therefore re-derive
    // from the persisted args plus the session's provider. The fake level on
    // disk stands in for that stale record.
    it("re-derives host capability reports on rehydrate instead of trusting the record", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        surface: "personal",
        sessionProfile: "light",
        instructions: { mode: "append", text: "You are the Halyard assistant." },
        settingSources: "project",
      } as never);

      expect(readPersistedChatState(session.id).instructionsCapability)
        .toMatchObject({ level: "applied" });

      await service.dispose({ sessionId: session.id });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        instructionsCapability: {
          level: "ignored",
          mode: "append",
          mechanism: "stale verdict from an older build",
          detail: "should be replaced on rehydrate",
        },
        settingSourcesCapability: {
          level: "ignored",
          value: "project",
          mechanism: "stale verdict from an older build",
          detail: "should be replaced on rehydrate",
        },
      });

      // A SECOND service, so nothing is left in `managedSessions` and the row
      // has to be rebuilt from the record on disk. Reusing the first service
      // would answer from the live session and never touch the rehydrate path
      // this test exists for.
      const { service: reopened } = createService();

      await expect(reopened.getSessionSummary(session.id)).resolves.toMatchObject({
        instructionsCapability: { level: "applied", mode: "append" },
        settingSourcesCapability: { level: "applied", value: "project" },
      });

      // And the corrected verdict is what gets written back, so the stale one
      // does not sit on disk waiting for the next reader.
      await reopened.updateSession({ sessionId: session.id, title: "Reopened" });
      expect(readPersistedChatState(session.id).instructionsCapability)
        .toMatchObject({ level: "applied" });
      expect(readPersistedChatState(session.id).settingSourcesCapability)
        .toMatchObject({ level: "applied" });
    });

    // The same defect again, and this field is a tool gate: a chat that lost
    // its policy on the first update after a restart would keep running with
    // no gate at all, which is the state the policy exists to replace.
    it("keeps the permission policy and its capability across a reconstruct", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        surface: "personal",
        sessionProfile: "light",
        permissionPolicy: {
          allowedTools: ["mcp:srv:*"],
          deniedTools: ["Bash"],
          sandboxRoot: tmpRoot,
          fallback: "ask",
        },
      } as never);

      const beforeReconstruct = readPersistedChatState(session.id);
      expect(beforeReconstruct.permissionPolicy).toEqual({
        allowedTools: ["mcp:srv:*"],
        deniedTools: ["Bash"],
        sandboxRoot: tmpRoot,
        fallback: "ask",
      });

      await service.dispose({ sessionId: session.id });
      await service.updateSession({ sessionId: session.id, title: "Reopened gated chat" });

      const afterReconstruct = readPersistedChatState(session.id);
      expect(afterReconstruct.permissionPolicy).toEqual({
        allowedTools: ["mcp:srv:*"],
        deniedTools: ["Bash"],
        sandboxRoot: tmpRoot,
        fallback: "ask",
      });
      // "ask" on Claude is best-effort: the tool lists are applied by the CLI,
      // but the ask verdict needs the Agent SDK prompt, which ADE does not own.
      expect(afterReconstruct.permissionCapability).toMatchObject({ level: "best-effort" });

      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        permissionPolicy: { fallback: "ask", deniedTools: ["Bash"] },
        permissionCapability: { level: "best-effort" },
      });
    });

    it("writes a chat transcript init record", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
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

    it("rejects chat creation when the selected lane worktree is unavailable", async () => {
      const { service, laneService } = createService();
      laneService.getLaneBaseAndBranch.mockReturnValue({
        baseRef: "main",
        branchRef: "feature/test",
        worktreePath: path.join(tmpRoot, "missing-lane"),
        laneType: "feature",
      });

      await expect(service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      })).rejects.toThrow(/worktree is unavailable/i);
    });
  });

  describe("launchHeadless", () => {
    it("creates a session and fires the kickoff turn fire-and-forget without a mounted pane", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-headless",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-headless",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service, sessionService } = createService();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        kickoffText: "Investigate the failing build and fix it.",
      });

      // createSession ran: a real session is returned and persisted, and
      // launchHeadless returned it immediately.
      expect(session).toBeDefined();
      expect(session.laneId).toBe("lane-1");
      expect(session.provider).toBe("claude");
      expect(sessionService.create).toHaveBeenCalledTimes(1);

      // The bug this fixes: with no mounted pane the kickoff never ran. Here the
      // kickoff text reaches the SDK *after* launchHeadless already resolved,
      // proving runSessionTurn fired fire-and-forget in the background.
      await vi.waitFor(() => {
        const payload = send.mock.calls
          .map((call) => String(call[0] ?? ""))
          .find((text) => text.includes("Investigate the failing build and fix it."));
        expect(payload).toBeTruthy();
      });
    });

    it("emits a persisted error when kickoff validation fails after the durable session is created", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        kickoffText: "/login",
      });

      expect(session).toBeDefined();
      await vi.waitFor(() => {
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            sessionId: session.id,
            event: expect.objectContaining({ type: "error", message: expect.stringMatching(/login/i) }),
          }),
        ]));
      });
    });

    it("terminates and persists a failed Codex kickoff when turn/start rejects", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const renameSync = vi.spyOn(fs, "renameSync");
      mockState.codexResponseOverrides.set("turn/start", {
        error: { code: -32_000, message: "turn start exploded" },
      });
      mockState.delayedCodexMethods.add("turn/start");
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        kickoffText: "Investigate the incident.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      renameSync.mockClear();
      mockState.flushCodexResponses();

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "done"
          && event.event.status === "failed",
      );

      const sessionEvents = events
        .filter((event) => event.sessionId === session.id)
        .map((event) => event.event);
      const errorIndex = sessionEvents.findIndex((event) =>
        event.type === "error" && /turn start exploded/i.test(event.message),
      );
      const failedIndex = sessionEvents.findIndex((event) =>
        event.type === "status"
        && event.turnStatus === "failed"
        && /turn start exploded/i.test(event.message ?? ""),
      );
      const doneIndex = sessionEvents.findIndex((event) =>
        event.type === "done" && event.status === "failed",
      );

      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(failedIndex).toBeGreaterThan(errorIndex);
      expect(doneIndex).toBeGreaterThan(failedIndex);
      expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      expect(renameSync).toHaveBeenCalledWith(
        expect.stringContaining(`.${session.id}.json.tmp-`),
        expect.stringContaining(`${session.id}.json`),
      );
    });

    it("returns the session and lets a pending kickoff turn outlive the default runSessionTurn timeout", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        // A turn that hangs forever would block the launch if it were awaited.
        const send = vi.fn(() => new Promise<void>(() => {}));
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream: vi.fn(() => (async function* () {
            await new Promise<void>(() => {});
          })()),
          close: vi.fn(),
          sessionId: "sdk-headless-pending",
          query: {
            setPermissionMode: vi.fn(async () => undefined),
            supportedCommands: vi.fn(async () => []),
          },
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        // Resolves promptly despite the hanging turn -> fire-and-forget.
        const session = await service.launchHeadless({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
          kickoffText: "Start the work.",
        });

        expect(session).toBeDefined();

        await vi.advanceTimersByTimeAsync(300_001);
        expect(events.find((event) =>
          event.event.type === "status" && event.event.turnStatus === "interrupted",
        )).toBeUndefined();
        expect(events.find((event) =>
          event.event.type === "error" && event.event.message.includes("Timed out waiting for session"),
        )).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("defaults the session to autonomous full-auto when no permission controls are supplied", async () => {
      // Map modes with the real semantics (full-auto => never / danger-full-access)
      // so the derived native codex fields prove launchHeadless defaulted the
      // session to full-auto — the only mode whose background turn never stalls
      // on a permission prompt no pane could answer.
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
        modelId: "gpt-5-codex",
        kickoffText: "Triage the incident.",
      });

      expect(session.codexApprovalPolicy).toBe("never");
      expect(session.codexSandbox).toBe("danger-full-access");
      expect(session.permissionMode).toBe("full-auto");
    });

    it("honors an explicit permissionMode supplied by the caller", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
        modelId: "gpt-5-codex",
        permissionMode: "edit",
        kickoffText: "Make a focused edit.",
      });

      // The caller's explicit mode wins over the full-auto default.
      expect(session.codexApprovalPolicy).toBe("untrusted");
      expect(session.codexSandbox).toBe("workspace-write");
      expect(session.permissionMode).toBe("edit");
    });

    it("persists the attached Linear issue link for a launched chat (FIX 1)", async () => {
      // Regression: launchHeadless passed contextAttachments to runSessionTurn,
      // but runSessionTurn dropped them before prepareSendMessage, so the
      // session→issue link was never recorded and agents reached for Linear MCP.
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-link",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-link",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service, laneService } = createService();
      const issue = makeLaneLinearIssue();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        kickoffText: "Fix the bug tracked by this issue.",
        contextAttachments: [makeLinearIssueContextAttachment(issue, "manual")],
      });

      // The session-scoped link is written so getSessionLinearEnv / the directive
      // resolve the issue and the agent uses `ade linear` instead of MCP.
      await vi.waitFor(() => {
        expect(laneService.attachLinearIssueToSession).toHaveBeenCalledWith(
          expect.objectContaining({
            chatSessionId: session.id,
            issues: expect.arrayContaining([expect.objectContaining({ id: issue.id })]),
          }),
        );
      });
      expect(mockState.sessionLinearLinks.get(session.id)?.[0]?.issue?.id).toBe(issue.id);
    });

    it("tags the backing terminal row with its owning chat session id (FIX 2)", async () => {
      // Regression: the chat's backing terminal was registered without a
      // chatSessionId, so laneAgents.ts could not exclude it and a phantom "CLI"
      // agent row appeared next to the chat row.
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          chatSessionId: session.id,
        }),
      );
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
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const summary = await service.getSessionSummary(created.id);
      expect(summary).not.toBeNull();
      expect(summary!.sessionId).toBe(created.id);
      expect(summary!.provider).toBe("opencode");

      const status = await service.getTurnStatus(created.id);
      expect(status).toMatchObject({
        sessionId: created.id,
        phase: "idle",
        provider: "opencode",
      });
    });

    it("surfaces and updates the first mirrored Claude SDK tag", async () => {
      installClaudeResponseFixture({ sdkSessionId: "sdk-tag-session", responseText: "unused" });
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: created.id,
        text: "Create the SDK session before tagging.",
        timeoutMs: 15_000,
      });

      await service.updateSession({ sessionId: created.id, tag: "review-ready" });
      expect(tagSession).toHaveBeenCalledWith(expect.any(String), "review-ready", {
        dir: fs.realpathSync(tmpRoot),
      });
      expect(sessionService.getClaudeSessionPointerByChatSessionId(created.id)?.tags).toEqual(["review-ready"]);
      await expect(service.getSessionSummary(created.id)).resolves.toMatchObject({
        claudeTag: "review-ready",
      });
      expect(events).toContainEqual(expect.objectContaining({
        event: { type: "session_meta_updated", claudeTag: "review-ready" },
      }));

      await service.updateSession({ sessionId: created.id, tag: "" });
      expect(tagSession).toHaveBeenLastCalledWith(expect.any(String), null, {
        dir: fs.realpathSync(tmpRoot),
      });
      await expect(service.getSessionSummary(created.id)).resolves.toMatchObject({ claudeTag: null });
    });
  });

  // --------------------------------------------------------------------------
  // getSessionCapabilities
  // --------------------------------------------------------------------------

  describe("getSessionCapabilities", () => {
    it("returns default capabilities for unknown session", () => {
      const { service } = createService();
      const caps = service.getSessionCapabilities({ sessionId: "unknown-id" });
      expect(caps).toMatchObject({
        supportsSubagentInspection: false,
        supportsSubagentControl: false,
        supportsReviewMode: false,
      });
      // Unknown session → the no-op subagent descriptor (nothing listable).
      expect(caps.subagent.canList).toBe(false);
      expect(caps.subagent.canViewFullTranscript).toBe(false);
    });

    it("returns capabilities for a opencode session (subagent inspection + transcript, no review)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const caps = service.getSessionCapabilities({ sessionId: session.id });
      // OpenCode child sessions are real sessions → listable with full transcript.
      expect(caps.supportsSubagentInspection).toBe(true);
      expect(caps.subagent.canList).toBe(true);
      expect(caps.subagent.canViewFullTranscript).toBe(true);
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
      expect(caps.subagent.canViewFullTranscript).toBe(true);
      // Claude consolidates multiple subagent kinds into one list.
      expect(caps.subagent.kinds.length).toBeGreaterThan(1);
      // supportsSubagentControl is true when a Claude runtime is initialized,
      // which createSession does eagerly for Claude sessions via ensureClaudeSessionRuntime.
      expect(caps.supportsSubagentControl).toBe(true);
      expect(caps.supportsReviewMode).toBe(false);
    });

    it("returns a cursor capability that lists subagents but cannot take over a transcript", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "",
        modelId: "cursor/auto",
      });

      const caps = service.getSessionCapabilities({ sessionId: session.id });
      expect(caps.subagent.canList).toBe(true);
      expect(caps.subagent.canViewFullTranscript).toBe(false);
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
        service.warmupModel({ sessionId: "no-such-session", modelId: "opencode/anthropic/claude-sonnet-5" }),
      ).resolves.toBeUndefined();
    });

    it("does nothing for non-anthropic model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      // A non-anthropic-cli model should be a no-op
      await expect(
        service.warmupModel({ sessionId: session.id, modelId: "opencode/anthropic/claude-sonnet-5" }),
      ).resolves.toBeUndefined();
    });

    it("does not rewrite a live session when the requested model does not match the backend session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await expect(
        service.warmupModel({ sessionId: session.id, modelId: "anthropic/claude-sonnet-5" }),
      ).resolves.toBeUndefined();

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.provider).toBe("opencode");
      expect(summary?.modelId).toBe("opencode/anthropic/claude-sonnet-5");
    });
  });

  // --------------------------------------------------------------------------
  // getAvailableModels
  // --------------------------------------------------------------------------

  describe("getAvailableModels", () => {
    it("keeps OpenCode model discovery passive on a cache miss", async () => {
      clearOpenCodeInventoryCache();
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "opencode" });

      expect(peekOpenCodeInventoryCache).toHaveBeenCalled();
      expect(probeOpenCodeProviderInventory).not.toHaveBeenCalled();
      expect(models).toEqual([]);
    });

    it("refreshes OpenCode models only when runtime activation is requested", async () => {
      clearOpenCodeInventoryCache();
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "opencode", activateRuntime: true });

      expect(probeOpenCodeProviderInventory).toHaveBeenCalled();
      expect(models.map((model) => model.id)).toContain("opencode/openai/gpt-5.4");
    });

    it("returns an array for codex provider", async () => {
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "codex" });
      expect(Array.isArray(models)).toBe(true);
    });

    it("pins GPT-6 Astra ahead of GPT-5.6 in filtered and provider-omitted catalogs", async () => {
      mockState.codexResponseOverrides.set("model/list", {
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
            ],
          },
          {
            id: "gpt-6-astra",
            displayName: "GPT-6-Astra",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
              { reasoningEffort: "max", description: "Max" },
            ],
            additionalSpeedTiers: ["fast"],
          },
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6-Luna",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
              { reasoningEffort: "max", description: "Max" },
            ],
            additionalSpeedTiers: ["fast"],
          },
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
              { reasoningEffort: "max", description: "Max" },
              { reasoningEffort: "ultra", description: "Ultra" },
            ],
            additionalSpeedTiers: ["fast"],
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
              { reasoningEffort: "max", description: "Max" },
              { reasoningEffort: "ultra", description: "Ultra" },
            ],
            additionalSpeedTiers: ["fast"],
          },
        ],
      });
      const { service } = createService();

      const models = await service.getAvailableModels({ provider: "codex" });

      expect(models.slice(0, 5).map((model) => model.id)).toEqual([
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ]);
      expect(models[0]).toMatchObject({
        isDefault: true,
        defaultReasoningEffort: "low",
        reasoningEfforts: [
          expect.objectContaining({ effort: "low" }),
          expect.objectContaining({ effort: "medium" }),
          expect.objectContaining({ effort: "high" }),
          expect.objectContaining({ effort: "xhigh" }),
          expect.objectContaining({ effort: "max" }),
        ],
        serviceTiers: ["fast"],
      });
      expect(models[0]?.reasoningEfforts?.map((entry) => entry.effort)).not.toContain("ultra");
      expect(models[1]).toMatchObject({ isDefault: false, defaultReasoningEffort: "low" });
      expect(models[1]?.reasoningEfforts?.map((entry) => entry.effort)).toEqual([
        "low", "medium", "high", "xhigh", "max", "ultra",
      ]);
      expect(models[2]?.isDefault).toBe(false);
      expect(models[3]?.reasoningEfforts?.map((entry) => entry.effort)).toEqual([
        "low", "medium", "high", "xhigh", "max",
      ]);
      expect(models[4]?.isDefault).toBe(false);

      const aggregate = await service.getAvailableModels({});
      const codexIds = new Set(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
      const aggregatedCodexModels = aggregate.filter((model) => codexIds.has(model.id));
      expect(aggregate.length).toBeGreaterThan(0);
      expect(aggregatedCodexModels).toEqual(models.slice(0, 5));
    });

    it("returns an array for claude provider", async () => {
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "claude" });
      expect(Array.isArray(models)).toBe(true);
    });

    it("uses the Qwen CLI's configured model instead of unrelated curated rows", async () => {
      vi.mocked(detectAllAuth).mockResolvedValue([
        {
          type: "cli-subscription",
          cli: "qwen",
          path: "/usr/local/bin/qwen",
          authenticated: true,
          verified: false,
        },
      ] as never);
      vi.mocked(detectCliAuthStatuses).mockResolvedValue([
        {
          cli: "qwen",
          installed: true,
          path: "/usr/local/bin/qwen",
          authenticated: true,
          verified: false,
        },
      ] as never);
      vi.mocked(loadQwenUserSettings).mockResolvedValue({
        authenticated: true,
        models: [{ id: "gpt-5.5", displayName: "gpt-5.5" }],
        defaultModelId: "gpt-5.5",
        selectedType: null,
        baseUrlOrigin: null,
      });

      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "qwen", activateRuntime: true });

      expect(models.map((model) => model.id)).toEqual(["qwen/gpt-5.5"]);
    });

    // Settings can switch a provider off. That has to mean the same thing on
    // every surface, so the gate lives on the one call every picker, the
    // catalog, and the cross-machine action all funnel through.
    it("offers nothing for a provider the user disabled, directly or in aggregate", async () => {
      const { service } = createService({
        projectConfigService: {
          get: vi.fn(() => ({ effective: { ai: { disabledProviders: ["claude"] } } })),
          getAll: vi.fn(() => ({})),
          set: vi.fn(),
        } as any,
      });

      expect(await service.getAvailableModels({ provider: "claude" })).toEqual([]);

      const aggregate = await service.getAvailableModels({});
      expect(aggregate.some((model) => model.family === "anthropic")).toBe(false);

      const catalog = await service.getModelCatalog({ mode: "force" });
      expect(catalog.groups.map((group) => group.key)).not.toContain("claude");
    });

    it("returns Cursor CLI models without requiring a Cursor SDK API key", async () => {
      delete process.env.CURSOR_API_KEY;
      vi.mocked(detectAllAuth).mockResolvedValue([
        {
          type: "cli-subscription",
          cli: "cursor",
          path: "/usr/local/bin/cursor-agent",
          authenticated: true,
          verified: true,
          paidPlan: true,
        },
      ]);
      vi.mocked(spawn).mockImplementationOnce(() => {
        const stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
        const stderr = new EventEmitter() as EventEmitter & { destroy: () => void };
        stdout.destroy = vi.fn();
        stderr.destroy = vi.fn();
        const child = new EventEmitter() as EventEmitter & {
          stdout: typeof stdout;
          stderr: typeof stderr;
          stdin: { destroy: () => void };
          kill: () => boolean;
          pid: number;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = { destroy: vi.fn() };
        child.kill = vi.fn(() => true);
        child.pid = 12345;
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from("auto - Auto\ncomposer-2 - Composer 2\n"));
          child.emit("close", 0);
        });
        return child as any;
      });

      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "cursor", activateRuntime: true });

      expect(models.map((model) => model.id)).toEqual(["cursor/auto", "cursor/composer-2"]);
      expect(models[0]).toMatchObject({
        cursorAvailability: { cli: true, sdk: false },
      });
      expect(models[0]?.description).toContain("Cursor CLI");

      // A surface that runs Cursor through the SDK (cursorSource: "sdk", e.g.
      // TUI/mobile chat) must not be offered these CLI-only models — they'd
      // fail on selection. With no SDK key configured, the sdk-scoped request
      // returns nothing rather than leaking the CLI-only rows.
      const sdkScoped = await service.getAvailableModels({
        provider: "cursor",
        activateRuntime: true,
        cursorSource: "sdk",
      });
      expect(sdkScoped).toEqual([]);
    });

    it("coalesces concurrent codex model discovery requests", async () => {
      const { service, logger } = createService();

      const [first, second] = await Promise.all([
        service.getAvailableModels({ provider: "codex" }),
        service.getAvailableModels({ provider: "codex" }),
      ]);

      expect(second).toEqual(first);
      const runtimeStarts = logger.info.mock.calls.filter(
        ([event]) => event === "agent_chat.codex_runtime_start",
      );
      expect(runtimeStarts).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Session creation edge cases
  // --------------------------------------------------------------------------

  describe("session creation edge cases", () => {
    /**
     * Drives one OpenCode turn against the mocked event stream.
     *
     * Every OpenCode streaming test needs the same six steps before it can assert
     * anything: gate `streamText`, create the session, send, wait for the started
     * status, reach into the mocked session state, and wake the stream's waiters
     * after pushing events. `finish` releases the gate and settles the send.
     */
    const startOpenCodeTurn = async (
      promptText: string,
      sessionOptions: { strictMcpConfig?: boolean; fastMode?: boolean; reasoningEffort?: string } = {},
    ) => {
      const events: AgentChatEventEnvelope[] = [];
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => { releaseStream = () => resolve(); });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await streamGate;
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "opencode/openai/gpt-5.4",
        modelId: "opencode/openai/gpt-5.4",
        ...sessionOptions,
      });

      const sendPromise = service.sendMessage({ sessionId: session.id, text: promptText });
      const started = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      const [sessionID, state] = [...mockState.openCodeSessions.entries()][0]!;
      // The casts live here so no test has to spell `as any` on every event.
      const pushEvents = (...next: any[]): void => {
        state.events.push(...next);
        const waiters = [...state.waiters];
        state.waiters.length = 0;
        waiters.forEach((waiter) => waiter());
      };
      const joined = (type: "text" | "reasoning"): string => events
        .filter((event) => event.event.type === type)
        .map((event) => (event.event as { text: string }).text)
        .join("");
      const waitForDone = (): Promise<AgentChatEventEnvelope> => waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === started.event.turnId,
      );
      const finish = async (): Promise<void> => {
        releaseStream();
        await sendPromise;
      };

      return {
        service,
        session,
        events,
        sessionID,
        pushEvents,
        joined,
        waitForDone,
        finish,
      };
    };

    it("applies automationId and automationRunId when surface is automation", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "automation",
        automationId: "auto-1",
        automationRunId: "run-1",
      });

      expect(session.surface).toBe("automation");
      expect(session.automationId).toBe("auto-1");
      expect(session.automationRunId).toBe("run-1");
    });

    it("creates a codex session with specified model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(session.provider).toBe("codex");
      expect(session.status).toBe("idle");
    });

    // The CTO surface offers its operator tools only to full-tooling sessions.
    it.each([
      ["opencode", "full_tooling", "", "opencode/anthropic/claude-sonnet-5"],
      ["copilot", "fallback", "gpt-5.4", "github-copilot/gpt-5.4"],
    ] as const)("gives a new %s session the %s capability mode", async (provider, expected, model, modelId) => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider, model, modelId });

      expect(session.capabilityMode).toBe(expected);
      expect((await service.getSessionSummary(session.id))?.capabilityMode).toBe(expected);
    });

    it("uses default execution mode for new sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      // executionMode defaults to null or undefined for new sessions
      expect(session.executionMode == null).toBe(true);
    });

    it("does not auto-upgrade guarded local opencode sessions into plan mode", async () => {
      replaceDynamicOpenCodeModelDescriptors([
        createDynamicOpenCodeModelDescriptor("lmstudio/qwen3.5-9b", {
          displayName: "qwen3.5-9b",
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
          openCodeProviderId: "lmstudio",
          openCodeModelId: "qwen3.5-9b",
        }),
      ]);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "LM Studio (Auto)",
        modelId: "lmstudio/auto",
      });

      expect(session.permissionMode).toBe("edit");
      expect(session.opencodePermissionMode).toBe("edit");
    });

    it("does not force an ADE OpenCode agent when config mode is selected", async () => {
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
        opencodePermissionMode: "config-toml",
      });

      expect(session.opencodePermissionMode).toBe("config-toml");
      expect(session.permissionMode).toBe("config-toml");

      await service.sendMessage({ sessionId: session.id, text: "Use configured OpenCode behavior." }, { awaitDispatch: true });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      expect(openCodeState.promptBodies.at(-1)).toEqual(expect.not.objectContaining({
        agent: expect.stringMatching(/^ade-/),
      }));
    });

    it("sends the fast variant for supported OpenCode models when enabled", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      replaceDynamicOpenCodeModelDescriptors([
        createDynamicOpenCodeModelDescriptor("", {
          displayName: "GPT 5.4",
          capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
          openCodeProviderId: "openai",
          openCodeModelId: "gpt-5.4",
          serviceTiers: ["fast"],
        }),
      ]);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
        fastMode: true,
      });

      expect(session.fastMode).toBe(true);

      await service.sendMessage({ sessionId: session.id, text: "Use OpenCode fast mode." }, { awaitDispatch: true });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      await vi.waitFor(() => {
        expect(openCodeState.promptBodies.length).toBeGreaterThan(0);
      });
      expect(openCodeState.promptBodies.at(-1)).toEqual(expect.objectContaining({
        variant: "fast",
      }));
    });

    it("sends OpenCode's own variant key for the chosen reasoning tier", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      const descriptor = createDynamicOpenCodeModelDescriptor("", {
        displayName: "DeepSeek Reasoner",
        capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
        openCodeProviderId: "deepseek",
        openCodeModelId: "deepseek-reasoner",
        reasoningTiers: ["low", "xhigh"],
      });
      // The model's OpenCode config names the tier `extra-high`.
      descriptor.openCodeVariantKeys = { xhigh: "extra-high" };
      replaceDynamicOpenCodeModelDescriptors([descriptor]);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/deepseek/deepseek-reasoner",
        reasoningEffort: "xhigh",
      });

      await service.sendMessage({ sessionId: session.id, text: "Think hard." }, { awaitDispatch: true });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      await vi.waitFor(() => {
        expect(openCodeState.promptBodies.length).toBeGreaterThan(0);
      });
      expect(openCodeState.promptBodies.at(-1)).toEqual(expect.objectContaining({
        variant: "extra-high",
      }));
    });

    /** GPT-5.4 as the inventory lists it when OpenCode also has its `-fast` sibling. */
    const registerOpenCodeFastSiblingRow = (): void => {
      const descriptor = createDynamicOpenCodeModelDescriptor("", {
        displayName: "GPT-5.4",
        capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
        openCodeProviderId: "openai",
        openCodeModelId: "gpt-5.4",
        reasoningTiers: ["low", "high"],
        serviceTiers: ["fast"],
        reportedTiers: true,
      });
      descriptor.openCodeFast = {
        withoutEffort: { modelId: "gpt-5.4-fast" },
        byEffort: {
          low: { modelId: "gpt-5.4-fast", variant: "low" },
          high: { modelId: "gpt-5.4-fast", variant: "high" },
        },
      };
      replaceDynamicOpenCodeModelDescriptors([descriptor]);
    };

    it("runs Fast with an effort as OpenCode's fast sibling model plus the effort variant", async () => {
      // OpenCode's prompt takes one `variant`. Sending `fast` there dropped the
      // effort; the sibling model keeps both.
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      registerOpenCodeFastSiblingRow();

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
        fastMode: true,
        reasoningEffort: "high",
      });

      await service.sendMessage({ sessionId: session.id, text: "Fast and careful." }, { awaitDispatch: true });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      await vi.waitFor(() => {
        expect(openCodeState.promptBodies.length).toBeGreaterThan(0);
      });
      expect(openCodeState.promptBodies.at(-1)).toEqual(expect.objectContaining({
        model: { providerID: "openai", modelID: "gpt-5.4-fast" },
        variant: "high",
      }));
    });

    it("keeps the effort and logs when OpenCode cannot run Fast with it", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      // A plain `fast` variant only: it cannot share the prompt's one `variant`.
      replaceDynamicOpenCodeModelDescriptors([
        createDynamicOpenCodeModelDescriptor("", {
          displayName: "GPT-5.4",
          capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
          openCodeProviderId: "openai",
          openCodeModelId: "gpt-5.4",
          reasoningTiers: ["low", "high"],
          serviceTiers: ["fast"],
          reportedTiers: true,
        }),
      ]);

      const { service, logger } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
        fastMode: true,
        reasoningEffort: "high",
      });

      await service.sendMessage({ sessionId: session.id, text: "Think hard." }, { awaitDispatch: true });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      await vi.waitFor(() => {
        expect(openCodeState.promptBodies.length).toBeGreaterThan(0);
      });
      expect(openCodeState.promptBodies.at(-1)).toEqual(expect.objectContaining({
        model: { providerID: "openai", modelID: "gpt-5.4" },
        variant: "high",
      }));
      const fastNotApplied = vi.mocked(logger.warn).mock.calls
        .filter(([event]) => event === "agent_chat.opencode_fast_not_applied");
      expect(fastNotApplied).toHaveLength(1);
      expect(fastNotApplied[0]![1]).toMatchObject({
        sessionId: session.id,
        modelId: "opencode/openai/gpt-5.4",
        reasoningEffort: "high",
        reason: "OpenCode cannot run GPT-5.4 in Fast mode at high effort.",
      });
    });

    it("lists an OpenCode approval that is blocking the session", async () => {
      // `hasLivePendingInput` consults five stores and `listPendingInputs` used
      // to read two, so an OpenCode chat reported `awaitingInput: true` with an
      // empty request list — "blocked, with nothing to show", which is exactly
      // the state the pending-inputs action exists to remove. An embedder that
      // reloads its UI has no other way to redraw the card.
      const events: AgentChatEventEnvelope[] = [];
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => { releaseStream = () => resolve(); });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await streamGate;
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "opencode/openai/gpt-5.4",
        modelId: "opencode/openai/gpt-5.4",
      });

      const sendPromise = service.sendMessage({ sessionId: session.id, text: "Run something." });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      const state = [...mockState.openCodeSessions.values()][0]!;
      state.events.push({
        type: "permission.asked",
        properties: {
          id: "perm-listable-1",
          sessionID: "opencode-session-1",
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
        },
      });
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "approval_request" && event.event.itemId === "perm-listable-1",
      );

      // The session says it is blocked...
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        awaitingInput: true,
      });
      // ...and can say what by.
      const pending = service.listPendingInputs({ sessionId: session.id });
      expect(pending.requests.map((request) => request.itemId)).toContain("perm-listable-1");
      expect(pending.requests[0]?.source).toBe("opencode");

      releaseStream();
      await sendPromise.catch(() => {});
    });

    it("full-auto answers an external_directory ask under the project .ade root without a card", async () => {
      // The test-drive block: a full-auto OpenCode chat waited eleven minutes
      // on `external_directory: <project>/.ade/*` — the observations and
      // artifacts the mac-desktop commands write. Full access has to include
      // the project's own state root, and answering before a card exists is
      // what keeps the card and `chat status` from disagreeing later.
      const events: AgentChatEventEnvelope[] = [];
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => { releaseStream = () => resolve(); });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await streamGate;
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "opencode/openai/gpt-5.4",
        modelId: "opencode/openai/gpt-5.4",
        opencodePermissionMode: "full-auto",
        permissionMode: "full-auto",
      });

      const sendPromise = service.sendMessage({ sessionId: session.id, text: "Use mac-desktop." });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      const state = [...mockState.openCodeSessions.values()][0]!;
      state.events.push({
        type: "permission.asked",
        properties: {
          id: "perm-ade-1",
          sessionID: "opencode-session-1",
          permission: "external_directory",
          patterns: [`${tmpRoot}/.ade/*`],
          metadata: {},
        },
      });
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());

      await vi.waitFor(() => {
        expect(state.permissionReply).toHaveBeenCalledWith(
          expect.objectContaining({ requestID: "perm-ade-1", reply: "always" }),
          expect.anything(),
        );
      });
      // No card was raised, so nothing is left for a later sweep to close
      // while the session summary still calls the chat blocked.
      expect(events.some((event) => event.event.type === "approval_request")).toBe(false);
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.awaitingInput ?? false).toBe(false);

      releaseStream();
      await sendPromise.catch(() => {});
    });

    it("full-auto still raises a card for an external_directory ask outside .ade", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => { releaseStream = () => resolve(); });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await streamGate;
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "opencode/openai/gpt-5.4",
        modelId: "opencode/openai/gpt-5.4",
        opencodePermissionMode: "full-auto",
        permissionMode: "full-auto",
      });

      const sendPromise = service.sendMessage({ sessionId: session.id, text: "Read /etc." });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      const state = [...mockState.openCodeSessions.values()][0]!;
      state.events.push({
        type: "permission.asked",
        properties: {
          id: "perm-etc-1",
          sessionID: "opencode-session-1",
          permission: "external_directory",
          patterns: ["/etc/*"],
          metadata: {},
        },
      });
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "approval_request" && event.event.itemId === "perm-etc-1",
      );
      expect(state.permissionReply).not.toHaveBeenCalled();

      releaseStream();
      await sendPromise.catch(() => {});
    });

    it("scopes the .ade auto-approval to literal paths inside the root", () => {
      // A glob in the middle cannot be proven inside the root without a glob
      // engine, and a pattern that escapes it must never be treated as the
      // project's own state.
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, [`${tmpRoot}/.ade/*`])).toBe(true);
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, [`${tmpRoot}/.ade`])).toBe(true);
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, [`.ade/artifacts/*`])).toBe(true);
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, ["/etc/*"])).toBe(false);
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, [`${tmpRoot}/.ade/../secrets/*`])).toBe(false);
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, [`${tmpRoot}/.ade/**/../../*`])).toBe(false);
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, [])).toBe(false);
      // One proven path does not vouch for an unproven sibling.
      expect(isOpenCodeExternalDirectoryInsideAdeRoot(tmpRoot, [`${tmpRoot}/.ade/*`, "/etc/*"])).toBe(false);
    });

    it("streams OpenCode assistant text from part deltas, without doubling it at the end", async () => {
      // OpenCode's processor calls updatePartDelta for every text-delta and
      // only calls updatePart at text-start and text-end. Ignoring
      // `message.part.delta` therefore meant nothing rendered until the turn
      // finished and the whole answer appeared in one jump. The closing
      // full-part update must not then re-emit the text a second time.
      const events: AgentChatEventEnvelope[] = [];
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => { releaseStream = () => resolve(); });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await streamGate;
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "opencode/openai/gpt-5.4",
        modelId: "opencode/openai/gpt-5.4",
      });

      const sendPromise = service.sendMessage({ sessionId: session.id, text: "Stream something." });
      const started = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      const state = [...mockState.openCodeSessions.values()][0]!;
      const pushEvents = (...next: any[]): void => {
        state.events.push(...next);
        const waiters = [...state.waiters];
        state.waiters.length = 0;
        waiters.forEach((waiter) => waiter());
      };

      const sessionID = "opencode-session-1";
      const renderedText = (): string => events
        .filter((event) => event.event.type === "text")
        .map((event) => (event.event as { text: string }).text)
        .join("");

      pushEvents(
        { type: "message.updated", properties: { info: { id: "msg-a", role: "assistant", sessionID } } },
        // text-start: the part exists but is still empty.
        { type: "message.part.updated", properties: { part: { id: "prt-a", type: "text", text: "", messageID: "msg-a", sessionID } } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-a", field: "text", delta: "Hello" } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-a", field: "text", delta: " world" } },
      );

      // The turn is still open and no closing full-part update has arrived, so
      // anything rendered here came from the deltas alone. This is the assertion
      // that fails when `message.part.delta` is ignored.
      await waitForEvent(events, (event): event is AgentChatEventEnvelope => event.event.type === "text");
      await vi.waitFor(() => { expect(renderedText()).toBe("Hello world"); });

      pushEvents(
        // text-end: the full accumulated part.
        { type: "message.part.updated", properties: { part: { id: "prt-a", type: "text", text: "Hello world", messageID: "msg-a", sessionID } } },
        { type: "session.idle", properties: { sessionID } },
      );

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === started.event.turnId,
      );

      // The closing full-part update must diff to nothing, not repeat the answer.
      expect(renderedText()).toBe("Hello world");

      releaseStream();
      await sendPromise;
    });

    it("routes OpenCode reasoning deltas (field \"text\") to reasoning, never to assistant text", async () => {
      // OpenCode's delta events name the part PROPERTY being appended to, not the
      // kind of part: a reasoning part's property is also called `text`, so its
      // deltas arrive with `field: "text"`. Classifying on `field` printed the
      // whole chain of thought as the assistant's answer, ran it together with
      // the real reply, and then repeated it inside the "Thought" chip when the
      // closing full part landed. Classify by the part kind instead.
      const turn = await startOpenCodeTurn("Think, then answer.");
      const { sessionID } = turn;

      turn.pushEvents(
        { type: "message.updated", properties: { info: { id: "msg-a", role: "assistant", sessionID } } },
        // reasoning-start: an empty reasoning part.
        { type: "message.part.updated", properties: { part: { id: "prt-r", type: "reasoning", text: "", messageID: "msg-a", sessionID } } },
        // reasoning-delta: published with field "text", not "reasoning".
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-r", field: "text", delta: "Let me weigh " } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-r", field: "text", delta: "the options." } },
        // text-start, then the real answer.
        { type: "message.part.updated", properties: { part: { id: "prt-t", type: "text", text: "", messageID: "msg-a", sessionID } } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-t", field: "text", delta: "Forty" } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-t", field: "text", delta: "-two." } },
      );

      await vi.waitFor(() => { expect(turn.joined("text")).toBe("Forty-two."); });
      expect(turn.joined("reasoning")).toBe("Let me weigh the options.");

      turn.pushEvents(
        // The closing full parts must diff to nothing, for both kinds.
        { type: "message.part.updated", properties: { part: { id: "prt-r", type: "reasoning", text: "Let me weigh the options.", messageID: "msg-a", sessionID } } },
        { type: "message.part.updated", properties: { part: { id: "prt-t", type: "text", text: "Forty-two.", messageID: "msg-a", sessionID } } },
        { type: "session.idle", properties: { sessionID } },
      );
      await turn.waitForDone();

      expect(turn.joined("reasoning")).toBe("Let me weigh the options.");
      expect(turn.joined("text")).toBe("Forty-two.");

      // The stored assistant message is the answer alone. Before the fix the
      // reasoning was appended to it, so the transcript replayed thoughts as
      // the reply.
      const transcript = await turn.service.getChatTranscript({ sessionId: turn.session.id });
      const assistantText = transcript.entries
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.text)
        .join("");
      expect(assistantText).toContain("Forty-two.");
      expect(assistantText).not.toContain("weigh");

      await turn.finish();
    });

    it("surfaces OpenCode provider retries as replaceable activity instead of transcript spam", async () => {
      // OpenCode retries a failing provider with exponential backoff and
      // publishes nothing but `session.status`. Without this handler the chat
      // showed a spinner for minutes and looked wedged.
      const turn = await startOpenCodeTurn("Ask a flaky provider.");
      const { sessionID } = turn;
      const providerMessage = "Upstream request failed: Endpoint is unavailable.";

      turn.pushEvents(
        {
          type: "session.status",
          properties: {
            sessionID,
            status: {
              type: "retry",
              attempt: 1,
              message: providerMessage,
              next: Date.now() + 8000,
              action: { title: { malformed: true }, message: null, link: 42 },
            },
          },
        },
        // The real sequence: OpenCode reports `busy` between two retry attempts.
        { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
        // The second attempt replaces the same inline status in the renderer.
        {
          type: "session.status",
          properties: {
            sessionID,
            status: { type: "retry", attempt: 2, message: providerMessage, next: Date.now() + 16000 },
          },
        },
        { type: "session.idle", properties: { sessionID } },
      );
      await turn.waitForDone();

      const retryActivities = turn.events
        .map((event) => event.event)
        .filter((event) => event.type === "activity" && event.activity === "working") as Array<{
          detail?: string;
        }>;
      expect(retryActivities).toHaveLength(2);
      expect(retryActivities[0]!.detail).toMatch(/^Retrying OpenCode · attempt 1 · retrying in /);
      expect(retryActivities[1]!.detail).toMatch(/^Retrying OpenCode · attempt 2 · retrying in /);
      expect(retryActivities.every((event) => (event as { providerRetry?: true }).providerRetry === true)).toBe(true);
      expect(turn.events.some((event) => event.event.type === "system_notice" && event.event.noticeKind === "provider_health")).toBe(false);

      await turn.finish();
    });

    it("keeps an OpenCode auto-compaction summary message out of the assistant's answer", async () => {
      // Auto-compaction writes its recap into a REAL assistant message flagged
      // `summary: true` and streams it as ordinary text parts, so the
      // assistant-role gate alone let a summary of the whole conversation render
      // as the model's reply. The compaction part and `session.compacted`
      // already report that compaction happened.
      const turn = await startOpenCodeTurn("Long conversation.");
      const { sessionID } = turn;

      turn.pushEvents(
        // The compaction summary message.
        { type: "message.updated", properties: { info: { id: "msg-sum", role: "assistant", sessionID, summary: true } } },
        { type: "message.part.updated", properties: { part: { id: "prt-sum", type: "text", text: "", messageID: "msg-sum", sessionID } } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-sum", partID: "prt-sum", field: "text", delta: "SUMMARY_OF_EVERYTHING" } },
        { type: "message.part.updated", properties: { part: { id: "prt-sum", type: "text", text: "SUMMARY_OF_EVERYTHING", messageID: "msg-sum", sessionID } } },
        // The real reply that follows it.
        { type: "message.updated", properties: { info: { id: "msg-a", role: "assistant", sessionID } } },
        { type: "message.part.updated", properties: { part: { id: "prt-a", type: "text", text: "", messageID: "msg-a", sessionID } } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-a", field: "text", delta: "Here is the answer." } },
        { type: "message.part.updated", properties: { part: { id: "prt-a", type: "text", text: "Here is the answer.", messageID: "msg-a", sessionID } } },
        { type: "session.idle", properties: { sessionID } },
      );
      await turn.waitForDone();

      expect(turn.joined("text")).toBe("Here is the answer.");
      expect(turn.joined("text")).not.toContain("SUMMARY_OF_EVERYTHING");

      const transcript = await turn.service.getChatTranscript({ sessionId: turn.session.id });
      const assistantText = transcript.entries
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.text)
        .join("");
      expect(assistantText).not.toContain("SUMMARY_OF_EVERYTHING");

      await turn.finish();
    });

    it("treats an OpenCode ContextOverflowError as recoverable instead of failing the turn", async () => {
      // OpenCode usually publishes this error, compacts the conversation itself,
      // and keeps going — it never idles at that point. Throwing killed a turn
      // that was about to resume on its own.
      const turn = await startOpenCodeTurn("Overflow the context.");
      const { sessionID } = turn;

      turn.pushEvents(
        {
          type: "session.error",
          properties: {
            sessionID,
            error: { name: "ContextOverflowError", data: { message: "Context window exceeded." } },
          },
        },
        // OpenCode compacts and carries on in the same turn.
        { type: "message.updated", properties: { info: { id: "msg-a", role: "assistant", sessionID } } },
        { type: "message.part.updated", properties: { part: { id: "prt-a", type: "text", text: "", messageID: "msg-a", sessionID } } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-a", field: "text", delta: "Carried on." } },
        { type: "session.idle", properties: { sessionID } },
      );
      const done = await turn.waitForDone();

      expect((done.event as { status: string }).status).toBe("completed");
      expect(turn.events.filter((event) => event.event.type === "error")).toHaveLength(0);
      const notices = turn.events
        .map((event) => event.event)
        .filter((event) => event.type === "system_notice") as Array<{ message: string; detail?: unknown }>;
      expect(notices).toHaveLength(1);
      expect(notices[0]!.message).toContain("Context limit reached");
      expect(String(notices[0]!.detail)).toContain("Context window exceeded.");

      await turn.finish();
    });

    it("fails an OpenCode turn whose context overflow never recovered", async () => {
      // The overflow is not always recoverable: with `compaction.auto` off
      // OpenCode idles without compacting, and compaction itself can overflow
      // again and stop. No further assistant text arrives, and calling that a
      // completed turn tells the user their question was answered.
      const turn = await startOpenCodeTurn("Overflow with auto-compaction off.");
      const { sessionID } = turn;

      turn.pushEvents(
        {
          type: "session.error",
          properties: {
            sessionID,
            error: { name: "ContextOverflowError", data: { message: "Context window exceeded." } },
          },
        },
        // No assistant text follows: OpenCode simply goes idle.
        { type: "session.idle", properties: { sessionID } },
      );
      const done = await turn.waitForDone();

      expect((done.event as { status: string }).status).toBe("failed");
      const errors = turn.events
        .map((event) => event.event)
        .filter((event) => event.type === "error") as Array<{ message: string }>;
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("Context window exceeded.");

      await turn.finish();
    });

    it("renders an OpenCode abort from another client as an interruption, not a failure", async () => {
      // The OpenCode TUI or CLI sharing this server can stop a session ADE is
      // streaming. OpenCode reports that as MessageAbortedError and then idles;
      // rendering it red made somebody else's stop look like ADE breaking.
      const turn = await startOpenCodeTurn("Start something long.");
      const { sessionID } = turn;

      turn.pushEvents(
        {
          type: "session.error",
          properties: {
            sessionID,
            error: { name: "MessageAbortedError", data: { message: "aborted" } },
          },
        },
        { type: "session.idle", properties: { sessionID } },
      );
      const done = await turn.waitForDone();

      expect((done.event as { status: string }).status).toBe("interrupted");
      expect(turn.events.filter((event) => event.event.type === "error")).toHaveLength(0);

      await turn.finish();
    });

    it("keeps draining OpenCode events while a question waits for the user", async () => {
      // Awaiting the answer inside the event loop stalled the whole stream: while
      // the modal was open, nothing else drained — no subagent approval, no
      // streamed text, no tool result — until the person answered.
      const turn = await startOpenCodeTurn("Ask me something.");
      const { sessionID } = turn;

      turn.pushEvents(
        {
          type: "question.asked",
          properties: {
            id: "question-1",
            sessionID,
            tool: "ask",
            questions: [{ question: "Which approach?", header: "Approach", options: [] }],
          },
        },
        // Published while the question is still open.
        { type: "message.updated", properties: { info: { id: "msg-a", role: "assistant", sessionID } } },
        { type: "message.part.updated", properties: { part: { id: "prt-a", type: "text", text: "", messageID: "msg-a", sessionID } } },
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-a", partID: "prt-a", field: "text", delta: "Streamed while asking." } },
      );

      const approval = await waitForEvent(
        turn.events,
        (event): event is AgentChatEventEnvelope => event.event.type === "approval_request",
      );

      // This is the assertion that fails when the loop blocks on the answer.
      await vi.waitFor(() => {
        expect(turn.joined("text")).toBe("Streamed while asking.");
      });

      await turn.service.respondToInput({
        sessionId: turn.session.id,
        itemId: (approval.event as { itemId: string }).itemId,
        decision: "decline",
      });

      turn.pushEvents({ type: "session.idle", properties: { sessionID } });
      await turn.waitForDone();

      await turn.finish();
    });

    it("cancels an open OpenCode question when the turn is interrupted", async () => {
      // `requestChatInput` parks the card in `managed.localPendingInputs`, which
      // the OpenCode interrupt path never drained. The leftover entry kept the
      // session reported as blocked, so the next send was refused, and a late
      // answer would have replied into an aborted session.
      const turn = await startOpenCodeTurn("Ask me something I will not answer.");
      const { sessionID } = turn;

      turn.pushEvents({
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID,
          tool: "ask",
          questions: [{ question: "Which approach?", header: "Approach", options: [] }],
        },
      });
      const approval = await waitForEvent(
        turn.events,
        (event): event is AgentChatEventEnvelope => event.event.type === "approval_request",
      );

      await turn.service.interrupt({ sessionId: turn.session.id });

      // The card is resolved as cancelled rather than left waiting forever.
      const resolved = await waitForEvent(
        turn.events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "pending_input_resolved"
          && (event.event as { itemId?: string }).itemId === (approval.event as { itemId: string }).itemId,
      );
      expect((resolved.event as { resolution: string }).resolution).toBe("cancelled");

      // And the session takes a new prompt instead of reporting itself blocked.
      turn.pushEvents({ type: "session.idle", properties: { sessionID } });
      await turn.waitForDone();
      await expect(
        turn.service.sendMessage({ sessionId: turn.session.id, text: "Next question." }),
      ).resolves.not.toThrow();

      await turn.finish();
    });

    it("cancels an open OpenCode question when an external abort ends the turn", async () => {
      // The other route to an interrupted turn. The OpenCode TUI or CLI on the
      // same server aborts the session: `session.error` sets `interrupted` and
      // the loop keeps going to idle, so the turn settles through the shared
      // completion path rather than ADE's own interrupt branch. That path did not
      // cancel, so the card survived a turn nobody could answer any more — and
      // `hasLivePendingInput` then refused the next send.
      const turn = await startOpenCodeTurn("Ask me something, then get aborted.");
      const { sessionID } = turn;

      turn.pushEvents({
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID,
          tool: "ask",
          questions: [{ question: "Which approach?", header: "Approach", options: [] }],
        },
      });
      const approval = await waitForEvent(
        turn.events,
        (event): event is AgentChatEventEnvelope => event.event.type === "approval_request",
      );

      turn.pushEvents(
        {
          type: "session.error",
          properties: {
            sessionID,
            error: { name: "MessageAbortedError", data: { message: "aborted" } },
          },
        },
        { type: "session.idle", properties: { sessionID } },
      );

      const done = await turn.waitForDone();
      expect((done.event as { status: string }).status).toBe("interrupted");

      const resolved = await waitForEvent(
        turn.events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "pending_input_resolved"
          && (event.event as { itemId?: string }).itemId === (approval.event as { itemId: string }).itemId,
      );
      expect((resolved.event as { resolution: string }).resolution).toBe("cancelled");

      // And the session is not left reporting itself blocked.
      await expect(
        turn.service.sendMessage({ sessionId: turn.session.id, text: "Next question." }),
      ).resolves.not.toThrow();

      await turn.finish();
    });

    it("shows generic progress after an OpenCode step finishes", async () => {
      // Otherwise the activity line keeps naming the step's last tool until the
      // next step-start, so a long gap between steps reads as a command that
      // never finished.
      const turn = await startOpenCodeTurn("Run a step.");
      const { sessionID } = turn;

      turn.pushEvents(
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "prt-step",
              type: "step-finish",
              messageID: "msg-a",
              sessionID,
              tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
            },
          },
        },
        { type: "session.idle", properties: { sessionID } },
      );
      await turn.waitForDone();

      const activities = turn.events
        .map((event) => event.event)
        .filter((event) => event.type === "activity") as Array<{ activity: string }>;
      expect(activities.some((activity) => activity.activity === "working")).toBe(true);

      await turn.finish();
    });

    it("reports an OpenCode turn's summed usage, provider cost, and last-step context", async () => {
      // Every step is one model request. The done event used to carry only the
      // last step and dropped reasoning and cost; it now sums the turn and keeps
      // the last step's input side as the context the next request starts from.
      // OpenCode's auth.json is read from this data dir, never the machine's.
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      const openCodeDataHome = path.join(tmpRoot, "xdg-data");
      fs.mkdirSync(path.join(openCodeDataHome, "opencode"), { recursive: true });
      fs.writeFileSync(
        path.join(openCodeDataHome, "opencode", "auth.json"),
        JSON.stringify({ openai: { type: "oauth", access: "secret", accountId: "acct-test" } }),
      );
      process.env.XDG_DATA_HOME = openCodeDataHome;
      try {
        const turn = await startOpenCodeTurn("Use tools for a while.");
        const { sessionID } = turn;
        const stepFinish = (id: string, input: number, output: number, reasoning: number, read: number, write: number, cost: number) => ({
          type: "message.part.updated",
          properties: {
            part: {
              id,
              type: "step-finish",
              messageID: "msg-a",
              sessionID,
              reason: "tool-calls",
              cost,
              tokens: { input, output, reasoning, cache: { read, write } },
            },
          },
        });

        turn.pushEvents(
          {
            type: "message.updated",
            properties: {
              info: { id: "msg-a", role: "assistant", sessionID, providerID: "openai", modelID: "gpt-5.4-mini" },
            },
          },
          stepFinish("prt-1", 1_000, 100, 40, 5_000, 200, 0.01),
          stepFinish("prt-2", 300, 50, 10, 6_000, 0, 0.02),
          stepFinish("prt-3", 200, 80, 0, 6_300, 100, 0.03),
          { type: "session.idle", properties: { sessionID } },
        );
        const done = await turn.waitForDone();
        const doneEvent = done.event as Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        expect(doneEvent.usage).toEqual({
          inputTokens: 1_500,
          outputTokens: 230,
          cacheReadTokens: 17_300,
          cacheCreationTokens: 300,
          reasoningTokens: 50,
          // The model's context limit ADE already has for the descriptor.
          contextWindow: 200_000,
          contextTokens: 6_600,
          requestCount: 3,
        });
        expect(doneEvent.costUsd).toBeCloseTo(0.06, 10);
        expect(doneEvent.costSource).toBe("provider");
        // The request named openai/gpt-5.4; the assistant message says what answered.
        expect(doneEvent.servedModel).toBe("opencode/openai/gpt-5.4-mini");
        // An OAuth login in OpenCode's auth.json is a plan; the token never leaves the file.
        expect(doneEvent.account).toEqual({
          provider: "opencode",
          kind: "subscription",
          upstream: "openai",
          accountId: "acct-test",
        });

        const liveSamples = turn.events
          .map((event) => event.event)
          .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "context_usage" }> =>
            event.type === "context_usage");
        // One live meter sample per step, each the step's input side.
        expect(liveSamples.map((sample) => sample.usage.totalTokens)).toEqual([6_200, 6_300, 6_600]);
        expect(liveSamples.every((sample) => sample.origin === "live" && sample.state === "measured")).toBe(true);
        expect(liveSamples[2]?.usage.maxTokens).toBe(200_000);

        await turn.finish();
      } finally {
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    });

    it("names a strict-config OpenCode chat's account from its isolated server's store", async () => {
      // A strict-config chat runs its own OpenCode server on ADE's isolated
      // XDG_DATA_HOME; the user's login in their own store did not pay.
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      const previousXdgRoot = process.env.ADE_OPENCODE_XDG_ROOT;
      const userDataHome = path.join(tmpRoot, "user-xdg-data");
      const isolatedRoot = path.join(tmpRoot, "ade-opencode-runtime");
      const isolatedStore = path.join(isolatedRoot, "xdg-v1", "data", "opencode");
      fs.mkdirSync(path.join(userDataHome, "opencode"), { recursive: true });
      fs.mkdirSync(isolatedStore, { recursive: true });
      fs.writeFileSync(
        path.join(userDataHome, "opencode", "auth.json"),
        JSON.stringify({ openai: { type: "oauth", access: "secret", accountId: "acct-user" } }),
      );
      fs.writeFileSync(path.join(isolatedStore, "auth.json"), JSON.stringify({ openai: { type: "api", key: "secret" } }));
      process.env.XDG_DATA_HOME = userDataHome;
      process.env.ADE_OPENCODE_XDG_ROOT = isolatedRoot;
      try {
        const turn = await startOpenCodeTurn("Answer from the isolated server.", { strictMcpConfig: true });
        turn.pushEvents({ type: "session.idle", properties: { sessionID: turn.sessionID } });
        const done = await turn.waitForDone();
        const doneEvent = done.event as Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        expect(doneEvent.account).toEqual({ provider: "opencode", kind: "api_key", upstream: "openai" });
        await turn.finish();
      } finally {
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
        if (previousXdgRoot === undefined) delete process.env.ADE_OPENCODE_XDG_ROOT;
        else process.env.ADE_OPENCODE_XDG_ROOT = previousXdgRoot;
      }
    });

    it("reports no served-model change when the fast sibling ADE asked for answers", async () => {
      registerOpenCodeFastSiblingRow();
      const turn = await startOpenCodeTurn("Answer fast.", { fastMode: true, reasoningEffort: "high" });
      const { sessionID } = turn;
      turn.pushEvents(
        {
          type: "message.updated",
          properties: {
            info: { id: "msg-a", role: "assistant", sessionID, providerID: "openai", modelID: "gpt-5.4-fast" },
          },
        },
        { type: "session.idle", properties: { sessionID } },
      );
      const done = await turn.waitForDone();
      const doneEvent = done.event as Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
      expect(doneEvent.status).toBe("completed");
      expect(doneEvent.servedModel).toBeUndefined();
      await turn.finish();
    });

    it("ignores part deltas that belong to a user message", async () => {
      // The delta stream carries no role, so the same assistant-role gate that
      // protects `message.part.updated` has to protect this one — otherwise the
      // user's own prompt echoes back as agent output.
      const events: AgentChatEventEnvelope[] = [];
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => { releaseStream = () => resolve(); });
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await streamGate;
          yield { type: "finish", usage: {} };
        })(),
      }) as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "opencode/openai/gpt-5.4",
        modelId: "opencode/openai/gpt-5.4",
      });

      const sendPromise = service.sendMessage({ sessionId: session.id, text: "Echo check." });
      const started = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      const state = [...mockState.openCodeSessions.values()][0]!;
      const sessionID = "opencode-session-1";
      state.events.push(
        { type: "message.updated", properties: { info: { id: "msg-u", role: "user", sessionID } } } as any,
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-u", partID: "prt-u", field: "text", delta: "Echo check." } } as any,
        // A delta whose message was never announced stays unrendered too.
        { type: "message.part.delta", properties: { sessionID, messageID: "msg-unknown", partID: "prt-x", field: "text", delta: "orphan" } } as any,
        { type: "session.idle", properties: { sessionID } } as any,
      );
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === started.event.turnId,
      );

      const text = events
        .filter((event) => event.event.type === "text")
        .map((event) => (event.event as { text: string }).text)
        .join("");
      expect(text).not.toContain("Echo check.");
      expect(text).not.toContain("orphan");
      expect(text).toBe("");

      releaseStream();
      await sendPromise;
    });

    it("keeps ADE instructions in the system channel on every turn, never in user text", async () => {
      // The prompt boundary, asserted on the wire ADE actually sends:
      //  - ADE's instructions ride the first-class `system` field, so OpenCode
      //    never renders them as a user message (the reported prompt echo);
      //  - a second turn carries the same contract rather than re-appending the
      //    instructions to the user's text (the reported reprint);
      //  - the user's own words stay in `parts` and out of `system`, so nothing
      //    the user typed can be promoted into privileged instructions.
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

      // runSessionTurn awaits completion, so the second turn is a genuine
      // follow-up rather than a steer queued onto an active one.
      await service.runSessionTurn({ sessionId: session.id, text: "First request." });
      await service.runSessionTurn({ sessionId: session.id, text: "Second request." });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      await vi.waitFor(() => {
        expect(openCodeState.promptBodies.length).toBe(2);
      });

      const partsText = (body: any): string => (body.parts ?? [])
        .map((part: any) => String(part?.text ?? ""))
        .join("\n");

      // `buildCodingAgentSystemPrompt` is mocked to this sentinel at the top of
      // the file; what matters is which channel carries its output.
      for (const body of openCodeState.promptBodies) {
        expect(typeof body.system).toBe("string");
        expect(body.system).toContain("system prompt");
        // The instructions must not also be pasted into the visible message.
        expect(partsText(body)).not.toContain("system prompt");
      }

      const [first, second] = openCodeState.promptBodies;
      expect(second.system).toBe(first.system);
      expect(partsText(first)).toContain("First request.");
      expect(partsText(second)).toContain("Second request.");
      expect(second.system).not.toContain("Second request.");
      expect(second.system).not.toContain("First request.");
    });
  });

  // --------------------------------------------------------------------------
  // Session status transitions
  // --------------------------------------------------------------------------

  describe("session status transitions", () => {
    it("session starts with idle status", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.status).toBe("idle");
    });

    it("session has null completion initially", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.completion).toBeNull();
    });

    it("repairs a persisted row a liveness sweep wrongly detached, on the next turn", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "",
        modelId: "anthropic/claude-sonnet-5",
      });

      // What a boot / owner-liveness reconcile does to a chat whose owner it
      // cannot see. The in-memory session stays idle, so the old
      // `status === "ended"` check never fired and the row stayed `detached`
      // forever — the sidebar reads that as "Ended".
      const persisted = mockState.sessions.get(session.id);
      persisted.status = "detached";
      persisted.endedAt = "2026-03-17T00:20:00.000Z";

      await service.sendMessage({ sessionId: session.id, text: "still here" });

      expect(sessionService.reopen).toHaveBeenCalledWith(session.id);
      expect(mockState.sessions.get(session.id)).toEqual(expect.objectContaining({
        status: "running",
        endedAt: null,
      }));
    });
  });
});
