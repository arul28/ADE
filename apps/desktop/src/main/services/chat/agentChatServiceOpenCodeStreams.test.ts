import {
  AgentChatEventEnvelope,
  buildOpenCodeStreamMessages,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createLogger,
  createService,
  fs,
  mockState,
  openCodeEventStream,
  path,
  startup,
  streamText,
  tmpRoot,
  waitFor,
  waitForEvent,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  // --------------------------------------------------------------------------
  // approveToolUse
  // --------------------------------------------------------------------------

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

  describe("OpenCode streams", () => {
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
  });
});
