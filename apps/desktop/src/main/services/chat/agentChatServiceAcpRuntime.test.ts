import {
  AcpHostModule,
  AcpSession,
  AcpSessionUpdate,
  AgentChatEventEnvelope,
  MockAcpAgent,
  createAcpRuntime,
  createAcpSessionPool,
  createMockAcpAgent,
  createService,
  getDynamicAcpModelDescriptors,
  getModelById,
  path,
  readPersistedChatState,
  respondWithSession,
  spawn,
  startup,
  waitFor,
  writePersistedChatState,
} from "./agentChatService.testHarness";
import { afterEach, describe, expect, it, test, vi } from "vitest";


// ---------------------------------------------------------------------------
// ACP providers (qwen, kimi, grok, copilot)
// ---------------------------------------------------------------------------
//
// These drive the real ACP host: the scripted agent is a fake child process, so
// the framing, the request correlation and the permission round-trip under test
// are the production ones. Only the operating system process is replaced.

/** Emit an `available_commands_update` for a scripted agent. */
function agentEmitCommands(
  agent: MockAcpAgent,
  sessionId: string,
  availableCommands: Array<{ name: string; description: string }>,
): void {
  agent.emitUpdate(sessionId, { sessionUpdate: "available_commands_update", availableCommands });
}

describe("acp chat runtime", () => {
  type AcpHarness = Awaited<ReturnType<typeof openAcpHarness>>;

  const acpTeardown: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of acpTeardown.splice(0)) dispose();
  });

  async function openAcpHarness(options: {
    provider: "qwen" | "kimi" | "grok" | "copilot";
    modelId: string;
    model: string;
    /** Extra `session/new` result fields, for config-option tests. */
    sessionExtra?: Record<string, unknown>;
    /** Seeded persisted state, for the resume test. */
    seedPersistedState?: Record<string, unknown>;
    sessionOverrides?: Record<string, unknown>;
  }) {
    const agent = createMockAcpAgent();
    agent.on("session/new", respondWithSession("acp-session-1", options.sessionExtra ?? {}));
    agent.on("session/load", respondWithSession("acp-session-1", options.sessionExtra ?? {}));
    agent.on("session/resume", respondWithSession("acp-session-1", options.sessionExtra ?? {}));
    agent.on("session/close", () => ({ result: {} }));
    agent.on("session/set_config_option", () => ({ result: {} }));
    agent.on("session/cancel", () => ({ result: {} }));

    const pool = createAcpSessionPool();
    acpTeardown.push(() => pool.disposeAll("test teardown"));

    const events: AgentChatEventEnvelope[] = [];
    const harness = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      acpSpawnOverride: () => agent.child,
      acpSessionPool: pool,
    });
    const session = await harness.service.createSession({
      laneId: "lane-1",
      provider: options.provider,
      model: options.model,
      modelId: options.modelId,
      ...(options.sessionOverrides ?? {}),
    });
    if (options.seedPersistedState) {
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        ...options.seedPersistedState,
      });
    }
    acpTeardown.push(() => { void harness.service.disposeAll(); });
    return { agent, events, session, ...harness };
  }

  /** Types of the events emitted for one turn, in order. */
  function eventTypes(harness: Pick<AcpHarness, "events">): string[] {
    return harness.events.map((envelope) => envelope.event.type);
  }

  function eventsOfType<T extends string>(
    harness: Pick<AcpHarness, "events">,
    type: T,
  ): Array<Record<string, any>> {
    return harness.events
      .map((envelope) => envelope.event as Record<string, any>)
      .filter((event) => event.type === type);
  }

  /** Script one prompt turn: stream `updates`, then answer with `result`. */
  function scriptPrompt(
    agent: MockAcpAgent,
    updates: AcpSessionUpdate[],
    result: Record<string, unknown> = { stopReason: "end_turn" },
  ): void {
    agent.on("session/prompt", async (params) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      for (const update of updates) agent.emitUpdate(sessionId, update);
      return { result };
    });
  }

  it("streams a turn as text then a terminal done, flushing text before the tool row", async () => {
    // The flush invariant: buffered assistant text must be committed before any
    // non-text event, or the tool row lands above the sentence that introduced
    // it and the transcript reads backwards.
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });
    scriptPrompt(harness.agent, [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the file." } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read src/index.ts",
        kind: "read",
        status: "completed",
        rawInput: { path: "src/index.ts" },
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Done." } },
    ]);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "look at this" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const types = eventTypes(harness);
    const firstText = types.indexOf("text");
    const toolCall = types.indexOf("tool_call");
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(toolCall).toBeGreaterThan(firstText);
    expect(types.indexOf("done")).toBeGreaterThan(toolCall);

    const done = eventsOfType(harness, "done").at(-1);
    expect(done?.status).toBe("completed");
    const statuses = eventsOfType(harness, "status").map((event) => event.turnStatus);
    expect(statuses).toContain("started");
    expect(statuses).toContain("completed");
  });

  it("configures Copilot's native ACP mode without sending an unsupported model option", async () => {
    const harness = await openAcpHarness({
      provider: "copilot",
      model: "claude-sonnet-4.6",
      modelId: "github-copilot/claude-sonnet-4.6",
      sessionOverrides: { permissionMode: "plan" },
    });
    scriptPrompt(harness.agent, []);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "plan this" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const configCalls = harness.agent.received.filter((entry) => entry.method === "session/set_config_option");
    expect(configCalls).toHaveLength(1);
    expect(configCalls[0]?.params).toMatchObject({
      configId: "mode",
      value: "https://agentclientprotocol.com/protocol/session-modes#plan",
    });
    expect(configCalls.some((entry) => (entry.params as { configId?: string }).configId === "model")).toBe(false);
  });

  it("logs an ACP turn that another model answered through the generic served-model check", async () => {
    // Copilot's own `model` option names the model it runs. It is not the one
    // the chat picked, so the turn's done event carries it as `servedModel`.
    const harness = await openAcpHarness({
      provider: "copilot",
      model: "claude-sonnet-4.6",
      modelId: "github-copilot/claude-sonnet-4.6",
      sessionExtra: {
        configOptions: [{
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "gpt-5.6-luna",
          options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }],
        }],
      },
    });
    scriptPrompt(harness.agent, [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi." } }]);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "who answers?" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    expect(eventsOfType(harness, "done").at(-1)?.servedModel).toBe("gpt-5.6-luna");
    expect(harness.logger.warn).toHaveBeenCalledWith("agent_chat.served_model_mismatch", expect.objectContaining({
      sessionId: harness.session.id,
      provider: "copilot",
      servedModel: "gpt-5.6-luna",
    }));
  });

  it("applies Qwen's selected model and reasoning effort at session startup", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3.7-plus",
      modelId: "qwen/qwen3.7-plus",
      sessionOverrides: { reasoningEffort: "high" },
    });
    scriptPrompt(harness.agent, []);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "use the selected effort" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const configCalls = harness.agent.received.filter((entry) => entry.method === "session/set_config_option");
    const configParams = configCalls.map((entry) => entry.params as { configId?: string; value?: unknown });
    expect(configParams.map((params) => params.configId)).toEqual(["mode", "model", "reasoning_effort"]);
    expect(configParams.at(-1)).toMatchObject({ configId: "reasoning_effort", value: "high" });
  });

  it("sends Qwen's default reasoning sentinel when no effort is selected", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3.7-plus",
      modelId: "qwen/qwen3.7-plus",
    });
    scriptPrompt(harness.agent, []);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "use the provider default" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const reasoningCalls = harness.agent.received
      .filter((entry) => entry.method === "session/set_config_option")
      .map((entry) => entry.params as { configId?: string; value?: unknown })
      .filter((params) => params.configId === "reasoning_effort");
    expect(reasoningCalls).toHaveLength(1);
    expect(reasoningCalls[0]).toMatchObject({ configId: "reasoning_effort", value: "default" });
  });

  it("does not mark Qwen ready after a transient startup effort failure", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3.7-plus",
      modelId: "qwen/qwen3.7-plus",
      sessionOverrides: { reasoningEffort: "high" },
    });
    let promptSeen = false;
    harness.agent.on("session/prompt", async () => {
      promptSeen = true;
      return { result: { stopReason: "end_turn" } };
    });
    harness.agent.on("session/set_config_option", (params) => {
      const config = params as { configId?: string; value?: unknown };
      if (config.configId === "reasoning_effort" && config.value === "high") {
        return { error: { code: -32001, message: "temporary Qwen ACP failure" } };
      }
      return { result: {} };
    });

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "start with high effort" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(1);
    });

    expect(promptSeen).toBe(false);
    expect(eventsOfType(harness, "done")[0]?.status).toBe("failed");
    expect(readPersistedChatState(harness.session.id).acpSessionId).toBeUndefined();
  });

  it("updates Qwen's live reasoning effort when the ACP runtime is reused", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3.7-plus",
      modelId: "qwen/qwen3.7-plus",
      sessionOverrides: { reasoningEffort: "low" },
    });
    scriptPrompt(harness.agent, []);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "first turn" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    await harness.service.updateSession({ sessionId: harness.session.id, reasoningEffort: "high" });
    await harness.service.updateSession({ sessionId: harness.session.id, reasoningEffort: null });

    const configCalls = harness.agent.received.filter((entry) => entry.method === "session/set_config_option");
    const reasoningCalls = configCalls
      .map((entry) => entry.params as { configId?: string; value?: unknown })
      .filter((params) => params.configId === "reasoning_effort");
    expect(reasoningCalls.map((params) => params.value)).toEqual(["low", "high", "default"]);
    expect(harness.agent.methodsReceived().filter((method) => method === "session/new")).toHaveLength(1);
  });

  it("retries a transient Qwen effort update before recreating the runtime", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3.7-plus",
      modelId: "qwen/qwen3.7-plus",
      sessionOverrides: { reasoningEffort: "low" },
    });
    scriptPrompt(harness.agent, []);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "first turn" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    let rejectNextHigh = true;
    harness.agent.on("session/set_config_option", (params) => {
      const config = params as { configId?: string; value?: unknown };
      if (config.configId === "reasoning_effort" && config.value === "high" && rejectNextHigh) {
        rejectNextHigh = false;
        return { error: { code: -32001, message: "temporary Qwen ACP failure" } };
      }
      return { result: {} };
    });

    await harness.service.updateSession({ sessionId: harness.session.id, reasoningEffort: "high" });
    await harness.service.updateSession({ sessionId: harness.session.id, reasoningEffort: "high" });
    await harness.service.sendMessage({ sessionId: harness.session.id, text: "retry turn" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(2);
    });

    const reasoningCalls = harness.agent.received
      .filter((entry) => entry.method === "session/set_config_option")
      .map((entry) => entry.params as { configId?: string; value?: unknown })
      .filter((params) => params.configId === "reasoning_effort");
    expect(reasoningCalls.map((params) => params.value)).toEqual(["low", "high", "high"]);
    expect(harness.agent.methodsReceived().filter((method) => method === "session/new")).toHaveLength(1);
  });

  it("preserves a separate ACP invalidation when a live effort update succeeds", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3.7-plus",
      modelId: "qwen/qwen3.7-plus",
      sessionOverrides: { permissionMode: "plan", reasoningEffort: "low" },
    });
    let releaseFirstPrompt: (() => void) | null = null;
    let promptCount = 0;
    harness.agent.on("session/prompt", async () => {
      promptCount += 1;
      if (promptCount === 1) {
        await new Promise<void>((resolve) => { releaseFirstPrompt = resolve; });
      }
      return { result: { stopReason: "end_turn" } };
    });

    void harness.service.sendMessage({ sessionId: harness.session.id, text: "first turn" });
    await harness.agent.waitForMethod("session/prompt");

    // A permission-mode change during an active turn owns the invalidation;
    // the successful reasoning RPC must not erase it before finalization.
    await harness.service.updateSession({ sessionId: harness.session.id, permissionMode: "full-auto" });
    expect(harness.session.acpPermissionMode).toBe("yolo");
    await harness.service.updateSession({ sessionId: harness.session.id, reasoningEffort: "high" });
    releaseFirstPrompt!();
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(1);
    });
    expect((harness.agent.child as unknown as { killed?: boolean }).killed).toBe(true);
  });

  it("forwards image URL attachments in the ACP prompt payload", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });
    let promptParams: Record<string, unknown> | null = null;
    harness.agent.on("session/prompt", async (params) => {
      promptParams = params as Record<string, unknown>;
      return { result: { stopReason: "end_turn" } };
    });

    void harness.service.sendMessage({
      sessionId: harness.session.id,
      text: "Review this image.",
      attachments: [{
        path: "https://example.test/review.webp",
        type: "image-url",
        url: "https://example.test/review.webp",
      }],
    });

    await vi.waitFor(() => {
      expect(promptParams).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const sentPrompt = promptParams as unknown as Record<string, unknown>;
    expect(sentPrompt.prompt).toEqual([
      { type: "text", text: expect.stringContaining("Review this image.") },
      {
        type: "image",
        data: "",
        mimeType: "image/webp",
        uri: "https://example.test/review.webp",
      },
    ]);
  });

  it("raises a permission request as a card and forwards the chosen option", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });
    let permissionAnswer: any = null;
    harness.agent.on("session/prompt", async (params) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      permissionAnswer = await harness.agent.callClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Write src/index.ts", kind: "edit" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      return { result: { stopReason: "end_turn" } };
    });

    void harness.service.sendMessage({ sessionId: harness.session.id, text: "edit it" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "approval_request").length).toBe(1);
    });
    const card = eventsOfType(harness, "approval_request")[0]!;
    const request = card.detail?.request as { requestId: string; source: string };
    expect(request.source).toBe("acp");

    await harness.service.respondToInput({
      sessionId: harness.session.id,
      itemId: card.itemId,
      decision: "accept",
    });

    await vi.waitFor(() => {
      expect(permissionAnswer).not.toBeNull();
    });
    expect(permissionAnswer.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });
  });

  it("sends the reject option when the user declines, never a silent allow", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });
    let permissionAnswer: any = null;
    harness.agent.on("session/prompt", async (params) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      permissionAnswer = await harness.agent.callClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Run rm -rf", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      return { result: { stopReason: "end_turn" } };
    });

    void harness.service.sendMessage({ sessionId: harness.session.id, text: "clean up" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "approval_request").length).toBe(1);
    });
    await harness.service.respondToInput({
      sessionId: harness.session.id,
      itemId: eventsOfType(harness, "approval_request")[0]!.itemId,
      decision: "decline",
    });

    await vi.waitFor(() => {
      expect(permissionAnswer).not.toBeNull();
    });
    expect(permissionAnswer.outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("answers an open permission request when the turn is interrupted", async () => {
    // A card that outlives its turn blocks the agent behind something the user
    // can no longer see. The interrupt has to settle it.
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });
    let permissionAnswer: any = null;
    harness.agent.on("session/prompt", async (params) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      permissionAnswer = await harness.agent.callClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Write a file", kind: "edit" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      return { result: { stopReason: "cancelled" } };
    });

    void harness.service.sendMessage({ sessionId: harness.session.id, text: "edit it" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "approval_request").length).toBe(1);
    });

    await harness.service.interrupt({ sessionId: harness.session.id });

    await vi.waitFor(() => {
      expect(permissionAnswer).not.toBeNull();
    });
    expect(permissionAnswer.outcome).toEqual({ outcome: "cancelled" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done").length).toBe(1);
    });
    // The composer is released only by a terminal marker. An interrupted turn
    // must still reach one.
    expect(eventsOfType(harness, "done").at(-1)?.status).toBe("interrupted");
  });

  it("reports a cancelled turn as interrupted even when the agent says end_turn", async () => {
    // Copilot's known bug (github/copilot-cli #4561). ADE's own cancel record
    // is the deciding source, never the agent's stopReason.
    const harness = await openAcpHarness({
      provider: "copilot",
      model: "claude-sonnet-4.6",
      modelId: "github-copilot/claude-sonnet-4.6",
    });
    let releasePrompt: (() => void) | null = null;
    harness.agent.on("session/prompt", async () => {
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      return { result: { stopReason: "end_turn" } };
    });

    void harness.service.sendMessage({ sessionId: harness.session.id, text: "work" });
    await vi.waitFor(() => {
      expect(releasePrompt).not.toBeNull();
    });
    await harness.service.interrupt({ sessionId: harness.session.id });
    releasePrompt!();

    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done").length).toBe(1);
    });
    expect(eventsOfType(harness, "done").at(-1)?.status).toBe("interrupted");
  });

  /**
   * Opens a Qwen harness whose first turn the agent answers and then holds in
   * the host's usage wait, with `session.turnAnswered` true, as the real
   * session reports it, until the test releases the wait.
   */
  const openAnsweredWindowHarness = async () => {
    const { createAcpRuntime: actualCreateAcpRuntime } = await vi.importActual<typeof AcpHostModule>("./acpHost");
    let markAnswered!: () => void;
    const answered = new Promise<void>((resolve) => { markAnswered = resolve; });
    let releaseUsage!: () => void;
    const usageWait = new Promise<void>((resolve) => { releaseUsage = resolve; });
    let queue: Array<Record<string, unknown>> | null = null;
    vi.mocked(createAcpRuntime).mockImplementationOnce(async (runtimeArgs) => {
      const runtime = await actualCreateAcpRuntime(runtimeArgs);
      queue = runtime.pendingSteers as Array<Record<string, unknown>>;
      const realPrompt = runtime.session.prompt.bind(runtime.session);
      let inAnsweredWindow = false;
      const realAnswered = Object.getOwnPropertyDescriptor(runtime.session, "turnAnswered")?.get;
      Object.defineProperty(runtime.session, "turnAnswered", {
        configurable: true,
        get: () => inAnsweredWindow || (realAnswered?.call(runtime.session) ?? false),
      });
      let first = true;
      (runtime.session as { prompt: AcpSession["prompt"] }).prompt = async (promptArgs) => {
        if (!first) return realPrompt(promptArgs);
        first = false;
        const interrupted = promptArgs.isInterrupted?.() ?? false;
        inAnsweredWindow = true;
        markAnswered();
        await usageWait;
        inAnsweredWindow = false;
        return { stopReason: "end_turn", interrupted, usage: null, events: [], done: {} };
      };
      return runtime;
    });
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });
    scriptPrompt(harness.agent, []);
    void harness.service.sendMessage({ sessionId: harness.session.id, text: "first" });
    await answered;
    // What the user queued for after this turn.
    queue!.push({
      steerId: "steer-after",
      uuid: "steer-after-uuid",
      text: "then this",
      attachments: [],
      contextAttachments: [],
      resolvedAttachments: [],
    });
    return { harness, releaseUsage, queue: queue! };
  };

  it("keeps a turn the agent already answered, and its queued steer, when a keep-queue Stop lands during the usage wait", async () => {
    // The verdict is taken when `session/prompt` answers. The usage the host
    // folds afterwards must not give a late Stop a window to flip a finished
    // turn to interrupted or to drop what the user queued next.
    const { harness, releaseUsage } = await openAnsweredWindowHarness();
    await harness.service.interrupt({ sessionId: harness.session.id, mode: "stop_only" });
    releaseUsage();

    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(2);
    });
    // The finished turn stays finished, and the runtime runs the queued steer.
    expect(eventsOfType(harness, "error")).toEqual([]);
    expect(eventsOfType(harness, "done").map((event) => event.status)).toEqual(["completed", "completed"]);
    expect(eventsOfType(harness, "status").some((event) => event.turnStatus === "interrupted")).toBe(false);
    expect(harness.agent.received.some((entry) => entry.method === "session/cancel")).toBe(false);
    expect(JSON.stringify(harness.agent.received.filter((entry) => entry.method === "session/prompt").at(-1)?.params))
      .toContain("then this");
  });

  it("still clears the queue on a clearing Stop in the answered window, without flipping the turn or cancelling", async () => {
    const { harness, releaseUsage, queue } = await openAnsweredWindowHarness();
    await harness.service.interrupt({ sessionId: harness.session.id });
    expect(queue).toHaveLength(0);
    releaseUsage();

    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(1);
    });
    expect(eventsOfType(harness, "done").map((event) => event.status)).toEqual(["completed"]);
    expect(eventsOfType(harness, "status").some((event) => event.turnStatus === "interrupted")).toBe(false);
    expect(harness.agent.received.some((entry) => entry.method === "session/cancel")).toBe(false);
    // The cleared steer never reaches the agent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.agent.received.filter((entry) => entry.method === "session/prompt")).toHaveLength(0);
  });

  it("reopens an ACP runtime when permission mode changes during a turn", async () => {
    const harness = await openAcpHarness({
      provider: "copilot",
      model: "claude-sonnet-4.6",
      modelId: "github-copilot/claude-sonnet-4.6",
      sessionOverrides: { permissionMode: "full-auto" },
    });
    let releaseFirstPrompt: (() => void) | null = null;
    let promptCount = 0;
    let permissionAnswer: Record<string, unknown> | null = null;
    harness.agent.on("session/prompt", async (params) => {
      promptCount += 1;
      const sessionId = (params as { sessionId: string }).sessionId;
      if (promptCount === 1) {
        await new Promise<void>((resolve) => { releaseFirstPrompt = resolve; });
        return { result: { stopReason: "end_turn" } };
      }
      permissionAnswer = await harness.agent.callClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Write src/index.ts", kind: "edit" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      return { result: { stopReason: "end_turn" } };
    });

    void harness.service.sendMessage({ sessionId: harness.session.id, text: "first" });
    await harness.agent.waitForMethod("session/prompt");
    expect(harness.session.acpPermissionMode).toBe("yolo");

    await harness.service.updateSession({ sessionId: harness.session.id, permissionMode: "plan" });
    expect(harness.session.acpPermissionMode).toBe("plan");
    releaseFirstPrompt!();
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(1);
    });

    void harness.service.sendMessage({ sessionId: harness.session.id, text: "second" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "approval_request")).toHaveLength(1);
    });
    // The old full-auto runtime would auto-approve this request. A second
    // session entry proves the mode change rebuilt the provider boundary first;
    // the resumed entry may be `session/resume` rather than `session/new`.
    const sessionEntries = harness.agent.methodsReceived().filter((method) =>
      method === "session/new" || method === "session/load" || method === "session/resume",
    );
    expect(sessionEntries).toHaveLength(2);

    await harness.service.respondToInput({
      sessionId: harness.session.id,
      itemId: eventsOfType(harness, "approval_request")[0]!.itemId,
      decision: "accept",
    });
    await vi.waitFor(() => {
      expect(permissionAnswer).not.toBeNull();
      expect(eventsOfType(harness, "done")).toHaveLength(2);
    });
    expect(permissionAnswer).toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("folds Grok's prompt-result usage into the turn", async () => {
    const harness = await openAcpHarness({
      provider: "grok",
      model: "grok-4.6",
      modelId: "xai/grok-4-6",
    });
    scriptPrompt(harness.agent, [], {
      stopReason: "end_turn",
      _meta: {
        costUsdTicks: 2_500_000_000,
        cachedReadTokens: 40,
        modelUsage: { "grok-4.6": { inputTokens: 100, outputTokens: 20 } },
      },
    });

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const tokens = eventsOfType(harness, "tokens").at(-1);
    // Grok's `inputTokens` counts the cache read. ADE's usage rows carry
    // uncached input with the cache in its own field (the meter adds them
    // back), so the 100 on the wire lands as 60 uncached + 40 cached.
    expect(tokens?.inputTokens).toBe(60);
    expect(tokens?.outputTokens).toBe(20);
    expect(tokens?.cacheReadTokens).toBe(40);
  });

  /** Grok 1.0.40's `session/new` and `session/resume` config options, in its wire shape. */
  const grokSessionOptions = (model: string, effort: string) => ({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: model,
        options: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"].map((value) => ({ value, name: value })),
      },
      {
        id: "reasoning_effort",
        name: "Reasoning Effort",
        category: "thought_level",
        type: "select",
        currentValue: effort,
        options: ["xhigh", "high", "medium", "low"].map((value) => ({ value, name: value })),
      },
    ],
  });

  const configCallsOf = (agent: MockAcpAgent) => agent.received
    .filter((entry) => entry.method === "session/set_config_option")
    .map((entry) => entry.params as { configId?: string; value?: unknown });

  it("applies Grok's selected model and effort through session/set_config_option, with no mode call", async () => {
    // Live 1.0.40: `-m` alone opened some ids on another model, and
    // `--reasoning-effort` never reached the session.
    const harness = await openAcpHarness({
      provider: "grok",
      model: "grok-4.6",
      modelId: "xai/grok-4-6",
      sessionExtra: grokSessionOptions("grok-4.7", "medium"),
      sessionOverrides: { reasoningEffort: "low" },
    });
    scriptPrompt(harness.agent, []);

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    expect(configCallsOf(harness.agent)).toEqual([
      { sessionId: "acp-session-1", configId: "model", value: "grok-4.6" },
      { sessionId: "acp-session-1", configId: "reasoning_effort", value: "low" },
    ]);
  });

  it("gives Grok's live-only models the efforts the session advertises", async () => {
    // grok-4.7 and grok-4.7-build-fast are not curated; they reach the catalog
    // only through the session's `model` option, and their effort picker only
    // through its `reasoning_effort` option.
    const harness = await openAcpHarness({
      provider: "grok",
      model: "grok-4.6",
      modelId: "xai/grok-4-6",
      sessionExtra: grokSessionOptions("grok-4.7", "medium"),
    });
    scriptPrompt(harness.agent, []);
    await harness.service.sendMessage({ sessionId: harness.session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const live = getDynamicAcpModelDescriptors("grok");
    for (const shortId of ["grok-4.7", "grok-4.7-build-fast"]) {
      expect(live.find((descriptor) => descriptor.shortId === shortId)?.reasoningTiers, shortId)
        .toEqual(["low", "medium", "high", "xhigh"]);
    }
    // A curated row keeps its researched tiers.
    expect(getModelById("xai/grok-4-5")?.reasoningTiers).toEqual(["low", "medium", "high"]);
  });

  it("moves a Grok chat to a newly picked model through session/set_config_option on the rejoined session", async () => {
    const harness = await openAcpHarness({
      provider: "grok",
      model: "grok-4.6",
      modelId: "xai/grok-4-6",
      sessionExtra: grokSessionOptions("grok-4.6", "medium"),
    });
    scriptPrompt(harness.agent, []);
    await harness.service.sendMessage({ sessionId: harness.session.id, text: "first" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(1);
    });

    await harness.service.updateSession({ sessionId: harness.session.id, modelId: "xai/grok-4-5" });
    await harness.service.sendMessage({ sessionId: harness.session.id, text: "second" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(2);
    });

    // `session/resume` brings back the model the session last ran, whatever
    // `-m` says, so the new model has to ride the config option.
    expect(harness.agent.methodsReceived()).toContain("session/resume");
    expect(configCallsOf(harness.agent).filter((params) => params.configId === "model")).toEqual([
      { sessionId: "acp-session-1", configId: "model", value: "grok-4.5" },
    ]);
  });

  it("still auto-approves Grok's permission requests in full auto, although Grok now takes session config", async () => {
    // Grok's posture rides spawn flags, not a `mode` config option, so ADE
    // answers for it when the user chose full auto.
    const harness = await openAcpHarness({
      provider: "grok",
      model: "grok-4.6",
      modelId: "xai/grok-4-6",
      sessionOverrides: { permissionMode: "full-auto" },
    });
    let permissionAnswer: unknown = null;
    harness.agent.on("session/prompt", async (params) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      permissionAnswer = await harness.agent.callClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Write src/index.ts", kind: "edit" },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      return { result: { stopReason: "end_turn" } };
    });

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "edit it" });
    await vi.waitFor(() => {
      expect(eventsOfType(harness, "done")).toHaveLength(1);
    });

    expect(harness.session.acpPermissionMode).toBe("yolo");
    expect(permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(eventsOfType(harness, "approval_request")[0]?.detail).toMatchObject({ autoApproved: true });
    expect(configCallsOf(harness.agent).some((params) => params.configId === "mode")).toBe(false);
  });

  it("reads Kimi's usage when it reports it, and never shows a no-usage notice", async () => {
    // Kimi 0.39.1 pushes one `usage_update` after each settled turn, after the
    // prompt result, and the result may carry the ACP `usage` block. Both are
    // read when present; there is no standing "no usage" banner.
    const harness = await openAcpHarness({
      provider: "kimi",
      model: "kimi-code/k3",
      modelId: "moonshot/k3",
    });
    harness.agent.on("session/prompt", async (params) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      harness.agent.emitUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      setImmediate(() => harness.agent.emitUpdate(sessionId, { sessionUpdate: "usage_update", used: 12_000, size: 256_000 }));
      return {
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 1_000, outputTokens: 10, totalTokens: 1_010, cachedReadTokens: 400 },
        },
      };
    });

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const contextEvents = eventsOfType(harness, "context_usage");
    expect(contextEvents.at(-1)?.usage).toMatchObject({ totalTokens: 12_000, maxTokens: 256_000 });
    // The exact context sample owns the meter, so no prompt-result tokens row.
    expect(eventsOfType(harness, "tokens")).toHaveLength(0);
    const notices = eventsOfType(harness, "system_notice").map((event) => String(event.message));
    expect(notices.filter((message) => message.includes("token usage"))).toHaveLength(0);
  });

  it("persists the agent's session id and rejoins with it after a restart", async () => {
    const harness = await openAcpHarness({
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });
    scriptPrompt(harness.agent, []);
    await harness.service.sendMessage({ sessionId: harness.session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });
    expect(readPersistedChatState(harness.session.id).acpSessionId).toBe("acp-session-1");

    // A second service over the same persisted state is the restart: it must
    // rejoin by id rather than start a fresh agent session.
    const agent = createMockAcpAgent();
    const resumeCalls: unknown[] = [];
    agent.on("session/resume", (params) => {
      resumeCalls.push(params);
      return { result: { sessionId: "acp-session-1" } };
    });
    agent.on("session/prompt", async () => ({ result: { stopReason: "end_turn" } }));
    const pool = createAcpSessionPool();
    acpTeardown.push(() => pool.disposeAll("test teardown"));
    // Same lane and session services: a restart re-reads ADE's own state, and
    // a fresh mock registry would look like a session ADE had never heard of
    // and send the reconciler down the continuity-recovery path.
    const restarted = createService({
      acpSpawnOverride: () => agent.child,
      acpSessionPool: pool,
      laneService: harness.laneService,
      sessionService: harness.sessionService,
    });
    acpTeardown.push(() => { void restarted.service.disposeAll(); });

    await restarted.service.sendMessage({ sessionId: harness.session.id, text: "still here?" });
    await vi.waitFor(() => {
      expect(resumeCalls.length).toBe(1);
    });
    expect(resumeCalls[0]).toMatchObject({ sessionId: "acp-session-1" });
    expect(agent.methodsReceived()).not.toContain("session/new");
  });

  it("offers the agent's advertised slash commands, deduped and TUI-filtered", async () => {
    const harness = await openAcpHarness({
      provider: "copilot",
      model: "claude-sonnet-4.6",
      modelId: "github-copilot/claude-sonnet-4.6",
    });
    harness.agent.on("session/prompt", async (params) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      const availableCommands = [
        { name: "review", description: "Review the diff" },
        // Copilot's terminal-only commands would reach the model as prose.
        { name: "diff", description: "Show the diff" },
        { name: "login", description: "Sign in" },
      ];
      agentEmitCommands(harness.agent, sessionId, availableCommands);
      // Re-sent on the same turn: the picker must not show it twice.
      agentEmitCommands(harness.agent, sessionId, availableCommands);
      return { result: { stopReason: "end_turn" } };
    });

    await harness.service.sendMessage({ sessionId: harness.session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(eventTypes(harness)).toContain("done");
    });

    const commands = harness.service.getSlashCommands({ sessionId: harness.session.id });
    const names = commands.map((command) => command.name);
    expect(names.filter((name) => name === "/review")).toHaveLength(1);
    expect(names).not.toContain("/diff");
    expect(names).not.toContain("/login");
  });

  it("emits one visible error and a terminal done when the agent cannot start", async () => {
    // A chat that never reaches `done` leaves the composer locked with nothing
    // on screen explaining why.
    const agent = createMockAcpAgent();
    agent.on("session/new", () => ({
      error: { code: -32000, message: "Authentication required: Use Qwen Code CLI to authenticate first." },
    }));
    const pool = createAcpSessionPool();
    acpTeardown.push(() => pool.disposeAll("test teardown"));
    const events: AgentChatEventEnvelope[] = [];
    const harness = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      acpSpawnOverride: () => agent.child,
      acpSessionPool: pool,
    });
    acpTeardown.push(() => { void harness.service.disposeAll(); });
    const session = await harness.service.createSession({
      laneId: "lane-1",
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });

    await harness.service.sendMessage({ sessionId: session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(events.some((envelope) => envelope.event.type === "done")).toBe(true);
    });

    const errors = events.map((e) => e.event as Record<string, any>).filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.message)).toContain("Authentication required");
    expect(errors[0]?.errorInfo?.category).toBe("agent_cli_auth");
    expect(errors[0]?.errorInfo?.agentCli?.agent).toBe("qwen");
    expect(errors[0]?.errorInfo?.agentCli?.authCommand).toBe("qwen --auth-type=openai");
    const done = events.map((e) => e.event as Record<string, any>).filter((e) => e.type === "done").at(-1);
    expect(done?.status).toBe("failed");
  });

  it("leads the card with the agent's stderr when the process dies during startup", async () => {
    // The generic "connection closed" sentence hides the one line that explains
    // the failure; the agent's own stderr must lead the card instead.
    const agent = createMockAcpAgent();
    agent.on("session/new", async () => {
      // A misconfigured CLI prints its reason and dies. Let the stderr write
      // reach the connection before the exit, as a draining OS pipe would.
      agent.writeStderr("Error: unknown model 'gpt-x'\nsupported models: auto, qwen3-coder-plus\n");
      await new Promise((resolve) => setTimeout(resolve, 0));
      agent.exit(1);
      return { error: { code: -32000, message: "agent exited" } };
    });
    const pool = createAcpSessionPool();
    acpTeardown.push(() => pool.disposeAll("test teardown"));
    const events: AgentChatEventEnvelope[] = [];
    const harness = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      acpSpawnOverride: () => agent.child,
      acpSessionPool: pool,
    });
    acpTeardown.push(() => { void harness.service.disposeAll(); });
    const session = await harness.service.createSession({
      laneId: "lane-1",
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });

    await harness.service.sendMessage({ sessionId: session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(events.some((envelope) => envelope.event.type === "done")).toBe(true);
    });

    const errors = events.map((e) => e.event as Record<string, any>).filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    const presentation = errors[0]?.errorInfo?.presentation;
    expect(presentation?.body).toContain("unknown model 'gpt-x'");
    expect(presentation?.body).not.toContain("connection closed");
    expect(presentation?.technicalDetail).toContain("supported models: auto, qwen3-coder-plus");
    const done = events.map((e) => e.event as Record<string, any>).filter((e) => e.type === "done").at(-1);
    expect(done?.status).toBe("failed");
  });

  it("keeps the stderr of an agent that dies before the handshake completes", async () => {
    // The pool initializes the connection before any exit handler exists, so a
    // crash during `initialize` must ride the rethrown error, not onProcessExit.
    const agent = createMockAcpAgent();
    agent.on("initialize", async () => {
      agent.writeStderr("Error: unknown flag --model\n");
      await new Promise((resolve) => setTimeout(resolve, 0));
      agent.exit(1);
      return { error: { code: -32000, message: "initialize failed" } };
    });
    const pool = createAcpSessionPool();
    acpTeardown.push(() => pool.disposeAll("test teardown"));
    const events: AgentChatEventEnvelope[] = [];
    const harness = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      acpSpawnOverride: () => agent.child,
      acpSessionPool: pool,
    });
    acpTeardown.push(() => { void harness.service.disposeAll(); });
    const session = await harness.service.createSession({
      laneId: "lane-1",
      provider: "qwen",
      model: "qwen3-coder-plus",
      modelId: "qwen/qwen3-coder-plus",
    });

    await harness.service.sendMessage({ sessionId: session.id, text: "hi" });
    await vi.waitFor(() => {
      expect(events.some((envelope) => envelope.event.type === "done")).toBe(true);
    });

    const errors = events.map((e) => e.event as Record<string, any>).filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    const presentation = errors[0]?.errorInfo?.presentation;
    expect(presentation?.body).toContain("unknown flag --model");
    expect(presentation?.technicalDetail).toContain("unknown flag --model");
    const done = events.map((e) => e.event as Record<string, any>).filter((e) => e.type === "done").at(-1);
    expect(done?.status).toBe("failed");
  });
});
