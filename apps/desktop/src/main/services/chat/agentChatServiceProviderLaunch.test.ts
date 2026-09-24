import {
  AgentChatEventEnvelope,
  BrowserActorCapabilityIssuer,
  claudeSdkCreateSessionCompat,
  claudeSdkSession,
  clearCursorCliModelsCache,
  createAcpRuntime,
  createAcpSessionPool,
  createDynamicPiModelDescriptor,
  createMockAcpAgent,
  createService,
  cursorModelsListMock,
  fs,
  mockState,
  os,
  path,
  probeCursorSdkModelDiscovery,
  query,
  readPersistedChatState,
  replaceDynamicPiModelDescriptors,
  respondWithSession,
  spawn,
  startup,
  waitFor,
  waitForEvent,
} from "./agentChatService.testHarness";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

describe("Cursor runs what the user picked", () => {
  type DoneEnvelope = AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> };
  const doneFor = (sessionId: string) => (event: AgentChatEventEnvelope): event is DoneEnvelope =>
    event.event.type === "done" && event.sessionId === sessionId;
  const cloudRepo = { repoUrl: "https://github.com/example/repo.git" };

  const composer2 = {
    id: "composer-2",
    displayName: "Composer 2",
    parameters: [
      { id: "reasoning_effort", displayName: "Reasoning effort", values: [{ value: "low" }, { value: "high" }] },
      {
        id: "verbosity",
        displayName: "Verbosity",
        values: [{ value: "terse", displayName: "Terse" }, { value: "verbose", displayName: "Verbose" }],
      },
    ],
  };
  const composer25 = {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [
      { id: "reasoning_effort", displayName: "Reasoning effort", values: [{ value: "low" }, { value: "high" }] },
      { id: "speed", displayName: "Speed", values: [{ value: "standard" }, { value: "fast" }] },
    ],
  };

  beforeEach(() => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    process.env.ADE_CURSOR_DASHBOARD_USAGE = "0";
  });
  afterEach(() => {
    delete process.env.ADE_CURSOR_DASHBOARD_USAGE;
  });

  it("sends a cloud follow-up the params it can express, and says once what it left out", async () => {
    // The only tier this model declares is standard, so Fast cannot be
    // expressed. A follow-up on a running conversation still goes, with the
    // params that did resolve, and the chat is told once.
    cursorModelsListMock.mockResolvedValue([{
      id: "composer-2",
      displayName: "Composer 2",
      parameters: [
        { id: "reasoning_effort", displayName: "Reasoning effort", values: [{ value: "high" }] },
        { id: "speed", displayName: "Speed", values: [{ value: "standard" }] },
      ],
    }]);
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      reasoningEffort: "high",
    } as any);
    await service.sendMessage({ sessionId: session.id, text: "Create.", runtime: "cloud", cloudOverrides: cloudRepo } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));
    const listCallsAfterCreate = cursorModelsListMock.mock.calls.length;

    await service.updateSession({ sessionId: session.id, fastMode: true });
    const allEvents: AgentChatEventEnvelope[] = [];
    for (const text of ["Follow up.", "Again."]) {
      events.length = 0;
      await service.sendMessage({ sessionId: session.id, text, runtime: "cloud" } as any, { awaitDispatch: true });
      await waitForEvent(events, doneFor(session.id));
      allEvents.push(...events);
    }

    const followups = mockState.cursorSdkCloudRequests.filter((request) => request.type === "cloud.followup");
    expect(followups).toHaveLength(2);
    expect(followups[0]?.payload.modelParams).toEqual([{ id: "reasoning_effort", value: "high" }]);
    const notices = allEvents.filter((event) =>
      event.sessionId === session.id
      && event.event.type === "system_notice"
      && event.event.message.includes("Cursor cannot apply the selected fast tier to composer-2"));
    expect(notices).toHaveLength(1);
    // The warm catalog for this key answered every follow-up: no fetch per run.
    expect(cursorModelsListMock.mock.calls.length).toBe(listCallsAfterCreate);
  });

  it("sends a cloud follow-up when the catalog cannot load", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
    await service.sendMessage({ sessionId: session.id, text: "Create.", runtime: "cloud", cloudOverrides: cloudRepo } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    cursorModelsListMock.mockRejectedValue(new Error("network down"));
    vi.mocked(globalThis.fetch).mockImplementation(async () => { throw new Error("network down"); });
    await service.updateSession({ sessionId: session.id, reasoningEffort: "high" });
    events.length = 0;
    await service.sendMessage({ sessionId: session.id, text: "Follow up.", runtime: "cloud" } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    const followup = mockState.cursorSdkCloudRequests.find((request) => request.type === "cloud.followup");
    expect(followup).toBeDefined();
    expect(followup?.payload.modelParams).toBeUndefined();
    expect(events.some((event) =>
      event.event.type === "system_notice"
      && event.event.message.includes("Cursor's model list could not be loaded"))).toBe(true);
  });

  it("refuses a cloud follow-up only for a model Cursor does not list", async () => {
    cursorModelsListMock.mockResolvedValue([composer2]);
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
    await service.sendMessage({ sessionId: session.id, text: "Create.", runtime: "cloud", cloudOverrides: cloudRepo } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    // The catalog no longer lists the model.
    clearCursorCliModelsCache();
    cursorModelsListMock.mockResolvedValue([composer25]);
    await service.updateSession({ sessionId: session.id, reasoningEffort: "high" });
    events.length = 0;
    await service.sendMessage({ sessionId: session.id, text: "Follow up.", runtime: "cloud" } as any, { awaitDispatch: true })
      .catch(() => undefined);
    const errorEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
        event.event.type === "error" && event.sessionId === session.id,
    );
    expect(errorEvent.event.message).toContain("Cursor Cloud does not list model composer-2");
    expect(mockState.cursorSdkCloudRequests.some((request) => request.type === "cloud.followup")).toBe(false);
  });

  it("sends a cloud follow-up the verified params of a fresh catalog read", async () => {
    cursorModelsListMock.mockResolvedValue([composer2]);
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      reasoningEffort: "high",
    } as any);
    await service.sendMessage({ sessionId: session.id, text: "Create.", runtime: "cloud", cloudOverrides: cloudRepo } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    events.length = 0;
    await service.sendMessage({ sessionId: session.id, text: "Follow up.", runtime: "cloud" } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    const followup = mockState.cursorSdkCloudRequests.find((request) => request.type === "cloud.followup");
    expect(followup?.payload.modelParams).toEqual([{ id: "reasoning_effort", value: "high" }]);
  });

  it("loads Cursor's catalog before a local send no picker ever warmed", async () => {
    // A CLI or automation chat: nothing called getModelCatalog, so the
    // in-memory catalog is empty when the first turn resolves its params.
    cursorModelsListMock.mockResolvedValue([composer25]);
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2.5",
      modelId: "cursor/composer-2.5",
      reasoningEffort: "high",
      fastMode: true,
    } as any);

    await service.sendMessage({ sessionId: session.id, text: "Go." }, { awaitDispatch: true });

    const expected = [
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "fast" },
    ];
    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(expect.objectContaining({ modelParams: expected }));
    expect(mockState.cursorSdkSendCalls.at(-1)).toEqual(expect.objectContaining({ modelParams: expected }));
  });

  it("says once, instead of silently dropping them, when the catalog cannot load for a local send", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("network down"));
    vi.mocked(globalThis.fetch).mockImplementation(async () => { throw new Error("network down"); });
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2.5",
      modelId: "cursor/composer-2.5",
      reasoningEffort: "high",
    } as any);

    await service.sendMessage({ sessionId: session.id, text: "Go." }, { awaitDispatch: true });

    expect(mockState.cursorSdkSendCalls.at(-1)?.modelParams).toBeUndefined();
    const notices = events.filter((event) =>
      event.sessionId === session.id
      && event.event.type === "system_notice"
      && event.event.message.includes("Cursor's model list could not be loaded"));
    expect(notices).toHaveLength(1);
    expect((notices[0]?.event as { message: string }).message).toContain("high reasoning effort");
  });

  it("sends the chat's Cursor config values as model params, local and cloud, and shows them as options", async () => {
    cursorModelsListMock.mockResolvedValue([composer2]);
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorConfigValues: { verbosity: "Verbose" },
    } as any);

    await service.sendMessage({ sessionId: session.id, text: "Local." }, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));
    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(expect.objectContaining({
      modelParams: [{ id: "verbosity", value: "verbose" }],
    }));
    expect(mockState.cursorSdkSendCalls.at(-1)).toEqual(expect.objectContaining({
      modelParams: [{ id: "verbosity", value: "verbose" }],
    }));

    // The composer renders the model's own options from the runtime snapshot;
    // effort has its own control and is not repeated there.
    const summary = await service.getSessionSummary(session.id);
    const options = summary?.cursorModeSnapshot?.configOptions ?? [];
    expect(options.map((option) => option.id)).toEqual(["verbosity"]);
    expect(options[0]).toMatchObject({ type: "select", currentValue: "Verbose" });
    expect(options[0]?.options?.map((choice) => choice.value)).toEqual(["", "terse", "verbose"]);

    // A change made in the composer rides the next run.
    await service.updateSession({ sessionId: session.id, cursorConfigValues: { verbosity: "terse" } });
    events.length = 0;
    await service.sendMessage({ sessionId: session.id, text: "Cloud.", runtime: "cloud", cloudOverrides: cloudRepo } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));
    const created = mockState.cursorSdkCloudRequests.find((request) => request.type === "cloud.send.stream");
    expect(created?.payload.modelParams).toEqual([{ id: "verbosity", value: "terse" }]);
  });

  it("shows a model option the chat never set as Cursor's default, not as an explicit value", async () => {
    cursorModelsListMock.mockResolvedValue([{
      ...composer2,
      parameters: [
        ...composer2.parameters,
        { id: "max_context", displayName: "Max context", values: [{ value: "true" }, { value: "false" }] },
      ],
    }]);
    // The picker's catalog fetch, which a desktop chat has already run.
    await probeCursorSdkModelDiscovery("cursor-test-key");
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
    await service.sendMessage({ sessionId: session.id, text: "Local." }, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    const options = (await service.getSessionSummary(session.id))?.cursorModeSnapshot?.configOptions ?? [];
    expect(options.map((option) => [option.id, option.type, option.currentValue])).toEqual([
      ["verbosity", "select", null],
      ["max_context", "boolean", null],
    ]);
    // Untouched options ride no param.
    expect(mockState.cursorSdkSendCalls.at(-1)?.modelParams ?? []).toEqual([]);
  });

  it("clears Fast on a switch to a model without a fast tier, and does not bring it back", async () => {
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "opus-5",
      modelId: "anthropic/claude-opus-5",
      fastMode: true,
    } as any);
    expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);

    // Opus to Fable: both have a fast tier, so the choice stands.
    await service.updateSession({ sessionId: session.id, modelId: "anthropic/claude-fable-5-1" });
    expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);

    // Sonnet has none. Left on, it hid behind the missing chip and came back
    // on the next fast-capable model.
    await service.updateSession({ sessionId: session.id, modelId: "anthropic/claude-sonnet-5" });
    expect((await service.getSessionSummary(session.id))?.fastMode).not.toBe(true);
    expect(readPersistedChatState(session.id).fastMode).not.toBe(true);

    await service.updateSession({ sessionId: session.id, modelId: "anthropic/claude-opus-5" });
    expect((await service.getSessionSummary(session.id))?.fastMode).not.toBe(true);
  });

  it("reads Cursor's catalog to decide whether Fast survives a Cursor model switch", async () => {
    cursorModelsListMock.mockResolvedValue([composer25, composer2]);
    await probeCursorSdkModelDiscovery("cursor-test-key");
    const listCalls = cursorModelsListMock.mock.calls.length;
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2.5",
      modelId: "cursor/composer-2.5",
      fastMode: true,
    } as any);

    // composer-2 declares no speed parameter.
    await service.updateSession({ sessionId: session.id, modelId: "cursor/composer-2" });
    expect((await service.getSessionSummary(session.id))?.fastMode).not.toBe(true);
    // The switch read the catalog in memory; it never fetched.
    expect(cursorModelsListMock.mock.calls.length).toBe(listCalls);
  });

  it("keeps Fast across a Cursor switch without waiting on a cold catalog", async () => {
    // A fetch that never answers: a switch that waited on it would hang here.
    cursorModelsListMock.mockImplementation(() => new Promise(() => {}));
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2.5",
      modelId: "cursor/composer-2.5",
      fastMode: true,
    } as any);

    await service.updateSession({ sessionId: session.id, modelId: "cursor/composer-2" });
    expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
  });

  it("keeps Fast across a Cursor switch when the catalog cannot say", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("network down"));
    vi.mocked(globalThis.fetch).mockImplementation(async () => { throw new Error("network down"); });
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2.5",
      modelId: "cursor/composer-2.5",
      fastMode: true,
    } as any);

    await service.updateSession({ sessionId: session.id, modelId: "cursor/composer-2" });
    expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
  });

  it("reconciles a cloud turn's served model against the cloud agent, not the local worker's", async () => {
    const settle = vi.fn(({ event }: { event: { turnId: string } }) => ({
      key: `session:${event.turnId}`,
      sessionId: "session",
      turnId: event.turnId,
      at: new Date().toISOString(),
    }));
    const ledger = {
      settle,
      observe: vi.fn(),
      amend: vi.fn(),
      nextTurnStartAfter: vi.fn(() => null),
    };
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      turnUsageLedger: ledger,
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
    await service.sendMessage({ sessionId: session.id, text: "Create.", runtime: "cloud", cloudOverrides: cloudRepo } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    // The real worker posts the run's start and then its result before the
    // request resolves, and the result clears the active cloud run.
    const pooled = mockState.cursorSdkPooled;
    const request = pooled.request;
    pooled.request = vi.fn(async (type: string, payload?: unknown) => {
      if (type === "cloud.followup") {
        pooled.bridge.onRunStarted?.(
          { agentId: "cloud-agent-1", runId: "cloud-run-2", modelSdkId: "composer-2" },
          { runtime: "cloud", runId: "cloud-run-2", agentId: "cloud-agent-1" },
        );
        pooled.bridge.onRunResult?.({ status: "finished" }, { runtime: "cloud", runId: "cloud-run-2", agentId: "cloud-agent-1" });
      }
      return request(type, payload);
    });
    mockState.turnUsageFollowUps = [];
    events.length = 0;
    await service.sendMessage({ sessionId: session.id, text: "Follow up.", runtime: "cloud" } as any, { awaitDispatch: true });
    await waitForEvent(events, doneFor(session.id));

    await vi.waitFor(() => expect(mockState.turnUsageFollowUps.length).toBeGreaterThan(0));
    expect(mockState.turnUsageFollowUps.at(-1)?.cursorAgentId).toBe("cloud-agent-1");
  });
});


describe("Pi follows the chat's effort and names another provider's route", () => {
  let sessionDir = "";
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-sessions-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    mockState.piInstallation = {
      cliPath: null,
      packageRoot: sessionDir,
      packageEntry: path.join(sessionDir, "index.js"),
      version: "0.0.0-test",
      nodeVersion: process.versions.node,
      sdkAvailable: true,
      cliAvailable: false,
      agentDir: sessionDir,
      settingsPath: path.join(sessionDir, "settings.json"),
      authPath: path.join(sessionDir, "auth.json"),
      modelsPath: path.join(sessionDir, "models.json"),
      modelsStorePath: path.join(sessionDir, "models-store.json"),
      blocker: null,
    };
  });
  afterEach(() => {
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  /** A live Pi worker that answers every call without running Pi. */
  const installFakePiWorker = (sendPrompt?: (pooled: any) => Promise<unknown>) => {
    const pooled: any = {
      process: { exitCode: null, killed: false, connected: true },
      bridge: { onEvent: null, onLifecycle: null, onUiRequest: null },
      ready: null,
      sessionFile: path.join(sessionDir, "pi-session.jsonl"),
      sessionId: "pi-session-1",
      currentModel: null,
      account: null,
      version: null,
      availableModels: [],
      request: vi.fn(async () => ({})),
      steer: vi.fn(async () => ({})),
      followUp: vi.fn(async () => ({})),
      abort: vi.fn(async () => {}),
      setModel: vi.fn(async () => ({})),
      setThinking: vi.fn(async () => ({})),
      compact: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => null),
      requestModels: vi.fn(async () => []),
      requestAuth: vi.fn(async () => ({})),
      login: vi.fn(async () => undefined),
      cancelLogin: vi.fn(),
      respondToUi: vi.fn(),
      dispose: vi.fn(),
    };
    pooled.sendPrompt = vi.fn(async () => (sendPrompt ? sendPrompt(pooled) : {}));
    mockState.piAcquire = async () => ({ generation: 1, pooled });
    return pooled;
  };

  const createPiSession = async (service: ReturnType<typeof createService>["service"], reasoningEffort?: string) => {
    const descriptor = createDynamicPiModelDescriptor("anthropic", "claude-sonnet-5");
    replaceDynamicPiModelDescriptors([descriptor]);
    return service.createSession({
      laneId: "lane-1",
      provider: "pi",
      model: descriptor.id,
      modelId: descriptor.id as never,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    } as any);
  };

  it("clears a live Pi session's thinking level when the chat clears its effort", async () => {
    const pooled = installFakePiWorker();
    const { service } = createService();
    const session = await createPiSession(service, "high");
    await service.resumeSession({ sessionId: session.id });
    expect(mockState.piAcquire).not.toBeNull();

    await service.updateSession({ sessionId: session.id, reasoningEffort: null });

    // Before, a cleared effort mapped to no level and nothing was sent, so the
    // live session kept thinking at `high`.
    expect(pooled.setThinking).toHaveBeenCalledWith(null);
    service.forceDisposeAll();
  });

  it("logs a Pi turn another provider answered, though the model name is the same", async () => {
    installFakePiWorker(async (pooled) => {
      pooled.bridge.onEvent?.({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "openrouter",
          model: "claude-sonnet-5",
          usage: { input: 10, output: 2 },
        },
      });
      return {};
    });
    const events: AgentChatEventEnvelope[] = [];
    const { service, logger } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await createPiSession(service);

    await service.sendMessage({ sessionId: session.id, text: "Go." }, { awaitDispatch: true });
    const done = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
        event.event.type === "done" && event.sessionId === session.id,
    );

    expect(done.event.servedModel).toBe("openrouter/claude-sonnet-5");
    expect(logger.warn).toHaveBeenCalledWith("agent_chat.served_model_mismatch", expect.objectContaining({
      sessionId: session.id,
      provider: "pi",
      servedModel: "openrouter/claude-sonnet-5",
    }));
    service.forceDisposeAll();
  });
});


describe("browser actor capability on a daemon-hosted chat", () => {
  /**
   * The runtime daemon cannot mint browser tokens itself: its issuer only has
   * the async `issue`, which asks the desktop over the bridge. Every provider
   * launch must still hand the agent a token, or `ade browser` reports "no
   * capability" from inside it. Each launch mints afresh, so the env must carry
   * the token issued for THIS launch, not one left over from an earlier one.
   */
  /** Launches one provider and returns the env it handed the agent. */
  type LaunchDriver = (issuer: BrowserActorCapabilityIssuer) => Promise<NodeJS.ProcessEnv | undefined>;

  const teardown: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of teardown.splice(0)) await dispose();
  });

  const openAcpService = (issuer: BrowserActorCapabilityIssuer) => {
    const agent = createMockAcpAgent();
    agent.on("session/new", respondWithSession("acp-session-1", {}));
    agent.on("session/set_config_option", () => ({ result: {} }));
    agent.on("session/prompt", async () => ({ result: { stopReason: "end_turn" } }));
    const pool = createAcpSessionPool();
    teardown.push(() => pool.disposeAll("test teardown"));
    return createService({
      browserActorCapabilityIssuer: issuer,
      acpSpawnOverride: () => agent.child,
      acpSessionPool: pool,
    });
  };

  const installPiWorker = (): Array<Record<string, unknown>> => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-browser-actor-"));
    const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    teardown.push(() => {
      if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
      fs.rmSync(sessionDir, { recursive: true, force: true });
    });
    mockState.piInstallation = {
      cliPath: null,
      packageRoot: sessionDir,
      packageEntry: path.join(sessionDir, "index.js"),
      version: "0.0.0-test",
      nodeVersion: process.versions.node,
      sdkAvailable: true,
      cliAvailable: false,
      agentDir: sessionDir,
      settingsPath: path.join(sessionDir, "settings.json"),
      authPath: path.join(sessionDir, "auth.json"),
      modelsPath: path.join(sessionDir, "models.json"),
      modelsStorePath: path.join(sessionDir, "models-store.json"),
      blocker: null,
    };
    const pooled: any = {
      process: { exitCode: null, killed: false, connected: true },
      bridge: { onEvent: null, onLifecycle: null, onUiRequest: null },
      ready: null,
      sessionFile: path.join(sessionDir, "pi-session.jsonl"),
      sessionId: "pi-session-1",
      currentModel: null,
      account: null,
      version: null,
      availableModels: [],
      request: vi.fn(async () => ({})),
      steer: vi.fn(async () => ({})),
      followUp: vi.fn(async () => ({})),
      abort: vi.fn(async () => {}),
      setModel: vi.fn(async () => ({})),
      setThinking: vi.fn(async () => ({})),
      compact: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => null),
      requestModels: vi.fn(async () => []),
      requestAuth: vi.fn(async () => ({})),
      login: vi.fn(async () => undefined),
      cancelLogin: vi.fn(),
      respondToUi: vi.fn(),
      dispose: vi.fn(),
      sendPrompt: vi.fn(async () => ({})),
    };
    const acquireCalls: Array<Record<string, unknown>> = [];
    mockState.piAcquire = async (args) => {
      acquireCalls.push(args);
      return { generation: 1, pooled };
    };
    return acquireCalls;
  };

  const sendAndDispose = async (
    service: ReturnType<typeof createService>["service"],
    sessionId: string,
  ) => {
    await service.sendMessage({ sessionId, text: "Open the app in the browser." }, { awaitDispatch: true });
    teardown.push(() => service.forceDisposeAll());
  };

  const launchPaths: Array<[string, LaunchDriver]> = [
    ["Claude pre-warm", async (issuer) => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(claudeSdkSession("sdk-browser-warm") as any);
      const { service } = createService({ browserActorCapabilityIssuer: issuer });
      await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      teardown.push(() => service.forceDisposeAll());
      await vi.waitFor(() => expect(startup).toHaveBeenCalled());
      await vi.waitFor(() => expect(claudeSdkCreateSessionCompat).toHaveBeenCalled());
      return (vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as { env?: NodeJS.ProcessEnv }).env;
    }],
    ["Claude cold query start", async (issuer) => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(claudeSdkSession("sdk-browser-cold") as any);
      // No warm query to reuse, so the turn launches the SDK itself.
      vi.mocked(startup).mockImplementationOnce(async () => {
        throw new Error("warm-up unavailable");
      });
      const { service } = createService({ browserActorCapabilityIssuer: issuer });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await sendAndDispose(service, session.id);
      await vi.waitFor(() => expect(query).toHaveBeenCalled());
      return (vi.mocked(query).mock.calls.at(-1)?.[0] as { options?: { env?: NodeJS.ProcessEnv } }).options?.env;
    }],
    ["Codex app-server", async (issuer) => {
      const { service } = createService({ browserActorCapabilityIssuer: issuer });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      await sendAndDispose(service, session.id);
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });
      const spawnCall = vi.mocked(spawn).mock.calls.find((call) =>
        call[0] === "codex" && Array.isArray(call[1]) && call[1].includes("app-server"));
      return (spawnCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    }],
    ["Cursor SDK", async (issuer) => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService({ browserActorCapabilityIssuer: issuer });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await sendAndDispose(service, session.id);
      return mockState.cursorSdkAcquireCalls.at(-1)?.baseEnv as NodeJS.ProcessEnv | undefined;
    }],
    ["Droid SDK", async (issuer) => {
      const { service } = createService({ browserActorCapabilityIssuer: issuer });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });
      await sendAndDispose(service, session.id);
      await vi.waitFor(() => expect(mockState.droidAcquireCalls.length).toBeGreaterThan(0));
      return mockState.droidAcquireCalls.at(-1)?.baseEnv as NodeJS.ProcessEnv | undefined;
    }],
    ["ACP agent (Qwen)", async (issuer) => {
      const { service } = openAcpService(issuer);
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "qwen",
        model: "qwen3-coder-plus",
        modelId: "qwen/qwen3-coder-plus",
      });
      await sendAndDispose(service, session.id);
      await vi.waitFor(() => expect(createAcpRuntime).toHaveBeenCalled());
      return vi.mocked(createAcpRuntime).mock.calls.at(-1)?.[0].spawnPlan.env;
    }],
    ["Pi SDK", async (issuer) => {
      const acquireCalls = installPiWorker();
      const descriptor = createDynamicPiModelDescriptor("anthropic", "claude-sonnet-5");
      replaceDynamicPiModelDescriptors([descriptor]);
      const { service } = createService({ browserActorCapabilityIssuer: issuer });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "pi",
        model: descriptor.id,
        modelId: descriptor.id as never,
      } as any);
      await sendAndDispose(service, session.id);
      await vi.waitFor(() => expect(acquireCalls.length).toBeGreaterThan(0));
      return acquireCalls.at(-1)?.baseEnv as NodeJS.ProcessEnv | undefined;
    }],
  ];

  it.each(launchPaths)("hands the %s launch the token issued for it", async (_label, launch) => {
    const issued: string[] = [];
    const issuer: BrowserActorCapabilityIssuer = {
      issue: async (capability) => {
        const token = `tok-${capability.chatSessionId}-${issued.length + 1}`;
        issued.push(token);
        return token;
      },
      revoke: async () => {},
    };

    const env = await launch(issuer);

    expect(issued.length).toBeGreaterThan(0);
    expect(env?.ADE_BROWSER_ACTOR_TOKEN).toBe(issued.at(-1));
    expect(env?.ADE_BROWSER_ACTOR_TOKEN).toMatch(new RegExp(`^tok-${env?.ADE_CHAT_SESSION_ID}-`));
  });
});
