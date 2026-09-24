import {
  AgentChatEventEnvelope,
  PendingInputRequest,
  acquireCursorSdkConnection,
  bridgeClaudeSessionToQuery,
  buildOpenCodePromptParts,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createService,
  fs,
  installRealTranscriptParser,
  mockState,
  parseAgentChatTranscript,
  path,
  query,
  readPersistedChatState,
  releaseCursorSdkConnection,
  startup,
  streamText,
  tmpRoot,
  waitFor,
  waitForCondition,
  waitForEvent,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("interrupt", () => {
    it("does not cancel staged Claude messages for stop_only", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const interrupt = vi.fn(async () => {
        releaseTurn();
        return { still_queued: [] };
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-stop-only",
              slash_commands: [],
            };
            return;
          }
          yield {
            type: "assistant",
            message: {
              id: "stop-only-assistant",
              content: [{ type: "text", text: "Still working." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          await turnGate;
        })()),
        close: vi.fn(() => releaseTurn()),
        interrupt,
        sessionId: "sdk-stop-only",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
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
      const turnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep this turn active.",
      });
      await waitForEvent(events, (entry): entry is AgentChatEventEnvelope => entry.event.type === "text");
      const queued = await service.steer({
        sessionId: session.id,
        text: "Keep this staged message.",
      });

      await expect(service.interrupt({
        sessionId: session.id,
        mode: "stop_only",
      })).resolves.toEqual({
        mode: "stop_only",
        cancelledQueuedCount: 0,
      });
      expect(events.some((entry) =>
        entry.event.type === "queue_recovery"
        && entry.event.state === "available"
      )).toBe(false);
      expect(events.some((entry) =>
        entry.event.type === "system_notice"
        && entry.event.steerId === queued.steerId
        && /cancelled because the current turn was interrupted/i.test(entry.event.message)
      )).toBe(false);
      await turnPromise;
    });

    it("cancels Claude's queued messages with the SDK option and makes them recoverable", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const request = vi.fn(async () => {
        releaseTurn();
        return { response: { still_queued: [], cancelled: [] } };
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-stop-and-clear",
            slash_commands: [],
            capabilities: ["interrupt_cancel_queued_v1"],
          };
          if (streamCall === 1) {
            return;
          }
          yield {
            type: "assistant",
            message: {
              id: "stop-and-clear-assistant",
              content: [{ type: "text", text: "Still working." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          await turnGate;
        })()),
        close: vi.fn(() => releaseTurn()),
        request,
        sessionId: "sdk-stop-and-clear",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
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
      const turnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep this turn active.",
      });
      await waitForEvent(events, (entry): entry is AgentChatEventEnvelope => entry.event.type === "text");
      const queued = await service.steer({
        sessionId: session.id,
        text: "Recover this staged message.",
      });

      const interrupted = await service.interrupt({
        sessionId: session.id,
        mode: "stop_and_clear",
      });
      expect(request).toHaveBeenCalledWith({
        subtype: "interrupt",
        cancel_queued: true,
      });
      expect(interrupted).toMatchObject({
        mode: "stop_and_clear",
        cancelledQueuedCount: 1,
        recoveryId: expect.any(String),
        recoveryExpiresAt: expect.any(String),
      });
      await expect(service.cancelSteer({
        sessionId: session.id,
        steerId: queued.steerId,
        requireQueued: true,
      })).rejects.toThrow("This message is no longer queued.");

      await expect(service.restoreCancelledQueue({
        sessionId: session.id,
        recoveryId: interrupted.recoveryId!,
      })).resolves.toEqual({ restored: true, restoredCount: 1 });
      await expect(service.cancelSteer({
        sessionId: session.id,
        steerId: queued.steerId,
        requireQueued: true,
      })).resolves.toBeUndefined();
      expect(events.filter((entry) => entry.event.type === "queue_recovery").map((entry) => entry.event))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ state: "available", messageCount: 1 }),
          expect.objectContaining({
            state: "restored",
            messageCount: 1,
            restoredSteers: [expect.objectContaining({
              steerId: queued.steerId,
              text: "Recover this staged message.",
            })],
          }),
        ]));
      await turnPromise;
    });

    it("re-settles a restored queued message when the next terminal event cancels it again", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const request = vi.fn(async () => ({ response: { still_queued: [], cancelled: [] } }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-restore-resettle",
            slash_commands: [],
            capabilities: ["interrupt_cancel_queued_v1"],
          };
          if (streamCall === 1) return;
          yield {
            type: "assistant",
            message: {
              id: "restore-resettle-assistant",
              content: [{ type: "text", text: "Still working." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          await turnGate;
        })()),
        close: vi.fn(() => releaseTurn()),
        request,
        sessionId: "sdk-restore-resettle",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
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
      const turnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep this turn active.",
      });
      await waitForEvent(events, (entry): entry is AgentChatEventEnvelope => entry.event.type === "text");
      const queued = await service.steer({
        sessionId: session.id,
        text: "Cancel me, restore me, cancel me again.",
      });

      const steerNotices = () => events.filter((entry) =>
        entry.event.type === "system_notice" && entry.event.steerId === queued.steerId);

      const interrupted = await service.interrupt({ sessionId: session.id, mode: "stop_and_clear" });
      expect(steerNotices().map((entry) =>
        entry.event.type === "system_notice" ? entry.event.message : "")).toEqual([
        "Queued message cancelled because the current turn was interrupted.",
      ]);

      await expect(service.restoreCancelledQueue({
        sessionId: session.id,
        recoveryId: interrupted.recoveryId!,
      })).resolves.toEqual({ restored: true, restoredCount: 1 });

      // Undo puts it back on the queue, so the next terminal event has to be
      // able to settle it again — otherwise the message is dropped in silence
      // and its chip stays staged forever (queue_recovery does not clear it).
      releaseTurn();
      await turnPromise;
      await service.dispose({ sessionId: session.id });

      expect(steerNotices().map((entry) =>
        entry.event.type === "system_notice" ? entry.event.message : "")).toEqual([
        "Queued message cancelled because the current turn was interrupted.",
        "Queued message cancelled because the session was closed.",
      ]);
    });

    it.each([
      { providerFirst: true, expectedOrder: ["interrupt_receipt", "done"] },
      { providerFirst: false, expectedOrder: ["done", "interrupt_receipt"] },
    ])("matches known and unknown Claude interrupt receipts when providerFirst=$providerFirst", async ({
      providerFirst,
      expectedOrder,
    }) => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const queryInterrupt = vi.fn(async () => {
        const sent = send.mock.calls.find(([message]) => typeof message?.uuid === "string")?.[0];
        setTimeout(releaseTurn, 0);
        return { still_queued: [sent.uuid, "unknown-internal-uuid"] };
      });
      const close = vi.fn(() => releaseTurn());
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: `sdk-interrupt-receipt-${providerFirst}`,
            slash_commands: [],
            capabilities: ["interrupt_receipt_v1"],
          };
          return;
        }
        yield {
          type: "assistant",
          message: {
            id: `receipt-assistant-${providerFirst}`,
            content: [{ type: "text", text: "Still working." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        await turnGate;
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        interrupt: queryInterrupt,
        sessionId: `sdk-interrupt-receipt-${providerFirst}`,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      const turnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep the turn active while a queued message is dispatched.",
      });
      await waitForEvent(events, (entry): entry is AgentChatEventEnvelope => entry.event.type === "text");
      const queued = await service.steer({
        sessionId: session.id,
        text: "Match this visible queued-message preview.",
      });
      expect(queued.queued).toBe(true);
      await service.dispatchSteer({
        sessionId: session.id,
        steerId: queued.steerId,
        mode: "inline",
      });
      await vi.waitFor(() => {
        expect(send.mock.calls.some(([message]) => typeof message?.uuid === "string")).toBe(true);
      });

      await (service.interrupt as any)(
        { sessionId: session.id },
        providerFirst ? { requireClaudeProviderInterrupt: true } : undefined,
      );
      await turnPromise;

      const receipt = events.find((entry) => entry.event.type === "interrupt_receipt");
      const sentUuid = send.mock.calls.find(([message]) => typeof message?.uuid === "string")?.[0].uuid;
      expect(receipt?.event).toMatchObject({
        stillQueuedUuids: [sentUuid, "unknown-internal-uuid"],
        known: [{ uuid: sentUuid, preview: "Match this visible queued-message preview." }],
      });
      const relevantOrder = events
        .map((entry) => entry.event.type)
        .filter((type) => type === "interrupt_receipt" || type === "done");
      expect(relevantOrder.slice(0, 2)).toEqual(expectedOrder);
    });

    it("throws when interrupting an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.interrupt({ sessionId: "unknown-session-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("cursor interrupt before runtime setup does not create a Claude session", async () => {
      process.env.CURSOR_API_KEY = "test-cursor-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockClear();
      await service.interrupt({ sessionId: session.id });
      expect(claudeSdkCreateSessionCompat).not.toHaveBeenCalled();
    });

    it("releases the cursor pool slot when interrupted during SDK setup", async () => {
      process.env.CURSOR_API_KEY = "test-cursor-key";
      let unblockAcquire: (() => void) | null = null;
      const acquireGate = new Promise<void>((resolve) => {
        unblockAcquire = resolve;
      });
      vi.mocked(acquireCursorSdkConnection).mockImplementationOnce(async (args: Record<string, unknown>) => {
        mockState.cursorSdkAcquireCalls.push(args);
        await acquireGate;
        const pooled: any = {
          process: { exitCode: null, killed: false },
          bridge: { onEvent: null, onRunStarted: null, onRunResult: null, onHookRequest: null },
          agentId: "cursor-sdk-agent-setup-interrupt",
          runId: null,
          request: vi.fn(async () => ({})),
          sendPrompt: vi.fn(async () => ({ id: "cursor-sdk-run-setup", status: "finished" })),
          updatePolicy: vi.fn(async () => {}),
          cancel: vi.fn(async () => {}),
          dispose: vi.fn(),
        };
        mockState.cursorSdkPooled = pooled;
        return { generation: 9, pooled };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      const turnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "Start cursor turn",
        displayText: "Start cursor turn",
      });
      await vi.waitFor(() => {
        expect(mockState.cursorSdkAcquireCalls.length).toBe(1);
      });
      await service.interrupt({ sessionId: session.id });
      unblockAcquire!();
      await expect(turnPromise).rejects.toThrow(/Cursor session interrupted/i);
      expect(releaseCursorSdkConnection).toHaveBeenCalledWith(
        expect.any(String),
        9,
      );
    });

    it("emits subagent_result stopped for active subagents on claude interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];

      // The stream function is called multiple times: once for warmup, once for the actual turn.
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          // Warmup stream — init + result to complete prewarm
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-interrupt-sub-1",
            slash_commands: [],
          };
          // Set before final yield: prewarm breaks the stream on `result` without draining further.
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Actual turn stream — emit two task_started events, then hang
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "sub-task-1",
          description: "Subagent A",
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "sub-task-2",
          description: "Subagent B",
        };
        // Hang until test resolves the promise (simulating a long-running turn)
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-interrupt-sub-1",
        setPermissionMode,
        stopTask,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      // Start the turn (don't await — it will hang)
      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Do something with subagents",
      });

      // Wait for the subagent_started events to appear
      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_started" && (e.event as any).taskId === "sub-task-2",
      );

      // Now interrupt on the background-killing axis — should emit
      // subagent_result "stopped" for both. Default Stop (stop_and_clear)
      // spares them once per-task stop exists.
      await service.interrupt({ sessionId: session.id, mode: "stop_and_clear_and_background" });

      const stoppedEvents = events.filter(
        (e) => e.event.type === "subagent_result" && (e.event as any).status === "stopped",
      );
      expect(stoppedEvents).toHaveLength(2);

      const stoppedTaskIds = stoppedEvents.map((e) => (e.event as any).taskId).sort();
      expect(stoppedTaskIds).toEqual(["sub-task-1", "sub-task-2"]);
      expect(stopTask).toHaveBeenCalledTimes(2);
      expect(stopTask.mock.calls.map((call) => call[0]).sort()).toEqual(["sub-task-1", "sub-task-2"]);

      // After interrupt, listSubagents should reflect the stopped status
      const subagents = await service.listSubagents({ sessionId: session.id });
      const stoppedSubagents = subagents.filter((s: any) => s.status === "stopped");
      expect(stoppedSubagents).toHaveLength(2);

      // Clean up: unblock the hanging stream so sendPromise resolves
      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("claude interrupt idempotency — second call is a no-op", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-idem-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "working" },
          },
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idem-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Hello",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope => e.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });
      const eventsAfterFirst = events.length;

      await service.interrupt({ sessionId: session.id });
      const newEvents = events.slice(eventsAfterFirst);
      expect(newEvents).toHaveLength(0);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("claude interrupt with no active subagents emits no subagent events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-no-sub-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "tick" },
          },
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-no-sub-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Hello",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope => e.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });

      const subagentResultEvents = events.filter(
        (e) => e.event.type === "subagent_result",
      );
      expect(subagentResultEvents).toHaveLength(0);

      const eventsAfterFirst = events.length;
      await service.interrupt({ sessionId: session.id });
      const newEvents = events.slice(eventsAfterFirst);
      expect(newEvents).toHaveLength(0);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("emits a single interrupted status and done event without closing the Claude session", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-single-interrupt", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "still working" },
          },
        };
        await hangPromise;
        return;
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-single-interrupt",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Please keep working",
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => event.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });

      const interruptedStatuses = events.filter(
        (event) => event.event.type === "status" && event.event.turnStatus === "interrupted",
      );
      const interruptedDone = events.filter(
        (event) => event.event.type === "done" && event.event.status === "interrupted",
      );
      expect(interruptedStatuses).toHaveLength(1);
      expect(interruptedDone).toHaveLength(1);
      // Default Stop spares background work, so the query stays alive.
      expect(close).not.toHaveBeenCalled();

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();

      expect(events.filter(
        (event) => event.event.type === "status" && event.event.turnStatus === "interrupted",
      )).toHaveLength(1);
      expect(events.filter(
        (event) => event.event.type === "done" && event.event.status === "interrupted",
      )).toHaveLength(1);
    });

    it("closes the Claude session when Stop also kills background tasks", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const close = vi.fn();
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-kill-interrupt", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "still working" },
          },
        };
        await hangPromise;
        return;
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close,
        sessionId: "sdk-bg-kill-interrupt",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Please keep working",
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => event.event.type === "text",
      );

      await service.interrupt({
        sessionId: session.id,
        mode: "stop_and_clear_and_background",
      });
      expect(close).toHaveBeenCalledTimes(1);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("bounds hung Claude interrupt and subagent stop calls below the desktop action timeout", async () => {
      try {
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let warmupComplete = false;
        let releaseTurn!: () => void;
        const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
        const neverSettles = new Promise<void>(() => {});
        const stopTask = vi.fn(() => neverSettles);
        const queryInterrupt = vi.fn(() => neverSettles);
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-bounded-interrupt", slash_commands: [] };
            warmupComplete = true;
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }
          yield { type: "system", subtype: "task_started", task_id: "hung-task-1", description: "Hung task one" };
          yield { type: "system", subtype: "task_started", task_id: "hung-task-2", description: "Hung task two" };
          await turnGate;
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send: vi.fn().mockResolvedValue(undefined),
          stream,
          close: vi.fn(),
          sessionId: "sdk-bounded-interrupt",
          setPermissionMode: vi.fn().mockResolvedValue(undefined),
          stopTask,
          interrupt: queryInterrupt,
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
        await vi.waitFor(() => { expect(warmupComplete).toBe(true); });

        const sendPromise = service.sendMessage({ sessionId: session.id, text: "Start hung subagents" });
        await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_started" && event.event.taskId === "hung-task-2");

        vi.useFakeTimers();
        let interruptSettled = false;
        const interruptPromise = service.interrupt({
          sessionId: session.id,
          mode: "stop_and_clear_and_background",
        }).then(() => {
          interruptSettled = true;
        });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(interruptSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(stopTask).toHaveBeenCalledTimes(2);
        expect(queryInterrupt).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_499);
        expect(interruptSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(interruptPromise).resolves.toBeUndefined();

        expect(events.filter((event) =>
          event.event.type === "status" && event.event.turnStatus === "interrupted"
        )).toHaveLength(1);
        expect(events.filter((event) =>
          event.event.type === "done" && event.event.status === "interrupted"
        )).toHaveLength(1);
        expect(events.filter((event) =>
          event.event.type === "subagent_result" && event.event.status === "stopped"
        )).toHaveLength(2);

        releaseTurn();
        await expect(sendPromise).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("terminalizes an orphaned Claude transcript turn when Stop sees an idle runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let warmupComplete = false;
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-idle-stop", slash_commands: [] };
        warmupComplete = true;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-stop",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });

      vi.mocked(parseAgentChatTranscript).mockReturnValue([{
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        sequence: 1,
        event: { type: "user_message", text: "Crash before started status", turnId: "orphaned-after-restart" },
      } as AgentChatEventEnvelope]);

      await service.interrupt({ sessionId: session.id });

      expect(events.filter((event) =>
        event.event.type === "status"
        && event.event.turnId === "orphaned-after-restart"
        && event.event.turnStatus === "interrupted"
      )).toHaveLength(1);
      expect(events.filter((event) =>
        event.event.type === "done"
        && event.event.turnId === "orphaned-after-restart"
        && event.event.status === "interrupted"
      )).toHaveLength(1);
      expect(events.at(-1)?.event).toMatchObject({
        type: "done",
        turnId: "orphaned-after-restart",
        status: "interrupted",
      });
    });

    it("resumes through a fresh SDK session after a background-killing interrupt so stale stream text is not replayed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let primaryStreamCall = 0;
      let releaseInterruptedStream = false;
      const primaryClose = vi.fn();
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);

      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-stale-replay", slash_commands: [] };
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }

          if (primaryStreamCall === 2) {
            yield {
              type: "assistant",
              session_id: "sdk-stale-replay",
              message: {
                content: [{ type: "text", text: "partial first answer" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            while (!releaseInterruptedStream) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return;
          }

          yield {
            type: "assistant",
            session_id: "sdk-stale-replay",
            message: {
              content: [{ type: "text", text: "stale tail from interrupted turn" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: primaryClose,
        sessionId: "sdk-stale-replay",
        setPermissionMode,
      };
      const resumedSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "assistant",
            session_id: "sdk-stale-replay",
            message: {
              content: [{ type: "text", text: "fresh follow-up answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-stale-replay",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(primarySession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(resumedSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(primaryStreamCall).toBeGreaterThanOrEqual(1);
      });

      const firstTurn = service.sendMessage({
        sessionId: session.id,
        text: "answer the first question",
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.text.includes("partial first answer"),
      );

      await service.interrupt({
        sessionId: session.id,
        mode: "stop_and_clear_and_background",
      });
      releaseInterruptedStream = true;
      await firstTurn;

      const followUp = await service.runSessionTurn({
        sessionId: session.id,
        text: "answer the follow up",
        timeoutMs: 15_000,
      });

      const persistedAfterInterrupt = readPersistedChatState(session.id);
      expect(primaryClose).toHaveBeenCalledTimes(1);
      expect(persistedAfterInterrupt.sdkSessionId).toEqual(expect.any(String));
      expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(persistedAfterInterrupt.sdkSessionId, expect.any(Object));
      expect(followUp.outputText).toContain("fresh follow-up answer");
      expect(followUp.outputText).not.toContain("stale tail");
    });

  });

  // --------------------------------------------------------------------------
  // steer
  // --------------------------------------------------------------------------


  describe("steer", () => {
    it("routes a send during an active Claude turn through the queued steer path", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let finishActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-send-to-steer", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          await activeTurnGate;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Queued send delivered" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-send-to-steer",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do the foreground work",
        timeoutMs: 15_000,
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.text.includes("Still working"),
      );

      const result = await service.sendMessage({
        sessionId: session.id,
        text: "Follow up when the active turn finishes",
        displayText: "Follow up soon",
        reasoningEffort: "high",
        executionMode: "subagents",
        interactionMode: "plan",
      }, { routeActiveToSteer: true });
      expect(result).toMatchObject({ queued: true, steerId: expect.any(String) });
      // Transcript events retain the raw prompt for delivery while exposing
      // the shorter display label separately for the queued chip.
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.text === "Follow up when the active turn finishes"
        && event.event.displayText === "Follow up soon"
        && event.event.deliveryState === "queued"
      )).toBe(true);

      finishActiveTurn();
      await activeTurn;
      await vi.waitFor(() => {
        // The delivered prompt carries the raw text plus the applied execution
        // and interaction mode directives.
        expect(send).toHaveBeenCalledWith(expect.stringContaining("Follow up when the active turn finishes"));
        const deliveredPrompt = send.mock.calls
          .map((call) => String(call[0]))
          .find((prompt) => prompt.includes("Follow up when the active turn finishes"));
        expect(deliveredPrompt).toContain("Use Claude subagents");
        expect(deliveredPrompt).toContain("plan mode for this turn");
      });
      // The delivered transcript message keeps the display text distinct from
      // the raw prompt text.
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.deliveryState !== "queued"
        && (event.event.displayText === "Follow up soon" || event.event.text === "Follow up soon")
      )).toBe(true);
    });

    it("does not steer /compact during an active Claude turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let finishActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-compact-no-steer", slash_commands: [] };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        await activeTurnGate;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-compact-no-steer",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do the foreground work",
        timeoutMs: 15_000,
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.text.includes("Still working"),
      );

      await expect(service.sendMessage({
        sessionId: session.id,
        text: "/compact keep the tests",
      }, { routeActiveToSteer: true })).rejects.toThrow(/already active/i);
      expect(events.some((event) =>
        event.event.type === "user_message" && String(event.event.text).includes("/compact")
      )).toBe(false);
      expect(send.mock.calls.map((call) => String(call[0])).some((prompt) => /\/compact/i.test(prompt))).toBe(false);

      finishActiveTurn();
      await activeTurn;
    });

    it("ignores empty active-turn sends but queues attachment-only steers", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let finishActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-empty-steer", slash_commands: [] };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        await activeTurnGate;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-empty-steer",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do the foreground work",
        timeoutMs: 15_000,
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.text.includes("Still working"),
      );

      const result = await service.sendMessage({
        sessionId: session.id,
        text: "   ",
      }, { routeActiveToSteer: true });
      expect(result).toBeUndefined();
      expect(events.some((event) =>
        event.event.type === "user_message" && event.event.deliveryState === "queued",
      )).toBe(false);

      const attachmentPath = path.join(tmpRoot, "attachment-only-steer.txt");
      fs.writeFileSync(attachmentPath, "Attachment-only steer context.");
      const attachmentResult = await service.sendMessage({
        sessionId: session.id,
        text: "",
        attachments: [{ path: attachmentPath, type: "file" }],
      }, { routeActiveToSteer: true });
      expect(attachmentResult).toMatchObject({ queued: true, steerId: expect.any(String) });
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.text === "Please review the attached files."
        && event.event.deliveryState === "queued"
        && event.event.attachments?.some((attachment) => attachment.path === attachmentPath),
      )).toBe(true);

      finishActiveTurn();
      await activeTurn;
      await vi.waitFor(() => {
        expect(send.mock.calls.some(([payload]) =>
          JSON.stringify(payload).includes("Please review the attached files."),
        )).toBe(true);
      });
      // Claude's persistent streaming-input query consumes the queued steer
      // without creating a replacement SDK stream.
      expect(streamCall).toBe(2);
    });

    it("defers scheduled Claude wakes but steers subagent completions inline", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let finishActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-wake-boundary", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          await activeTurnGate;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Scheduled check complete" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-wake-boundary",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do the foreground work",
        timeoutMs: 15_000,
      });
      const activeText = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "text" }>;
      } => event.event.type === "text" && event.event.text.includes("Still working"));
      const activeTurnId = activeText.event.turnId;

      const result = await service.messageSession({
        sessionId: session.id,
        text: "Check PR CI",
        kind: "wake",
        metadata: {
          scheduledWake: {
            scheduleId: "wake-boundary-1",
            kind: "wakeup",
            firedAt: "2026-07-09T09:00:00.000Z",
            reason: "Check PR CI",
          },
        },
      });

      expect(result).toMatchObject({ routedAction: "sendMessage", delivery: "queued", queued: true });
      const queued = events.find((event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
      } =>
        event.event.type === "user_message"
        && event.event.deliveryState === "queued"
        && event.event.text === "Check PR CI");
      expect(queued?.event.metadata?.scheduledWake).toBeUndefined();
      expect(send.mock.calls.some(([payload]) => JSON.stringify(payload).includes("Check PR CI"))).toBe(false);

      const childCompletion = await service.messageSession(
        {
          sessionId: session.id,
          text: "Your subagent finished.",
          kind: "wake",
          metadata: {
            spawnCompletion: {
              childSessionId: "child-1",
              childTitle: "Review agent",
              spawnKind: "subagent",
              status: "completed",
              summary: "Review complete.",
            },
          },
        },
        { trustedSpawnCompletion: true },
      );
      expect(childCompletion).toMatchObject({
        routedAction: "steer",
        delivery: "delivered",
        queued: false,
      });
      expect(send.mock.calls.map(([payload]) => payload).find((payload) =>
        typeof payload === "object"
        && payload?.priority === "next"
        && JSON.stringify(payload).includes("Your subagent finished.")
      )).toBeDefined();

      finishActiveTurn();
      await activeTurn;
      const delivered = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
      } =>
        event.event.type === "user_message"
        && event.event.metadata?.scheduledWake?.scheduleId === "wake-boundary-1");
      expect(delivered.event.turnId).toBeTruthy();
      expect(delivered.event.turnId).not.toBe(activeTurnId);
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Check PR CI"));
    });

    it("never queues a scheduled wake on the CTO thread — its steer queue cap is zero", async () => {
      const { service } = createService({ onEvent: () => {} });
      const cto = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        identityKey: "cto",
      });
      await service.sendMessage({
        sessionId: cto.id,
        text: "Finish the foreground work.",
      }, { awaitDispatch: true });

      // The same wake on any other chat stages for the turn boundary. On the
      // CTO it is redirected into the live turn, because a coordinator that
      // parks its inputs stops coordinating until the turn ends.
      const result = await service.messageSession({
        sessionId: cto.id,
        text: "Check PR CI after the current turn.",
        kind: "wake",
        metadata: {
          scheduledWake: {
            scheduleId: "cto-wake-1",
            kind: "wakeup",
            firedAt: "2026-07-09T09:00:00.000Z",
            reason: "Check PR CI",
          },
        },
      });

      expect(result).toMatchObject({ routedAction: "steer", delivery: "delivered", queued: false });
      expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "turn/steer",
          params: expect.objectContaining({
            input: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining("Check PR CI after the current turn.") }),
            ]),
          }),
        }),
      ]));
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(1);
    });

    it("defers scheduled Codex wakes but steers subagent completions into the active turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Finish the foreground work.",
      }, { awaitDispatch: true });

      const result = await service.messageSession({
        sessionId: session.id,
        text: "Check PR CI after the current turn.",
        kind: "wake",
        metadata: {
          scheduledWake: {
            scheduleId: "codex-wake-boundary-1",
            kind: "wakeup",
            firedAt: "2026-07-09T09:00:00.000Z",
            reason: "Check PR CI",
          },
        },
      });

      expect(result).toMatchObject({
        routedAction: "sendMessage",
        delivery: "queued",
        queued: true,
      });
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(1);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);

      const childCompletion = await service.messageSession(
        {
          sessionId: session.id,
          text: "Your subagent finished.",
          kind: "wake",
          metadata: {
            spawnCompletion: {
              childSessionId: "child-1",
              childTitle: "Review agent",
              spawnKind: "subagent",
              status: "completed",
              summary: "Review complete.",
            },
          },
        },
        { trustedSpawnCompletion: true },
      );
      expect(childCompletion).toMatchObject({
        routedAction: "steer",
        delivery: "delivered",
        queued: false,
      });
      expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "turn/steer",
          params: expect.objectContaining({
            input: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining("Your subagent finished.") }),
            ]),
          }),
        }),
      ]));

      mockState.emitCodexPayload({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      });

      const turnStarts = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start");
      expect(turnStarts[1]?.params).toEqual(expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("Check PR CI after the current turn.") }),
        ]),
      }));
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/steer")).toHaveLength(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            metadata: expect.objectContaining({
              scheduledWake: expect.objectContaining({ scheduleId: "codex-wake-boundary-1" }),
            }),
          }),
        }),
      ]));
    });

    it("throws when steering an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.steer({
          sessionId: "unknown-session-id",
          text: "refocus on the main bug",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("cancelSteer removes a queued steer and emits a system_notice", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          // init stream
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

        if (streamCall === 2) {
          // The blocking turn — yields an assistant message then waits
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Still working" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }

        // streamCall >= 3: any follow-up turn — should NOT happen because the steer was cancelled
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Follow up" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => {
          interruptedTurnClosed = true;
        }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Start a turn so the runtime is busy
      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do some work",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue a steer — runtime is busy so it should be queued
      await service.steer({ sessionId: session.id, text: "queued steer text" });

      // Find the queued user_message event to get the steerId
      const queuedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "queued steer text",
      );
      expect(queuedEvent).toBeDefined();
      const steerId = (queuedEvent!.event as any).steerId as string;
      expect(steerId).toBeTruthy();

      // Cancel the steer
      await service.cancelSteer({ sessionId: session.id, steerId });

      // Verify a system_notice with "Queued message cancelled." was emitted
      const cancelNotice = events.find(
        (e) =>
          e.event.type === "system_notice"
          && (e.event as any).message === "Queued message cancelled.",
      );
      expect(cancelNotice).toBeDefined();

      // Interrupt the turn to let it complete
      await service.interrupt({ sessionId: session.id });
      await activeTurn;

      // The cancelled steer should NOT have been delivered — `send` should not have been
      // called with "queued steer text"
      const sendCalls = send.mock.calls.map((c: any[]) => c[0]);
      const deliveredSteer = sendCalls.find(
        (arg: any) =>
          (typeof arg === "string" && arg.includes("queued steer text"))
          || (typeof arg === "object" && JSON.stringify(arg).includes("queued steer text")),
      );
      expect(deliveredSteer).toBeUndefined();
    });

    it("does not resurrect a cancelled persisted steer when no runtime is attached", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      const cancelledSteerId = "persisted-steer-to-cancel";
      const survivingSteerId = "persisted-steer-to-keep";
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        pendingSteers: [
          { steerId: cancelledSteerId, text: "Remove me" },
          { steerId: survivingSteerId, text: "Keep me" },
        ],
      });

      await service.cancelSteer({ sessionId: session.id, steerId: cancelledSteerId, requireQueued: true });

      expect(readPersistedChatState(session.id).pendingSteers).toEqual([
        { steerId: survivingSteerId, text: "Keep me" },
      ]);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Queued message cancelled."
        && event.event.steerId === cancelledSteerId,
      )).toBe(true);
    });

    it("editSteer updates the queued steer text and cancels on interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
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

        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Still working" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }

        // streamCall >= 3: follow-up turn after steer delivery
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Responding to updated text" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => {
          interruptedTurnClosed = true;
        }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Start a turn so the runtime is busy
      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do some work",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue a steer
      await service.steer({ sessionId: session.id, text: "original steer text" });

      // Get the steerId from the queued user_message event
      const queuedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "original steer text",
      );
      expect(queuedEvent).toBeDefined();
      const steerId = (queuedEvent!.event as any).steerId as string;
      expect(steerId).toBeTruthy();

      // Edit the steer
      await service.editSteer({ sessionId: session.id, steerId, text: "updated text" });

      // Verify a user_message with updated text and deliveryState "queued" was emitted
      const editedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "updated text"
          && (e.event as any).steerId === steerId,
      );
      expect(editedEvent).toBeDefined();

      // Interrupt the turn — queued steers should be cancelled, not delivered
      await service.interrupt({ sessionId: session.id });
      await activeTurn;

      // Wait for the cancellation notice for the queued steer
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "system_notice"
          && (event.event as any).steerId === steerId
          && /cancelled/i.test((event.event as any).message),
      );

      // The steer should NOT have been delivered via send
      const sendCalls = send.mock.calls.map((c: any[]) => c[0]);
      const deliveredWithUpdatedText = sendCalls.find(
        (arg: any) =>
          (typeof arg === "string" && arg.includes("updated text"))
          || (typeof arg === "object" && JSON.stringify(arg).includes("updated text")),
      );
      expect(deliveredWithUpdatedText).toBeUndefined();
    });

    it("sends atomic and staged inline steers as querying priority-next messages", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let interruptedTurnClosed = false;
      let releaseWarmup!: () => void;
      const warmupGate = new Promise<void>((resolve) => {
        releaseWarmup = resolve;
      });

      const stream = vi.fn(() => (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        while (!interruptedTurnClosed) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => { interruptedTurnClosed = true; }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(startup).mockImplementationOnce(async () => {
        await warmupGate;
        return {
          query: (prompt: unknown) => bridgeClaudeSessionToQuery(mockSession, prompt),
          close: () => mockSession.close(),
        } as any;
      });

      const { service } = createService({ onEvent: (e: AgentChatEventEnvelope) => events.push(e) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const activeTurn = service.runSessionTurn({ sessionId: session.id, text: "Do work", timeoutMs: 15_000 });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started");

      const guarded = await service.steer({ sessionId: session.id, text: "dispatch exactly once" });
      expect(guarded.queued).toBe(true);
      const guardedDispatchPromise = service.dispatchSteer({
        sessionId: session.id,
        steerId: guarded.steerId,
        mode: "inline",
      });
      await expect(service.cancelSteer({
        sessionId: session.id,
        steerId: guarded.steerId,
        requireQueued: true,
      })).rejects.toThrow("already being dispatched");

      const directPromise = service.steer({
        sessionId: session.id,
        text: "send this atomically",
        dispatchMode: "inline",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(send.mock.calls.some((call: any[]) => call[0]?.priority === "next")).toBe(false);
      releaseWarmup();
      const guardedDispatch = await guardedDispatchPromise;
      const direct = await directPromise;
      expect(guardedDispatch.dispatchedAt).not.toBeNull();
      await expect(service.cancelSteer({
        sessionId: session.id,
        steerId: guarded.steerId,
        requireQueued: true,
      })).rejects.toThrow("no longer queued");
      expect(events.filter((e) =>
        e.event.type === "user_message"
        && (e.event as any).steerId === guarded.steerId
        && (e.event as any).deliveryState === "inline",
      )).toHaveLength(1);
      expect(direct).toMatchObject({ queued: false, steerId: expect.any(String) });
      expect(events.some((e) =>
        e.event.type === "user_message"
        && (e.event as any).text === "send this atomically"
        && (e.event as any).deliveryState === "queued",
      )).toBe(false);
      await vi.waitFor(() => {
        expect(send.mock.calls.map((call: any[]) => call[0]).find((arg: any) =>
          arg?.priority === "next"
          && arg?.shouldQuery === true
          && JSON.stringify(arg).includes("send this atomically"),
        )).toBeDefined();
      });
      const sentPayloads = send.mock.calls.map((call: any[]) => call[0]);
      expect(sentPayloads.findIndex((payload: any) => typeof payload === "string" && payload.includes("Do work")))
        .toBeLessThan(sentPayloads.findIndex((payload: any) => payload?.priority === "next"));

      await service.steer({ sessionId: session.id, text: "fold this in" });
      const queued = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).deliveryState === "queued"
        && (e.event as any).text === "fold this in",
      );
      expect(queued).toBeDefined();
      const steerId = (queued!.event as any).steerId as string;

      // Dispatch inline — Claude consumes priority-next between tool steps.
      const result = await service.dispatchSteer({ sessionId: session.id, steerId, mode: "inline" });
      expect(result.dispatchedAt).not.toBeNull();

      // The 2nd send call (after the initial turn's send) is the inline dispatch
      const inlineSendCall = send.mock.calls.find((c: any[]) => {
        const arg = c[0];
        return typeof arg === "object"
          && arg
          && (arg as any).shouldQuery === true
          && (arg as any).priority === "next"
          && JSON.stringify(arg).includes("fold this in");
      });
      expect(inlineSendCall).toBeDefined();
      const inlinePayload = inlineSendCall![0] as any;
      expect(inlinePayload.shouldQuery).toBe(true);
      expect(inlinePayload.priority).toBe("next");
      expect(inlinePayload.message?.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("fold this in") })]),
      );

      // user_message with deliveryState:"inline" should have been emitted
      const inlineEvent = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).steerId === steerId
        && (e.event as any).deliveryState === "inline",
      );
      expect(inlineEvent).toBeDefined();

      // Cleanup
      await service.interrupt({ sessionId: session.id });
      await activeTurn;
    });

    it("returns an idle Claude steer after dispatch acceptance while the provider turn keeps running", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let finishTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => { finishTurn = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-idle-steer", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Working after acceptance" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        await turnGate;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-steer",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });

      const result = await service.steer({
        sessionId: session.id,
        text: "Treat this stale steer as a normal turn",
        dispatchMode: "inline",
        reasoningEffort: "high",
        executionMode: "subagents",
        interactionMode: "plan",
      });
      expect(result).toMatchObject({ queued: false, steerId: expect.any(String) });

      const delivered = events.find((event) =>
        event.event.type === "user_message"
        && event.event.text === "Treat this stale steer as a normal turn"
      );
      expect(delivered?.event).toMatchObject({
        type: "user_message",
        steerId: result.steerId,
        deliveryState: "delivered",
        turnId: expect.any(String),
      });
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        reasoningEffort: "high",
        executionMode: "subagents",
        interactionMode: "plan",
      });
      expect(events.some((event) => event.event.type === "done")).toBe(false);

      finishTurn();
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "done" && event.event.status === "completed");
    });

    it("emits one interrupted terminal pair when a Claude model switches mid-turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let oldStreamFinished = false;
      let releaseActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { releaseActiveTurn = resolve; });
      let releaseReplacementTurn!: () => void;
      const replacementTurnGate = new Promise<void>((resolve) => { releaseReplacementTurn = resolve; });
      let replacementTurnStreaming = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-model-switch", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Switch me while I am running" }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          await activeTurnGate;
          oldStreamFinished = true;
          return;
        }
        if (streamCall === 3) {
          yield { type: "system", subtype: "init", session_id: "sdk-model-switch-next", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        replacementTurnStreaming = true;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Replacement turn is active" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        await replacementTurnGate;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      const mockSession = {
        send,
        stream,
        close,
        sessionId: "sdk-model-switch",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });

      await service.sendMessage({
        sessionId: session.id,
        text: "Keep working while I switch models",
      }, { awaitDispatch: true });
      const started = await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started");
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "text" && event.event.turnId === started.event.turnId);
      const queued = await service.steer({
        sessionId: session.id,
        text: "Do this after the old model finishes",
      });
      expect(queued).toMatchObject({ queued: true, steerId: expect.any(String) });

      // Force the restart reconciler's view of the transcript to lag behind the
      // live stream, matching the race where model-switch teardown creates the
      // replacement runtime before the old stream emits its terminal pair.
      vi.mocked(parseAgentChatTranscript).mockReturnValue([
        {
          sessionId: session.id,
          timestamp: new Date().toISOString(),
          sequence: 1,
          event: { type: "user_message", text: "Keep working while I switch models", turnId: started.event.turnId } as any,
        },
        {
          sessionId: session.id,
          timestamp: new Date().toISOString(),
          sequence: 2,
          event: { type: "status", turnStatus: "started", turnId: started.event.turnId } as any,
        },
      ]);

      await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-5",
      });
      const interruptedDone = await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "done"
        && event.event.turnId === started.event.turnId
        && event.event.status === "interrupted");
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "system_notice"
        && event.event.steerId === queued.steerId
        && event.event.message.includes("cancelled"));

      await vi.waitFor(() => { expect(streamCall).toBeGreaterThanOrEqual(3); });
      await service.sendMessage({
        sessionId: session.id,
        text: "Replacement turn after model switch",
      }, { awaitDispatch: true });
      const replacementStarted = await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "status"
        && event.event.turnStatus === "started"
        && event.event.turnId !== started.event.turnId);
      await vi.waitFor(() => { expect(replacementTurnStreaming).toBe(true); });

      releaseActiveTurn();
      await vi.waitFor(() => { expect(oldStreamFinished).toBe(true); });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(events.filter((event) =>
        event.event.type === "status"
        && event.event.turnId === started.event.turnId
        && event.event.turnStatus === "interrupted"
      )).toHaveLength(1);
      const doneEvents = events.filter((event) =>
        event.event.type === "done"
        && event.event.turnId === started.event.turnId
        && event.event.status === "interrupted"
      );
      expect(doneEvents).toHaveLength(1);
      expect(interruptedDone.event).toMatchObject({
        model: "claude-opus-5",
        modelId: "anthropic/claude-opus-5",
      });
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({ status: "active" });
      expect(close).toHaveBeenCalled();
      expect(events.filter((event) =>
        event.event.type === "user_message"
        && event.event.steerId === queued.steerId
        && event.event.deliveryState === "delivered"
      )).toHaveLength(0);

      releaseReplacementTurn();
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "done"
        && event.event.turnId === replacementStarted.event.turnId
        && event.event.status === "completed");
    });

    it("dispatchSteer mode:'interrupt' uses Claude priority-now without tearing down the query", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const queryInterrupt = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => { interruptedTurnClosed = true; }),
        sessionId: "sdk-session-1",
        setPermissionMode,
        query: { interrupt: queryInterrupt },
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: (e: AgentChatEventEnvelope) => events.push(e) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const activeTurn = service.runSessionTurn({ sessionId: session.id, text: "Do work", timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue two steers — the second one will be the dispatch target
      await service.steer({ sessionId: session.id, text: "first queued" });
      await service.steer({ sessionId: session.id, text: "interrupt with me" });

      const target = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).deliveryState === "queued"
        && (e.event as any).text === "interrupt with me",
      );
      expect(target).toBeDefined();
      const steerId = (target!.event as any).steerId as string;

      const result = await service.dispatchSteer({ sessionId: session.id, steerId, mode: "interrupt" });
      expect(result.dispatchedAt).not.toBeNull();

      await vi.waitFor(() => {
        expect(send.mock.calls.some(([arg]) => arg?.priority === "now" && arg?.shouldQuery === true)).toBe(true);
      });
      const interruptPayload = send.mock.calls
        .map((call: any[]) => call[0])
        .find((arg: any) => arg?.priority === "now" && arg?.shouldQuery === true);
      expect(interruptPayload).toBeDefined();
      expect(queryInterrupt).not.toHaveBeenCalled();

      await service.interrupt({ sessionId: session.id });
      await activeTurn;
    });

    it("dispatchSteer no-ops when the steerId is not in the queue", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      const mockSession = {
        send, stream, close: vi.fn(), sessionId: "sdk-session-1", setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: () => {} });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const result = await service.dispatchSteer({
        sessionId: session.id,
        steerId: "this-steer-id-does-not-exist",
        mode: "inline",
      });
      expect(result.dispatchedAt).toBeNull();
    });

    it("delivers a restored staged Claude message as a fresh turn and clears persistence", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const handle = {
        send,
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-restored", slash_commands: [] };
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }
          yield {
            type: "assistant",
            session_id: "sdk-restored",
            message: { content: [{ type: "text", text: "Handled restored message." }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-restored",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(handle as any);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(handle as any);

      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const sessionId = "restored-staged-claude";
      const steerId = "restored-steer";
      sessionService.create({
        sessionId,
        laneId: "lane-1",
        toolType: "claude-chat",
        title: "Restored staged chat",
        startedAt: "2026-07-10T12:00:00.000Z",
      });
      writePersistedChatState(sessionId, {
        version: 2,
        sessionId,
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        sdkSessionId: "sdk-restored",
        pendingSteers: [{ steerId, text: "Handle this restored message" }],
        updatedAt: "2026-07-10T12:00:00.000Z",
      });
      await service.resumeSession({ sessionId });

      const result = await service.dispatchSteer({ sessionId, steerId, mode: "inline" });

      expect(result.dispatchedAt).not.toBeNull();
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Handle this restored message"));
      expect(send.mock.calls.some((call: any[]) => call[0]?.priority != null)).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && (event.event as any).steerId === steerId
        && /delivering/i.test((event.event as any).message)
      )).toBe(true);
      expect(readPersistedChatState(sessionId).pendingSteers).toBeUndefined();
    });

    it("dispatchSteer rejects interrupt on Codex sessions but accepts inline", async () => {
      const { service } = createService({ onEvent: () => {} });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5-codex" });

      // Rejection comes from the canonical per-provider table, so the copy
      // names the provider and the mode instead of the method. Codex has no
      // cancel-and-resend, so "interrupt" is the one it refuses.
      await expect(
        service.dispatchSteer({ sessionId: session.id, steerId: "any", mode: "interrupt" }),
      ).rejects.toThrow(/Codex sessions support only the "inline" active-turn dispatch mode/i);

      // Inline is accepted and no-ops when there is nothing staged under that id.
      await expect(
        service.dispatchSteer({ sessionId: session.id, steerId: "any", mode: "inline" }),
      ).resolves.toEqual({ dispatchedAt: null });
    });

    it("promotes a staged Codex steer into the live turn through dispatchSteer", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      await service.sendMessage({ sessionId: session.id, text: "Start working" }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "status" && event.event.turnStatus === "started")).toBe(true);
      });

      // A wake stages rather than steering — this is the row the composer's
      // "send now" promotes.
      await service.messageSession({
        sessionId: session.id,
        kind: "wake",
        text: "Check the other repro too.",
      });
      const staged = await vi.waitFor(() => {
        const queued = events.find((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued");
        expect(queued).toBeTruthy();
        return queued!.event as Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
      });

      mockState.codexRequestPayloads = [];
      const result = await service.dispatchSteer({
        sessionId: session.id,
        steerId: staged.steerId!,
        mode: "inline",
      });

      expect(result.dispatchedAt).not.toBeNull();
      const steerRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/steer");
      expect(steerRequest).toBeTruthy();
      expect(JSON.stringify(steerRequest?.params ?? {})).toContain("Check the other repro too.");
      // The staged chip has to be resolved, or it stays parked in the composer.
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.steerId === staged.steerId
        && event.event.message.includes("Delivering"))).toBe(true);
    });

    it("cancelDispatchedSteer cancels an SDK-queued Claude steer by its command UUID", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const cancelAsyncMessage = vi.fn().mockResolvedValue(true);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => { interruptedTurnClosed = true; }),
        sessionId: "sdk-session-1",
        setPermissionMode,
        query: { cancelAsyncMessage },
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: (e: AgentChatEventEnvelope) => events.push(e) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const activeTurn = service.runSessionTurn({ sessionId: session.id, text: "Do work", timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      await service.steer({ sessionId: session.id, text: "fold this in" });
      const queued = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).deliveryState === "queued"
        && (e.event as any).text === "fold this in",
      );
      const steerId = (queued!.event as any).steerId as string;

      await service.dispatchSteer({ sessionId: session.id, steerId, mode: "inline" });

      // Capture the UUID we sent on the SDK message
      const inlineSendCall = send.mock.calls.find((c: any[]) => {
        const arg = c[0];
        return typeof arg === "object"
          && arg
          && (arg as any).shouldQuery === true
          && (arg as any).priority === "next";
      });
      const sentUuid = (inlineSendCall![0] as any).uuid as string;
      expect(typeof sentUuid).toBe("string");
      expect(sentUuid.length).toBeGreaterThan(0);

      const cancelResult = await service.cancelDispatchedSteer({ sessionId: session.id, steerId });
      expect(cancelResult.cancelled).toBe(true);
      expect(cancelAsyncMessage).toHaveBeenCalledWith(sentUuid);
      expect(events.find((entry) =>
        entry.event.type === "system_notice"
        && entry.event.steerId === steerId
        && /cancelled/i.test(entry.event.message)
      )?.event).toMatchObject({
        type: "system_notice",
        steerId,
        message: "Queued message cancelled.",
      });

      // Cleanup
      await service.interrupt({ sessionId: session.id });
      await activeTurn;
    });

    it("cancelDispatchedSteer returns cancelled:false when steerId not tracked", async () => {
      const { service } = createService({ onEvent: () => {} });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const result = await service.cancelDispatchedSteer({ sessionId: session.id, steerId: "never-dispatched" });
      expect(result.cancelled).toBe(false);
    });

    it("delivers queued OpenCode steers with attachments after the active turn settles", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      let streamCallCount = 0;
      vi.mocked(streamText).mockImplementation(() => {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          return {
            fullStream: (async function* () {
              await new Promise<void>((resolve) => {
                firstTurnControl.release = resolve;
              });
              yield { type: "finish", usage: {} };
            })(),
          } as any;
        }
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });
      vi.mocked(buildOpenCodePromptParts).mockClear();

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Finish the active turn first.",
      });
      for (let attempt = 0; attempt < 20 && vi.mocked(buildOpenCodePromptParts).mock.calls.length < 1; attempt += 1) {
        await Promise.resolve();
      }
      expect(vi.mocked(buildOpenCodePromptParts).mock.calls.length).toBeGreaterThanOrEqual(1);

      const attachmentPath = path.join(tmpRoot, "opencode-steer-context.txt");
      fs.writeFileSync(attachmentPath, "OpenCode steer attachment context.");

      const steerResult = await service.steer({
        sessionId: session.id,
        text: "Then review the attached context.",
        attachments: [{ path: attachmentPath, type: "file" }],
      });
      expect(steerResult.queued).toBe(true);

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && (event.event as any).deliveryState === "queued"
          && event.event.text === "Then review the attached context."
          && JSON.stringify((event.event as any).attachments ?? []).includes("opencode-steer-context.txt"),
      );

      expect(firstTurnControl.release).toBeTypeOf("function");
      firstTurnControl.release!();
      await firstTurn;

      for (let attempt = 0; attempt < 50 && vi.mocked(buildOpenCodePromptParts).mock.calls.length < 2; attempt += 1) {
        await Promise.resolve();
      }
      expect(vi.mocked(buildOpenCodePromptParts).mock.calls).toHaveLength(2);
      expect(vi.mocked(buildOpenCodePromptParts).mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        prompt: expect.stringContaining("Then review the attached context."),
        files: expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("opencode-steer-context.txt"),
            filename: "opencode-steer-context.txt",
          }),
        ]),
      }));

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && event.event.text === "Then review the attached context."
          && JSON.stringify((event.event as any).attachments ?? []).includes("opencode-steer-context.txt")
          && (event.event as any).deliveryState !== "queued",
      );
    });

    it("folds an inline OpenCode steer into the live turn through the v2 delivery", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            firstTurnControl.release = resolve;
          });
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }
      expect(firstTurnControl.release).toBeTypeOf("function");

      const steerResult = await service.steer({
        sessionId: session.id,
        text: "Fold this into the live turn.",
        dispatchMode: "inline",
      });
      expect(steerResult.queued).toBe(false);
      expect(mockState.openCodeV2SteerCalls).toHaveLength(1);
      expect(mockState.openCodeV2SteerCalls[0]).toEqual(expect.objectContaining({
        sessionID: expect.any(String),
        delivery: "steer",
        // The server validates its `msg_` message-ID brand; a bare uuid would
        // 400 and silently degrade every inline steer to the queue.
        id: expect.stringMatching(/^msg_/),
        prompt: expect.objectContaining({ text: expect.stringContaining("Fold this into the live turn.") }),
      }));

      const delivered = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && event.event.text === "Fold this into the live turn."
          && (event.event as any).deliveryState === "inline",
      );
      expect((delivered.event as any).steerId).toBe(steerResult.steerId);

      firstTurnControl.release!();
      await firstTurn;
    });

    it("queues an OpenCode steer that carries per-message overrides instead of folding it inline", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            firstTurnControl.release = resolve;
          });
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }

      // The v2 steer prompt carries text and file parts only, so an execution
      // override picked for this message cannot ride it. The row must stage
      // instead, preserving the directive for the turn boundary.
      const steerResult = await service.steer({
        sessionId: session.id,
        text: "Keep my execution override.",
        dispatchMode: "inline",
        executionMode: "focused",
      });
      expect(steerResult.queued).toBe(true);
      expect(mockState.openCodeV2SteerCalls).toHaveLength(0);
      expect(events.some((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Keep my execution override."
        && (entry.event as any).deliveryState === "queued"
      )).toBe(true);
      expect(events.some((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Keep my execution override."
        && (entry.event as any).deliveryState === "inline"
      )).toBe(false);

      firstTurnControl.release!();
      await firstTurn;
    });

    it("keeps a staged OpenCode steer with overrides staged instead of promoting it inline", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            firstTurnControl.release = resolve;
          });
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }

      const queued = await service.steer({
        sessionId: session.id,
        text: "Promote me with my override.",
        executionMode: "focused",
      });
      expect(queued.queued).toBe(true);
      const queuedRow = events.find((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Promote me with my override."
        && (entry.event as any).deliveryState === "queued"
      );
      const steerId = (queuedRow!.event as any).steerId as string;

      const dispatchResult = await service.dispatchSteer({
        sessionId: session.id,
        steerId,
        mode: "inline",
      });
      expect(dispatchResult.dispatchedAt).toBeNull();
      expect(mockState.openCodeV2SteerCalls).toHaveLength(0);
      expect(events.some((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Promote me with my override."
        && (entry.event as any).deliveryState === "inline"
      )).toBe(false);

      firstTurnControl.release!();
      await firstTurn;
    });

    it("queues an inline OpenCode steer when the live delivery is refused", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            firstTurnControl.release = resolve;
          });
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      mockState.openCodeV2SteerError = new Error("steer delivery refused");

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }

      const steerResult = await service.steer({
        sessionId: session.id,
        text: "This one has to wait.",
        dispatchMode: "inline",
      });
      expect(steerResult.queued).toBe(true);
      expect(mockState.openCodeV2SteerCalls).toHaveLength(1);
      expect(events.some((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "This one has to wait."
        && (entry.event as any).deliveryState === "queued"
      )).toBe(true);
      expect(events.some((entry) =>
        entry.event.type === "system_notice"
        && /couldn't go into the running turn/i.test(entry.event.message)
      )).toBe(true);

      firstTurnControl.release!();
      await firstTurn;
    });

    it("promotes a staged OpenCode steer into the live turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            firstTurnControl.release = resolve;
          });
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }

      const queued = await service.steer({
        sessionId: session.id,
        text: "Promote me into the live turn.",
      });
      expect(queued.queued).toBe(true);
      const queuedRow = events.find((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Promote me into the live turn."
        && (entry.event as any).deliveryState === "queued"
      );
      const steerId = (queuedRow!.event as any).steerId as string;

      const dispatchResult = await service.dispatchSteer({
        sessionId: session.id,
        steerId,
        mode: "inline",
      });
      expect(dispatchResult.dispatchedAt).not.toBeNull();
      expect(mockState.openCodeV2SteerCalls).toHaveLength(1);
      expect(mockState.openCodeV2SteerCalls[0]?.prompt?.text).toContain("Promote me into the live turn.");
      expect(events.some((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Promote me into the live turn."
        && (entry.event as any).deliveryState === "inline"
      )).toBe(true);

      firstTurnControl.release!();
      await firstTurn;
    });

    it("names a non-file attachment in the prompt when the inline OpenCode steer skips it", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            firstTurnControl.release = resolve;
          });
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }

      const steerResult = await service.steer({
        sessionId: session.id,
        text: "Fold in this linked image.",
        attachments: [{
          type: "image-url",
          path: "https://cdn.example.com/reference.png",
          url: "https://cdn.example.com/reference.png",
        }],
        dispatchMode: "inline",
      });
      expect(steerResult.queued).toBe(false);
      const promptText = mockState.openCodeV2SteerCalls[0]?.prompt?.text as string;
      // The URL cannot be a file part, so it must still reach the model as text.
      expect(promptText).toContain("Attached context:");
      expect(promptText).toContain("https://cdn.example.com/reference.png");
      expect(mockState.openCodeV2SteerCalls[0]?.prompt?.files ?? []).toHaveLength(0);

      firstTurnControl.release!();
      await firstTurn;
    });

    it("refuses a cancel while an OpenCode promotion is in flight", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            firstTurnControl.release = resolve;
          });
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }

      const queued = await service.steer({
        sessionId: session.id,
        text: "Do not cancel me mid-flight.",
      });
      expect(queued.queued).toBe(true);
      const queuedRow = events.find((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Do not cancel me mid-flight."
        && (entry.event as any).deliveryState === "queued"
      );
      const steerId = (queuedRow!.event as any).steerId as string;

      let releaseSteer!: () => void;
      mockState.openCodeV2SteerBarrier = new Promise<void>((resolve) => {
        releaseSteer = resolve;
      });
      const dispatch = service.dispatchSteer({ sessionId: session.id, steerId, mode: "inline" });
      for (let attempt = 0; attempt < 20 && mockState.openCodeV2SteerCalls.length < 1; attempt += 1) {
        await Promise.resolve();
      }
      expect(mockState.openCodeV2SteerCalls).toHaveLength(1);

      await expect(service.cancelSteer({ sessionId: session.id, steerId }))
        .rejects.toThrow("already being dispatched");

      releaseSteer();
      await expect(dispatch).resolves.toMatchObject({ dispatchedAt: expect.any(Number) });
      expect(events.some((entry) =>
        entry.event.type === "user_message"
        && entry.event.text === "Do not cancel me mid-flight."
        && (entry.event as any).deliveryState === "inline"
      )).toBe(true);

      firstTurnControl.release!();
      await firstTurn;
    });

    it("sends a refused OpenCode steer as its own turn when the live turn already ended", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      let streamCallCount = 0;
      vi.mocked(streamText).mockImplementation(() => {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          return {
            fullStream: (async function* () {
              await new Promise<void>((resolve) => {
                firstTurnControl.release = resolve;
              });
              yield { type: "finish", usage: {} };
            })(),
          } as any;
        }
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });
      vi.mocked(buildOpenCodePromptParts).mockClear();
      mockState.openCodeV2SteerError = new Error("steer delivery refused");

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start the long turn.",
      });
      for (let attempt = 0; attempt < 20 && !firstTurnControl.release; attempt += 1) {
        await Promise.resolve();
      }

      // Hold the refused steer in flight across the turn boundary, so the
      // queue fallback lands after the tail already drained.
      let releaseSteer!: () => void;
      mockState.openCodeV2SteerBarrier = new Promise<void>((resolve) => {
        releaseSteer = resolve;
      });
      const steerResult = service.steer({
        sessionId: session.id,
        text: "I should still be delivered.",
        dispatchMode: "inline",
      });
      for (let attempt = 0; attempt < 20 && mockState.openCodeV2SteerCalls.length < 1; attempt += 1) {
        await Promise.resolve();
      }
      expect(mockState.openCodeV2SteerCalls).toHaveLength(1);

      firstTurnControl.release!();
      await firstTurn;
      releaseSteer();

      await expect(steerResult).resolves.toMatchObject({ queued: false });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && event.event.text === "I should still be delivered."
          && (event.event as any).deliveryState !== "queued",
      );
      expect(vi.mocked(buildOpenCodePromptParts).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("bridges OpenCode question events through ADE's question UI", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      mockState.openCodeQuestionForNextPrompt = {
        id: "opencode-question-1",
        questions: [
          {
            header: "Scope",
            question: "Which surface should I inspect first?",
            options: [
              { label: "CLI", description: "Check terminal resume." },
              { label: "Chat", description: "Check SDK chat." },
            ],
            custom: true,
          },
        ],
      };

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Ask a clarifying question.",
      });

      const questionEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => {
          if (event.event.type !== "approval_request") return false;
          const detail = event.event.detail as { request?: PendingInputRequest } | undefined;
          return detail?.request?.source === "opencode"
            && detail.request.kind === "structured_question"
            && detail.request.providerMetadata?.openCodeQuestion === true;
        },
      );
      const request = ((questionEvent.event as any).detail as { request: PendingInputRequest }).request;
      expect(request.questions[0]?.question).toBe("Which surface should I inspect first?");
      expect(request.questions[0]?.options?.map((option) => option.value)).toEqual(["CLI", "Chat"]);

      // Answer only AFTER the turn has completed. The ask runs detached, so the
      // loop reaches idle without waiting, and this is the interleaving that pins
      // the completion path's refusal to cancel an open question card: cancel
      // there and the card is gone before the user answers.
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.status === "completed",
      );

      await service.respondToInput({
        sessionId: session.id,
        itemId: request.itemId ?? request.requestId,
        decision: "accept",
        answers: { q_1: "Chat" },
      });
      await turn;

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      expect(openCodeState.questionReply).toHaveBeenCalledWith({
        requestID: "opencode-question-1",
        directory: expect.stringMatching(/project$/),
        answers: [["Chat"]],
      }, { throwOnError: true });
    });

    /**
     * Reported twice on 2026-09-22 against an OpenCode chat: an "OPENCODE
     * ASKS" card with four options sat open for 19 minutes, the owner answered
     * it, and the card redrew itself as "the request closed before it was
     * answered / unanswered / That request is no longer active." The answer
     * never reached the agent — the turn only moved when he retyped the same
     * words as an ordinary message.
     *
     * The brain log for that session names the branch:
     * `agent_chat.approval_without_live_runtime` with `decision: "accept"`.
     * The card is a transcript event and therefore durable; its waiter is a
     * closure in one process. When the runtime (or the process) goes away
     * while the card is open, the card is redrawn with nothing behind it, and
     * the old settle read neither `answers` nor `responseText` before
     * recording the answer as `cancelled` and returning SUCCESS — which made
     * the composer drop the typed text too.
     *
     * The restarted service below is that state exactly: same session row,
     * same transcript, no runtime, no waiter.
     */
    it("re-routes an answer whose waiter died instead of losing it", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      mockState.openCodeQuestionForNextPrompt = {
        id: "opencode-question-orphaned",
        questions: [
          {
            header: "Simulator build for proof",
            question: "How should I proceed?",
            options: [
              { label: "Build now, clean up after", description: "One focused build." },
              { label: "Free space first", description: "Stop and wait." },
            ],
            custom: true,
          },
        ],
      };

      const first = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      const turn = first.service.runSessionTurn({
        sessionId: session.id,
        text: "Ask a clarifying question.",
      });
      const questionEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => {
          if (event.event.type !== "approval_request") return false;
          const detail = event.event.detail as { request?: PendingInputRequest } | undefined;
          return detail?.request?.providerMetadata?.openCodeQuestion === true;
        },
      );
      const request = ((questionEvent.event as any).detail as { request: PendingInputRequest }).request;
      const itemId = request.itemId ?? request.requestId;
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.status === "completed",
      );
      await turn;

      // The durable half has to be on disk before the restart: that transcript
      // is the only place the restarted brain can learn the card's shape.
      const transcriptPath = first.sessionService.get(session.id)!.transcriptPath;
      await waitForCondition(
        () => fs.existsSync(transcriptPath) && fs.readFileSync(transcriptPath, "utf8").includes(itemId),
        "the question card to reach the transcript",
      );

      // The suite stubs the transcript parser to `[]` by default; a restarted
      // brain has nothing BUT the transcript, so this test needs the real one.
      installRealTranscriptParser();

      const restartedEvents: AgentChatEventEnvelope[] = [];
      const restarted = createService({
        onEvent: (event: AgentChatEventEnvelope) => restartedEvents.push(event),
      }).service;

      await restarted.respondToInput({
        sessionId: session.id,
        itemId,
        decision: "accept",
        answers: { [request.questions[0]!.id]: "Build now, clean up after" },
      });

      // 1. The answer reached the agent. Not "a call was made" — the session
      //    carries a user message holding what the owner picked, which is the
      //    thing that was missing when he had to retype it.
      const delivered = await waitForEvent(
        restartedEvents,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && event.event.text.includes("Build now, clean up after"),
      );
      expect(delivered.event.type).toBe("user_message");

      // 2. The receipt tells the truth. An answered question must never be
      //    recorded as unanswered.
      const receipt = restartedEvents.find((entry) =>
        entry.event.type === "pending_input_resolved" && entry.event.itemId === itemId);
      expect(receipt, "answering the card must write a receipt").toBeTruthy();
      expect((receipt!.event as { resolution: string }).resolution).toBe("accepted");
      expect((receipt!.event as { answers?: Record<string, unknown> }).answers)
        .toMatchObject({ [request.questions[0]!.id]: "Build now, clean up after" });

      // 3. No dead end.
      expect(restartedEvents.some((entry) =>
        entry.event.type === "system_notice"
        && entry.event.message === "That request is no longer active.")).toBe(false);

      // 4. Answering twice must not undo the first answer. The second response
      //    finds an `accepted` receipt and changes nothing.
      const receiptsBefore = restartedEvents.filter((entry) =>
        entry.event.type === "pending_input_resolved" && entry.event.itemId === itemId).length;
      await restarted.respondToInput({
        sessionId: session.id,
        itemId,
        decision: "accept",
        answers: { [request.questions[0]!.id]: "Build now, clean up after" },
      });
      expect(restartedEvents.filter((entry) =>
        entry.event.type === "pending_input_resolved" && entry.event.itemId === itemId).length)
        .toBe(receiptsBefore);
      expect(restartedEvents.some((entry) =>
        entry.event.type === "system_notice"
        && entry.event.message === "That request is no longer active.")).toBe(false);
    });

    it("sends Claude image follow-ups as SDK user messages after an earlier text turn", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
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
            content: [{ type: "text", text: streamCall === 2 ? "First turn done" : "Follow-up done" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const imagePath = path.join(tmpRoot, "follow-up.png");
      fs.writeFileSync(imagePath, "fake-image-bytes");

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start with text only",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Now use this screenshot",
        attachments: [{ path: imagePath, type: "image" }],
      });

      expect(send).toHaveBeenCalledTimes(3);
      expect(String(send.mock.calls[1]?.[0] ?? "")).toContain("Start with text only");

      const followUpPayload = send.mock.calls[2]?.[0] as Record<string, unknown>;
      expect(followUpPayload.type).toBe("user");
      expect(followUpPayload.session_id).toEqual(expect.any(String));
      expect(followUpPayload.session_id).not.toBe("");
      expect(followUpPayload.parent_tool_use_id).toBeNull();

      const message = followUpPayload.message as { role: string; content: Array<Record<string, unknown>> };
      expect(message.role).toBe("user");
      expect(message.content[0]?.type).toBe("text");
      expect(String(message.content[0]?.text ?? "")).toContain("Now use this screenshot");
      expect(message.content[1]?.type).toBe("image");
      expect((message.content[1]?.source as Record<string, unknown>).type).toBe("base64");
    });

    it("omits large Cursor SDK file attachments without reading the full file", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      const largePath = path.join(tmpRoot, "large-context.txt");
      const largeContent = `${"x".repeat(512 * 1024 + 1)}large-tail-marker`;
      fs.writeFileSync(largePath, largeContent);

      const readFileSpy = vi.spyOn(fs, "readFileSync");
      let readFileCalls: unknown[][] = [];
      try {
        await service.runSessionTurn({
          sessionId: session.id,
          text: "Use this large file",
          attachments: [{ path: largePath, type: "file" }],
        });
        readFileCalls = [...readFileSpy.mock.calls];
      } finally {
        readFileSpy.mockRestore();
      }

      expect(readFileCalls.some(([target]) => typeof target === "number")).toBe(false);
      const payloadText = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(payloadText).toContain(`[File: ${largePath} omitted: size ${largeContent.length} bytes]`);
      expect(payloadText).not.toContain("large-tail-marker");
    });
  });

  // --------------------------------------------------------------------------
  // approveToolUse
  // --------------------------------------------------------------------------
});
