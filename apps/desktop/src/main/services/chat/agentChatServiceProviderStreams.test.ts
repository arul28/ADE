import {
  AgentChatEventEnvelope,
  buildOpenCodeStreamMessages,
  claudeInputText,
  claudeNoticeMessages,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createClaudeCompactionFixture,
  createClaudeStreamFixture,
  createLogger,
  createMemoryTurnUsageLedger,
  createService,
  fs,
  makeDefaultClaudeSession,
  mockState,
  openCodeEventStream,
  path,
  query,
  readPersistedChatState,
  runClaudeStreamFixture,
  startup,
  streamText,
  tmpRoot,
  waitFor,
  waitForCondition,
  waitForEvent,
  waitForFakeTimers,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("approveToolUse", () => {
    it("throws when approving for an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.approveToolUse({
          sessionId: "unknown-session-id",
          itemId: "unknown-item-id",
          decision: "accept",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("gracefully handles missing Claude approval without throwing", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-missing-approval",
            slash_commands: [],
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
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-missing-approval",
        setPermissionMode,
      } as any);

      const events: AgentChatEventEnvelope[] = [];
      const { service, logger } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Run a turn so the Claude runtime gets created
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Hello",
      });

      // Call approveToolUse with a non-existent itemId — should NOT throw
      await service.approveToolUse({
        sessionId: session.id,
        itemId: "nonexistent-item-id",
        decision: "accept",
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.claude_approval_not_found",
        expect.objectContaining({
          sessionId: session.id,
          itemId: "nonexistent-item-id",
          decision: "accept",
        }),
      );

      // A silent return is not enough. The renderer keeps a card the summary
      // still names, and the summary's restart fallback only stops naming it
      // once a receipt exists — so without this the click accomplishes nothing
      // and the next full re-derivation draws the card again.
      const receipt = events.find((entry) =>
        entry.event.type === "pending_input_resolved"
        && entry.event.itemId === "nonexistent-item-id");
      expect(receipt, "answering a card with no waiter must write a receipt").toBeTruthy();
      // Recorded as cancelled, not accepted: no runtime ever received the
      // acceptance, and this event is durable and synced.
      expect((receipt!.event as { resolution: string }).resolution).toBe("cancelled");
      expect(events.some((entry) =>
        entry.event.type === "system_notice"
        && entry.event.message === "That request is no longer active.")).toBe(true);
    });

  it("preserves original attachments across local auto-continuation retries", async () => {
      const resolvedPath = path.join(tmpRoot, "note.txt");
      fs.writeFileSync(resolvedPath, "remember this", "utf8");

      const streamMessages = await buildOpenCodeStreamMessages({
        messages: [
          {
            role: "user",
            content: "Add an about me page.\n\nAttached context:\n- file: note.txt",
          },
          {
            role: "assistant",
            content: "I will explore the src directory to identify where pages and routing are defined in the application.",
          },
          {
            role: "user",
            content: "Continue from your last step.",
          },
        ],
        persistedTurnUserMessageIndex: 0,
        resolvedAttachments: [{
          path: "note.txt",
          type: "file",
          _rootPath: tmpRoot,
          _resolvedPath: resolvedPath,
        }],
        modelDescriptor: {
          id: "lmstudio/qwen2.5-coder:32b",
          displayName: "qwen2.5-coder:32b",
          family: "lmstudio",
          authTypes: ["local"],
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
          color: "#64748B",
          providerRoute: "@ai-sdk/openai-compatible",
          providerModelId: "qwen2.5-coder:32b",
          isCliWrapped: false,
          harnessProfile: "verified",
        } as any,
        getDirtyFileTextForPath: () => "remember unsaved edits",
        logger: createLogger() as any,
      });

      expect(streamMessages).toHaveLength(3);
      expect(streamMessages[0]?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "file", filename: "note.txt" }),
      ]));
      const persistedContent = streamMessages[0]?.content as Array<Record<string, unknown>>;
      const filePart = persistedContent.find((part) => part.type === "file") as { data?: Buffer } | undefined;
      expect(filePart?.data?.toString("utf8")).toBe("remember unsaved edits");
      expect(streamMessages[2]).toEqual({
        role: "user",
        content: "Continue from your last step.",
      });
    });
  });

  it("emits immediate startup activity before opencode stream output arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

    vi.mocked(streamText).mockImplementation(() => ({
      fullStream: (async function* () {
        await streamGate;
        yield { type: "finish", usage: {} };
      })(),
    }) as any);

    const harness = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const { service } = harness;

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "opencode/openai/gpt-5.4",
      modelId: "opencode/openai/gpt-5.4",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const startedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const startupActivity = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
      } =>
        event.event.type === "activity"
        && event.event.turnId === startedEvent.event.turnId
        && (event.event.activity === "thinking" || event.event.activity === "working"),
    );

    expect(startupActivity.event.detail).toBeTruthy();

    releaseStream();
    await sendPromise;
  });

  it("keeps an OpenCode turn active until child sessions become idle", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });
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

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Delegate the repository scan.",
    });
    const started = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );
    const state = [...mockState.openCodeSessions.values()][0]!;
    const pushEvents = (...nextEvents: any[]): void => {
      state.events.push(...nextEvents);
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());
    };

    pushEvents(
      {
        type: "session.created",
        properties: {
          info: {
            id: "opencode-child-1",
            parentID: "opencode-session-1",
            title: "Repository explorer",
            model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
          },
        },
      },
      {
        type: "session.idle",
        properties: { sessionID: "opencode-session-1" },
      },
    );

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "subagent_started" && event.event.taskId === "opencode-child-1",
    );
    const startedEnvelope = events.find(
      (event) => event.event.type === "subagent_started" && event.event.taskId === "opencode-child-1",
    );
    expect((startedEnvelope?.event as { model?: string }).model).toBe("opencode/anthropic/claude-sonnet-5");
    expect(events.some((event) =>
      event.event.type === "done" && event.event.turnId === started.event.turnId
    )).toBe(false);

    pushEvents(
      {
        type: "session.updated",
        properties: {
          info: {
            id: "opencode-child-1",
            parentID: "opencode-session-1",
            title: "Repository explorer",
            summary: { additions: 4, deletions: 1, files: 2 },
          },
        },
      },
      {
        type: "session.idle",
        properties: { sessionID: "opencode-child-1" },
      },
    );

    const result = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "subagent_result" }>;
      } => event.event.type === "subagent_result" && event.event.taskId === "opencode-child-1",
    );
    expect(result.event).toMatchObject({
      status: "completed",
      summary: "+4 −1 · 2 files",
      finalSummary: "+4 −1 · 2 files",
      turnId: started.event.turnId,
    });

    releaseStream();
    const done = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
      } => event.event.type === "done" && event.event.turnId === started.event.turnId,
    );
    expect(done.event).toMatchObject({
      status: "completed",
      turnId: started.event.turnId,
    });
    await sendPromise;
  });

  it("finishes an OpenCode turn when a settled child keeps publishing session.updated", async () => {
    // 2026-09-21: a child reported (session.idle) and one millisecond later
    // OpenCode published session.updated for that same finished child. The
    // "missed the created event" synthesis re-added it, nothing settled it
    // again, and the parent's idle waited forever: the transcript read
    // subagent_started → subagent_result → subagent_started, with no done.
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });
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
    const sendPromise = service.sendMessage({ sessionId: session.id, text: "Run the dev loop." });
    const started = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );
    const state = [...mockState.openCodeSessions.values()][0]!;
    const pushEvents = (...nextEvents: any[]): void => {
      state.events.push(...nextEvents);
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());
    };
    const child = (extra: Record<string, unknown> = {}) => ({
      id: "opencode-child-1",
      parentID: "opencode-session-1",
      title: "Post-rebase quality revalidation",
      ...extra,
    });

    pushEvents(
      { type: "session.created", properties: { info: child() } },
      { type: "session.idle", properties: { sessionID: "opencode-child-1" } },
      // The late update for the finished child.
      { type: "session.updated", properties: { info: child({ summary: { additions: 1, deletions: 0, files: 1 } }) } },
    );
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "subagent_result" && event.event.taskId === "opencode-child-1",
    );

    releaseStream();
    const done = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "done" && event.event.turnId === started.event.turnId,
    );
    expect(done.event).toMatchObject({ status: "completed" });
    // One row, started once, settled once: the late update did not resurrect it.
    expect(events.filter((e) => e.event.type === "subagent_started" && e.event.taskId === "opencode-child-1")).toHaveLength(1);
    await sendPromise;
  });

  it("never renders OpenCode user-message parts as assistant output", async () => {
    // Regression: `message.part.updated` carries user-message parts too (the
    // prompt echo, and historically the synthetic system-prompt part). Without
    // an assistant-role gate, whatever rode in the user message echoed into the
    // transcript as a left-side agent bubble before the agent answered.
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });
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

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Resolve the failing test.",
    });
    const started = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );

    const state = [...mockState.openCodeSessions.values()][0]!;
    const pushEvents = (...nextEvents: any[]): void => {
      state.events.push(...nextEvents);
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());
    };

    pushEvents(
      // The user message echo: role announced first, then its plain text part
      // with no synthetic/ignored flags — exactly what OpenCode streams.
      { type: "message.updated", properties: { info: { id: "msg-user-1", role: "user", sessionID: "opencode-session-1" } } },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt-user-1",
            type: "text",
            text: "Resolve the failing test.",
            messageID: "msg-user-1",
            sessionID: "opencode-session-1",
          },
        },
      },
      // A part whose message role is not yet known must stay unrendered too.
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt-unknown-1",
            type: "text",
            text: "orphan part before its message.updated",
            messageID: "msg-unannounced",
            sessionID: "opencode-session-1",
          },
        },
      },
      // The real answer.
      { type: "message.updated", properties: { info: { id: "msg-asst-1", role: "assistant", sessionID: "opencode-session-1" } } },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt-asst-1",
            type: "text",
            text: "Fixed it.",
            messageID: "msg-asst-1",
            sessionID: "opencode-session-1",
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "opencode-session-1" } },
    );

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "done" && event.event.turnId === started.event.turnId,
    );

    const textPayloads = events
      .filter((event) => event.event.type === "text")
      .map((event) => (event.event as { text: string }).text)
      .join("");
    expect(textPayloads).toContain("Fixed it.");
    expect(textPayloads).not.toContain("Resolve the failing test.");
    expect(textPayloads).not.toContain("orphan part");

    releaseStream();
    await sendPromise;
  });

  it("does not adopt OpenCode placeholder session titles", async () => {
    // OpenCode mints "New session - <ISO>" (and child variants) until its own
    // titler runs; adopting one would flash timestamp soup as the chat title
    // and block auto-titling.
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });
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
    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Name this thread properly.",
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );

    const state = [...mockState.openCodeSessions.values()][0]!;
    const pushEvents = (...nextEvents: any[]): void => {
      state.events.push(...nextEvents);
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      waiters.forEach((waiter) => waiter());
    };

    pushEvents(
      {
        type: "session.created",
        properties: { info: { id: "opencode-session-1", title: "New session - 2026-08-22T15:25:28.226Z" } },
      },
      {
        type: "session.updated",
        properties: { info: { id: "opencode-session-1", title: "Child session - 2026-08-22T15:26:00.000Z" } },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const placeholderAdoptions = events.filter(
      (event) =>
        event.event.type === "session_meta_updated"
        && /[12]:\d{2}:\d{2}\.\d{3}Z$/.test((event.event as { title?: string }).title ?? ""),
    );
    expect(placeholderAdoptions).toEqual([]);

    pushEvents({
      type: "session.updated",
      properties: { info: { id: "opencode-session-1", title: "Lane status sweep" } },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope &
        { event: Extract<AgentChatEventEnvelope["event"], { type: "session_meta_updated" }> } =>
        event.event.type === "session_meta_updated" && event.event.title === "Lane status sweep",
    );

    releaseStream();
    await sendPromise;
  });

    it("subscribes to the OpenCode event stream before dispatching the prompt", async () => {
    // The SSE stream is live-only. Dispatching first races the subscription:
    // if the server publishes the assistant message.updated before /event is
    // connected, the role announcement is lost and the role gate would drop
    // every part of that message.
    const observations: string[] = [];
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {})(),
    } as any);
    vi.mocked(openCodeEventStream).mockImplementationOnce((async () => {
      // Snapshot how many prompts have been dispatched at subscribe time.
      const state = [...mockState.openCodeSessions.values()][0];
      observations.push(`promptBodiesAtSubscribe=${state ? state.promptBodies.length : -1}`);
      // Ends immediately: the turn fails cleanly, which is all this test needs.
      return (async function* () {})() as AsyncGenerator<never>;
    }) as unknown as typeof openCodeEventStream);

    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "opencode/openai/gpt-5.4",
      modelId: "opencode/openai/gpt-5.4",
    });
    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Check dispatch order.",
    });
    // The turn dispatches asynchronously; wait for the subscription snapshot.
    await vi.waitFor(() => {
      expect(observations.length).toBeGreaterThan(0);
    });
    // Zero means the SSE subscription was live before any prompt was dispatched.
    expect(observations).toEqual(["promptBodiesAtSubscribe=0"]);
    // Let the failed turn settle (its failure is emitted as an error event).
    await sendPromise.catch(() => undefined);
  });

  it("renders OpenCode follow-up text whose message.updated arrives before promptAsync settles", async () => {
    // The SSE is live-only. Awaiting promptAsync before draining it used to
    // drop the role announcement on a fast follow-up; the role gate then
    // swallowed every assistant part while session.idle still completed.
    let pulling = false;
    const liveQueue: any[] = [];
    let liveWaiter: (() => void) | null = null;
    const wakeLive = () => {
      const waiter = liveWaiter;
      liveWaiter = null;
      waiter?.();
    };
    const pushLive = (...nextEvents: any[]) => {
      if (!pulling) return;
      liveQueue.push(...nextEvents);
      wakeLive();
    };

    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {})(),
    } as any);
    vi.mocked(openCodeEventStream).mockImplementationOnce((async () => {
      return (async function* () {
        pulling = true;
        wakeLive();
        while (true) {
          if (liveQueue.length > 0) {
            yield liveQueue.shift();
            continue;
          }
          await new Promise<void>((resolve) => {
            liveWaiter = resolve;
            if (liveQueue.length > 0) {
              liveWaiter = null;
              resolve();
            }
          });
        }
      })();
    }) as unknown as typeof openCodeEventStream);

    let releasePrompt!: () => void;
    mockState.openCodePromptAsyncBarrier = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });

    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "opencode/openai/gpt-5.4",
      modelId: "opencode/openai/gpt-5.4",
    });
    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "What model are you now?",
    });

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );
    await vi.waitFor(() => {
      expect(pulling).toBe(true);
    });
    expect(mockState.openCodeSessions.values().next().value?.promptBodies.length ?? 0).toBe(1);

    const sessionID = [...mockState.openCodeSessions.keys()][0]!;
    pushLive(
      {
        type: "message.updated",
        properties: { info: { id: "msg-fast-1", role: "assistant", sessionID } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "text-fast-1",
            type: "text",
            text: "Still receiving messages.",
            messageID: "msg-fast-1",
            sessionID,
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "finish-fast-1",
            sessionID,
            type: "step-finish",
            tokens: { input: 20, output: 8, cache: { read: 0, write: 0 } },
          },
        },
      },
      {
        type: "session.idle",
        properties: { sessionID },
      },
    );

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "text" && event.event.text.includes("Still receiving messages."),
    );

    releasePrompt();
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope => event.event.type === "done",
    );
    await sendPromise;
  });

it("fails a cleanly ended OpenCode event stream and clears active child sessions", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });
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
    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Delegate the repository scan.",
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );

    const state = [...mockState.openCodeSessions.values()][0]!;
    state.events.push({
      type: "session.created",
      properties: {
        info: {
          id: "opencode-child-eof",
          parentID: "opencode-session-1",
          title: "Repository explorer",
        },
      },
    });
    state.waiters.splice(0).forEach((waiter) => waiter());
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "subagent_started" && event.event.taskId === "opencode-child-eof",
    );

    state.aborted = true;
    state.waiters.splice(0).forEach((waiter) => waiter());
    const stopped = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "subagent_result" }>;
      } => event.event.type === "subagent_result" && event.event.taskId === "opencode-child-eof",
    );
    expect(stopped.event).toMatchObject({
      status: "stopped",
      summary: "OpenCode event stream ended before the child session became idle",
    });

    releaseStream();
    await sendPromise;
    expect(service.hasActiveWorkloads()).toBe(false);
  });

  it("renders assistant OpenCode image file parts without echoing user attachments", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });
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
    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Generate a small diagram.",
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );

    const state = [...mockState.openCodeSessions.values()][0]!;
    const inlineData = `data:image/png;base64,${"A".repeat(80 * 1024)}`;
    state.events.push(
      {
        type: "message.updated",
        properties: { info: { id: "user-msg", sessionID: "opencode-session-1", role: "user" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "user-image",
            sessionID: "opencode-session-1",
            messageID: "user-msg",
            type: "file",
            mime: "image/png",
            filename: "reference.png",
            url: "file:///tmp/reference.png",
          },
        },
      },
      {
        type: "message.updated",
        properties: { info: { id: "assistant-msg", sessionID: "opencode-session-1", role: "assistant" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "generated-image",
            sessionID: "opencode-session-1",
            messageID: "assistant-msg",
            type: "file",
            mime: "image/png",
            filename: "diagram.png",
            url: "file:///tmp/diagram.png",
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "image-tool-part",
            callID: "image-tool-call",
            sessionID: "opencode-session-1",
            messageID: "assistant-msg",
            type: "tool",
            tool: "generate_image",
            state: {
              status: "completed",
              input: { prompt: "Inline image" },
              output: "Generated image",
              title: "Generate image",
              metadata: {},
              time: { start: 1, end: 2 },
              attachments: [{
                id: "generated-inline-image",
                sessionID: "opencode-session-1",
                messageID: "assistant-msg",
                type: "file",
                mime: "image/png",
                filename: "inline.png",
                url: inlineData,
              }],
            },
          },
        },
      },
    );
    const waiters = [...state.waiters];
    state.waiters.length = 0;
    waiters.forEach((waiter) => waiter());

    const image = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
        event.event.type === "codex_image_generation" && event.event.itemId === "generated-image",
    );
    expect(image.event).toMatchObject({
      prompt: "diagram.png",
      result: "file:///tmp/diagram.png",
      savedPath: "/tmp/diagram.png",
      status: "completed",
    });
    expect(events.some((event) =>
      event.event.type === "codex_image_generation" && event.event.itemId === "user-image"
    )).toBe(false);

    const inlineImage = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
        event.event.type === "codex_image_generation" && event.event.itemId === "generated-inline-image",
    );
    expect(inlineImage.event.result).toBe(inlineData);
    expect(inlineImage.event.resultOriginalBytes).toBeUndefined();

    const storedInlineImage = (await service.getChatEventHistory(session.id)).events.find((event) =>
      event.event.type === "codex_image_generation" && event.event.itemId === "generated-inline-image"
    );
    expect(storedInlineImage?.event.type).toBe("codex_image_generation");
    if (storedInlineImage?.event.type !== "codex_image_generation") throw new Error("Expected stored image event");
    expect(storedInlineImage.event.result).toBeNull();
    expect(storedInlineImage.event.resultOriginalBytes).toBe(Buffer.byteLength(inlineData, "utf8"));
    expect(storedInlineImage.event.resultOmittedBytes).toBe(Buffer.byteLength(inlineData, "utf8"));
    expect(JSON.stringify(storedInlineImage.event)).not.toContain("A".repeat(1024));
    expect(JSON.stringify((await service.getChatEventHistory(session.id)).events)).not.toContain("A".repeat(1024));

    const storedToolResult = (await service.getChatEventHistory(session.id)).events.find((event) =>
      event.event.type === "tool_result" && event.event.itemId === "image-tool-call"
    );
    expect(storedToolResult?.event.type).toBe("tool_result");
    if (storedToolResult?.event.type !== "tool_result") throw new Error("Expected stored tool result");
    expect(JSON.stringify(storedToolResult.event.result)).toContain("Inline image was left out");

    releaseStream();
    await sendPromise;
  });

  it("dedupes repeated OpenCode compaction part updates without relying on part ids", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

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

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Compact this context.",
    });

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const state = [...mockState.openCodeSessions.values()][0]!;
    state.events.push(
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "opencode-session-1", type: "compaction", auto: false },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "opencode-session-1", type: "compaction", auto: false },
        },
      },
      {
        type: "session.compacted",
        properties: { sessionID: "opencode-session-1" },
      },
    );
    const waiters = [...state.waiters];
    state.waiters.length = 0;
    waiters.forEach((waiter) => waiter());

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "context_compact" }>;
      } => event.event.type === "context_compact" && event.event.state === "completed",
    );

    const compactionEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "context_compact" }> =>
        event.type === "context_compact"
      );
    expect(compactionEvents).toHaveLength(2);
    expect(compactionEvents.map((event) => event.state)).toEqual(["started", "completed"]);
    expect(compactionEvents.every((event) => event.trigger === "manual")).toBe(true);

    releaseStream();
    await sendPromise;
  });

  it("emits immediate startup activity before Claude SDK stream output arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
          slash_commands: [],
        };
        return;
      }

      await streamGate;
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-1",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const startedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const startupActivity = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
      } =>
        event.event.type === "activity"
        && event.event.turnId === startedEvent.event.turnId
        && (event.event.activity === "thinking" || event.event.activity === "working"),
    );

    expect(startupActivity.event.detail).toBeTruthy();

    releaseStream();
    await sendPromise;
  });

  it.each([
    { subtype: "error_during_execution", terminalReason: undefined, expectedStatus: "failed" },
    { subtype: "error_max_turns", terminalReason: undefined, expectedStatus: "failed" },
    { subtype: "error_max_budget_usd", terminalReason: undefined, expectedStatus: "failed" },
    { subtype: "error_max_structured_output_retries", terminalReason: undefined, expectedStatus: "failed" },
    { subtype: "success", terminalReason: "budget_exhausted", expectedStatus: "failed" },
    { subtype: "success", terminalReason: "structured_output_retry_exhausted", expectedStatus: "failed" },
    { subtype: "success", terminalReason: "max_turns", expectedStatus: "failed" },
    { subtype: "success", terminalReason: "api_error", expectedStatus: "failed" },
    { subtype: "success", terminalReason: "malformed_tool_use_exhausted", expectedStatus: "failed" },
    { subtype: "success", terminalReason: "prompt_too_long", expectedStatus: "failed" },
    { subtype: "error_during_execution", terminalReason: "aborted_streaming", expectedStatus: "interrupted" },
    { subtype: "error_during_execution", terminalReason: "aborted_tools", expectedStatus: "interrupted" },
  ])("maps Claude $subtype/$terminalReason results to $expectedStatus", async ({
    subtype,
    terminalReason,
    expectedStatus,
  }) => {
    const events = await runClaudeStreamFixture({
      sdkSessionId: `sdk-terminal-${subtype}-${terminalReason ?? "none"}`,
      messages: [{
        type: "result",
        subtype,
        is_error: subtype !== "success",
        ...(terminalReason ? { terminal_reason: terminalReason } : {}),
        usage: { input_tokens: 1, output_tokens: 1 },
      }],
    });

    const done = events.find((entry) =>
      entry.event.type === "done"
      && entry.event.terminalReason === terminalReason
    );
    expect(done?.event).toMatchObject({
      type: "done",
      status: expectedStatus,
      ...(terminalReason
        ? { terminalReason, terminalReasonSource: "sdk" }
        : {}),
    });
  });

  it("surfaces Claude protocol frames and adopts a reset conversation as the SDK resume pointer", async () => {
    const goal = {
      condition: "Finish the SDK wiring",
      iterations: 1,
      set_at: 100,
      tokens_at_start: 200,
      last_reason: "initial",
    };
    const { events, service, session } = await createClaudeStreamFixture({
      sdkSessionId: "sdk-protocol-surfaces",
      messages: [
        {
          type: "system",
          subtype: "init",
          session_id: "sdk-protocol-surfaces",
          slash_commands: [],
          capabilities: ["interrupt_receipt_v1", "future_capability", "interrupt_receipt_v1"],
        },
        {
          type: "conversation_reset",
          new_conversation_id: "conversation-after-clear",
          session_id: "sdk-protocol-surfaces",
          uuid: "conversation-reset-1",
        },
        { type: "active_goal", value: goal, session_id: "conversation-after-clear", uuid: "goal-1" },
        { type: "active_goal", value: goal, session_id: "conversation-after-clear", uuid: "goal-duplicate" },
        {
          type: "active_goal",
          value: { ...goal, iterations: 2, last_reason: "continued" },
          session_id: "conversation-after-clear",
          uuid: "goal-2",
        },
        { type: "active_goal", value: null, session_id: "conversation-after-clear", uuid: "goal-clear" },
        {
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 5,
          retry_delay_ms: 750,
          error_status: 529,
          error: "overloaded",
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    expect(events.find((entry) => entry.event.type === "conversation_reset")?.event).toEqual(expect.objectContaining({
      type: "conversation_reset",
      newConversationId: "conversation-after-clear",
    }));
    expect(events.filter((entry) => entry.event.type === "claude_goal_updated")).toHaveLength(2);
    expect(events.filter((entry) => entry.event.type === "claude_goal_cleared")).toHaveLength(1);
    expect(events.find((entry) => entry.event.type === "api_retry")?.event).toMatchObject({
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 750,
      errorStatus: 529,
    });
    expect(readPersistedChatState(session.id)).toMatchObject({
      sdkSessionId: "conversation-after-clear",
      protocolCapabilities: ["interrupt_receipt_v1", "future_capability"],
    });
    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      protocolCapabilities: ["interrupt_receipt_v1", "future_capability"],
    });
  });

  it("flushes buffered assistant text before a live-only Claude retry", async () => {
    const { events } = await createClaudeStreamFixture({
      sdkSessionId: "sdk-retry-flush-buffer",
      messages: [
        {
          type: "assistant",
          message: { id: "m-retry-flush", content: [{ type: "text", text: "Running." }] },
        },
        {
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 4_000,
          error_status: 529,
          error: "overloaded",
        },
      ],
    });

    const textIndex = events.findIndex((entry) =>
      entry.event.type === "text" && entry.event.text === "Running.");
    const retryIndex = events.findIndex((entry) => entry.event.type === "api_retry");
    const retryActivityIndex = events.findIndex((entry) =>
      entry.event.type === "activity" && entry.event.providerRetry === true);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(retryIndex).toBeGreaterThan(textIndex);
    expect(retryActivityIndex).toBeGreaterThan(textIndex);
  });

  it("emits deduplicated command lifecycle events only for ADE-owned Claude messages", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "system", subtype: "init", session_id: "sdk-command-lifecycle", slash_commands: [] };
        return;
      }
      let sentUuid: string | undefined;
      await vi.waitFor(() => {
        const userMessage = events.find((entry) => entry.event.type === "user_message")?.event;
        sentUuid = userMessage?.type === "user_message" ? userMessage.messageId : undefined;
        expect(sentUuid).toEqual(expect.any(String));
      });
      yield { type: "command_lifecycle", command_uuid: "internal-command", status: "queued" };
      yield { type: "command_lifecycle", command_uuid: sentUuid, status: "queued" };
      yield { type: "command_lifecycle", command_uuid: sentUuid, status: "queued" };
      yield { type: "command_lifecycle", command_uuid: sentUuid, status: "started" };
      yield { type: "command_lifecycle", command_uuid: sentUuid, status: "discarded" };
      yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    })());
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-command-lifecycle",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    await service.runSessionTurn({ sessionId: session.id, text: "Track this command." });

    const lifecycle = events
      .map((entry) => entry.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "command_lifecycle" }> =>
        event.type === "command_lifecycle");
    expect(lifecycle.map((event) => event.status)).toEqual(["queued", "started", "discarded"]);
    expect(lifecycle.every((event) => event.preview === "Track this command.")).toBe(true);
  });

  it("persists and rehydrates the current Claude active goal", async () => {
    const goal = {
      condition: "Prove goal persistence",
      iterations: 3,
      set_at: 1_234,
      tokens_at_start: 5_678,
      last_reason: "verification",
    };
    const harness = await createClaudeStreamFixture({
      sdkSessionId: "sdk-goal-persistence",
      messages: [
        { type: "active_goal", value: goal, session_id: "sdk-goal-persistence", uuid: "goal-persist" },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    expect(readPersistedChatState(harness.session.id).claudeGoal).toMatchObject({
      condition: goal.condition,
      iterations: 3,
      setAt: 1_234,
      tokensAtStart: 5_678,
      lastReason: "verification",
      updatedAt: expect.any(Number),
    });

    const rehydrated = createService({ sessionService: harness.sessionService });
    await expect(rehydrated.service.getSessionSummary(harness.session.id)).resolves.toMatchObject({
      claudeGoal: {
        condition: goal.condition,
        iterations: 3,
        setAt: 1_234,
        tokensAtStart: 5_678,
        lastReason: "verification",
        updatedAt: expect.any(Number),
      },
    });
  });

  it("attaches structured Claude tool outputs and enriches Agent and Task results", async () => {
    const toolUseResult = (toolUseId: string, structured: unknown) => ({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: `result:${toolUseId}` }],
      },
      tool_use_result: structured,
    });
    const agentOutput = (summary: string, worktreePath: string) => ({
      status: "completed",
      content: [{ type: "text", text: summary }],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
      toolStats: {
        readCount: 1,
        searchCount: 2,
        bashCount: 3,
        editFileCount: 4,
        otherToolCount: 5,
      },
      worktreePath,
      worktreeBranch: "feature/sdk-wiring",
    });
    const { events } = await createClaudeStreamFixture({
      sdkSessionId: "sdk-structured-tool-results",
      messages: [
        {
          type: "assistant",
          message: {
            id: "assistant-tools",
            content: [
              { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
              { type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "needle" } },
              { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
              { type: "tool_use", id: "agent-1", name: "Agent", input: { prompt: "Inspect Agent output" } },
              { type: "tool_use", id: "task-1", name: "Task", input: { prompt: "Inspect Task output" } },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "agent-task-1",
          agent_id: "agent-id-1",
          parent_tool_use_id: "agent-1",
          description: "Inspect Agent output",
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "agent-task-2",
          agent_id: "agent-id-2",
          parent_tool_use_id: "task-1",
          description: "Inspect Task output",
        },
        toolUseResult("bash-1", { timedOutAfterMs: 30_000, backgroundCwdHint: "cwd remains unchanged" }),
        toolUseResult("grep-1", { totalFiles: 7, totalLines: 19 }),
        toolUseResult("read-1", { futureShape: { preserved: true } }),
        toolUseResult("agent-1", agentOutput("Agent completed.", "/tmp/agent-worktree")),
        toolUseResult("task-1", agentOutput("Task completed.", "/tmp/task-worktree")),
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    const toolResults = events
      .map((entry) => entry.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }> =>
        event.type === "tool_result");
    expect(toolResults.find((event) => event.itemId === "bash-1")).toMatchObject({
      structured: { timedOutAfterMs: 30_000, backgroundCwdHint: "cwd remains unchanged" },
      timedOutAfterMs: 30_000,
      backgroundCwdHint: "cwd remains unchanged",
    });
    expect(toolResults.find((event) => event.itemId === "grep-1")).toMatchObject({
      grepTotals: { files: 7, lines: 19 },
    });
    expect(toolResults.find((event) => event.itemId === "read-1")?.structured).toEqual({
      futureShape: { preserved: true },
    });

    const subagentResults = events
      .map((entry) => entry.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "subagent_result" }> =>
        event.type === "subagent_result" && event.worktreePath != null);
    expect(subagentResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: "agent-task-1",
        worktreePath: "/tmp/agent-worktree",
        worktreeBranch: "feature/sdk-wiring",
        totalTokens: 35,
        toolUseCount: 15,
      }),
      expect.objectContaining({
        taskId: "agent-task-2",
        worktreePath: "/tmp/task-worktree",
        worktreeBranch: "feature/sdk-wiring",
        totalTokens: 35,
        toolUseCount: 15,
      }),
    ]));
  });

  it("throttles live Claude context usage by both time and percentage movement", async () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const messages = [
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "usage-message",
            usage: {
              input_tokens: 100_000,
              cache_read_input_tokens: 20_000,
              cache_creation_input_tokens: 30_000,
              output_tokens: 0,
            },
          },
        },
      },
      {
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 20_000 } },
      },
      {
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 5_000 } },
      },
      {
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 20_000 } },
      },
      { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const timedMessages = (async function* () {
      now = 0;
      yield messages[0]!;
      now = 1_000;
      yield messages[1]!;
      now = 6_000;
      yield messages[2]!;
      now = 7_000;
      yield messages[3]!;
      yield messages[4]!;
    })();
    const materialized: Array<Record<string, unknown>> = [];
    for await (const message of timedMessages) materialized.push(message);
    // Re-apply the intended times from inside the SDK stream rather than while
    // materializing the fixtures.
    let streamCall = 0;
    const send = vi.fn().mockResolvedValue(undefined);
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "system", subtype: "init", session_id: "sdk-live-usage", slash_commands: [] };
        return;
      }
      now = 0;
      yield materialized[0]!;
      now = 1_000;
      yield materialized[1]!;
      now = 6_000;
      yield materialized[2]!;
      now = 7_000;
      yield materialized[3]!;
      yield materialized[4]!;
    })());
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-live-usage",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    await service.runSessionTurn({ sessionId: session.id, text: "Measure context." });
    dateNow.mockRestore();

    const usageEvents = events
      .map((entry) => entry.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "context_usage" }> =>
        event.type === "context_usage" && event.origin === "live");
    expect(usageEvents.map((event) => event.usage.percentage)).toEqual([15, 17]);
  });

  it("refreshes authoritative Claude context usage automatically after a settled turn", async () => {
    vi.useFakeTimers();
    try {
      const getContextUsage = vi.fn().mockResolvedValue({
        categories: [
          { name: "System", tokens: 10_000 },
          { name: "Messages", tokens: 40_000 },
        ],
        totalTokens: 50_000,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 25,
        gridRows: [],
        model: "claude-sonnet-5",
      });
      let streamCall = 0;
      let releaseTail!: () => void;
      const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        getContextUsage,
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-authoritative-context",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          if (streamCall > 1) await tailGate;
        })()),
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Measure context after this turn.",
        timeoutMs: 15_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      await turn;

      await waitForFakeTimers(() => {
        expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
        expect(events.map((entry) => entry.event))
          .toEqual(expect.arrayContaining([
            expect.objectContaining({
              type: "context_usage",
              origin: "snapshot",
              state: "measured",
              usage: expect.objectContaining({ percentage: 25 }),
            }),
          ]));
      });
      releaseTail();
      await service.dispose({ sessionId: session.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests a full Claude context snapshot after compact and a summary after settle", async () => {
    const getContextUsage = vi.fn().mockResolvedValue({
      categories: [{ name: "Messages", tokens: 40_000 }],
      totalTokens: 40_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 20,
      gridRows: [],
      model: "claude-sonnet-5",
    });
    await createClaudeStreamFixture({
      sdkSessionId: "sdk-context-detail",
      getContextUsage,
      messages: [
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 90_000, post_tokens: 40_000 },
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });
    expect(getContextUsage).toHaveBeenCalledWith({ detail: "full" });
    expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
  });

  it("records Claude modelUsage extras on done without changing outputTokens", async () => {
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-model-usage-extras",
      messages: [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 10, output_tokens: 20 },
          total_cost_usd: 0.01,
          queued_turn_count: 0,
          user_message_uuid: "user-msg-result",
          modelUsage: {
            "claude-sonnet-5": {
              inputTokens: 10,
              outputTokens: 20,
              thinkingTokens: 7,
              costUSD: 0.01,
              costBasis: "list",
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              contextWindow: 200_000,
              maxOutputTokens: 16_000,
            },
          },
        },
      ],
    });
    const done = events
      .map((entry) => entry.event)
      .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
    expect(done).toMatchObject({
      type: "done",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        thinkingTokens: 7,
      },
      costUsd: 0.01,
      costBasis: "list",
      queuedTurnCount: 0,
      userMessageUuid: "user-msg-result",
    });
    // One ModelUsage key naming the requested model is not a different served model.
    expect(done?.servedModel).toBeUndefined();
  });

  it("reports Claude's served model, 1h cache writes, and API-key account on done", async () => {
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-served-model",
      messages: [
        {
          type: "system",
          subtype: "init",
          session_id: "sdk-served-model",
          model: "claude-sonnet-5",
          apiKeySource: "ANTHROPIC_API_KEY",
          slash_commands: [],
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: {
            input_tokens: 10,
            output_tokens: 920,
            cache_creation_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
          },
          modelUsage: {
            // The requested model answered little; a fallback carried the turn.
            "claude-sonnet-5": { inputTokens: 5, outputTokens: 20 },
            "claude-haiku-4-5": { inputTokens: 5, outputTokens: 900 },
          },
        },
      ],
    });
    const done = events
      .map((entry) => entry.event)
      .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
    expect(done?.usage?.cacheWrite1hTokens).toBe(300);
    expect(done?.servedModel).toBe("claude-haiku-4-5");
    expect(done?.account).toMatchObject({ provider: "claude", kind: "api_key" });
    // An API-key turn is not billed to the login, so its email and plan stay off.
    expect(done?.account?.email).toBeUndefined();
  });

  it("gives the usage ledger every figure a Claude turn reports", async () => {
    const { ledger, rows } = createMemoryTurnUsageLedger();
    const requestStart = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
      type: "stream_event",
      ...extra,
      event: { type: "message_start", message: { id: `msg-${Object.values(usage).join("-")}`, usage } },
    });
    const { events, session } = await createClaudeStreamFixture({
      sdkSessionId: "sdk-ledger-complete",
      serviceOverrides: { turnUsageLedger: ledger },
      messages: [
        { type: "system", subtype: "init", session_id: "sdk-ledger-complete", model: "claude-sonnet-5", apiKeySource: "none", slash_commands: [] },
        requestStart({ input_tokens: 10, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 200, output_tokens: 1 }),
        // A subagent's request is its own; it is not a request of this turn.
        requestStart({ input_tokens: 90_000, output_tokens: 1 }, { parent_tool_use_id: "toolu_subagent" }),
        requestStart({ input_tokens: 4, cache_read_input_tokens: 5_200, cache_creation_input_tokens: 150, output_tokens: 1 }),
        {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.0421,
          usage: {
            input_tokens: 14,
            output_tokens: 600,
            cache_read_input_tokens: 10_200,
            cache_creation_input_tokens: 350,
            cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 300 },
          },
          modelUsage: {
            "claude-sonnet-5": {
              inputTokens: 14,
              outputTokens: 600,
              cacheReadInputTokens: 10_200,
              cacheCreationInputTokens: 350,
              webSearchRequests: 0,
              costUSD: 0.0421,
              contextWindow: 1_000_000,
              maxOutputTokens: 64_000,
              provider: "firstParty",
              costBasis: "list",
            },
          },
        },
      ],
    });
    const done = events
      .map((entry) => entry.event)
      .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
    expect(done).toMatchObject({
      status: "completed",
      usage: {
        inputTokens: 14,
        outputTokens: 600,
        cacheReadTokens: 10_200,
        cacheCreationTokens: 350,
        cacheWrite1hTokens: 300,
        // The last main-thread request's whole input side.
        contextTokens: 5_354,
        contextWindow: 1_000_000,
        requestCount: 2,
      },
      costUsd: 0.0421,
      costSource: "list_price",
      costBasis: "list",
      account: { provider: "claude", kind: "subscription" },
    });
    expect(done?.servedModel).toBeUndefined();
    expect(done?.account).not.toHaveProperty("routedAway");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: session.id,
      provider: "claude",
      requestedModel: "anthropic/claude-sonnet-5",
      servedModel: null,
      inputTokens: 14,
      outputTokens: 600,
      cacheReadTokens: 10_200,
      cacheWriteTokens: 350,
      cacheWrite1hTokens: 300,
      contextTokens: 5_354,
      contextWindow: 1_000_000,
      requestCount: 2,
      costUsd: 0.0421,
      costSource: "list_price",
      usageConfidence: "measured",
      account: { provider: "claude", kind: "subscription" },
    });
  });

  it.each([
    { name: "an API key", apiKeySource: "ANTHROPIC_API_KEY", provider: "firstParty", env: {}, kind: "api_key", routedAway: undefined },
    { name: "Bedrock", apiKeySource: "none", provider: "bedrock", env: {}, kind: "unknown", routedAway: "cloud" },
    {
      name: "a redirected endpoint",
      apiKeySource: "none",
      provider: "firstParty",
      env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
      kind: "unknown",
      routedAway: "endpoint",
    },
  ])("names who paid for a Claude turn on $name", async ({ apiKeySource, provider, env, kind, routedAway }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    try {
      const { ledger, rows } = createMemoryTurnUsageLedger();
      const { events } = await createClaudeStreamFixture({
        sdkSessionId: `sdk-ledger-account-${provider}-${apiKeySource}`,
        serviceOverrides: { turnUsageLedger: ledger },
        messages: [
          { type: "system", subtype: "init", session_id: "sdk-ledger-account", model: "claude-sonnet-5", apiKeySource, slash_commands: [] },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.001,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: { "claude-sonnet-5": { inputTokens: 1, outputTokens: 1, provider } },
          },
        ],
      });
      const done = events
        .map((entry) => entry.event)
        .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
      expect(done?.account).toMatchObject({ provider: "claude", kind });
      expect(done?.account?.routedAway).toBe(routedAway);
      expect(rows[0]?.account).toMatchObject({ kind });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("counts each idle Claude turn's own requests and cost", async () => {
    const { ledger, rows } = createMemoryTurnUsageLedger();
    const events: AgentChatEventEnvelope[] = [];
    let streamCall = 0;
    let releaseIdle!: () => void;
    const releaseIdlePromise = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const requestStart = (id: string, input: number) => ({
      type: "stream_event",
      event: { type: "message_start", message: { id, usage: { input_tokens: input, output_tokens: 1 } } },
    });
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-idle-ledger", slash_commands: [] };
          return;
        }
        yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-idle-ledger" };
        await releaseIdlePromise;
        // Background turn one: two requests.
        yield requestStart("idle-1a", 100);
        yield requestStart("idle-1b", 120);
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.02,
          usage: { input_tokens: 220, output_tokens: 8 },
          session_id: "sdk-idle-ledger",
        };
        // Background turn two: one request of its own.
        yield requestStart("idle-2a", 140);
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.01,
          usage: { input_tokens: 140, output_tokens: 4 },
          session_id: "sdk-idle-ledger",
        };
      })()),
      close: vi.fn(),
      sessionId: "sdk-idle-ledger",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      turnUsageLedger: ledger,
    });
    const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
    await service.runSessionTurn({ sessionId: session.id, text: "Start background work." });
    releaseIdle();

    await waitForCondition(
      () => events.filter((event) => event.event.type === "done" && event.event.turnId.startsWith("claude-idle-")).length === 2,
      "two idle Claude turns",
    );
    const idleDone = events
      .map((entry) => entry.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> =>
        event.type === "done" && event.turnId.startsWith("claude-idle-"));
    expect(idleDone[0]).toMatchObject({
      usage: { inputTokens: 220, requestCount: 2, contextTokens: 120 },
      costUsd: 0.02,
      costSource: "list_price",
    });
    expect(idleDone[1]).toMatchObject({
      usage: { inputTokens: 140, requestCount: 1, contextTokens: 140 },
      costUsd: 0.01,
      costSource: "list_price",
    });
    expect(rows.filter((row) => row.turnId.startsWith("claude-idle-")).map((row) => row.requestCount)).toEqual([2, 1]);
    service.forceDisposeAll();
  });

  it("stamps user_message_uuid from the first assistant frame onto done", async () => {
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-early-user-message-uuid",
      messages: [
        {
          type: "assistant",
          user_message_uuid: "user-msg-early",
          message: {
            content: [{ type: "text", text: "hello" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });
    const done = events
      .map((entry) => entry.event)
      .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
    expect(done?.userMessageUuid).toBe("user-msg-early");
  });

  it("warns when Claude reports this client's hooks were ignored", async () => {
    const initializationResult = vi.fn().mockResolvedValue({ hooks_applied: false });
    const onClaudeHooksIgnored = vi.fn();
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      ...makeDefaultClaudeSession(),
      initializationResult,
    });
    const { service, logger } = createService({ onClaudeHooksIgnored });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    await service.sendMessage({ sessionId: session.id, text: "hello" });
    await vi.waitFor(() => {
      expect(onClaudeHooksIgnored).toHaveBeenCalledWith({ sessionId: session.id });
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.claude_hooks_ignored",
      expect.objectContaining({ sessionId: session.id }),
    );
  });

  it("warns and records the plugins-ignored fact when the CLI applies no plugin", async () => {
    const initializationResult = vi.fn().mockResolvedValue({ hooks_applied: true, plugins_applied: false });
    const onClaudePluginsIgnored = vi.fn();
    const onClaudeHooksIgnored = vi.fn();
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      ...makeDefaultClaudeSession(),
      initializationResult,
    });
    const { service, logger } = createService({ onClaudePluginsIgnored, onClaudeHooksIgnored });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    await service.sendMessage({ sessionId: session.id, text: "hello" });
    await vi.waitFor(() => {
      expect(onClaudePluginsIgnored).toHaveBeenCalledWith({ sessionId: session.id });
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.claude_plugins_ignored",
      expect.objectContaining({ sessionId: session.id }),
    );
    // Plugins and hooks are independent reports; a plugin miss must not be
    // reported as a hooks miss.
    expect(logger.warn).not.toHaveBeenCalledWith("agent_chat.claude_hooks_ignored", expect.anything());
    expect(onClaudeHooksIgnored).not.toHaveBeenCalled();
  });

  it("logs why the CLI could not start when a result frame carries a startup failure", async () => {
    const harness = await createClaudeStreamFixture({
      sdkSessionId: "sdk-startup-failure",
      messages: [
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          startup_failure_reason: "cwd_unavailable",
          errors: ["cwd unavailable"],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });
    await vi.waitFor(() => {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        "agent_chat.claude_startup_failure",
        expect.objectContaining({ reason: "cwd_unavailable" }),
      );
    });
  });

  it("lets natural compaction suppress the 97% fallback", async () => {
    const harness = await createClaudeStreamFixture({
      sdkSessionId: "sdk-natural-compact",
      messages: [
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "natural-usage", usage: { input_tokens: 980_000, output_tokens: 0 } },
          },
        },
        { type: "system", subtype: "status", status: "compacting" },
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 980_000, post_tokens: 500_000 },
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    expect(harness.send.mock.calls.map(([message]) => claudeInputText(message))).not.toContain("/compact");
    expect(harness.logger.info).toHaveBeenCalledWith(
      "agent_chat.claude_context_compaction_observed",
      expect.objectContaining({ trigger: "natural", occupancyPctAtTrigger: 98 }),
    );
  });

  it("starts a fresh guardrail episode after occupancy drops below 80%", async () => {
    const harness = await createClaudeStreamFixture({
      sdkSessionId: "sdk-guardrail-episode-reset",
      messages: [
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "first-episode", usage: { input_tokens: 920_000, output_tokens: 0 } },
          },
        },
        { type: "system", subtype: "status", status: "compacting" },
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 920_000, post_tokens: 700_000 },
        },
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "second-episode", usage: { input_tokens: 970_000, output_tokens: 0 } },
          },
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    await vi.waitFor(() => {
      expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
        .toHaveLength(1);
    });
  });

  it("issues one fallback compact at a 97% turn boundary", async () => {
    const harness = await createClaudeStreamFixture({
      sdkSessionId: "sdk-fallback-compact",
      messages: [
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "fallback-usage", usage: { input_tokens: 970_000, output_tokens: 0 } },
          },
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    await vi.waitFor(() => {
      expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
        .toHaveLength(1);
    });
    expect(harness.events.find((entry) =>
      entry.event.type === "context_compact"
      && entry.event.trigger === "ade_fallback"
      && entry.event.state === "started"
    )?.event).toMatchObject({ compactionId: expect.any(String) });
  });

  it("claims a compaction only after the SDK confirms the boundary", async () => {
    const harness = await createClaudeCompactionFixture({
      sdkSessionId: "sdk-compact-confirmed",
      first: [{
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "prompt_too_long",
        errors: ["prompt is too long for this context window"],
        usage: { input_tokens: 1, output_tokens: 0 },
      }],
      afterCompact: [
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 900_000, post_tokens: 120_000 },
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    await vi.waitFor(() => {
      expect(claudeNoticeMessages(harness.events))
        .toContain("context overflowed — compacted; please re-send your last message");
    }, { timeout: 5_000 });
    expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
      .toHaveLength(1);
  });

  it("says it could not compact when the SDK has too few messages to compact", async () => {
    const harness = await createClaudeCompactionFixture({
      sdkSessionId: "sdk-compact-unavailable",
      first: [{
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "prompt_too_long",
        errors: ["prompt is too long for this context window"],
        usage: { input_tokens: 1, output_tokens: 0 },
      }],
      afterCompact: [{
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Not enough messages to compact."],
        usage: { input_tokens: 1, output_tokens: 0 },
      }],
    });

    await vi.waitFor(() => {
      expect(claudeNoticeMessages(harness.events))
        .toContain("Claude could not compact this conversation. Start a new chat or hand off with a shorter history.");
    }, { timeout: 5_000 });
    // The false claim is the bug: ADE told the user to re-send into the same
    // overflow after a compaction that never happened.
    expect(claudeNoticeMessages(harness.events))
      .not.toContain("context overflowed — compacted; please re-send your last message");
    // One refusal is the answer; ADE must not ask again.
    expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
      .toHaveLength(1);
  });

  it("re-arms the fallback compaction after a later turn completes normally", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const gate = (match: string) => {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((r) => { resolve = r; });
      return { match, promise, resolve };
    };
    const compactSent = gate("/compact");
    const secondTurnSent = gate("turn two");
    const thirdTurnSent = gate("turn three");
    const send = vi.fn(async (message: unknown) => {
      const text = claudeInputText(message);
      for (const entry of [compactSent, secondTurnSent, thirdTurnSent]) {
        if (text === entry.match || text.includes(entry.match)) entry.resolve();
      }
    });
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "system", subtype: "init", session_id: "sdk-compact-rearm", slash_commands: [] };
        return;
      }
      // Turn one overflows, so ADE asks for a compaction.
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "prompt_too_long",
        errors: ["prompt is too long for this context window"],
        usage: { input_tokens: 1, output_tokens: 0 },
      };
      // The SDK refuses: one exchange is not enough to compact.
      await compactSent.promise;
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Not enough messages to compact."],
        usage: { input_tokens: 1, output_tokens: 0 },
      };
      // Turn two completes normally and the conversation has grown.
      await secondTurnSent.promise;
      yield {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "rearm-low", usage: { input_tokens: 1_000, output_tokens: 0 } },
        },
      };
      yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
      // Turn three ends at the fallback threshold.
      await thirdTurnSent.promise;
      yield {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "rearm-high", usage: { input_tokens: 970_000, output_tokens: 0 } },
        },
      };
      yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-compact-rearm",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({ sessionId: session.id, text: "turn one" });
    await vi.waitFor(() => {
      expect(claudeNoticeMessages(events))
        .toContain("Claude could not compact this conversation. Start a new chat or hand off with a shorter history.");
    }, { timeout: 5_000 });

    await service.runSessionTurn({ sessionId: session.id, text: "turn two" });
    await service.runSessionTurn({ sessionId: session.id, text: "turn three" });

    // The refusal described one moment, not the session: a grown conversation
    // must be compactable again.
    await vi.waitFor(() => {
      expect(send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
        .toHaveLength(2);
    }, { timeout: 5_000 });
  });

  it("reports a compaction the query teardown threw away", async () => {
    const events: AgentChatEventEnvelope[] = [];
    // The next turn cannot set its permission mode, so ADE rebuilds the query —
    // closing the input pump the /compact is still queued on.
    let failPermissionMode = false;
    const setPermissionMode = vi.fn(async () => {
      if (!failPermissionMode) return;
      failPermissionMode = false;
      throw new Error("claude query is gone");
    });
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "system", subtype: "init", session_id: "sdk-compact-abandoned", slash_commands: [] };
        return;
      }
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "prompt_too_long",
        errors: ["prompt is too long for this context window"],
        usage: { input_tokens: 1, output_tokens: 0 },
      };
      await new Promise<void>(() => {});
    })());
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-compact-abandoned",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({ sessionId: session.id, text: "first message" });
    await vi.waitFor(() => {
      expect(send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
        .toHaveLength(1);
    }, { timeout: 5_000 });

    failPermissionMode = true;
    await service.runSessionTurn({ sessionId: session.id, text: "second message" }).catch(() => undefined);

    await vi.waitFor(() => {
      expect(claudeNoticeMessages(events))
        .toContain("Claude could not compact this conversation. Its session restarted before the compaction ran.");
    }, { timeout: 5_000 });
    // The held notice never fires: no compaction happened.
    expect(claudeNoticeMessages(events))
      .not.toContain("context overflowed — compacted; please re-send your last message");
    expect(events.find((entry) => entry.event.type === "context_compact"
      && entry.event.state === "failed")?.event).toMatchObject({ failReason: "teardown" });
  });

  it("recovers once from prompt_too_long without replaying the failed user message", async () => {
    const harness = await createClaudeStreamFixture({
      sdkSessionId: "sdk-overflow-recovery",
      messages: [{
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "prompt_too_long",
        errors: ["prompt is too long for this context window"],
        usage: { input_tokens: 1, output_tokens: 0 },
      }],
    });

    await vi.waitFor(() => {
      expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
        .toHaveLength(1);
    });
    // The SDK has not confirmed a boundary, so ADE must not say it compacted.
    expect(claudeNoticeMessages(harness.events))
      .not.toContain("context overflowed — compacted; please re-send your last message");
    expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) =>
      text.includes("Exercise Claude streaming text."))).toHaveLength(1);
  });

  it("does not duplicate Claude thinking when the final assistant message repeats streamed content", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let reasoningCountAfterDelta = -1;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-thinking",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Checking both imports before editing.",
          },
        },
      };
      await new Promise((resolve) => setTimeout(resolve, 120));
      reasoningCountAfterDelta = events.filter((event) => event.event.type === "reasoning").length;
      yield {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Checking both imports before editing." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-thinking",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const reasoningEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "reasoning" }> => event.type === "reasoning");
    expect(reasoningEvents.map((event) => event.text)).toEqual(["Checking both imports before editing."]);
    // The streamed thinking_delta must be what created the reasoning row — not the
    // final assistant message (which would also produce a row if dedupe broke).
    expect(reasoningCountAfterDelta).toBe(1);
    expect(events.some((event) => event.event.type === "activity" && event.event.activity === "thinking")).toBe(true);
    const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
      includePartialMessages?: boolean;
      agentProgressSummaries?: boolean;
      forwardSubagentText?: boolean;
    } | undefined;
    expect(sessionOpts).toEqual(expect.objectContaining({
      includePartialMessages: true,
      agentProgressSummaries: true,
      forwardSubagentText: false,
    }));
  });

  it("does not duplicate Claude thinking when the snapshot reports a different content index", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-thinking-index",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "thinking_delta",
            thinking: "Checking both imports before editing.",
          },
        },
      };
      await new Promise((resolve) => setTimeout(resolve, 120));
      // The SDK strips a redacted/empty thinking block from the snapshot, so
      // the completed block lands at index 0 although the stream said 1.
      yield {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Checking both imports before editing." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-thinking-index",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const reasoningEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "reasoning" }> => event.type === "reasoning");
    expect(reasoningEvents.map((event) => event.text)).toEqual(["Checking both imports before editing."]);
  });

  it("groups Claude text deltas by the stable message id and suppresses the repeated snapshot", async () => {
    const messageId = "msg-stable-stream";
    const fragments = ["Stable ", "Claude ", "text ", "stays ", "whole."];
    const fullText = fragments.join("");
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-session-stable-stream",
      messages: [
        {
          type: "stream_event",
          uuid: "wire-message-start",
          event: {
            type: "message_start",
            message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
          },
        },
        ...fragments.map((text, index) => ({
          type: "stream_event",
          uuid: `wire-delta-${index + 1}`,
          event: {
            type: "content_block_delta",
            index: 0,
            message: { id: messageId },
            delta: { type: "text_delta", text },
          },
        })),
        {
          type: "assistant",
          uuid: "wire-assistant-snapshot",
          supersedes: ["superseded-wire-message"],
          message: {
            id: messageId,
            content: [{ type: "text", text: fullText }],
            usage: { input_tokens: 1, output_tokens: 5 },
          },
        },
        { type: "result", usage: { input_tokens: 1, output_tokens: 5 } },
      ],
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
    expect(new Set(textEvents.map((event) => event.messageId))).toEqual(new Set([messageId]));

    const retraction = events.find((event) => event.event.type === "transcript_retraction");
    expect(retraction?.event).toMatchObject({
      type: "transcript_retraction",
      replacementMessageId: messageId,
    });
  });

  it("keeps sequential Claude text blocks ordered under one stable message id", async () => {
    const messageId = "msg-stable-blocks";
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-session-stable-blocks",
      messages: [
        {
          type: "stream_event",
          uuid: "wire-blocks-start",
          event: {
            type: "message_start",
            message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-0-delta-1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "First " },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-0-delta-2",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "block. " },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-1-delta-1",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Second " },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-1-delta-2",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "block." },
          },
        },
        {
          type: "assistant",
          uuid: "wire-blocks-snapshot",
          message: {
            id: messageId,
            content: [
              { type: "text", text: "First block. " },
              { type: "text", text: "Second block." },
            ],
            usage: { input_tokens: 1, output_tokens: 4 },
          },
        },
        { type: "result", usage: { input_tokens: 1, output_tokens: 4 } },
      ],
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe("First block. Second block.");
    expect(textEvents.every((event) => event.messageId === messageId)).toBe(true);
  });

  it("falls back to Claude wire UUIDs when streamed text has no stable message id", async () => {
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-session-wire-fallback",
      messages: [
        {
          type: "stream_event",
          uuid: "wire-fallback-start",
          event: { type: "message_start", message: {} },
        },
        {
          type: "stream_event",
          uuid: "wire-fallback-delta",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Fallback text." },
          },
        },
        {
          type: "assistant",
          uuid: "wire-fallback-snapshot",
          message: {
            content: [
              { type: "text", text: "Fallback text." },
              { type: "text", text: " Snapshot fallback." },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
        { type: "result", usage: { input_tokens: 1, output_tokens: 2 } },
      ],
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe("Fallback text. Snapshot fallback.");
    expect(textEvents.map((event) => event.messageId)).toEqual([
      "wire-fallback-delta",
      "wire-fallback-snapshot",
    ]);
  });

  it("does not duplicate Claude text when an assistant snapshot repeats id-less streamed deltas", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-text-dedupe",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Got it. Let me check" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " the desktop app structure." },
        },
      };
      yield {
        type: "assistant",
        message: {
          id: "msg-text-dedupe",
          content: [{ type: "text", text: "Got it. Let me check the desktop app structure." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-text-dedupe",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text)).toEqual(["Got it. Let me check the desktop app structure."]);
  });

  it("does not duplicate Claude text when the final assistant snapshot extends streamed deltas", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-text-suffix",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "I checked the renderer" },
        },
      };
      yield {
        type: "assistant",
        message: {
          id: "msg-text-suffix",
          content: [{ type: "text", text: "I checked the renderer and added focused tests." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-text-suffix",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe("I checked the renderer and added focused tests.");
  });

  it("keeps Claude streamed text dedupable when a tool-use start arrives before the assistant snapshot", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-text-tool-dedupe",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Let me check the desktop app." },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "tool-use-after-text",
            name: "Bash",
            input: { command: "ls" },
          },
        },
      };
      yield {
        type: "assistant",
        message: {
          id: "msg-text-tool-dedupe",
          content: [
            { type: "text", text: "Let me check the desktop app." },
            { type: "tool_use", id: "tool-use-after-text", name: "Bash", input: { command: "ls" } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-text-tool-dedupe",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text)).toEqual(["Let me check the desktop app."]);
    expect(events.some((event) => event.event.type === "tool_call" && event.event.tool === "Bash")).toBe(true);
  });

  it("re-emits a Claude tool_call with parsed args once the input has streamed in after content_block_start", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-streamed-args",
          slash_commands: [],
        };
        return;
      }

      // Stream path: tool_use starts with NO input; the input arrives via
      // input_json_delta and only parses at content_block_stop. Without the
      // enriched re-emit the persisted tool_call keeps args:{} forever.
      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-use-streamed-args", name: "Read", input: {} },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"apps/desk" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "top/src/a.ts\"}" },
        },
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-streamed-args",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Read the file.",
    });

    const toolCalls = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "tool_call" }> => event.type === "tool_call")
      .filter((event) => event.tool === "Read");
    expect(toolCalls).toHaveLength(2);
    // Same itemId so renderers collapse both into a single entry.
    expect(new Set(toolCalls.map((event) => event.itemId)).size).toBe(1);
    expect(toolCalls[0]?.args).toEqual({});
    expect(toolCalls[1]?.args).toEqual({ file_path: "apps/desktop/src/a.ts" });
  });

  it("normalizes Claude server web and MCP blocks into compact activity lifecycles", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-structured-activity",
          slash_commands: [],
        };
        return;
      }
      yield {
        type: "assistant",
        message: {
          id: "msg-structured-activity",
          content: [
            {
              type: "server_tool_use",
              id: "search-1",
              name: "web_search",
              input: { query: "ADE transcript UI" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "search-1",
              content: [{
                type: "web_search_result",
                title: "ADE",
                url: "https://example.com/ade",
                encrypted_content: "opaque",
              }],
            },
            {
              type: "mcp_tool_use",
              id: "mcp-1",
              server_name: "github",
              name: "search_issues",
              input: { query: "label:bug" },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "mcp-1",
              is_error: false,
              content: [{ type: "text", text: "Issue 1" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-structured-activity",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    await service.runSessionTurn({
      sessionId: session.id,
      text: "Research the transcript UI.",
    });

    expect(events.filter((event) =>
      event.event.type === "web_search" && event.event.itemId === "search-1"
    ).map((event) => event.event.type === "web_search" ? event.event.status : null)).toEqual([
      "running",
      "completed",
    ]);
    expect(events.filter((event) =>
      (event.event.type === "tool_call" || event.event.type === "tool_result")
      && event.event.itemId === "mcp-1"
    ).map((event) => event.event.type)).toEqual(["tool_call", "tool_result"]);
    expect(events.find((event) =>
      event.event.type === "tool_call" && event.event.itemId === "mcp-1"
    )?.event).toMatchObject({
      tool: "github:search_issues",
      mcp: { server: "github", tool: "search_issues" },
    });
  });

  it("emits completed Claude tool_result rows when tool_use_summary arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-tool-summary",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-use-1",
            name: "Read",
            input: { file_path: "apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx" },
          },
        },
      };
      yield {
        type: "tool_use_summary",
        summary: "Checked the shared chat renderer",
        preceding_tool_use_ids: ["tool-use-1"],
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-tool-summary",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Inspect the shared chat renderer.",
    });

    const completedToolResults = events.filter((event) =>
      event.event.type === "tool_result"
      && event.event.itemId === "tool-use-1"
      && event.event.status === "completed"
    );

    expect(completedToolResults).toHaveLength(1);
    expect(completedToolResults[0]!.event.type).toBe("tool_result");
    if (completedToolResults[0]!.event.type !== "tool_result") {
      throw new Error("Expected tool_result");
    }
    expect(completedToolResults[0]!.event.result).toMatchObject({
      synthetic: true,
      source: "claude_tool_use_summary",
      summary: "Checked the shared chat renderer",
    });
  });

  it("emits completed Claude tool_result rows for open tools when the turn ends without a tool summary", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-tool-fallback",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-use-2",
            name: "Read",
            input: { file_path: "apps/desktop/src/renderer/components/chat/ChatWorkLogBlock.tsx" },
          },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-tool-fallback",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Inspect the grouped work log renderer.",
    });

    const completedToolResults = events.filter((event) =>
      event.event.type === "tool_result"
      && event.event.itemId === "tool-use-2"
      && event.event.status === "completed"
    );

    expect(completedToolResults).toHaveLength(1);
    expect(completedToolResults[0]!.event.type).toBe("tool_result");
    if (completedToolResults[0]!.event.type !== "tool_result") {
      throw new Error("Expected tool_result");
    }
    expect(completedToolResults[0]!.event.result).toMatchObject({
      synthetic: true,
      source: "claude_turn_finalization",
      finalTurnStatus: "completed",
    });
  });

  it("allows generic Claude tools without manufacturing updatedInput", async () => {
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-can-use-tool", slash_commands: [] };
      })()),
      close: vi.fn(),
      sessionId: "sdk-can-use-tool",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);
    const { service } = createService();
    await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    await vi.waitFor(() => expect(claudeSdkCreateSessionCompat).toHaveBeenCalled());
    const options = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
      canUseTool: (
        tool: string,
        input: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };

    const result = await options.canUseTool(
      "Read",
      { file_path: "README.md" },
      { signal: new AbortController().signal, toolUseID: "read-tool-1" },
    );

    expect(result).toEqual({ behavior: "allow" });
    expect(result).not.toHaveProperty("updatedInput");
  });

  it("suppresses the 'tool calls were denied' notice for tool_use_ids resolved inline via canUseTool", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let service: ReturnType<typeof createService>["service"];
    let sessionId = "";

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-denial-suppression",
          slash_commands: [],
        };
        return;
      }

      const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;

      // Approve plan exit through canUseTool — this records the tool_use_id in
      // runtime.resolvedToolUseIds so the SDK's later permission_denials echo
      // for the same id should NOT surface a "denied this turn" notice.
      await sessionOpts.canUseTool("EnterPlanMode", {}, {
        signal: new AbortController().signal,
        toolUseID: "tool-enter-plan-suppress",
      });
      const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
        planDescription: "Ship the approved plan.",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-exit-plan-suppress",
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && typeof ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind) === "string"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );
      await service.approveToolUse({
        sessionId,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });
      await exitPromise;

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-exit-plan-suppress",
            name: "ExitPlanMode",
            input: { planDescription: "Ship the approved plan." },
          },
        },
      };
      yield {
        type: "system",
        subtype: "permission_denied",
        session_id: "sdk-session-denial-suppression",
        tool_name: "ExitPlanMode",
        tool_use_id: "tool-exit-plan-suppress",
        decision_reason: "echoed denial from the SDK",
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        permission_denials: [
          // Resolved inline — must not surface a notice.
          { tool_name: "ExitPlanMode", tool_use_id: "tool-exit-plan-suppress" },
          // Genuine denial — must still surface a notice.
          { tool_name: "Bash", tool_use_id: "tool-bash-unresolved" },
        ],
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-denial-suppression",
      setPermissionMode,
    } as any);

    ({ service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    }));

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    sessionId = session.id;

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Plan, approve, and report.",
    });

    const denialNotices = events
      .map((envelope) => envelope.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
        event.type === "system_notice" && typeof event.message === "string" && event.message.includes("denied this turn"),
      );

    expect(denialNotices).toHaveLength(1);
    expect(denialNotices[0]!.message).toContain("Bash");
    expect(denialNotices[0]!.message).not.toContain("ExitPlanMode");
    expect(denialNotices[0]!.message).toMatch(/^1 tool call was denied this turn/);
    expect(events.filter((envelope) =>
      envelope.event.type === "tool_result"
      && envelope.event.itemId === "tool-exit-plan-suppress"
      && envelope.event.status === "failed"
    )).toHaveLength(0);
  });

  it("bridges Claude AskUserQuestion through ADE's question UI", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let permissionResult: Record<string, unknown> | null = null;

    const askInput = {
      questions: [
        {
          question: "What should we do about the two task list views?",
          header: "Task views",
          options: [
            {
              label: "Remove the TurnSummaryCard tasks",
              description: "Keep only the inline task list.",
              preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
            },
            {
              label: "Keep both, improve summary",
              description: "Keep both task views, but make the summary less intrusive.",
              preview: "<div><strong>Hybrid</strong><p>Inline progress plus a compact summary card.</p></div>",
            },
          ],
          multiSelect: false,
        },
        {
          question: "Should the inline task list pin while tasks are active?",
          header: "Inline pinning",
          options: [
            { label: "Yes, pin while active" },
            { label: "No, let it scroll" },
          ],
          multiSelect: false,
        },
      ],
    };

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-ask-user",
          slash_commands: [],
        };
        return;
      }

      const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
      permissionResult = await sessionOpts.canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-user-1",
      });

      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Thanks, I can continue now." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-ask-user",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      permissionMode: "plan",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Figure out the task list UX and ask any clarifying questions you need.",
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && typeof (event.event.detail as { request?: { providerMetadata?: { tool?: string } } } | undefined)?.request?.providerMetadata?.tool === "string"
        && ((event.event.detail as { request?: { providerMetadata?: { tool?: string } } }).request?.providerMetadata?.tool === "AskUserQuestion"),
    );

    const request = (approvalEvent.event.detail as {
      request: {
        kind: string;
        questions: Array<{
          id: string;
          question: string;
          options?: Array<{ preview?: string; previewFormat?: string }>;
        }>;
      };
    }).request;
    expect(request.kind).toBe("structured_question");
    expect(request.questions.map((question) => question.question)).toEqual([
      "What should we do about the two task list views?",
      "Should the inline task list pin while tasks are active?",
    ]);
    expect(request.questions[0]?.options?.[0]).toMatchObject({
      preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
      previewFormat: "markdown",
    });

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      answers: {
        question_1: "Keep both, improve summary",
        question_2: "Yes, pin while active",
      },
    });

    await sendPromise;

    expect(permissionResult).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          "What should we do about the two task list views?": "Keep both, improve summary",
          "Should the inline task list pin while tasks are active?": "Yes, pin while active",
        },
      },
    });
  });

  it("keeps standalone ask_user declines explicit without emitting a fake cleanup tool_result", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Planning question",
      body: "Which part of the planning UI should we test first?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which part of the planning UI should we test first?",
        options: [
          { label: "Question flow", value: "question_flow" },
          { label: "Plan updates", value: "plan_updates" },
        ],
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Planning question";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "decline",
    });

    const result = await requestPromise;
    expect(result.decision).toBe("decline");
    expect(events.filter((event) => event.event.type === "tool_result")).toHaveLength(0);
  });

  it("replaces blank question text with the body rather than publishing an empty prompt", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    // OpenCode and Droid hand over an EMPTY question rather than omitting it,
    // which every caller's `??` fallback misses — and `questions` outranks
    // `body` here, so the card rendered with no prompt on it and a blank
    // description underneath.
    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Blank question",
      body: "Which database should the worker read from?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "   ",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Blank question";
      },
    );

    const request = (approvalEvent.event.detail as {
      request: { description?: string; questions: Array<{ question: string }> };
    }).request;
    expect(request.questions[0]?.question).toBe("Which database should the worker read from?");
    expect(request.description).toBe("Which database should the worker read from?");

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "decline",
    });
    await requestPromise;
  });

  it("persists awaitingInput while chat input is pending and clears it after resolution", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Pending question",
      body: "Which path should we take?",
      questions: [{
        id: "__proto__",
        header: "Question 1",
        question: "Which path should we take?",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Pending question";
      },
    );

    expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      awaitingInput: true,
      pendingInputItemId: approvalEvent.event.itemId,
    });

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Take the safe path.",
    });

    const result = await requestPromise;
    expect(result).toMatchObject({
      decision: "accept",
      responseText: "Take the safe path.",
    });
    expect(Object.prototype.hasOwnProperty.call(result.answers, "__proto__")).toBe(true);
    expect(result.answers.__proto__).toEqual(["Take the safe path."]);
    const resolutionEvent = events.find((event) =>
      event.sessionId === session.id
      && event.event.type === "pending_input_resolved"
      && event.event.itemId === approvalEvent.event.itemId,
    );
    expect(resolutionEvent?.event).toMatchObject({
      type: "pending_input_resolved",
      itemId: approvalEvent.event.itemId,
      resolution: "accepted",
    });
    const recorded = resolutionEvent?.event.type === "pending_input_resolved"
      ? resolutionEvent.event.answers
      : undefined;
    expect(Object.prototype.hasOwnProperty.call(recorded, "__proto__")).toBe(true);
    expect(recorded?.__proto__).toBe("Take the safe path.");
    expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
  });

  it.each([
    ["claude", "sonnet", undefined],
    ["codex", "gpt-5.4", undefined],
    ["opencode", "", "opencode/anthropic/claude-sonnet-5"],
    ["cursor", "composer-2", "cursor/composer-2"],
    ["droid", "claude-opus-4-6", "droid/claude-opus-4-6"],
  ] as const)(
    "clears pending input and persisted awaitingInput when a %s session is settled",
    async (provider, model, modelId) => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider,
        model,
        ...(modelId ? { modelId } : {}),
      });
      const requestPromise = service.requestChatInput({
        chatSessionId: session.id,
        title: "Pending settlement question",
        body: "Should this session remain open?",
        questions: [{
          id: "answer",
          header: "Question",
          question: "Should this session remain open?",
          allowsFreeform: true,
        }],
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { title?: string } } | undefined)?.request?.title === "Pending settlement question"),
      );

      expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
      await service.dismissPendingInputForSettlement({ sessionId: session.id });

      await expect(requestPromise).resolves.toMatchObject({ decision: "cancel" });
      expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
      await expect(service.getSessionSummary(session.id)).resolves.not.toMatchObject({
        awaitingInput: true,
        pendingInputItemId: approvalEvent.event.itemId,
      });
    },
  );

  it.each([
    ["claude", "sonnet", undefined],
    ["codex", "gpt-5.4", undefined],
    ["opencode", "", "opencode/anthropic/claude-sonnet-5"],
    ["cursor", "composer-2", "cursor/composer-2"],
    ["droid", "claude-opus-4-6", "droid/claude-opus-4-6"],
  ] as const)(
    "clears a restored stale awaitingInput marker for %s without a live provider waiter",
    async (provider, model, modelId) => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider,
        model,
        ...(modelId ? { modelId } : {}),
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        awaitingInput: true,
      });

      await service.dismissPendingInputForSettlement({ sessionId: session.id });

      expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
      await expect(service.getSessionSummary(session.id)).resolves.not.toMatchObject({
        awaitingInput: true,
      });
    },
  );

  it("rejects normal chat sends while a pending input request is waiting", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Pending question",
      body: "Which path should we take?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which path should we take?",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Pending question";
      },
    );

    await expect(service.sendMessage({
      sessionId: session.id,
      text: "Treat this as the answer even though it came through chat.send.",
    })).rejects.toThrow("Answer or decline the pending request before sending another message.");

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "decline",
    });

    await expect(requestPromise).resolves.toMatchObject({ decision: "decline" });
  });

  it("maps freeform replies to the single pending question when only one answer is needed", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Single question",
      body: "Which area should we test first?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which area should we test first?",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Single question";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Question flow",
    });

    await expect(requestPromise).resolves.toMatchObject({
      decision: "accept",
      answers: { answer: ["Question flow"] },
      responseText: "Question flow",
    });
  });

  // The reply must not be copied into every question — that is the fan-out this
  // test was written for. It must also not land under a synthetic "response"
  // key, which is where it used to go: Claude's `question.reply` takes one
  // answer array per ASKED question, so that key matched nothing and the user's
  // reply never reached the model. It answers the first question, and only the
  // first, which is what the desktop composer produces for the same input.
  it("lands a single freeform reply on one question rather than fanning it out", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Multiple questions",
      body: "Tell me which plan we should use and whether to pin tasks.",
      questions: [
        {
          id: "plan_focus",
          header: "Plan focus",
          question: "What kind of planning scenario should I use?",
          allowsFreeform: true,
        },
        {
          id: "task_pinning",
          header: "Task pinning",
          question: "Should the inline task list stay pinned?",
          allowsFreeform: true,
        },
      ],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Multiple questions";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Start with the UI planning case.",
    });

    const resolved = await requestPromise;
    expect(resolved).toMatchObject({
      decision: "accept",
      answers: { plan_focus: ["Start with the UI planning case."] },
      responseText: "Start with the UI planning case.",
    });
    expect(Object.keys(resolved.answers ?? {})).toEqual(["plan_focus"]);
  });

  it("responds to native Codex requestUserInput declines with empty answers instead of interrupting the turn", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      codexApprovalPolicy: "untrusted",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Ask one planning question before coding.",
    }, { awaitDispatch: true });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "native-request-1",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-question-1",
        threadId: "thread-1",
        turnId: "turn-1",
        questions: [
          {
            id: "plan_focus",
            header: "Plan focus",
            question: "What kind of planning scenario should I use?",
            isOther: true,
            options: [
              { label: "UI planning" },
              { label: "Bug fix planning" },
            ],
          },
        ],
      },
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && event.event.itemId === "codex-question-1",
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "cancel",
    });

    expect(
      mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt"),
    ).toBe(false);
    expect(
      mockState.codexRequestPayloads.find((payload) => payload.id === "native-request-1"),
    ).toMatchObject({
      id: "native-request-1",
      result: {
        answers: {},
      },
    });
  });

  it("keeps Codex isBlocking:false as live steering instead of awaiting you", async () => {
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
      text: "Keep going while I answer.",
    }, { awaitDispatch: true });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "steering-request-1",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-steer-1",
        threadId: "thread-1",
        turnId: "turn-1",
        isBlocking: false,
        questions: [{
          id: "steer",
          header: "Steer",
          question: "Want a tighter plan?",
          isOther: true,
          options: [{ label: "Yes" }, { label: "No" }],
        }],
      },
    });
    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && event.event.itemId === "codex-steer-1",
    );
    expect((approvalEvent.event.detail as { request?: { blocking?: boolean } } | undefined)?.request?.blocking)
      .toBe(false);

    await service.sendMessage({
      sessionId: session.id,
      text: "Keep coding; I'll answer in the card.",
    }, { awaitDispatch: true, routeActiveToSteer: true });

    const summary = await service.getSessionSummary(session.id);
    expect(summary?.awaitingInput).toBeUndefined();
    expect(summary?.pendingInputItemId).toBeUndefined();
    expect(summary?.steeringInput).toBe(true);
    expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
    expect(readPersistedChatState(session.id).steeringInput).toBeUndefined();
  });

  it("points pendingInputItemId at a blocking Codex request when a steering card is already live", async () => {
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
      text: "Keep going.",
    }, { awaitDispatch: true });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "steer-then-block-1",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-steer-first",
        isBlocking: false,
        questions: [{ id: "steer", question: "Want more tests?", options: [{ label: "Yes" }] }],
      },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-steer-first",
    );
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "steer-then-block-2",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-block-second",
        questions: [{ id: "block", question: "Approve this command?", options: [{ label: "Allow" }] }],
      },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-block-second",
    );

    const summary = await service.getSessionSummary(session.id);
    expect(summary?.awaitingInput).toBe(true);
    expect(summary?.pendingInputItemId).toBe("codex-block-second");
    expect(summary?.steeringInput).toBe(true);
  });

  it("still blocks Codex requestUserInput when isBlocking is omitted", async () => {
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
      text: "Ask before coding.",
    }, { awaitDispatch: true });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "blocking-request-1",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-block-1",
        questions: [{
          id: "plan",
          header: "Plan",
          question: "Which plan?",
          options: [{ label: "A" }],
        }],
      },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request"
        && event.event.itemId === "codex-block-1",
    );

    await expect(service.sendMessage({
      sessionId: session.id,
      text: "Treat this as the answer.",
    })).rejects.toThrow("Answer or decline the pending request before sending another message.");

    const summary = await service.getSessionSummary(session.id);
    expect(summary?.awaitingInput).toBe(true);
    expect(summary?.pendingInputItemId).toBe("codex-block-1");
    expect(summary?.steeringInput).toBeUndefined();
  });

  it("cancels a Codex steering card when the turn completes", async () => {
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
      text: "Keep going.",
    }, { awaitDispatch: true });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "steering-request-done",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-steer-done",
        isBlocking: false,
        questions: [{ id: "steer", question: "Want more tests?", options: [{ label: "Yes" }] }],
      },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-steer-done",
    );

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "pending_input_resolved"
        && event.event.itemId === "codex-steer-done",
    );
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.steeringInput).not.toBe(true);
    expect(summary?.awaitingInput).not.toBe(true);
  });

  it("enables Codex update_plan on every thread/start", async () => {
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    await service.sendMessage({
      sessionId: session.id,
      text: "Plan then patch.",
    }, { awaitDispatch: true });
    const startPayload = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
    expect(startPayload?.params).toMatchObject({
      config: { tools: { update_plan: { enabled: true } } },
    });
  });

  it("emits the Codex 50% five-hour plan notice from used_percent, not remaining/limit", async () => {
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
      text: "Keep working.",
    }, { awaitDispatch: true });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: { remaining: 10, limit: 100 },
    });
    await Promise.resolve();
    expect(events.some((event) =>
      event.event.type === "system_notice"
      && event.event.message === "Approaching Codex plan limit"
    )).toBe(false);

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { used_percent: 50 }, secondary: { used_percent: 10 } } },
    });
    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.noticeKind === "rate_limit"
        && event.event.status === "allowed_warning"
        && event.event.message === "Approaching Codex plan limit"
      )).toBe(true);
    });
  });

  it("emits Computer Use status only on macOS and folds MCP live events into the working row", async () => {
    const originalPlatform = process.platform;
    const events: AgentChatEventEnvelope[] = [];
    try {
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
        text: "Keep working.",
      }, { awaitDispatch: true });

      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      mockState.emitCodexPayload({
        method: "mcpServer/startupStatus/updated",
        params: { serverName: "computer_use", status: "ok" },
      });
      await Promise.resolve();
      expect(events.some((event) =>
        event.event.type === "tool_call" && event.event.tool === "computer_use"
      )).toBe(false);

      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      mockState.emitCodexPayload({
        method: "mcpServer/startupStatus/updated",
        params: { serverName: "computer_use", status: "ok" },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "tool_call"
          && event.event.tool === "computer_use"
          && (event.event.args as { status?: string } | undefined)?.status === "ready"
        )).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "mcp-stream-1",
        method: "mcpServer/event/stream/start",
        params: { serverName: "docs" },
      });
      mockState.emitCodexPayload({
        method: "mcpServer/event/resource/updated",
        params: { serverName: "docs", message: "file changed" },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "tool_call"
          && event.event.tool === "mcp_event"
          && (event.event.args as { event?: string } | undefined)?.event === "file changed"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.some((payload) =>
        payload.id === "mcp-stream-1" && payload.result && typeof payload.result === "object"
      )).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("lists installed Codex plugins from a live runtime without toggling them", async () => {
    mockState.codexResponseOverrides.set("plugin/list", () => ({
      marketplaces: [{
        name: "openai-bundled",
        plugins: [{
          id: "bundled.docs",
          name: "docs",
          enabled: true,
          installed: true,
          source: { type: "local" },
          installPolicy: "INSTALLED_BY_DEFAULT",
        }],
      }],
    }));
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    await service.sendMessage({
      sessionId: session.id,
      text: "Open Codex.",
    }, { awaitDispatch: true });
    await expect(service.listCodexPlugins({})).resolves.toEqual([
      expect.objectContaining({
        id: "bundled.docs",
        name: "docs",
        enabled: true,
        origin: "bundled",
      }),
    ]);
    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "plugin/reconcile")).toBe(true);
    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "plugin/list")).toBe(true);
  });

  it("lists Codex plugins from the requested lane when sessionId is omitted", async () => {
    mockState.codexResponseOverrides.set("plugin/list", () => ({
      marketplaces: [{
        name: "openai-bundled",
        plugins: [{
          id: "bundled.docs",
          name: "docs",
          enabled: true,
          installed: true,
          source: { type: "local" },
          installPolicy: "INSTALLED_BY_DEFAULT",
        }],
      }],
    }));
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    await service.sendMessage({
      sessionId: session.id,
      text: "Open Codex.",
    }, { awaitDispatch: true });
    await expect(service.listCodexPlugins({ laneId: "lane-missing" })).resolves.toEqual([]);
    await expect(service.listCodexPlugins({ laneId: "lane-1" })).resolves.toEqual([
      expect.objectContaining({ id: "bundled.docs", origin: "bundled" }),
    ]);
  });

  it("fails open on Codex plugin method-not-found and surfaces other plugin errors", async () => {
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    await service.sendMessage({
      sessionId: session.id,
      text: "Open Codex.",
    }, { awaitDispatch: true });

    mockState.codexResponseOverrides.set("plugin/list", {
      error: { code: -32601, message: "Method not found" },
    });
    await expect(service.listCodexPlugins({ sessionId: session.id })).resolves.toEqual([]);

    mockState.codexResponseOverrides.set("plugin/list", {
      error: { code: -32000, message: "auth failed" },
    });
    await expect(service.listCodexPlugins({ sessionId: session.id })).rejects.toThrow(/auth failed/);
  });

  it("clears Codex modelId when the runtime reports an unregistered thread model", async () => {
    mockState.codexResponseOverrides.set("thread/start", () => ({
      thread: { id: "thread-unknown-model", model: "gpt-unknown-preview" },
    }));
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      modelId: "openai/gpt-5.4",
    });
    await service.sendMessage({
      sessionId: session.id,
      text: "Open Codex.",
    }, { awaitDispatch: true });
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.model).toBe("gpt-unknown-preview");
    expect(summary?.modelId).toBeUndefined();
  });
});
