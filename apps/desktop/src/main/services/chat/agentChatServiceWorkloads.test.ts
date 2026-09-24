import {
  AgentChatCreateScheduledWorkArgs,
  AgentChatEventEnvelope,
  CROSS_PROVIDER_REPLAY_HEADER,
  CURSOR_SILENCE_WATCHDOG_TRIP_MS,
  ChatScheduledWorkState,
  PTY_SEND_PRE_DELIVERY_ERROR_CODE,
  SCHEDULED_WORK_STATE_KEY,
  SCHEDULE_TEST_START,
  SessionTurnAbandonedError,
  acquireCursorSdkConnection,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createScheduledWorkDb,
  createService,
  deriveScheduledWorkSnapshots,
  fs,
  installClaudeResponseFixture,
  installClaudeWakeupFixture,
  installRealTranscriptParser,
  mockState,
  parkCursorSend,
  parkCursorSteer,
  path,
  pumpUntil,
  query,
  readPersistedChatState,
  runGit,
  storedWakeup,
  streamText,
  tmpRoot,
  tripCursorSdkSilenceWatchAndRecycle,
  waitFor,
  waitForEvent,
  waitForFakeTimerCondition,
  waitForFakeTimerPromise,
  waitForFakeTimers,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("hasActiveWorkloads", () => {
    it("reports active Codex app-server turns so project rebalancing keeps their context alive", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(service.hasActiveWorkloads()).toBe(false);

      await service.sendMessage({
        sessionId: session.id,
        text: "Keep this turn alive during a project switch.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      expect(service.hasActiveWorkloads()).toBe(true);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done"
          && event.event.status === "completed"
          && event.event.turnId === "turn-1",
      );

      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("reports active Claude turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let finishTurn = () => {};
      const finishTurnPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-active-claude", slash_commands: [] };
            warmupComplete = true;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-active-claude",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
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
          await finishTurnPromise;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-active-claude",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-active-claude",
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
      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Claude turn alive during a project switch.",
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "text"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("reports active opencode turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let finishTurn = () => {};
      const finishTurnPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "working" };
          await finishTurnPromise;
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this opencode turn alive during a project switch.",
        }, { awaitDispatch: true });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "text"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("reports active Cursor SDK turns so project switching does not close the chat runtime", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const finishTurn = parkCursorSend();
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Cursor turn alive during a project switch.",
        }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(0);
        });
        expect(mockState.cursorSdkSendCalls.at(-1)).toMatchObject({
          mode: "agent",
          idempotencyKey: expect.stringMatching(new RegExp(`^ade:${session.id}:.+:cursor-local:send$`)),
        });
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("surfaces Cursor SDK HTTP/2 backoff failures as rate limits", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      mockState.cursorSendPromptError = new Error(
        "Cursor SDK send failed: Cursor rate limited this request: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
      );
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Trigger Cursor backoff.",
      }, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );
      expect(errorEvent.event.message).toContain("Rate limited by Cursor");
      expect(errorEvent.event.errorInfo).toMatchObject({
        category: "rate_limit",
        provider: "Cursor",
      });
      expect(errorEvent.event.detail).toContain("NGHTTP2_ENHANCE_YOUR_CALM");
    });

    it("surfaces Cursor SDK transport codes as network failures", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      mockState.cursorSendPromptError = Object.assign(
        new Error("Cursor SDK send failed: [internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR"),
        {
          code: "network",
          cursorSdk: {
            message: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
            requestId: "req-cursor-network",
          },
        },
      );
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Trigger Cursor transport failure.",
      }, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );
      expect(errorEvent.event.errorInfo).toMatchObject({
        category: "network",
        provider: "Cursor",
      });
      expect(errorEvent.event.detail).toContain("req-cursor-network");
    });

    it("never expires an active Cursor run on a normal full-auto send", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Full-auto Cursor turn.",
      }, { awaitDispatch: true });

      // The ADE full-auto permission mode must not reach the SDK's
      // `local.force`; only the recovery re-send may expire a run.
      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
      expect(mockState.cursorSdkSendCalls[0]).not.toHaveProperty("force");
      expect(mockState.cursorSdkSendCalls[0]?.forceExpireActiveRun).toBeUndefined();
    });

    it("explains a Cursor agent_busy rejection instead of leaking the raw error", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // Reachable when a concurrent send lands on an agent whose previous run
      // is still registered active (e.g. after settle clears ADE's own busy
      // flag). Without local.force on normal sends the SDK reports it.
      mockState.cursorSendPromptError = Object.assign(
        new Error("Cursor SDK send failed: agent_busy"),
        { code: "agent_busy" },
      );
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Send while the previous run is still active.",
      }, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );
      expect(errorEvent.event.message).toBe(
        "Cursor is already running this chat. Wait for the active turn to finish or cancel it before sending another message.",
      );
      expect(errorEvent.event.errorInfo).toMatchObject({ category: "busy", provider: "Cursor" });
      // A busy rejection is not a transport failure: no rotation, no poison.
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(0);
      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
    });

    it("expires the abandoned run on the first Cursor send after settlement, and only that one", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const releaseStuckTurn = parkCursorSend();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      try {
        void service.sendMessage({
          sessionId: session.id,
          text: "Turn that will be abandoned.",
        });
        await vi.waitFor(() => {
          expect(mockState.cursorSdkSendCalls).toHaveLength(1);
        });

        // Settle force-clears busy/activeTurnId after a best-effort cancel, so
        // the run may still be registered active on the Cursor agent.
        await service.dismissPendingInputForSettlement({ sessionId: session.id });
        // Later sends must not queue behind the abandoned turn.
        mockState.cursorSendPromptGate = null;

        await service.sendMessage({
          sessionId: session.id,
          text: "First send after settling.",
        }, { awaitDispatch: true });
        expect(mockState.cursorSdkSendCalls).toHaveLength(2);
        expect(mockState.cursorSdkSendCalls[1]?.forceExpireActiveRun).toBe(true);
        // awaitDispatch can resolve before the turn's finally clears busy.
        // The one-shot expiry is already consumed; wait until this send is
        // idle so the next one is a true follow-up, not an overlap bounce.
        await vi.waitFor(() => {
          expect(service.hasActiveWorkloads()).toBe(false);
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Second send after settling.",
        }, { awaitDispatch: true });
        expect(mockState.cursorSdkSendCalls).toHaveLength(3);
        // One-shot: the flag must not persist into the next turn.
        expect(mockState.cursorSdkSendCalls[2]?.forceExpireActiveRun).toBeUndefined();
        // And the original send never carried it.
        expect(mockState.cursorSdkSendCalls[0]?.forceExpireActiveRun).toBeUndefined();
      } finally {
        releaseStuckTurn();
      }
    });

    it("recovers once when the first Cursor send throws write ECANCELED", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // The 2026-08-11 incident shape: a transport write cancellation that
      // poisons the agent thread before anything streams.
      mockState.cursorSendPromptError = new Error("Cursor SDK send failed: [internal] write ECANCELED");
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

      void service.sendMessage({
        sessionId: session.id,
        text: "Send that dies on the wire.",
      }, { awaitDispatch: true }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      await vi.waitFor(() => {
        expect(events.some((event) => event.event.type === "error")).toBe(true);
      });

      // One automatic recycle + re-send, then the failure surfaces once.
      expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(1);
      expect(mockState.cursorSdkSendCalls[1]?.forceExpireActiveRun).toBe(true);
      expect(events.filter((event) =>
        event.sessionId === session.id && event.event.type === "error",
      )).toHaveLength(1);
    });

    it("restages a verbatim transcript replay into its own bucket across a Cursor thread recycle", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Keep the banner aligned with the composer.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(session.status).toBe("idle");
      });

      // Out-of-family model switch stages both buckets: the verbatim replay
      // and the ADE continuity reconstruction rebuilt from the conversation.
      await service.updateSession({
        sessionId: session.id,
        modelId: "cursor/composer-2",
      });
      expect(readPersistedChatState(session.id).pendingTranscriptReplay)
        .toContain("Keep the banner aligned with the composer.");

      mockState.cursorSdkSendCalls = [];
      mockState.onCursorSendPrompt = () => {
        mockState.cursorSendPromptError = mockState.cursorSdkSendCalls.length === 1
          ? new Error("Cursor SDK send failed: [internal] write ECANCELED")
          : null;
      };

      await service.sendMessage({
        sessionId: session.id,
        text: "Continue after the recycle.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });

      const continuityHeader = "System context (ADE continuity, do not echo verbatim):";
      const retryPrompt = String(mockState.cursorSdkSendCalls[1]?.promptText ?? "");
      expect(retryPrompt.split(continuityHeader).length - 1).toBe(1);
      expect(retryPrompt).toContain(CROSS_PROVIDER_REPLAY_HEADER);
      expect(retryPrompt).toContain("Keep the banner aligned with the composer.");

      const headerIndex = retryPrompt.indexOf(continuityHeader);
      const replayIndex = retryPrompt.indexOf(CROSS_PROVIDER_REPLAY_HEADER);
      expect(replayIndex).toBeGreaterThanOrEqual(0);
      expect(replayIndex).toBeLessThan(headerIndex);
      expect(retryPrompt.slice(headerIndex)).not.toContain(CROSS_PROVIDER_REPLAY_HEADER);
      expect(readPersistedChatState(session.id).pendingTranscriptReplay).toBeNull();
    });

    it("recovers once when a Cursor run returns a transport error with no stream events", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // The true production shape: cursorSdkWorker posts a synthetic terminal
      // `status: ERROR` sdk_event immediately before run_result. Counting that
      // as stream activity is what made this branch dead in the field while a
      // test that emitted nothing still passed.
      mockState.cursorSendPromptResult = {
        id: "cursor-sdk-run-1",
        status: "error",
        error: { message: "[internal] write ECANCELED", code: "stream_error" },
      };
      mockState.onCursorSendPrompt = (pooled) => {
        pooled.bridge.onEvent?.({
          type: "status",
          status: "ERROR",
          message: "[internal] write ECANCELED",
          adeErrorCode: "[internal] write ECANCELED",
          adeErrorDetail: { message: "[internal] write ECANCELED" },
        }, { runtime: "local", runId: "cursor-sdk-run-1" });
      };
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      void service.sendMessage({
        sessionId: session.id,
        text: "Run that returns a transport error.",
      }, { awaitDispatch: true }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });

      expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(1);
      expect(mockState.cursorSdkAcquireCalls.at(-1)?.agentId).toBeNull();
      expect(mockState.cursorSdkSendCalls[1]?.forceExpireActiveRun).toBe(true);
    });

    it("does not recover a Cursor transport error that arrived after real output", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // Same terminal error, but the run streamed first — recycling would throw
      // away work the user can already see, so it must not fire.
      mockState.cursorSendPromptResult = {
        id: "cursor-sdk-run-1",
        status: "error",
        error: { message: "[internal] write ECANCELED", code: "stream_error" },
      };
      mockState.onCursorSendPrompt = (pooled) => {
        pooled.bridge.onEvent?.(
          { type: "assistant", message: { content: [{ type: "text", text: "Partial answer." }] } },
          { runtime: "local", runId: "cursor-sdk-run-1" },
        );
        pooled.bridge.onEvent?.({
          type: "status",
          status: "ERROR",
          adeErrorCode: "[internal] write ECANCELED",
        }, { runtime: "local", runId: "cursor-sdk-run-1" });
      };
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Run that streams then dies.",
      }, { awaitDispatch: true }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(events.some((event) => event.event.type === "done")).toBe(true);
      });

      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(0);
    });

    it("recovers a Cursor stale access token on the same agent thread, invisibly, before any output", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // The SDK exchanges the API key for a short-lived access token once per
      // worker and never refreshes it, so ~60 min in every send dies instantly
      // with this exact text. The key is fine; only the worker is spent.
      const staleTokenMessage = "Authentication error If you are logged in, try logging out and back in.";
      mockState.onCursorSendPrompt = (pooled) => {
        if (mockState.cursorSdkSendCalls.length > 1) {
          mockState.cursorSendPromptResult = null;
          return;
        }
        mockState.cursorSendPromptResult = {
          id: "cursor-sdk-run-1",
          status: "error",
          error: { message: staleTokenMessage, code: staleTokenMessage },
        };
        pooled.bridge.onEvent?.({
          type: "status",
          status: "ERROR",
          adeErrorCode: staleTokenMessage,
          adeErrorDetail: { message: staleTokenMessage, requestId: "req-stale-1" },
        }, { runtime: "local", runId: "cursor-sdk-run-1" });
      };
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Send whose token just expired.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(events.some((event) => event.event.type === "done")).toBe(true);
      });

      // Exactly one recycle and one re-send...
      expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(1);
      // ...onto the SAME agent id, so the whole conversation survives. This is
      // what separates it from the transport recycle, which rotates to a new
      // agent and re-seeds it with a continuity summary.
      expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
      expect(mockState.cursorSdkAcquireCalls[1]?.agentId).toBe("cursor-sdk-agent-1");
      expect(mockState.cursorSdkSendCalls[1]?.forceExpireActiveRun).toBe(true);
      // Nothing had streamed yet, so the original prompt is re-sent verbatim —
      // byte-identical to attempt 1, not a "continue" instruction. Accepted
      // trade-off: `forceExpireActiveRun` expires the wedged run but does not
      // unregister the message it already recorded, so the resumed thread can
      // hold this prompt twice. A silent, correct answer beats a deduped no-op.
      expect(String(mockState.cursorSdkSendCalls[1]?.promptText ?? ""))
        .toContain("Send whose token just expired.");
      expect(mockState.cursorSdkSendCalls[1]?.promptText)
        .toBe(mockState.cursorSdkSendCalls[0]?.promptText);
      // And the user sees none of it: no error card, no notice.
      expect(events.filter((event) => event.event.type === "error")).toHaveLength(0);
      expect(events.filter((event) => event.event.type === "system_notice")).toHaveLength(0);
      expect(events.filter((event) => event.event.type === "done").at(-1)?.event)
        .toMatchObject({ status: "completed" });
    });

    it("ignores visible output from an abandoned run when deciding to resume mid-turn", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // Same stale-token recovery, but the only "real output" belongs to a run
      // this turn already walked away from. Crediting it would tell Cursor to
      // continue from work that never happened on this turn, so the retry must
      // be the verbatim replay instead.
      const staleTokenMessage = "Authentication error If you are logged in, try logging out and back in.";
      mockState.onCursorSendPrompt = (pooled) => {
        if (mockState.cursorSdkSendCalls.length > 1) {
          mockState.cursorSendPromptResult = null;
          return;
        }
        mockState.cursorSendPromptResult = {
          id: "cursor-sdk-run-1",
          status: "error",
          error: { message: staleTokenMessage, code: staleTokenMessage },
        };
        // This turn's run, which scopes the watchdog...
        pooled.bridge.onRunStarted?.({
          agentId: "cursor-sdk-agent-1",
          runId: "cursor-sdk-run-1",
          modelSdkId: "composer-2",
        }, { runtime: "local" });
        // ...and a late frame from the previous, abandoned one.
        pooled.bridge.onEvent?.(
          { type: "assistant", message: { content: [{ type: "text", text: "Output from the old run." }] } },
          { runtime: "local", runId: "cursor-sdk-run-0" },
        );
        pooled.bridge.onEvent?.({
          type: "status",
          status: "ERROR",
          adeErrorCode: staleTokenMessage,
          adeErrorDetail: { message: staleTokenMessage },
        }, { runtime: "local", runId: "cursor-sdk-run-1" });
      };
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Refactor the composer.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(events.some((event) => event.event.type === "done")).toBe(true);
      });

      expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      const retryPrompt = String(mockState.cursorSdkSendCalls[1]?.promptText ?? "");
      expect(retryPrompt).not.toContain("Continue where you left off");
      expect(retryPrompt).toBe(String(mockState.cursorSdkSendCalls[0]?.promptText ?? ""));
      // Nothing visible happened on this turn, so the recovery stays silent.
      expect(events.filter((event) => event.event.type === "system_notice")).toHaveLength(0);
      expect(events.filter((event) => event.event.type === "error")).toHaveLength(0);
    });

    it("continues the resumed Cursor thread when the access token expires mid-turn", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const staleTokenMessage = "Authentication error If you are logged in, try logging out and back in.";
      mockState.onCursorSendPrompt = (pooled) => {
        if (mockState.cursorSdkSendCalls.length > 1) {
          mockState.cursorSendPromptResult = null;
          return;
        }
        mockState.cursorSendPromptResult = {
          id: "cursor-sdk-run-1",
          status: "error",
          error: { message: staleTokenMessage, code: staleTokenMessage },
        };
        // Real output first: the token ages out an hour into a working turn.
        pooled.bridge.onEvent?.(
          { type: "assistant", message: { content: [{ type: "text", text: "Started the refactor." }] } },
          { runtime: "local", runId: "cursor-sdk-run-1" },
        );
        pooled.bridge.onEvent?.({
          type: "status",
          status: "ERROR",
          adeErrorCode: staleTokenMessage,
          adeErrorDetail: { message: staleTokenMessage },
        }, { runtime: "local", runId: "cursor-sdk-run-1" });
      };
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Refactor the composer.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(events.some((event) => event.event.type === "done")).toBe(true);
      });

      expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      expect(mockState.cursorSdkAcquireCalls[1]?.agentId).toBe("cursor-sdk-agent-1");
      // The thread was resumed, so re-sending the original prompt would restart
      // work Cursor had already done — it is asked to continue instead.
      const retryPrompt = String(mockState.cursorSdkSendCalls[1]?.promptText ?? "");
      expect(retryPrompt).toContain("Continue where you left off");
      expect(retryPrompt).not.toContain("Refactor the composer.");
      // The reply visibly stopped, so this one case says something — quietly.
      // Recovery is live state and disappears from the durable transcript.
      const retryActivities = events.filter((event) =>
        event.event.type === "activity"
        && event.event.detail === "Reconnecting to Cursor",
      );
      expect(retryActivities).toHaveLength(1);
      const history = await service.getChatEventHistory(session.id);
      expect(history.events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              type: "system_notice",
              message: "Reconnected to Cursor and continued.",
            }),
          }),
        ]),
      );
      expect(history.events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              type: "activity",
              activity: "working",
              providerRetry: true,
            }),
          }),
        ]),
      );
      expect(events.filter((event) => event.event.type === "error")).toHaveLength(0);
    });

    it("surfaces the Cursor stale-token failure once when the recovery re-send fails the same way", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const staleTokenMessage = "Authentication error If you are logged in, try logging out and back in.";
      mockState.cursorSendPromptResult = {
        id: "cursor-sdk-run-1",
        status: "error",
        error: { message: staleTokenMessage, code: staleTokenMessage },
      };
      mockState.onCursorSendPrompt = (pooled) => {
        pooled.bridge.onEvent?.({
          type: "status",
          status: "ERROR",
          adeErrorCode: staleTokenMessage,
          adeErrorDetail: { message: staleTokenMessage, requestId: "req-stale-2" },
        }, { runtime: "local", runId: "cursor-sdk-run-1" });
      };
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Send that stays unauthenticated.",
      }, { awaitDispatch: true }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(events.some((event) => event.event.type === "error")).toBe(true);
      });

      // One recovery, no loop.
      expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      const errorEvents = events.filter((event) => event.event.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.event).toMatchObject({
        message: "Cursor's session expired. ADE reconnected and retried, but Cursor rejected the request "
          + "again — sign in to Cursor again in Settings, then resend.",
        errorInfo: { category: "auth", provider: "Cursor" },
      });
      // The raw SDK text never reaches the transcript, but the request id does.
      expect(String((errorEvents[0]?.event as { detail?: string }).detail ?? ""))
        .toContain("req-stale-2");
    });

    it("does not recycle the Cursor worker for a genuinely bad API key", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // A fresh worker would fail identically: this is the user's problem to
      // fix, so it must surface immediately rather than burn a recovery.
      mockState.cursorSendPromptError = new Error("Authentication failed: Invalid API key");
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

      await service.sendMessage({
        sessionId: session.id,
        text: "Send with a bad key.",
      }, { awaitDispatch: true }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(events.some((event) => event.event.type === "error")).toBe(true);
      });

      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(0);
      const errorEvents = events.filter((event) => event.event.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(String((errorEvents[0]?.event as { message?: string }).message ?? ""))
        .toContain("Check your Cursor credentials");
    });

    it("carries a queued Cursor steer across a thread recycle and delivers it after recovery", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      vi.useFakeTimers();
      try {
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Turn that goes silent.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);

        // The user types again during the silent window: cursor queues it as a
        // steer, on a runtime the recycle is about to destroy.
        await service.steer({ sessionId: session.id, text: "Also check the migration." });
        await pumpUntil("queued steer", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        mockState.cursorSendPromptGate = null;
        await tripCursorSdkSilenceWatchAndRecycle();
        // Re-send, then the carried steer delivered as its own turn.
        await pumpUntil("steer delivered after recovery", () => mockState.cursorSdkSendCalls.length >= 3);

        // The message the user typed during the outage is not lost.
        expect(String(mockState.cursorSdkSendCalls[2]?.promptText ?? "")).toContain("Also check the migration.");
        // ...and it is not cancelled behind their back.
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("cancelled"))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * Cursor "interrupt & continue". Unlike Claude's interrupt, and unlike
     * Cursor's own inline steer, this one cancels the run and resends on the
     * same agent — these cover that the cancel happens, the resend lands on the
     * same thread, and nothing the user already queued is thrown away.
     *
     * The inline-steer block further down uses its own `startStalledCursorTurn`:
     * it needs a turn that never settles and a way to end it on demand, while
     * this one needs the cancel plumbing that drives the redirect.
     */
    const startBusyCursorSession = async (events: AgentChatEventEnvelope[]) => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      const releaseTurn = parkCursorSend();
      void service.sendMessage({
        sessionId: session.id,
        text: "Original turn.",
      }, { awaitDispatch: true }).catch(() => undefined);
      await waitForFakeTimers(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(1);
      });
      // The worker's cancel is what actually settles the in-flight run.
      mockState.onCursorCancel = () => {
        mockState.onCursorCancel = null;
        mockState.cursorSendPromptGate = null;
        releaseTurn?.();
      };
      return { service, session };
    };

    it("dispatches a Cursor steer with dispatchMode interrupt by cancelling the run and resending on the same agent", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      await service.steer({
        sessionId: session.id,
        text: "Actually, do the migration first.",
        dispatchMode: "interrupt",
      });

      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      expect(String(mockState.cursorSdkSendCalls[1]?.promptText ?? ""))
        .toContain("Actually, do the migration first.");
      // The previous turn is reported as interrupted, not failed.
      expect(events.some((event) =>
        event.event.type === "status" && event.event.turnStatus === "interrupted")).toBe(true);
      // Same agent, same thread: no rotation and no new worker.
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(0);
      expect(readPersistedChatState(session.id).cursorSdkAgentId).toBe("cursor-sdk-agent-1");
    });

    it("keeps already-queued Cursor steers across an interrupt-and-continue", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      await service.steer({ sessionId: session.id, text: "Then update the docs." });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });

      await service.steer({
        sessionId: session.id,
        text: "Actually, do the migration first.",
        dispatchMode: "interrupt",
      });

      // Redirect turn, then the message the user had already staged.
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(3);
      });
      expect(String(mockState.cursorSdkSendCalls[1]?.promptText ?? ""))
        .toContain("Actually, do the migration first.");
      expect(String(mockState.cursorSdkSendCalls[2]?.promptText ?? ""))
        .toContain("Then update the docs.");
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && typeof event.event.steerId === "string"
        && event.event.message.includes("cancelled"))).toBe(false);
    });

    it("routes messageSession kind interrupt-replace on Cursor through interrupt-and-continue", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      const result = await service.messageSession({
        sessionId: session.id,
        text: "Stop and take this instead.",
        kind: "interrupt-replace",
      });

      expect(result.routedAction).toBe("interrupt-replace");
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      expect(String(mockState.cursorSdkSendCalls[1]?.promptText ?? ""))
        .toContain("Stop and take this instead.");
      expect(events.some((event) =>
        event.event.type === "status" && event.event.turnStatus === "interrupted")).toBe(true);
      expect(readPersistedChatState(session.id).cursorSdkAgentId).toBe("cursor-sdk-agent-1");
    });

    it("routes messageSession kind auto on Cursor through the inline steer", async () => {
      // "auto" reads `defaultActiveTurnDispatchMode`, which is the first entry
      // in the canonical table. Cursor's first entry became "inline" when
      // @cursor/sdk 1.0.31 added `Run.steer()`, so auto now folds the message
      // into the live run instead of cancelling it.
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      const result = await service.messageSession({
        sessionId: session.id,
        text: "Do this instead.",
        kind: "auto",
      });

      expect(result.routedAction).toBe("steer");
      expect(mockState.cursorSdkSteerCalls).toEqual(["Do this instead."]);
      // The live turn takes the text, so no second turn starts and the first
      // one is never interrupted.
      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
      expect(events.some((event) =>
        event.event.type === "status" && event.event.turnStatus === "interrupted")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "user_message" && event.event.deliveryState === "inline")).toBe(true);
    });

    it("keeps messageSession kind queue on Cursor queued instead of interrupting", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      const result = await service.messageSession({
        sessionId: session.id,
        text: "Then update the docs.",
        kind: "queue",
      });

      expect(result.routedAction).toBe("steer");
      expect(result.queued).toBe(true);
      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });
    });

    it("still clears queued Droid steers on interrupt-replace, unlike Cursor", async () => {
      // The Cursor redirect softens the stop to `stop_only` so the user's other
      // queued messages ride through. That is Cursor-only: every other provider
      // keeps the pre-existing `interrupt-replace` contract, which clears.
      const events: AgentChatEventEnvelope[] = [];
      let finishTurn = () => {};
      mockState.droidPromptGate = new Promise<void>((resolve) => { finishTurn = resolve; });
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });
      try {
        void service.sendMessage({
          sessionId: session.id,
          text: "Original Droid turn.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await vi.waitFor(() => {
          expect(mockState.droidPromptCalls.length).toBeGreaterThanOrEqual(1);
        });
        // The cancel is what settles the in-flight prompt, as on the real SDK.
        mockState.droidPooled?.cancel.mockImplementation(async () => {
          mockState.droidPromptGate = null;
          finishTurn();
        });

        await service.steer({ sessionId: session.id, text: "Then update the docs." });
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
        });

        await service.messageSession({
          sessionId: session.id,
          text: "Stop and take this instead.",
          kind: "interrupt-replace",
        });

        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "system_notice"
            && typeof event.event.steerId === "string"
            && event.event.message.includes("cancelled"))).toBe(true);
        });
        await vi.waitFor(() => {
          expect(mockState.droidPromptCalls.some((call) =>
            String(call.prompt ?? call.promptText ?? "").includes("Stop and take this instead."))).toBe(true);
        });
      } finally {
        mockState.droidPromptGate = null;
        finishTurn();
      }
    });

    it("promotes a staged Cursor steer to interrupt-and-continue through dispatchSteer", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      const staged = await service.steer({ sessionId: session.id, text: "Run this one instead." });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });

      await service.dispatchSteer({ sessionId: session.id, steerId: staged.steerId, mode: "interrupt" });

      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      expect(String(mockState.cursorSdkSendCalls[1]?.promptText ?? "")).toContain("Run this one instead.");
      // The staged chip has to be resolved, or it stays parked in the composer.
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.steerId === staged.steerId
        && event.event.message.includes("Delivering"))).toBe(true);
    });

    it("accepts an inline steer dispatch on Cursor now that the SDK has a steer channel", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService({ onEvent: () => {} });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      // The table guard no longer refuses the mode. With no live turn the
      // message simply becomes an ordinary send rather than an error.
      await expect(service.steer({
        sessionId: session.id,
        text: "Fold this into the live run.",
        dispatchMode: "inline",
      })).resolves.toMatchObject({ queued: false });
    });

    // Regression (quality A2): the redirect rebuilds the send from scratch, so
    // the per-message overrides the user picked for THIS message have to be
    // carried across it. Before the fix they were dropped and the redirect ran
    // on whatever the session already had.
    it("carries per-message reasoning and execution overrides through the Cursor interrupt redirect", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);
      const before = await service.getSessionSummary(session.id);
      expect(before?.reasoningEffort ?? null).toBeNull();
      expect(before?.executionMode).toBe("focused");

      await service.steer({
        sessionId: session.id,
        text: "Actually, do the migration first.",
        dispatchMode: "interrupt",
        reasoningEffort: "high",
        executionMode: "parallel",
      });

      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      const after = await service.getSessionSummary(session.id);
      expect(after?.reasoningEffort).toBe("high");
      expect(after?.executionMode).toBe("parallel");
      expect(readPersistedChatState(session.id).reasoningEffort).toBe("high");
    });

    // Regression (quality A2): the same three overrides ride the staged row
    // when the user promotes it, exactly as `deliverNextQueuedSteer` applies
    // them at a natural turn boundary.
    it("carries a staged Cursor steer's overrides through the promotion redirect", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      const staged = await service.steer({
        sessionId: session.id,
        text: "Run this one instead.",
        reasoningEffort: "high",
        executionMode: "subagents",
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });
      // Staging must not apply them: they belong to the message, not the session.
      expect((await service.getSessionSummary(session.id))?.executionMode).toBe("focused");

      await service.dispatchSteer({ sessionId: session.id, steerId: staged.steerId, mode: "interrupt" });

      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      const after = await service.getSessionSummary(session.id);
      expect(after?.reasoningEffort).toBe("high");
      expect(after?.executionMode).toBe("subagents");
    });

    // Regression (quality A8): `steerWithOptions` already expanded the chips,
    // so the redirect's `sendMessage` must not expand them a second time —
    // expanded file content can itself contain chip syntax.
    it("expands @-mention chips exactly once on the Cursor interrupt redirect", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      await service.steer({
        sessionId: session.id,
        text: "apply the fix from @chat:other-session-id",
        dispatchMode: "interrupt",
      });

      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      const promptText = String(mockState.cursorSdkSendCalls[1]?.promptText ?? "");
      expect(promptText).toContain("<ade-mention");
      expect(promptText.match(/<ade-mention/g) ?? []).toHaveLength(1);
      expect(promptText).toContain("other-session-id");
    });

    // Regression (quality A4/B7): the settle wait can time out with the run
    // still live. The old blanket `finally` disarmed the preserve flag on the
    // way out, so the late cancel — issued by exactly the stop this redirect
    // asked for — wiped the messages the user had already queued.
    it("keeps queued Cursor steers when the interrupt's settle wait times out", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      await service.steer({ sessionId: session.id, text: "Then update the docs." });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });

      // The stop reaches the worker, but the run does not settle: the redirect
      // gives up after its 30 s wait and reports that, instead of hanging.
      const releaseTurn = mockState.onCursorCancel;
      mockState.onCursorCancel = () => {};
      vi.useFakeTimers();
      try {
        const redirect = service.steer({
          sessionId: session.id,
          text: "Actually, do the migration first.",
          dispatchMode: "interrupt",
        }).then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : String(error)));
        await vi.advanceTimersByTimeAsync(31_000);
        await expect(redirect).resolves.toMatch(/still stopping/);
      } finally {
        vi.useRealTimers();
      }

      // The run settles late, and its tail runs the cancel the stop earned.
      // The flag is still armed, so the user's other message survives it.
      releaseTurn?.();
      await waitForFakeTimers(() => {
        expect(events.some((event) =>
          event.event.type === "status" && event.event.turnStatus === "interrupted")).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && typeof event.event.steerId === "string"
        && event.event.message.includes("cancelled"))).toBe(false);
    });

    // Regression (quality R6): the promotion splices the row out of the queue
    // before the redirect completes, so a cancel arriving in that window must
    // say the message is going out, not that it was never queued.
    it("tells the user a promoted Cursor steer is already being dispatched, not that it is gone", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, session } = await startBusyCursorSession(events);

      const staged = await service.steer({ sessionId: session.id, text: "Run this one instead." });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });

      // The worker's cancel runs inside the redirect, while the row is spliced
      // out but the dispatch has not landed yet.
      let cancelDuringDispatch: Promise<unknown> | null = null;
      const releaseTurn = mockState.onCursorCancel;
      mockState.onCursorCancel = () => {
        cancelDuringDispatch = service
          .cancelSteer({ sessionId: session.id, steerId: staged.steerId, requireQueued: true })
          .then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : String(error)));
        releaseTurn?.();
      };

      await service.dispatchSteer({ sessionId: session.id, steerId: staged.steerId, mode: "interrupt" });

      expect(cancelDuringDispatch, "the cancel must land inside the dispatch window").toBeTruthy();
      await expect(cancelDuringDispatch!).resolves.toBe("This message is already being dispatched.");
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThanOrEqual(2);
      });
      expect(String(mockState.cursorSdkSendCalls[1]?.promptText ?? "")).toContain("Run this one instead.");
    });

    it("settles a re-queued Cursor steer exactly once when the recovery re-send also goes silent", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      vi.useFakeTimers();
      try {
        // Neither attempt ever answers, so the steer is carried onto attempt 2's
        // runtime and then abandoned again when that one is recycled too.
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Both attempts go silent.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);

        await service.steer({ sessionId: session.id, text: "Queued during the outage." });
        await pumpUntil("queued steer", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("recovery re-send", () => mockState.cursorSdkSendCalls.length >= 2);
        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("terminal failure", () => events.some((event) => event.event.type === "error"));

        // Settled, and settled once: the attempt body and the wrapper cover
        // disjoint windows, so the chip clears without a duplicate notice.
        // Only one steer exists in this test, so any steer-scoped cancellation
        // notice belongs to it.
        const cancelNotices = events.filter((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("cancelled"));
        expect(cancelNotices).toHaveLength(1);
        expect(cancelNotices[0]?.event).toMatchObject({
          message: "Queued message cancelled because ADE recycled the Cursor thread — resend it if still needed.",
        });
        // The steer was never delivered as a turn of its own.
        expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("settles a queued Cursor steer when the user stops a silent run", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      vi.useFakeTimers();
      try {
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Silent run the user stops.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);

        await service.steer({ sessionId: session.id, text: "Queued before the stop." });
        await pumpUntil("queued steer", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        // Stop lands while the run is still silent; a plain stop does not clear
        // the queue, so the recycle is what strands the steer.
        mockState.onCursorCancel = () => {
          mockState.onCursorCancel = null;
          void service.interrupt({ sessionId: session.id });
        };
        await vi.advanceTimersByTimeAsync(CURSOR_SILENCE_WATCHDOG_TRIP_MS);
        await pumpUntil("turn settled", () => events.some((event) => event.event.type === "done"));

        const cancelNotices = events.filter((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("cancelled"));
        // Not silently dropped, and not double-noticed.
        expect(cancelNotices).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("settles a Cursor steer queued during the recovery re-send when that attempt also goes silent", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      vi.useFakeTimers();
      try {
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Both attempts go silent.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);

        // Queued during attempt 1 — carried across the recycle by the wrapper.
        await service.steer({ sessionId: session.id, text: "Carried across the recycle." });
        await pumpUntil("carried steer queued", () => events.filter((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued").length >= 1);

        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("recovery re-send", () => mockState.cursorSdkSendCalls.length >= 2);

        // Queued during attempt 2 — lands on the rebuilt runtime, which the
        // wrapper does not track. Only the attempt itself can settle it.
        await service.steer({ sessionId: session.id, text: "Queued during the re-send." });
        await pumpUntil("second steer queued", () => events.filter((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued").length >= 2);

        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("terminal failure", () => events.some((event) => event.event.type === "error"));

        const cancelNotices = events.filter((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("cancelled"));
        // Both steers settled, neither twice.
        expect(cancelNotices).toHaveLength(2);
        const noticedIds = cancelNotices.map((event) =>
          event.event.type === "system_notice" ? event.event.steerId : null);
        expect(new Set(noticedIds).size).toBe(2);
        // Neither was delivered as a turn of its own.
        expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not cancel a delivered Cursor steer when a later recycle swaps the runtime", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      vi.useFakeTimers();
      try {
        parkCursorSend();
        // Send 3 is the delivered steer's own turn: it goes silent too, so its
        // nested recycle detaches managed.runtime while the outer wrapper is
        // still holding the carried steer — the false-cancel window.
        mockState.onCursorSendPrompt = () => {
          if (mockState.cursorSdkSendCalls.length !== 3) return;
          parkCursorSend();
          // The gate is read synchronously right after this hook, so clearing
          // it on a microtask stalls only send 3 and lets its re-send run free.
          queueMicrotask(() => { mockState.cursorSendPromptGate = null; });
        };
        void service.sendMessage({
          sessionId: session.id,
          text: "Turn that goes silent.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);

        await service.steer({ sessionId: session.id, text: "Carried, then delivered." });
        await pumpUntil("queued steer", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        // Attempt 2 succeeds and delivers the carried steer.
        mockState.cursorSendPromptGate = null;
        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("steer delivered", () => mockState.cursorSdkSendCalls.length >= 3);
        // The delivered steer's turn is silent in turn; its recovery re-send
        // (send 4) succeeds and leaves a different runtime on the session.
        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("nested recovery", () => mockState.cursorSdkSendCalls.length >= 4);
        // Let the nested chain unwind fully, so the outer wrapper's finally
        // runs while the session is on a different runtime than it re-queued on.
        await pumpUntil("both turns settled", () => events.filter((event) =>
          event.event.type === "done").length >= 2);

        // The steer really was delivered...
        expect(String(mockState.cursorSdkSendCalls[2]?.promptText ?? ""))
          .toContain("Carried, then delivered.");
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("Delivering"))).toBe(true);
        // ...so the runtime swap must not retroactively cancel it.
        expect(events.filter((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("cancelled"))).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    describe("Cursor inline steer", () => {
      // `pumpUntil` drives fake timers, and every test here parks a turn that
      // never settles on its own.
      // The file-level afterEach already restores the clock.
      beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => {
        // Parks drain in the file-level afterEach, after the real clock is
        // restored. Draining here would settle the stalled send on the fake
        // clock this block installed.
        vi.useRealTimers();
      });

      /** A Cursor session parked on a turn that never finishes on its own. */
      const startStalledCursorTurn = async (events: AgentChatEventEnvelope[]) => {
        process.env.CURSOR_API_KEY = "cursor-test-key";
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "cursor",
          model: "composer-2",
          modelId: "cursor/composer-2",
        });
        const endTurn = parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "A turn that keeps running.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);
        // `endTurn` lets the turn finish. Without calling it the runtime stays
        // busy for the whole test, which is what every case below wants except
        // the two that prove a stranded row still goes out.
        return { service, session, endTurn };
      };

      const noticeTexts = (events: AgentChatEventEnvelope[]) => events
        .filter((event) => event.event.type === "system_notice")
        .map((event) => (event.event.type === "system_notice" ? event.event.message : ""));

      it("folds the message into the live run when the turn accepts it", async () => {
        const events: AgentChatEventEnvelope[] = [];
        const { service, session } = await startStalledCursorTurn(events);

        await service.steer({
          sessionId: session.id,
          text: "Do this instead.",
          dispatchMode: "inline",
        });

        expect(mockState.cursorSdkSteerCalls).toEqual(["Do this instead."]);
        // The steered text belongs to the live turn, so it must not start one.
        expect(mockState.cursorSdkSendCalls).toHaveLength(1);
        const inline = events.filter((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "inline");
        expect(inline).toHaveLength(1);
        // Nothing is left staged, so no chip survives the send.
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(false);
      });

      it("queues the message and explains why when the turn refuses it", async () => {
        const events: AgentChatEventEnvelope[] = [];
        mockState.cursorSteerOutcome = "revert_to_followup";
        const { service, session } = await startStalledCursorTurn(events);

        await service.steer({
          sessionId: session.id,
          text: "Too late for this one.",
          dispatchMode: "inline",
        });

        expect(mockState.cursorSdkSteerCalls).toEqual(["Too late for this one."]);
        // The text is never lost: it falls back to the ordinary staged queue.
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
        expect(noticeTexts(events).some((text) => text.includes("send as a new message"))).toBe(true);
      });

      it("keeps the staged chip alive on the fallback notice", async () => {
        // The renderer retires a chip when a notice names its steer AND the text
        // matches /cancelled|delivering/i. The fallback leaves the message
        // queued, so its wording must fail that test or the user loses sight of
        // a message still waiting to send.
        const events: AgentChatEventEnvelope[] = [];
        mockState.cursorSteerOutcome = "revert_to_followup";
        const { service, session } = await startStalledCursorTurn(events);

        await service.steer({
          sessionId: session.id,
          text: "Still mine.",
          dispatchMode: "inline",
        });

        const fallback = events.find((event) =>
          event.event.type === "system_notice" && event.event.message.includes("send as a new message"));
        expect(fallback).toBeTruthy();
        const message = fallback?.event.type === "system_notice" ? fallback.event.message : "";
        expect(/cancelled|delivering/i.test(message)).toBe(false);
      });

      it("never offers an attachment-bearing message to the text-only steer channel", async () => {
        // `Run.steer(text)` has no image channel and no file blocks. Sending the
        // bare text would drop the files while the transcript row still claimed
        // they went. The staged queue delivers them intact.
        const events: AgentChatEventEnvelope[] = [];
        const { service, session } = await startStalledCursorTurn(events);

        const imagePath = path.join(tmpRoot, "cursor-inline-steer.png");
        fs.writeFileSync(imagePath, "fake-image-bytes");
        await service.steer({
          sessionId: session.id,
          text: "Look at this screenshot.",
          dispatchMode: "inline",
          attachments: [{ path: imagePath, type: "image" }],
        });

        // The steer channel is never even asked, so the notice must not blame
        // the agent for a refusal ADE made itself.
        expect(mockState.cursorSdkSteerCalls).toEqual([]);
        const notice = noticeTexts(events).find((text) => text.includes("send as a new message"));
        expect(notice).toBeTruthy();
        expect(notice).not.toMatch(/cursor/i);
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });

      it("does not promise a new message when the queue is full and drops it", async () => {
        // The fallback notice says the message will send. Emitting it before the
        // queue-full guard would pair that promise with "Steer dropped".
        const events: AgentChatEventEnvelope[] = [];
        mockState.cursorSteerOutcome = "revert_to_followup";
        const { service, session } = await startStalledCursorTurn(events);

        // Fill until the host itself reports the queue full, so the private cap's
        // value never leaks in here and a change to it cannot quietly stop this
        // test from reaching the branch it exists for.
        let filler = 0;
        while ((await service.steer({ sessionId: session.id, text: `filler ${filler}` })).reason !== "queue_full") {
          filler += 1;
          if (filler > 100) throw new Error("queue never reported full");
        }
        const result = await service.steer({
          sessionId: session.id,
          text: "One too many.",
          dispatchMode: "inline",
        });

        expect(result.reason).toBe("queue_full");
        const texts = noticeTexts(events);
        expect(texts.some((text) => text.includes("queue is full"))).toBe(true);
        expect(texts.some((text) => text.includes("send as a new message"))).toBe(false);
      });

      it("queues the message rather than losing it when the steer call throws", async () => {
        const events: AgentChatEventEnvelope[] = [];
        mockState.cursorSteerError = new Error("Cursor SDK steer failed: worker gone");
        const { service, session } = await startStalledCursorTurn(events);

        // A dead worker must not take the user's typed text down with it.
        await service.steer({
          sessionId: session.id,
          text: "Survives a dead worker.",
          dispatchMode: "inline",
        });

        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued")).toBe(true);
      });

      it("sends a stranded row when the refusal is the turn ending", async () => {
        // The whole reason `drainCursorQueueHeadIfIdle` exists. Cursor drains its
        // queue at one place only: the end of a turn. When the steer is refused
        // BECAUSE that turn just ended, the boundary already decided not to
        // drain (the queue was empty then), so without the flush this row waits
        // for the user to send something unrelated.
        const events: AgentChatEventEnvelope[] = [];
        mockState.cursorSteerOutcome = "revert_to_followup";
        const { service, session, endTurn } = await startStalledCursorTurn(events);
        mockState.onCursorSteer = () => {
          mockState.cursorSendPromptGate = null;
          endTurn();
        };

        await service.steer({
          sessionId: session.id,
          text: "Stranded without the flush.",
          dispatchMode: "inline",
        });

        // Send 2 is the stranded row going out on its own, with no further user
        // action. Before the flush existed this stayed at 1.
        await pumpUntil("stranded row delivered", () => mockState.cursorSdkSendCalls.length >= 2);
        expect(String(mockState.cursorSdkSendCalls[1]?.promptText ?? ""))
          .toContain("Stranded without the flush.");
      });

      it("refuses to edit or cancel a row while its dispatch is in flight", async () => {
        // The inline dispatch keeps the row in `pendingSteers` across the SDK
        // await and sends the text it read at call time. An edit landing in that
        // window would put text in the transcript the agent never received, and
        // a cancel would clear the chip for a message already on its way.
        const events: AgentChatEventEnvelope[] = [];
        const { service, session } = await startStalledCursorTurn(events);
        const staged = await service.steer({ sessionId: session.id, text: "Do not mutate me." });
        await pumpUntil("staged row", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        // `onCursorSteer` runs INSIDE the mocked steer, which is exactly the
        // window the guard protects.
        const attempts: Promise<unknown>[] = [];
        mockState.onCursorSteer = () => {
          attempts.push(
            service.editSteer({ sessionId: session.id, steerId: staged.steerId, text: "edited" })
              .then(() => "edit-allowed", (error: Error) => error.message),
            service.cancelSteer({ sessionId: session.id, steerId: staged.steerId })
              .then(() => "cancel-allowed", (error: Error) => error.message),
          );
        };

        await service.dispatchSteer({
          sessionId: session.id,
          steerId: staged.steerId,
          mode: "inline",
        });
        const outcomes = await Promise.all(attempts);
        expect(outcomes).toHaveLength(2);
        for (const outcome of outcomes) {
          expect(String(outcome)).toMatch(/already being dispatched/);
        }
        // The delivered text is the text that was staged, not the attempted edit.
        expect(mockState.cursorSdkSteerCalls).toEqual(["Do not mutate me."]);
      });

      it("promotes an already staged row into the live run", async () => {
        const events: AgentChatEventEnvelope[] = [];
        const { service, session } = await startStalledCursorTurn(events);

        const staged = await service.steer({ sessionId: session.id, text: "Staged first." });
        await pumpUntil("staged row", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        const result = await service.dispatchSteer({
          sessionId: session.id,
          steerId: staged.steerId,
          mode: "inline",
        });

        expect(result.dispatchedAt).toBeTypeOf("number");
        expect(mockState.cursorSdkSteerCalls).toEqual(["Staged first."]);
        expect(mockState.cursorSdkSendCalls).toHaveLength(1);
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "inline")).toBe(true);
      });

      it("does not treat a recycled run's steer ack as delivery of a staged row", async () => {
        // Recycle copies `pendingSteers` onto the replacement and kills this
        // run. An ack from the dying run is not ownership on the session that
        // remains — reporting dispatched would drop the only surviving copy.
        const events: AgentChatEventEnvelope[] = [];
        const { service, session } = await startStalledCursorTurn(events);
        const staged = await service.steer({ sessionId: session.id, text: "Keep me once." });
        await pumpUntil("staged row", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        const releaseSteer = parkCursorSteer();
        const dispatching = service.dispatchSteer({
          sessionId: session.id,
          steerId: staged.steerId,
          mode: "inline",
        });
        await pumpUntil("steer in flight", () => mockState.cursorSdkSteerCalls.length >= 1);
        await tripCursorSdkSilenceWatchAndRecycle();
        releaseSteer();
        const result = await dispatching;

        expect(result.dispatchedAt).toBeNull();
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "inline")).toBe(false);
      });

      it("does not treat a recycled run's steer ack as inline on a fresh send", async () => {
        const events: AgentChatEventEnvelope[] = [];
        const { service, session } = await startStalledCursorTurn(events);
        const releaseSteer = parkCursorSteer();
        const sending = service.steer({
          sessionId: session.id,
          text: "Keep me once.",
          dispatchMode: "inline",
        });
        await pumpUntil("steer in flight", () => mockState.cursorSdkSteerCalls.length >= 1);
        await tripCursorSdkSilenceWatchAndRecycle();
        releaseSteer();
        const result = await sending;
        expect(result.queued).toBe(true);
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "inline")).toBe(false);
      });

      it("leaves a promoted row staged when the turn refuses it", async () => {
        const events: AgentChatEventEnvelope[] = [];
        const { service, session } = await startStalledCursorTurn(events);

        const staged = await service.steer({ sessionId: session.id, text: "Stays staged." });
        await pumpUntil("staged row", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));
        mockState.cursorSteerOutcome = "revert_to_followup";

        const result = await service.dispatchSteer({
          sessionId: session.id,
          steerId: staged.steerId,
          mode: "inline",
        });

        // Not dispatched, so the row keeps its place and the turn boundary
        // still owns delivering it.
        expect(result.dispatchedAt).toBeNull();
        expect(noticeTexts(events).some((text) => text.includes("send as a new message"))).toBe(true);
        expect(events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "inline")).toBe(false);
      });
    });

    it("cancels a carried Cursor steer with recycle copy when the re-send cannot start", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      vi.useFakeTimers();
      try {
        // Keep the first send parked. Completing it with a throw is racy with
        // leftover Cursor inline parks: the catch path then cancels the steer
        // as "current turn failed" instead of carrying it through recycle.
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Turn that dies.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);
        await service.steer({ sessionId: session.id, text: "Queued during the outage." });
        await pumpUntil("queued steer", () => events.some((event) =>
          event.event.type === "user_message" && event.event.deliveryState === "queued"));

        // Fail the *next* acquire, armed immediately before recycle so a
        // leftover acquire from the previous test cannot consume the slot.
        mockState.cursorAcquireErrorOnCall = mockState.cursorSdkAcquireCalls.length + 1;
        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("carried steer cancelled", () => events.some((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("recycled the Cursor thread")));

        const cancelNotices = events.filter((event) =>
          event.event.type === "system_notice"
          && typeof event.event.steerId === "string"
          && event.event.message.includes("cancelled"));
        expect(cancelNotices).toHaveLength(1);
        expect(cancelNotices[0]?.event).toMatchObject({
          type: "system_notice",
          message: "Queued message cancelled because ADE recycled the Cursor thread — resend it if still needed.",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("rotates onto a fresh Cursor agent after a restart when the previous thread was abandoned", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      vi.useFakeTimers();
      try {
        // Both attempts go silent, so the terminal path recycles the rotated
        // agent too and arms a rotation for whatever comes next.
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Both attempts go silent.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);
        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("second cursor send", () => mockState.cursorSdkSendCalls.length >= 2);
        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("terminal failure", () => mockState.cursorSdkPoisonCalls.length >= 2);
      } finally {
        vi.useRealTimers();
      }

      const persisted = readPersistedChatState(session.id);
      // The wedged agent id is still on disk (teardown preserves it), so the
      // rotation intent has to be durable too or a restart resumes it.
      expect(persisted.cursorSdkAgentId).toBe("cursor-sdk-agent-1");
      expect(persisted.cursorSdkPendingRotationPreviousAgentId).toBe("cursor-sdk-agent-1");

      // Simulate the restart: a brand-new service reads the same session dir,
      // so the in-memory WeakMap is gone and only the persisted field remains.
      mockState.cursorSendPromptGate = null;
      mockState.cursorSdkAcquireCalls = [];
      mockState.cursorSdkSendCalls = [];
      const { service: restarted } = createService();
      await restarted.sendMessage({
        sessionId: session.id,
        text: "Send after restart.",
      }, { awaitDispatch: true });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(1);
      expect(mockState.cursorSdkAcquireCalls[0]?.agentId).toBeNull();
      // The fresh agent is seeded with the conversation rather than starting cold.
      expect(String(mockState.cursorSdkSendCalls[0]?.promptText ?? ""))
        .toContain("Cursor SDK continuity recovery");
      // One-shot: spent by the rotation it caused.
      expect(readPersistedChatState(session.id).cursorSdkPendingRotationPreviousAgentId).toBeUndefined();
    });

    it("reports the turn once when the Cursor recovery re-send cannot start a runtime", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // Attempt 2 forks a brand-new worker, so a fork/auth failure lands before
      // its own try block — the wrapper owns the terminal set for that path.
      mockState.cursorSendPromptError = new Error("Cursor SDK send failed: [internal] write ECANCELED");
      mockState.cursorAcquireErrorOnCall = 2;
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

      const dispatch = service.sendMessage({
        sessionId: session.id,
        text: "Recovery whose runtime will not start.",
      }, { awaitBackendDispatch: true }).then(() => "resolved", () => "rejected");

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.sessionId === session.id && event.event.type === "done")).toBe(true);
      });
      // The dispatch acknowledgement always settles — no caller is left hanging.
      await expect(dispatch).resolves.toBeDefined();

      // Exactly one terminal set, even though no attempt ever reported one itself.
      expect(events.filter((e) => e.sessionId === session.id && e.event.type === "error")).toHaveLength(1);
      expect(events.filter((e) => e.sessionId === session.id && e.event.type === "done")).toHaveLength(1);
      expect(events.filter((e) =>
        e.sessionId === session.id && e.event.type === "status" && e.event.turnStatus === "failed",
      )).toHaveLength(1);
      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
    });

    it("surfaces the failure once when the Cursor recovery re-send fails during a handoff send", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const terminalCounts = (events: AgentChatEventEnvelope[], sessionId: string) => ({
        errors: events.filter((e) => e.sessionId === sessionId && e.event.type === "error").length,
        done: events.filter((e) => e.sessionId === sessionId && e.event.type === "done").length,
        failed: events.filter((e) =>
          e.sessionId === sessionId && e.event.type === "status" && e.event.turnStatus === "failed").length,
      });
      const runFailingHandoffSend = async (error: Error) => {
        mockState.cursorSendPromptError = error;
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
        // awaitBackendDispatch is the stronger acknowledgement cross-machine
        // handoff and steer replay use: it resolves only from the provider
        // path, so a recovery that swallowed the rethrow left it pending.
        const dispatch = service.sendMessage({
          sessionId: session.id,
          text: "Handoff send.",
        }, { awaitBackendDispatch: true }).then(() => "resolved", () => "rejected");
        await vi.waitFor(() => {
          expect(events.some((e) => e.sessionId === session.id && e.event.type === "done")).toBe(true);
        });
        return { dispatch, counts: terminalCounts(events, session.id) };
      };

      // Baseline: an auth failure is never recoverable, so this is one attempt.
      const baseline = await runFailingHandoffSend(
        Object.assign(new Error("Cursor SDK send failed: unauthorized"), { status: 401 }),
      );
      await expect(baseline.dispatch).resolves.toBe("rejected");
      const baselineSends = mockState.cursorSdkSendCalls.length;

      mockState.cursorSdkSendCalls = [];
      mockState.cursorSdkPoisonCalls = [];
      // Both attempts die on the wire, so the automatic re-send fails too.
      const recovered = await runFailingHandoffSend(
        new Error("Cursor SDK send failed: [internal] write ECANCELED"),
      );

      // It settles rather than hanging — the contract handoff/steer replay need.
      await expect(recovered.dispatch).resolves.toBe("rejected");
      // One recycle and one automatic re-send really did happen...
      expect(baselineSends).toBe(1);
      expect(mockState.cursorSdkSendCalls).toHaveLength(2);
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(1);
      // ...yet the user is told about the failure exactly as many times as if
      // there had been no recovery at all. Two attempts, one report.
      expect(recovered.counts).toEqual(baseline.counts);
    });

    it("still expires the abandoned run when the runtime is evicted between settle and the next send", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const releaseStuckTurn = parkCursorSend();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        permissionMode: "edit",
      });

      try {
        void service.sendMessage({ sessionId: session.id, text: "Turn to abandon." });
        await vi.waitFor(() => {
          expect(mockState.cursorSdkSendCalls).toHaveLength(1);
        });
        await service.dismissPendingInputForSettlement({ sessionId: session.id });
        mockState.cursorSendPromptGate = null;
        // The pending expiry is durable, not just runtime-scoped...
        expect(readPersistedChatState(session.id).cursorSdkForceExpireNextSend).toBe(true);

        // ...which matters because the runtime that observed the abandonment
        // can be torn down (here: a policy change repools it; in the field,
        // idle TTL or budget eviction) while cursorSdkAgentId survives and
        // resumes the very agent still holding the stale run.
        await service.updateSession({ sessionId: session.id, permissionMode: "full-auto" });
        await service.sendMessage({
          sessionId: session.id,
          text: "Send after eviction.",
        }, { awaitDispatch: true });

        expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
        expect(mockState.cursorSdkAcquireCalls[1]?.poolKey).not.toBe(mockState.cursorSdkAcquireCalls[0]?.poolKey);
        expect(mockState.cursorSdkSendCalls).toHaveLength(2);
        expect(mockState.cursorSdkSendCalls[1]?.forceExpireActiveRun).toBe(true);
        // One-shot: consumed on the send that used it.
        expect(readPersistedChatState(session.id).cursorSdkForceExpireNextSend).toBeUndefined();
      } finally {
        releaseStuckTurn();
      }
    });

    it("does not resend after the user interrupts during a Cursor thread recycle", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      // Stop lands while the wedged worker is being cancelled and disposed.
      // One-shot: interrupt() itself cancels, so re-entering would recurse.
      mockState.cursorSendPromptError = new Error("Cursor SDK send failed: [internal] write ECANCELED");
      mockState.onCursorCancel = () => {
        mockState.onCursorCancel = null;
        void service.interrupt({ sessionId: session.id });
      };

      void service.sendMessage({
        sessionId: session.id,
        text: "Interrupted while recycling.",
      }, { awaitDispatch: true }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "done" && event.sessionId === session.id,
        )).toBe(true);
      });

      // The recycle happened, but the re-send did not.
      expect(mockState.cursorSdkPoisonCalls).toHaveLength(1);
      expect(mockState.cursorSdkSendCalls).toHaveLength(1);
      const done = events.filter((event) =>
        event.sessionId === session.id && event.event.type === "done",
      );
      expect(done).toHaveLength(1);
      expect(done[0]?.event).toMatchObject({ type: "done", status: "interrupted" });
    });

    it("rotates onto a fresh Cursor agent and resends once when a run goes silent", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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
      await service.sendMessage({
        sessionId: session.id,
        text: "First Cursor turn.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(session.status).toBe("idle");
      });
      const acquiresBefore = mockState.cursorSdkAcquireCalls.length;
      const poisonedPooled = mockState.cursorSdkPooled;

      vi.useFakeTimers();
      try {
        // The wedged thread: the send never settles and no worker event lands.
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Second Cursor turn.",
        }, { awaitDispatch: true });
        await pumpUntil("second cursor send", () => mockState.cursorSdkSendCalls.length >= 2);
        expect(mockState.cursorSdkSendCalls).toHaveLength(2);
        // The retry must run against a healthy worker.
        mockState.cursorSendPromptGate = null;

        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("recovery re-send", () => mockState.cursorSdkSendCalls.length >= 3);

        expect(mockState.cursorSdkPoisonCalls).toHaveLength(1);
        expect(poisonedPooled.cancel).toHaveBeenCalled();
        expect(mockState.cursorSdkAcquireCalls).toHaveLength(acquiresBefore + 1);
        // A fresh agent, not a resume of the wedged one.
        expect(mockState.cursorSdkAcquireCalls.at(-1)?.agentId).toBeNull();
        const resent = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
        expect(resent).toContain("Cursor SDK continuity recovery");
        expect(resent).toContain("Second Cursor turn.");
        // Only the recovery re-send may expire a stuck active run.
        expect(mockState.cursorSdkSendCalls.at(-1)?.forceExpireActiveRun).toBe(true);
        expect(mockState.cursorSdkSendCalls[0]?.forceExpireActiveRun).toBeUndefined();
        expect(mockState.cursorSdkSendCalls[1]?.forceExpireActiveRun).toBeUndefined();
        // The retry must not duplicate the user bubble.
        expect(events.filter((event) =>
          event.sessionId === session.id
          && event.event.type === "user_message",
        )).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails the turn with a fresh-thread message when the rotated Cursor agent is also silent", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
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

      vi.useFakeTimers();
      try {
        parkCursorSend();
        void service.sendMessage({
          sessionId: session.id,
          text: "Both attempts go silent.",
        }, { awaitDispatch: true }).catch(() => undefined);
        await pumpUntil("first cursor send", () => mockState.cursorSdkSendCalls.length >= 1);

        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("second cursor send", () => mockState.cursorSdkSendCalls.length >= 2);
        await tripCursorSdkSilenceWatchAndRecycle();
        await pumpUntil("terminal error event", () => events.some((event) => event.event.type === "error"));

        const errorEvent = events.find((event) =>
          event.sessionId === session.id && event.event.type === "error",
        );
        expect(errorEvent?.event).toMatchObject({
          type: "error",
          message: "Cursor stopped responding. ADE opened a fresh Cursor thread — try sending again.",
          errorInfo: { category: "network" },
        });
        // Exactly one automatic re-send: two sends, no third.
        expect(mockState.cursorSdkSendCalls).toHaveLength(2);
        // Both wedged threads are recycled — the second without a re-send — so
        // the next user send starts fresh, as the error copy promises.
        expect(mockState.cursorSdkPoisonCalls).toHaveLength(2);
        // Exactly one terminal report for the turn.
        expect(events.filter((event) =>
          event.sessionId === session.id && event.event.type === "error",
        )).toHaveLength(1);
        expect(events.filter((event) =>
          event.sessionId === session.id && event.event.type === "done",
        )).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reacquires Cursor SDK workers that exited before a follow-up turn", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "First Cursor turn.",
      });
      const firstPooled = mockState.cursorSdkPooled;
      firstPooled.process.exitCode = 1;

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Follow-up after worker exit.",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
      expect(firstPooled.sendPrompt).toHaveBeenCalledTimes(1);
      expect(mockState.cursorSdkPooled).not.toBe(firstPooled);
      expect(mockState.cursorSdkPooled.sendPrompt).toHaveBeenCalledTimes(1);
    });

    it("keeps Cursor SDK state stable when policy changes require a new worker pool", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        permissionMode: "edit",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "First Cursor turn.",
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Follow-up after policy change.",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
      const firstAcquire = mockState.cursorSdkAcquireCalls[0];
      const secondAcquire = mockState.cursorSdkAcquireCalls[1];
      expect(secondAcquire.poolKey).not.toBe(firstAcquire.poolKey);
      expect(secondAcquire.stateKey).toBe(firstAcquire.stateKey);
    });

    it("replays the full transcript when Cursor SDK resume opens a new agent", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the mobile files tab parity work.",
      });
      const firstPooled = mockState.cursorSdkPooled;
      firstPooled.process.exitCode = 1;
      mockState.cursorSdkAgentIdForNextAcquire = "cursor-sdk-agent-2";

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Did you finish the prior work?",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
      expect(mockState.cursorSdkAcquireCalls[1]).toEqual(
        expect.objectContaining({ agentId: "cursor-sdk-agent-1" }),
      );
      const promptText = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(promptText).toContain("Cursor SDK continuity recovery");
      expect(promptText).toContain("cursor-sdk-agent-1");
      expect(promptText).toContain("cursor-sdk-agent-2");
      // The rotated agent gets the whole conversation replayed verbatim, not a
      // 20-line tail.
      expect(promptText).toContain("verbatim replay");
      expect(promptText).not.toContain("Recent Conversation Tail");
      expect(promptText).toContain("Inspect the mobile files tab parity work.");
      expect(promptText).toContain("Did you finish the prior work?");
      // Prompts are prepared before the runtime is acquired, so the rotation
      // turn itself stays deduped — but the rotated agent is brand new, so the
      // lane execution directive must be re-emitted on the following turn
      // instead of staying suppressed by lastLaneDirectiveKey.
      expect(promptText).not.toContain("[ADE launch directive]");
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Continue with the next step.",
      });
      const postRotationPrompt = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(postRotationPrompt).toContain("[ADE launch directive]");
      // One staged replay, consumed exactly once: the rotation stage is durable,
      // so a turn that did not trigger a rotation must not replay it again.
      expect(postRotationPrompt).not.toContain("verbatim replay");
      expect(postRotationPrompt).not.toContain("Cursor SDK continuity recovery");
    });

    it("recreates the Cursor SDK agent with recovery context when resume state is missing", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the runtime compaction lane crash.",
      });
      const firstPooled = mockState.cursorSdkPooled;
      firstPooled.process.exitCode = 1;
      mockState.cursorSdkAgentIdForNextAcquire = "cursor-sdk-agent-2";
      vi.mocked(acquireCursorSdkConnection).mockImplementationOnce(async (args: Record<string, unknown>) => {
        mockState.cursorSdkAcquireCalls.push(args);
        throw Object.assign(
          new Error("Agent cursor-sdk-agent-1 not found (operation=Agent.resume)"),
          {
            code: "agent_not_found",
            cursorSdk: {
              code: "agent_not_found",
              message: "Agent cursor-sdk-agent-1 not found",
              operation: "Agent.resume",
            },
          },
        );
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Did the SDK resume bug come back?",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(3);
      expect(mockState.cursorSdkAcquireCalls[1]).toEqual(
        expect.objectContaining({ agentId: "cursor-sdk-agent-1" }),
      );
      expect(mockState.cursorSdkAcquireCalls[2]).toEqual(
        expect.objectContaining({ agentId: null }),
      );
      const promptText = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(promptText).toContain("Cursor SDK continuity recovery");
      expect(promptText).toContain("cursor-sdk-agent-1");
      expect(promptText).toContain("cursor-sdk-agent-2");
      expect(promptText).toContain("verbatim replay");
      expect(promptText).not.toContain("Recent Conversation Tail");
      expect(promptText).toContain("Inspect the runtime compaction lane crash.");
      expect(promptText).toContain("Did the SDK resume bug come back?");
    });

    it("reports active Droid SDK turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let finishTurn = () => {};
      mockState.droidPromptGate = new Promise<void>((resolve) => { finishTurn = resolve; });
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Droid turn alive during a project switch.",
        }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(mockState.droidPromptCalls.length).toBeGreaterThan(0);
        });
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("does not treat an idle reusable Claude query as an active workload", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-claude",
            slash_commands: [],
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-idle-claude",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-idle-claude",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Complete a short turn.",
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done"
          && event.event.status === "completed",
      );

      expect(service.hasActiveWorkloads()).toBe(false);
    });

    describe("runSessionTurn limits", () => {
      const codexTurnStarts = (): number => mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;

      /** Start a headless Codex turn that is busy running one command; `outcome()` is null while it waits. */
      const startTurnRunningCommand = async (
        service: any,
        args: { sessionId: string; timeoutMs: number | null; idleTimeoutMs: number | null },
      ) => {
        const startsBefore = codexTurnStarts();
        let outcome: string | null = null;
        const turn = service.runSessionTurn({ ...args, text: "Wait on CI." });
        turn.then(() => { outcome = "resolved"; }, (error: Error) => { outcome = error.message; });
        await vi.waitFor(() => expect(codexTurnStarts()).toBeGreaterThan(startsBefore));
        const turnId = `turn-${mockState.codexTurnCounter}`;
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { turn: { id: turnId, status: "inProgress" } },
        });
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "item/started",
          params: {
            turnId,
            item: { id: "cmd-ci", type: "commandExecution", command: "gh run watch", cwd: "/tmp", status: "inProgress", commandActions: [] },
          },
        });
        return { turnId, outcome: () => outcome };
      };

      it("stops a turn that goes quiet, but never while a command is still running", async () => {
        const { service } = createService();
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const { turnId, outcome } = await startTurnRunningCommand(service, {
            sessionId: session.id,
            timeoutMs: null,
            idleTimeoutMs: 60_000,
          });

          // A 40-minute CI wait is one open command, not idleness.
          await vi.advanceTimersByTimeAsync(40 * 60_000);
          expect(outcome()).toBeNull();

          mockState.emitCodexPayload({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              turnId,
              item: {
                id: "cmd-ci",
                type: "commandExecution",
                command: "gh run watch",
                cwd: "/tmp",
                status: "completed",
                aggregatedOutput: "ok",
                exitCode: 0,
                commandActions: [],
              },
            },
          });
          await vi.advanceTimersByTimeAsync(59_000);
          expect(outcome()).toBeNull();

          const interruptsBefore = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt").length;
          await vi.advanceTimersByTimeAsync(2_000);
          expect(outcome()).toMatch(/Stopped after 1 min with no activity/);
          await vi.waitFor(() => {
            expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt").length)
              .toBeGreaterThan(interruptsBefore);
          });
        } finally {
          vi.useRealTimers();
          service.forceDisposeAll();
        }
      });

      it("counts provider retries as activity, so a retrying turn is not stopped as idle", async () => {
        const { service } = createService();
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const startsBefore = codexTurnStarts();
          let outcome: string | null = null;
          service.runSessionTurn({ sessionId: session.id, text: "Ship it.", timeoutMs: null, idleTimeoutMs: 60_000 })
            .then(() => { outcome = "resolved"; }, (error: Error) => { outcome = error.message; });
          await vi.waitFor(() => expect(codexTurnStarts()).toBeGreaterThan(startsBefore));
          const turnId = `turn-${mockState.codexTurnCounter}`;
          mockState.emitCodexPayload({
            jsonrpc: "2.0",
            method: "turn/started",
            params: { turn: { id: turnId, status: "inProgress" } },
          });

          // Retry activity is live-only; every 40 s it must restart the 60 s watch.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await vi.advanceTimersByTimeAsync(40_000);
            mockState.emitCodexPayload({
              jsonrpc: "2.0",
              method: "error",
              params: { turnId, willRetry: true, error: { message: "Temporary upstream failure.", codexErrorInfo: "serverOverloaded" } },
            });
          }
          await vi.advanceTimersByTimeAsync(40_000);
          expect(outcome).toBeNull();

          // A late retry from an earlier turn is not this turn's activity.
          mockState.emitCodexPayload({
            jsonrpc: "2.0",
            method: "error",
            params: { turnId: "turn-stale", willRetry: true, error: { message: "Temporary upstream failure.", codexErrorInfo: "serverOverloaded" } },
          });
          await vi.advanceTimersByTimeAsync(21_000);
          expect(outcome).toMatch(/with no activity/);
        } finally {
          vi.useRealTimers();
          service.forceDisposeAll();
        }
      });

      it("applies no clock at all when the caller asks for none", async () => {
        const { service } = createService();
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const { turnId, outcome } = await startTurnRunningCommand(service, {
            sessionId: session.id,
            timeoutMs: null,
            idleTimeoutMs: null,
          });

          // Well past the old 5-minute headless default and the old 20-minute rule cap.
          await vi.advanceTimersByTimeAsync(90 * 60_000);
          expect(outcome()).toBeNull();

          mockState.emitCodexPayload({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { turn: { id: turnId, status: "completed" } },
          });
          await vi.waitFor(() => expect(outcome()).toBe("resolved"));
        } finally {
          vi.useRealTimers();
          service.forceDisposeAll();
        }
      });

      it("releases a waiting turn when its chat session ends, as an abandoned turn", async () => {
        const { service } = createService();
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
        const startsBefore = codexTurnStarts();
        const turn = service.runSessionTurn({ sessionId: session.id, text: "Long job.", timeoutMs: null });
        const settled = turn.then(() => null, (error: unknown) => error);
        await vi.waitFor(() => expect(codexTurnStarts()).toBeGreaterThan(startsBefore));
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { turn: { id: `turn-${mockState.codexTurnCounter}`, status: "inProgress" } },
        });

        try {
          await service.dispose({ sessionId: session.id });

          // Without the release a caller with no clock (an automation) waits forever.
          const error = await settled;
          expect(error).toBeInstanceOf(SessionTurnAbandonedError);
          expect((error as Error).message).toMatch(/ended before the turn finished/);
        } finally {
          service.forceDisposeAll();
        }
      });
    });

    describe("auto-resume after a provider usage limit resets", () => {
      /**
       * Drives one Codex turn to a usage-limit failure. `resetAt` is the reset
       * instant the provider publishes through `account/rateLimits/updated`;
       * `null` models a provider that reports no reset time at all.
       */
      const codexTurnStarts = (): number => mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;

      const waitForNextCodexTurnStart = async (startsBefore: number): Promise<void> => {
        await vi.waitFor(() => {
          expect(codexTurnStarts()).toBeGreaterThan(startsBefore);
        }, { timeout: 5_000, interval: 10 });
      };

      const failCodexTurnAtUsageLimit = (turnId: string, resetAt: string | null): void => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { turn: { id: turnId, status: "inProgress" } },
        });
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "account/rateLimits/updated",
          params: { rateLimits: { remaining: 0, limit: 100, resetAt } },
        });
        const error = {
          message: "You've hit your usage limit.",
          codexErrorInfo: "usageLimitReached",
        };
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "error",
          params: { turnId, error, willRetry: false },
        });
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { turn: { id: turnId, status: "failed", error } },
        });
      };

      const completeCodexTurn = (turnId: string): void => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { turn: { id: turnId, status: "inProgress" } },
        });
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { turn: { id: turnId, status: "completed" } },
        });
      };

      const failTurnAtUsageLimit = async (
        service: any,
        sessionId: string,
        turnId: string,
        resetAt: string | null,
      ): Promise<void> => {
        const turnStartsBefore = codexTurnStarts();
        const turn = service.runSessionTurn({ sessionId, text: "Ship the fix." });
        await waitForNextCodexTurnStart(turnStartsBefore);
        failCodexTurnAtUsageLimit(turnId, resetAt);
        await turn;
      };

      /**
       * A reset instant whose armed fire time lands `inMs` from now, once the
       * 90s anti-race buffer is added. Tests that need the resume to actually
       * fire have to arm against a window that is nearly over — the buffer is
       * the whole reason a fresh reset instant is minutes away, not seconds.
       */
      const resetFiringIn = (inMs: number): string =>
        new Date(Date.now() - 90_000 + inMs).toISOString();

      /**
       * A scheduled-work store whose load blocks until the test releases it.
       *
       * Both halves of the arm/cancel race only exist while the scheduler has
       * no rows: an arm parked on `scheduledWorkReady` has not written its row
       * yet, and a booting brain has not read the durable one back yet. Holding
       * `loadState` open is the only way to stand in that window on purpose
       * instead of hoping a sleep lands inside it.
       */
      const createBootGatedScheduledWorkDb = () => {
        const backing = createScheduledWorkDb();
        let releaseBoot!: () => void;
        const booted = new Promise<void>((resolve) => { releaseBoot = resolve; });
        return {
          db: {
            ...backing.db,
            getJson: (key: string) => (key === SCHEDULED_WORK_STATE_KEY
              // Read on release, not on call, so the test can seed the durable
              // row after it knows the session id.
              ? booted.then(() => backing.db.getJson(key))
              : backing.db.getJson(key)),
          },
          seed: (state: ChatScheduledWorkState) => {
            backing.db.setJson(SCHEDULED_WORK_STATE_KEY, state);
          },
          readState: backing.readState,
          releaseBoot: () => releaseBoot(),
        };
      };

      it("cancels an auto-resume that was arming when the user sent a message", async () => {
        const scheduledWork = createBootGatedScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-arming",
          new Date(Date.now() + 30 * 60_000).toISOString(),
        );
        // The failure event is what starts the arm, so this is the point after
        // which the arm is parked on the scheduler with no row written yet.
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope => event.event.type === "error",
        );
        // The user gets there first. A sweep now finds nothing to cancel — the
        // row it is looking for is still in flight behind the scheduler.
        await service.sendMessage({
          sessionId: session.id,
          text: "Never mind, I'll drive this myself.",
        });

        scheduledWork.releaseBoot();

        // The row really was created and then undone — asserting only that
        // nothing is pending would pass before the arm had even written it.
        await vi.waitFor(() => {
          expect(scheduledWork.readState()?.schedules).toEqual([
            expect.objectContaining({
              id: `auto-resume:${session.id}`,
              source: "auto_resume_limit",
              status: "cancelled",
            }),
          ]);
        });
        expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
      });

      it("resumeUsageLimitNow restores everything when the send fails after the commit point", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-late-fail",
          new Date(Date.now() + 30 * 60_000).toISOString(),
        );
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });
        const armed = (await service.getSessionSummary(session.id))?.usageLimitResume;
        expect(armed).toMatchObject({ state: "armed" });

        // The turn fails INSIDE the dispatch commit point — past the place the
        // ordinary user-message sweep runs, before the provider acknowledges
        // anything. That sweep must skip this send: it is the resume's own
        // prompt, whose cancellation this path already issued and awaited, and
        // a second cancel there would move the epoch the undo below depends on.
        mockState.codexResponseOverrides.set("turn/start", () => ({
          error: { code: -32000, message: "codex app-server is gone" },
        }));
        await expect(service.resumeUsageLimitNow({ sessionId: session.id }))
          .rejects.toThrow();
        mockState.codexResponseOverrides.delete("turn/start");

        // Everything the manual resume borrowed comes back.
        const restored = await service.getSessionSummary(session.id);
        expect(restored?.usageLimitResume).toMatchObject({
          state: "armed",
          fireAt: armed?.fireAt,
          scheduleId: `auto-resume:${session.id}`,
          attempts: 1,
        });
        expect(restored?.usageLimitParkedUntil).toBe(armed?.fireAt);
        const rows = await service.listScheduledWork({ sessionId: session.id });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: `auto-resume:${session.id}`,
          status: "scheduled",
          nextRunAt: armed?.fireAt,
        });
        // Including the streak: the arm already spent still counts against the
        // two-arm cap, so the resume the scheduler fires next is the last one.
        expect(events.filter((event) =>
          event.event.type === "system_notice"
          && typeof event.event.message === "string"
          && /^Resumes at /.test(event.event.message))).toHaveLength(1);
      });

      it("Run next on the manual-resume turn cancels the pending row", async () => {
        installRealTranscriptParser();
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        // A staged copy of the continue prompt Resume now sends, left
        // unprocessed when its turn was aborted. Its metadata is the host's own
        // dispatch marker, and a replay of it is NOT that host path.
        await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });
        const staged = await service.steer({
          sessionId: session.id,
          text: "The provider usage limit has reset. Continue the interrupted task.",
          metadata: { usageLimitResume: "manual" },
        });
        mockState.emitCodexPayload({ method: "turn/aborted", params: { turnId: "turn-1" } });
        await vi.waitFor(() => {
          expect(events.some((entry) =>
            entry.event.type === "user_message"
            && entry.event.steerId === staged.steerId
            && entry.event.deliveryState === "unprocessed")).toBe(true);
        });

        // Arm a resume, so the replay below has a row to cancel.
        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-run-next",
          new Date(Date.now() + 30 * 60_000).toISOString(),
        );
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        await service.resolveUnprocessedMessage({
          sessionId: session.id,
          steerId: staged.steerId,
          action: "run_next",
        });

        // The replay is ordinary user activity: it must sweep the resume away
        // rather than inherit the exemption and leave a row that fires an
        // unattended prompt later.
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        });
        const replayed = events.findLast((entry) =>
          entry.event.type === "user_message"
          && (entry.event as any).metadata?.replayedFromUnprocessedSteer);
        expect((replayed?.event as any)?.metadata?.usageLimitResume).toBeUndefined();
      });

      it("cancels a durable auto-resume during scheduler boot", async () => {
        const scheduledWork = createBootGatedScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });
        // A row armed before the last restart, still on disk, not yet loaded.
        scheduledWork.seed({
          version: 1,
          schedules: [{
            id: `auto-resume:${session.id}`,
            sessionId: session.id,
            kind: "wakeup",
            prompt: "Continue the interrupted task from where it stopped.",
            reason: "Auto-resume after usage limit reset",
            fireAt: Date.now() + 30 * 60_000,
            createdAt: Date.now() - 60_000,
            status: "scheduled",
            pausedFlag: false,
            lateFlag: false,
            durable: true,
            source: "auto_resume_limit",
          }],
          pausedSessionIds: [],
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "I'm back, taking this over.",
        });

        scheduledWork.releaseBoot();

        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        });
        expect(scheduledWork.readState()?.schedules).toEqual([
          expect.objectContaining({
            id: `auto-resume:${session.id}`,
            status: "cancelled",
          }),
        ]);
      });

      it("stops re-arming after two consecutive auto-resume failures", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        // The cap only counts resumes that actually ran and died at the limit
        // again, so this drives the real trip path: every failure after the
        // first one belongs to a turn the scheduler itself dispatched. Claude's
        // snapshot is session-scoped and `mergeSnapshot` carries a stale reset
        // forward, so a limit the resume cannot clear still publishes a fresh
        // reset instant on every cycle; Codex's rolling window models that here.
        await failTurnAtUsageLimit(service, session.id, "turn-cap-1", resetFiringIn(400));

        const firstResumeStarts = codexTurnStarts();
        await waitForNextCodexTurnStart(firstResumeStarts);
        failCodexTurnAtUsageLimit("turn-cap-2", resetFiringIn(400));

        const secondResumeStarts = codexTurnStarts();
        await waitForNextCodexTurnStart(secondResumeStarts);
        failCodexTurnAtUsageLimit("turn-cap-3", resetFiringIn(400));

        const paused = await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "system_notice"
            && typeof event.event.message === "string"
            && event.event.message === "Paused after 2 tries",
        );
        expect(paused.event).toMatchObject({ noticeKind: "rate_limit", severity: "info" });
        // The notice explains the failure, so it has to be committed after it.
        // The cap check runs from inside the error's own commit, before that
        // event has minted its sequence, so an inline emit would number the
        // notice below the error and render it above.
        const lastLimitError = [...events].reverse().find((event) =>
          event.event.type === "error"
          && typeof event.event.message === "string"
          && event.event.message.includes("usage limit"));
        expect(lastLimitError?.sequence).toEqual(expect.any(Number));
        expect(paused.sequence ?? -1).toBeGreaterThan(lastLimitError?.sequence ?? 0);

        // Three failures, two arms: the third window is never armed, so no
        // further turn is spent on a limit that is not lifting.
        expect(events.filter((event) =>
          event.event.type === "system_notice"
          && typeof event.event.message === "string"
          && /^Resumes at /.test(event.event.message)))
          .toHaveLength(2);
        const [afterCap] = await service.listScheduledWork({ sessionId: session.id });
        expect(afterCap?.status).toBe("fired");

        // A user message is the intervening event that clears the streak, so
        // the next limit arms again rather than staying paused forever.
        await vi.waitFor(() => {
          expect(service.hasActiveWorkloads()).toBe(false);
        }, { timeout: 5_000, interval: 10 });
        const userTurnStarts = codexTurnStarts();
        await service.sendMessage({ sessionId: session.id, text: "Try again now." });
        await waitForNextCodexTurnStart(userTurnStarts);
        completeCodexTurn("turn-cap-user");

        const nextResetMs = Date.now() + 150 * 60_000;
        await failTurnAtUsageLimit(
          service, session.id, "turn-cap-4", new Date(nextResetMs).toISOString(),
        );
        await vi.waitFor(async () => {
          const [next] = await service.listScheduledWork({ sessionId: session.id });
          expect(Date.parse(next?.nextRunAt ?? "")).toBe(nextResetMs + 90_000);
        }, { timeout: 5_000, interval: 10 });
      });

      it("a successful auto-resume resets the streak", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        // Walk the chat right up to the cap, then let a resume actually work.
        await failTurnAtUsageLimit(service, session.id, "streak-1", resetFiringIn(400));
        const firstResumeStarts = codexTurnStarts();
        await waitForNextCodexTurnStart(firstResumeStarts);
        failCodexTurnAtUsageLimit("streak-2", resetFiringIn(400));

        const secondResumeStarts = codexTurnStarts();
        await waitForNextCodexTurnStart(secondResumeStarts);
        completeCodexTurn("streak-resume-ok");

        // The next limit arrives on another scheduled turn, so nothing in
        // between clears the streak by hand — only the successful resume can.
        // A fired resume always carries `scheduledWake`, which is exactly what
        // the dispatch sweep skips, so without the completion hook this chat
        // would still be holding two failed arms and would pause itself here
        // instead of scheduling a third resume.
        await vi.waitFor(() => {
          expect(service.hasActiveWorkloads()).toBe(false);
        }, { timeout: 5_000, interval: 10 });
        const wakeupStarts = codexTurnStarts();
        await service.createScheduledWork({
          sessionId: session.id,
          runAt: new Date(Date.now() + 300).toISOString(),
          prompt: "Pick the task back up.",
          reason: "Follow-up",
        });
        await waitForNextCodexTurnStart(wakeupStarts);
        const laterResetMs = Date.now() + 60 * 60_000;
        failCodexTurnAtUsageLimit("streak-3", new Date(laterResetMs).toISOString());

        await vi.waitFor(async () => {
          const rows = await service.listScheduledWork({ sessionId: session.id });
          const resume = rows.find((row: { id: string }) => row.id === `auto-resume:${session.id}`);
          expect(Date.parse(resume?.nextRunAt ?? "")).toBe(laterResetMs + 90_000);
        }, { timeout: 5_000, interval: 10 });
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && typeof event.event.message === "string"
          && event.event.message === "Paused after 2 tries")).toBe(false);
      });

      it("explicit cancel wins over an in-flight arm", async () => {
        const scheduledWork = createBootGatedScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });
        // A durable row from before the last restart, so Chat info has
        // something to offer Cancel for while this process is still booting the
        // scheduler — and while the fresh arm below is parked behind it.
        scheduledWork.seed({
          version: 1,
          schedules: [{
            id: `auto-resume:${session.id}`,
            sessionId: session.id,
            kind: "wakeup",
            prompt: "Continue the interrupted task from where it stopped.",
            reason: "Auto-resume after usage limit reset",
            fireAt: Date.now() + 30 * 60_000,
            createdAt: Date.now() - 60_000,
            status: "scheduled",
            pausedFlag: false,
            lateFlag: false,
            durable: true,
            source: "auto_resume_limit",
          }],
          pausedSessionIds: [],
        });

        // Both the dismissal and the arm below park behind the booting
        // scheduler, and the dismissal parked first, so it is the one that runs
        // first on release — the arm's upsert lands on an already-cancelled row
        // and its `scheduled` status would otherwise win, resurrecting exactly
        // the row the user just dismissed.
        const dismissal = service.cancelScheduledWork({
          sessionId: session.id,
          scheduleId: `auto-resume:${session.id}`,
        });
        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-dismissed",
          new Date(Date.now() + 45 * 60_000).toISOString(),
        );
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope => event.event.type === "error",
        );

        scheduledWork.releaseBoot();
        await dismissal;

        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        }, { timeout: 5_000, interval: 10 });
        expect(scheduledWork.readState()?.schedules).toEqual([
          expect.objectContaining({
            id: `auto-resume:${session.id}`,
            status: "cancelled",
          }),
        ]);
      });

      it("an empty send leaves a pending auto-resume armed", async () => {
        const scheduledWork = createScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-empty-send",
          new Date(Date.now() + 30 * 60_000).toISOString(),
        );
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        }, { timeout: 5_000, interval: 10 });

        // A send that never becomes a turn is not the user taking over.
        await service.sendMessage({ sessionId: session.id, text: "   " });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
      });

      it("schedules a tagged auto-resume when the usage limit reports a reset time", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });
        const resetAtMs = Date.now() + 30 * 60_000;

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-1",
          new Date(resetAtMs).toISOString(),
        );

        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });
        const [schedule] = await service.listScheduledWork({ sessionId: session.id });
        expect(schedule).toMatchObject({
          id: `auto-resume:${session.id}`,
          sessionId: session.id,
          kind: "wakeup",
          status: "scheduled",
          source: "auto_resume_limit",
          durable: true,
        });
        expect(schedule.prompt).toContain("Continue the interrupted task from where it stopped");
        // Reset instant plus the 90s buffer, so the resume never races the reset.
        expect(Date.parse(schedule.nextRunAt ?? "")).toBe(resetAtMs + 90_000);
        // The tag survives a brain restart alongside the rest of the row.
        expect(scheduledWork.readState()?.schedules).toEqual([
          expect.objectContaining({
            id: `auto-resume:${session.id}`,
            source: "auto_resume_limit",
            fireAt: resetAtMs + 90_000,
          }),
        ]);

        const notice = await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "system_notice"
            && typeof event.event.message === "string"
            && /^Resumes at /.test(event.event.message),
        );
        expect(notice.event).toMatchObject({ noticeKind: "rate_limit", severity: "info" });
      });

      it("schedules no auto-resume when the usage limit reports no reset time", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await failTurnAtUsageLimit(service, session.id, "turn-limit-noreset", null);

        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope => event.event.type === "error",
        );
        expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && typeof event.event.message === "string"
          && /^Resumes at /.test(event.event.message))).toBe(false);
      });

      it("replaces the pending auto-resume instead of stacking on a repeat usage limit", async () => {
        const scheduledWork = createScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });
        const firstResetMs = Date.now() + 30 * 60_000;
        const secondResetMs = Date.now() + 90 * 60_000;

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-a",
          new Date(firstResetMs).toISOString(),
        );
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-b",
          new Date(secondResetMs).toISOString(),
        );
        await vi.waitFor(async () => {
          const [schedule] = await service.listScheduledWork({ sessionId: session.id });
          expect(Date.parse(schedule?.nextRunAt ?? "")).toBe(secondResetMs + 90_000);
        });
        expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
      });

      it("cancels the pending auto-resume when the user sends a message", async () => {
        const scheduledWork = createScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-user",
          new Date(Date.now() + 30 * 60_000).toISOString(),
        );
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Never mind, I'll drive this myself.",
        });

        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        });
      });

      it("leaves user-created scheduled work untouched when it cancels an auto-resume", async () => {
        const scheduledWork = createScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });
        const userSchedule = await service.createScheduledWork({
          sessionId: session.id,
          delaySeconds: 3_600,
          prompt: "Check CI in an hour.",
          reason: "CI watcher",
        });

        await failTurnAtUsageLimit(
          service,
          session.id,
          "turn-limit-scoped",
          new Date(Date.now() + 30 * 60_000).toISOString(),
        );
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(2);
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Taking over manually.",
        });

        await vi.waitFor(async () => {
          const remaining = await service.listScheduledWork({ sessionId: session.id });
          expect(remaining.map((item: { id: string }) => item.id)).toEqual([userSchedule.item.id]);
        });
        const [survivor] = await service.listScheduledWork({ sessionId: session.id });
        expect(survivor.source).toBeUndefined();
      });
    });

    it("creates durable recurring and one-shot scheduled work and validates inputs and session state", async () => {
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      });

      const recurring = await service.createScheduledWork({
        sessionId: session.id,
        cron: "9,29,49 * * * *",
        prompt: "  Check CI and report.  ",
        reason: " CI watcher ",
      });
      const oneShot = await service.createScheduledWork({
        sessionId: session.id,
        cron: "15 10 * * 1",
        prompt: "Prepare the weekly report.",
        recurring: false,
      });
      const relativeOneShotCreatedAt = Date.now();
      const relativeOneShot = await service.createScheduledWork({
        sessionId: session.id,
        delaySeconds: 720,
        prompt: "Check CI in twelve minutes.",
      });
      const absoluteRunAt = "2100-01-02T03:04:05.000-05:00";
      const absoluteOneShot = await service.createScheduledWork({
        sessionId: session.id,
        runAt: absoluteRunAt,
        prompt: "Run at an explicit instant.",
      });

      expect(recurring.item).toMatchObject({
        id: `action:${session.id}:test-uuid-2`,
        sessionId: session.id,
        kind: "cron",
        status: "scheduled",
        prompt: "Check CI and report.",
        reason: "CI watcher",
        cron: "9,29,49 * * * *",
        durable: true,
      });
      expect(recurring.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(oneShot.item).toMatchObject({
        id: `action:${session.id}:test-uuid-3`,
        kind: "wakeup",
        status: "scheduled",
        durable: true,
      });
      expect(relativeOneShot.item).toMatchObject({
        id: `action:${session.id}:test-uuid-4`,
        kind: "wakeup",
        status: "scheduled",
        durable: true,
      });
      expect(Date.parse(relativeOneShot.item.nextRunAt ?? "")).toBeGreaterThanOrEqual(
        relativeOneShotCreatedAt + 720_000,
      );
      expect(absoluteOneShot.item).toMatchObject({
        id: `action:${session.id}:test-uuid-5`,
        kind: "wakeup",
        nextRunAt: new Date(absoluteRunAt).toISOString(),
        durable: true,
      });
      expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([
        recurring.item,
        oneShot.item,
        relativeOneShot.item,
        absoluteOneShot.item,
      ]);
      const storedSchedules = scheduledWork.readState()?.schedules ?? [];
      expect(storedSchedules).toEqual([
        expect.objectContaining({
          id: recurring.item.id,
          kind: "cron",
          expiresAt: expect.any(Number),
        }),
        expect.objectContaining({
          id: oneShot.item.id,
          kind: "wakeup",
        }),
        expect.objectContaining({
          id: relativeOneShot.item.id,
          kind: "wakeup",
          fireAt: expect.any(Number),
        }),
        expect.objectContaining({
          id: absoluteOneShot.item.id,
          kind: "wakeup",
          fireAt: Date.parse(absoluteRunAt),
        }),
      ]);
      expect(storedSchedules[0]?.provider).toBeUndefined();
      expect(storedSchedules[1]?.provider).toBeUndefined();
      expect(storedSchedules[1]?.expiresAt).toBeUndefined();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.id,
          event: expect.objectContaining({
            type: "scheduled_work_update",
            id: recurring.item.id,
            origin: "action",
            status: "scheduled",
          }),
        }),
      ]));

      await service.setScheduledWorkPaused({ sessionId: session.id, paused: true });
      const pausedCreate = await service.createScheduledWork({
        sessionId: session.id,
        cron: "0 * * * *",
        prompt: "Wait until scheduling resumes.",
      });
      expect(pausedCreate.item.status).toBe("paused");
      const pausedCreateEvents = events.filter((envelope) =>
        envelope.event.type === "scheduled_work_update"
        && envelope.event.id === pausedCreate.item.id
      );
      expect(pausedCreateEvents.at(-1)?.event).toEqual(expect.objectContaining({
        status: "paused",
        nextRunAt: expect.any(String),
      }));

      await expect(service.createScheduledWork({
        sessionId: session.id,
        cron: "not a cron",
        prompt: "Check CI.",
      })).rejects.toThrow(/cron.*valid 5-field cron.*local timezone/i);
      await expect(service.createScheduledWork({
        sessionId: session.id,
        cron: "0 * * * *",
        delaySeconds: 60,
        prompt: "Ambiguous schedule.",
      } as unknown as AgentChatCreateScheduledWorkArgs)).rejects.toThrow(/exactly one of cron, runAt, or delaySeconds/i);
      await expect(service.createScheduledWork({
        sessionId: session.id,
        runAt: "2100-01-02T03:04:05",
        prompt: "Missing timezone.",
      })).rejects.toThrow(/explicit offset or Z/i);
      await expect(service.createScheduledWork({
        sessionId: session.id,
        runAt: "2000-01-02T03:04:05Z",
        prompt: "Past timestamp.",
      })).rejects.toThrow(/valid future timestamp/i);
      await expect(service.createScheduledWork({
        sessionId: session.id,
        delaySeconds: 0,
        prompt: "Invalid delay.",
      })).rejects.toThrow(/positive whole number/i);
      await expect(service.createScheduledWork({
        sessionId: session.id,
        delaySeconds: 1.5,
        prompt: "Fractional delay.",
      })).rejects.toThrow(/positive whole number/i);
      await expect(service.createScheduledWork({
        sessionId: session.id,
        delaySeconds: 60,
        prompt: "Recurring relative delay.",
        recurring: true,
      } as unknown as AgentChatCreateScheduledWorkArgs)).rejects.toThrow(/one-shot and cannot recur/i);
      await expect(service.createScheduledWork({
        sessionId: session.id,
        cron: "0 * * * *",
        prompt: "   ",
      })).rejects.toThrow(/prompt is required/i);

      sessionService.create({
        sessionId: "ended-chat",
        laneId: "lane-1",
        toolType: "codex-chat",
      });
      sessionService.end({ sessionId: "ended-chat", status: "completed" });
      await expect(service.createScheduledWork({
        sessionId: "ended-chat",
        cron: "0 * * * *",
        prompt: "This must not be scheduled.",
      })).rejects.toThrow(/ended or archived/i);

      sessionService.create({
        sessionId: "untracked-cli",
        laneId: "lane-1",
        toolType: "codex",
        tracked: false,
      });
      await expect(service.createScheduledWork({
        sessionId: "untracked-cli",
        cron: "0 * * * *",
        prompt: "This must not be scheduled.",
      })).rejects.toThrow(/not found/i);
    });

    it("delivers a provider-neutral action schedule through messageSession for an idle live Claude chat", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-action-schedule",
        delaySeconds: 600,
        lingerAfterTurn: new Promise<void>(() => undefined),
      });
      const { service } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const foregroundTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep the Claude runtime warm.",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await foregroundTurn;

      const created = await service.createScheduledWork({
        sessionId: session.id,
        cron: "1 * * * *",
        prompt: "Deliver this through the ADE wake path.",
        recurring: false,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.id,
          event: expect.objectContaining({
            type: "user_message",
            metadata: expect.objectContaining({
              scheduledWake: expect.objectContaining({ scheduleId: created.item.id }),
            }),
          }),
        }),
      ]));
      service.forceDisposeAll();
    });

    it("resumes an ended tracked CLI session when its durable one-shot becomes due", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const sendToSession = vi.fn(async () => ({
        ptyId: "pty-cli-scheduled",
        sessionId: "cli-scheduled",
        pid: 42,
        session: null,
        resumed: true,
        reusedExistingRuntime: false,
      }));
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        ptyService: {
          create: vi.fn(),
          canAcceptScheduledTurn: () => true,
          enrichSessions: (rows: Array<Record<string, unknown>>) => rows.map((row) => ({
            ...row,
            runtimeState: "exited",
          })),
          sendToSession,
        },
      });
      sessionService.create({
        sessionId: "cli-scheduled",
        laneId: "lane-1",
        toolType: "codex",
      });
      sessionService.end({ sessionId: "cli-scheduled", status: "completed" });

      const created = await service.createScheduledWork({
        sessionId: "cli-scheduled",
        cron: "1 * * * *",
        prompt: "Check CI and report the result.",
        recurring: false,
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sendToSession).toHaveBeenCalledWith({
        sessionId: "cli-scheduled",
        text: "Check CI and report the result.",
      });
      expect(await service.listScheduledWork({
        sessionId: "cli-scheduled",
        includeTerminal: true,
      })).toEqual([
        expect.objectContaining({
          id: created.item.id,
          status: "completed",
        }),
      ]);
      service.forceDisposeAll();
    });

    it("reads durable schedule state for a tracked CLI session", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const { service, sessionService } = createService({ db: scheduledWork.db });
      sessionService.create({
        sessionId: "cli-state",
        laneId: "lane-1",
        toolType: "codex",
      });
      const created = await service.createScheduledWork({
        sessionId: "cli-state",
        cron: "1 * * * *",
        prompt: "Inspect this from ADE Code.",
        recurring: false,
      });

      expect(await service.getScheduledWorkState({ sessionId: "cli-state" })).toEqual({
        sessionId: "cli-state",
        paused: false,
        nextWakeAt: new Date(SCHEDULE_TEST_START + 60_000).toISOString(),
        items: [expect.objectContaining({ id: created.item.id, status: "scheduled" })],
      });
      await service.setScheduledWorkPaused({ sessionId: "cli-state", paused: true });
      expect(await service.getScheduledWorkState({ sessionId: "cli-state" })).toMatchObject({
        sessionId: "cli-state",
        paused: true,
        nextWakeAt: null,
      });
      service.forceDisposeAll();
    });

    it("waits for a tracked CLI turn boundary before delivering scheduled work", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      let canAcceptScheduledTurn = false;
      const sendToSession = vi.fn(async () => ({
        ptyId: "pty-cli-busy",
        sessionId: "cli-busy",
        pid: 42,
        session: null,
        resumed: false,
        reusedExistingRuntime: true,
      }));
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        ptyService: {
          create: vi.fn(),
          canAcceptScheduledTurn: () => canAcceptScheduledTurn,
          enrichSessions: (rows: Array<Record<string, unknown>>) => rows.map((row) => ({
            ...row,
            runtimeState: canAcceptScheduledTurn ? "waiting-input" : "running",
          })),
          sendToSession,
        },
      });
      sessionService.create({
        sessionId: "cli-busy",
        laneId: "lane-1",
        toolType: "claude",
      });
      await service.createScheduledWork({
        sessionId: "cli-busy",
        cron: "1 * * * *",
        prompt: "Continue after the foreground CLI turn.",
        recurring: false,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sendToSession).not.toHaveBeenCalled();
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("scheduled");

      canAcceptScheduledTurn = true;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sendToSession).toHaveBeenCalledOnce();
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("done");
      service.forceDisposeAll();
    });

    it("retries a tracked CLI occurrence when resume fails before delivery", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const sendToSession = vi.fn(async () => {
        throw Object.assign(
          new Error("Terminal session 'cli-no-resume' does not have a resume command."),
          { code: PTY_SEND_PRE_DELIVERY_ERROR_CODE },
        );
      });
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        ptyService: {
          create: vi.fn(),
          canAcceptScheduledTurn: () => true,
          enrichSessions: (rows: Array<Record<string, unknown>>) => rows.map((row) => ({
            ...row,
            runtimeState: "exited",
          })),
          sendToSession,
        },
      });
      sessionService.create({
        sessionId: "cli-no-resume",
        laneId: "lane-1",
        toolType: "codex",
      });
      sessionService.end({ sessionId: "cli-no-resume", status: "completed" });
      await service.createScheduledWork({
        sessionId: "cli-no-resume",
        cron: "1 * * * *",
        prompt: "Retry this only after a resumable target exists.",
        recurring: false,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sendToSession).toHaveBeenCalledOnce();
      expect(scheduledWork.readState()?.schedules[0]).toEqual(expect.objectContaining({
        status: "scheduled",
        fireAt: SCHEDULE_TEST_START + 60_000,
      }));
      expect(scheduledWork.readState()?.schedules[0]?.lastFiredAt).toBeUndefined();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(sendToSession).toHaveBeenCalledTimes(2);
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("scheduled");
      service.forceDisposeAll();
    });

    it("defers provider and ADE-action schedules while their live session is busy", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let releaseBusySend!: () => void;
      const busySendGate = new Promise<void>((resolve) => { releaseBusySend = resolve; });
      const send = vi.fn(async () => { await busySendGate; });
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-busy-backstop", slash_commands: [] };
          return;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-busy-backstop",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);
      const { service } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const foregroundTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep working through the backstop deadline.",
      });
      await waitForFakeTimerCondition(
        () => send.mock.calls.length > 0,
        "the foreground Claude send to start",
      );
      expect(send).toHaveBeenCalled();
      expect(service.hasActiveWorkloads()).toBe(true);
      const options = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      await options?.hooks?.PostToolUse?.[0]?.hooks[0]?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-busy-backstop",
        tool_name: "ScheduleWakeup",
        tool_use_id: "tool-busy-backstop",
        tool_input: {
          delaySeconds: 60,
          reason: "Check PR CI",
          prompt: "Check PR CI after the foreground turn.",
        },
        tool_response: {
          scheduledFor: SCHEDULE_TEST_START,
          clampedDelaySeconds: 60,
          wasClamped: false,
        },
      });
      const actionSchedule = await service.createScheduledWork({
        sessionId: session.id,
        cron: "1 * * * *",
        prompt: "Run the ADE-owned follow-up after the foreground turn.",
        recurring: false,
      });
      await vi.advanceTimersByTimeAsync(90_000);

      expect(scheduledWork.readState()?.schedules.find((item) => item.id === `wakeup:${session.id}`)).toEqual(expect.objectContaining({
        status: "scheduled",
        fireAt: SCHEDULE_TEST_START,
        lateFlag: false,
      }));
      expect(scheduledWork.readState()?.schedules.find((item) => item.id === actionSchedule.item.id)).toEqual(expect.objectContaining({
        status: "scheduled",
        fireAt: SCHEDULE_TEST_START + 60_000,
      }));
      expect(scheduledWork.readState()?.schedules.every((item) => item.lastFiredAt == null)).toBe(true);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake != null
      )).toBe(false);

      releaseBusySend();
      await vi.advanceTimersByTimeAsync(0);
      await foregroundTurn;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake?.scheduleId === actionSchedule.item.id
      )).toBe(true);
      service.forceDisposeAll();
    });

    it("projects the next durable wake onto the chat session summary", async () => {
      const before = Date.now();
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-next-wake", slash_commands: [] };
            return;
          }
          yield {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "tool-next-wake",
                name: "ScheduleWakeup",
                input: {
                  delaySeconds: 120,
                  reason: "Check PR CI",
                  prompt: "Check PR CI and report the result.",
                },
              }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          const options = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
            hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
          } | undefined;
          await options?.hooks?.PostToolUse?.[0]?.hooks[0]?.({
            hook_event_name: "PostToolUse",
            session_id: "sdk-next-wake",
            tool_name: "ScheduleWakeup",
            tool_use_id: "tool-next-wake",
            tool_input: {
              delaySeconds: 120,
              reason: "Check PR CI",
              prompt: "Check PR CI and report the result.",
            },
            tool_response: {
              scheduledFor: Date.now() + 120_000,
              clampedDelaySeconds: 120,
              wasClamped: false,
            },
          });
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-next-wake",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({ sessionId: session.id, text: "Check CI again later." });

      const summary = await service.getSessionSummary(session.id);
      const nextWakeAt = Date.parse(summary?.nextWakeAt ?? "");
      expect(summary?.scheduledWorkPaused).toBe(false);
      expect(nextWakeAt).toBeGreaterThanOrEqual(before + 119_000);
      expect(nextWakeAt).toBeLessThanOrEqual(Date.now() + 121_000);
      expect(summary?.scheduledWork).toEqual([
        expect.objectContaining({
          sessionId: session.id,
          kind: "wakeup",
          status: "scheduled",
          title: "Check PR CI",
          durable: true,
        }),
      ]);

      const listed = await service.listScheduledWork({ sessionId: session.id });
      expect(listed).toEqual(summary?.scheduledWork);
      const cancelled = await service.cancelScheduledWork({
        sessionId: session.id,
        scheduleId: listed[0]!.id,
      });
      expect(cancelled).toMatchObject({
        schedule: { id: listed[0]!.id, status: "paused" },
        providerCancellationRequested: true,
        providerCancellationConfirmed: false,
      });
      expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([
        expect.objectContaining({ id: listed[0]!.id, status: "paused" }),
      ]);
      expect((await service.getSessionSummary(session.id))?.scheduledWork).toEqual([
        expect.objectContaining({ id: listed[0]!.id, status: "paused" }),
      ]);
      service.forceDisposeAll();

      const mismatchedWork = createScheduledWorkDb({
        version: 1,
        schedules: [storedWakeup(session.id, {
          provider: "claude",
          providerSessionId: "sdk-earlier-wakeup",
          providerScheduleId: "provider-earlier-wakeup",
          durable: true,
          status: "paused",
          pausedFlag: true,
        })],
        pausedSessionIds: [],
      });
      const mismatched = createService({ db: mismatchedWork.db });
      await expect(mismatched.service.cancelScheduledWork({
        sessionId: session.id,
        scheduleId: `wakeup:${session.id}`,
      })).resolves.toMatchObject({
        schedule: { status: "cancelled" },
        providerCancellationRequested: false,
        providerCancellationConfirmed: false,
      });
      expect(mismatchedWork.readState()?.schedules).toEqual([
        expect.objectContaining({ status: "cancelled", terminalAt: expect.any(Number) }),
      ]);
      mismatched.service.forceDisposeAll();

      const orphanedWork = createScheduledWorkDb({
        version: 1,
        schedules: [storedWakeup("missing-owner", {
          provider: "claude",
          providerScheduleId: "provider-missing",
          durable: true,
          status: "paused",
          pausedFlag: true,
        })],
        pausedSessionIds: [],
      });
      const orphaned = createService({ db: orphanedWork.db });
      await expect(orphaned.service.cancelScheduledWork({
        sessionId: "missing-owner",
        scheduleId: "wakeup:missing-owner",
      })).resolves.toMatchObject({
        schedule: { status: "cancelled" },
        providerCancellationRequested: false,
        providerCancellationConfirmed: false,
      });
      expect(orphanedWork.readState()?.schedules).toEqual([
        expect.objectContaining({ id: "wakeup:missing-owner", status: "cancelled" }),
      ]);
      orphaned.service.forceDisposeAll();
    });

    it("keeps legacy ownerless Claude schedules paused until provider deletion confirms", async () => {
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [storedWakeup("test-uuid-1", {
          provider: "claude",
          providerScheduleId: "provider-legacy-wakeup",
          durable: true,
        })],
        pausedSessionIds: [],
      });
      const { send } = installClaudeResponseFixture({
        sdkSessionId: "sdk-legacy-owner-cancel",
        responseText: "Done.",
      });
      const { service } = createService({ db: scheduledWork.db });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const postToolUseHook = opts?.hooks?.PostToolUse?.[0]?.hooks[0];
      expect(session.id).toBe("test-uuid-1");
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start the Claude session.",
      });

      await expect(service.cancelScheduledWork({
        sessionId: session.id,
        scheduleId: `wakeup:${session.id}`,
      })).resolves.toMatchObject({
        schedule: { status: "paused" },
        providerCancellationRequested: true,
        providerCancellationConfirmed: false,
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(expect.stringContaining(
          "CronDelete: provider-legacy-wakeup",
        ));
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: `wakeup:${session.id}`,
          status: "paused",
          pausedFlag: true,
        }),
      ]);

      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-legacy-owner-cancel",
        tool_name: "CronDelete",
        tool_use_id: "tool-delete-legacy-ownerless",
        tool_input: { id: "provider-legacy-wakeup" },
        tool_response: { id: "provider-legacy-wakeup" },
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: `wakeup:${session.id}`,
          status: "cancelled",
          terminalAt: expect.any(Number),
        }),
      ]);
      service.forceDisposeAll();
    });

    it("locally tombstones legacy ownerless work when the chat cannot be woken", async () => {
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [storedWakeup("test-uuid-1", {
          provider: "claude",
          providerScheduleId: "provider-unavailable-wakeup",
          durable: true,
        })],
        pausedSessionIds: [],
      });
      installClaudeResponseFixture({
        sdkSessionId: "sdk-legacy-owner-unavailable",
        responseText: "Done.",
      });
      const { service, sessionService, logger } = createService({
        db: scheduledWork.db,
        projectConfigService: {
          get: vi.fn(() => ({
            effective: {
              ai: {
                permissions: {
                  cli: { mode: "edit" },
                  inProcess: { mode: "edit" },
                },
                chat: {},
                sessionIntelligence: { titles: { enabled: false } },
              },
            },
          })),
          getAll: vi.fn(() => ({})),
          set: vi.fn(),
        } as any,
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start the Claude session.",
      });
      await service.dispose({ sessionId: session.id });
      const sessionRow = sessionService.get(session.id);
      // Probe once for the still-present chat, then fail later lookups so the
      // wake cannot proceed. Call-count once() mocks are consumed by unrelated
      // session-intelligence reads after a turn.
      let cancelLookups = 0;
      sessionService.get.mockImplementation((id: string) => {
        if (id !== session.id) return null;
        cancelLookups += 1;
        return cancelLookups === 1 ? sessionRow : null;
      });

      await expect(service.cancelScheduledWork({
        sessionId: session.id,
        scheduleId: `wakeup:${session.id}`,
      })).resolves.toMatchObject({
        schedule: { status: "cancelled" },
        providerCancellationRequested: false,
        providerCancellationConfirmed: false,
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: `wakeup:${session.id}`,
          status: "cancelled",
          terminalAt: expect.any(Number),
        }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.claude_legacy_scheduled_work_cancel_request_failed",
        expect.objectContaining({ sessionId: session.id, scheduleCount: 1 }),
      );
      service.forceDisposeAll();
    });

    it("keeps the Claude SDK stream alive for scheduled wakeups after a foreground result", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startBackground!: () => void;
      let finishBackground!: () => void;
      const startBackgroundPromise = new Promise<void>((resolve) => { startBackground = resolve; });
      const finishBackgroundPromise = new Promise<void>((resolve) => { finishBackground = resolve; });
      let releaseIdleWorkflowNotification!: () => void;
      const idleWorkflowNotificationGate = new Promise<void>((resolve) => {
        releaseIdleWorkflowNotification = resolve;
      });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-wakeup",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-wakeup",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startBackgroundPromise;
        yield {
          type: "assistant",
          uuid: "assistant-idle-tool",
          message: {
            id: "msg-idle-tool",
            content: [
              {
                type: "tool_use",
                id: "tool-wakeup-1",
                name: "ScheduleWakeup",
                input: {
                  reason: "CI was still running",
                  prompt: "Check CI again and report back.",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        const options = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
          hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
        } | undefined;
        await options?.hooks?.PostToolUse?.[0]?.hooks[0]?.({
          hook_event_name: "PostToolUse",
          tool_name: "ScheduleWakeup",
          tool_use_id: "tool-wakeup-1",
          tool_input: {
            delaySeconds: 60,
            reason: "CI was still running",
            prompt: "Check CI again and report back.",
          },
          tool_response: {
            scheduledFor: Date.now() + 60_000,
            clampedDelaySeconds: 60,
            wasClamped: false,
          },
        });
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-wakeup",
          task_id: "cron-task-1",
          task_type: "cron",
          parent_tool_use_id: "tool-wakeup-1",
          description: "Check CI again",
          agent_id: "agent-child-1",
          parent_agent_id: "agent-parent-1",
        };

        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-wakeup",
          task_id: "idle-workflow-1",
          task_type: "local_workflow",
          workflow_name: "idle-review",
          description: "Review idle changes",
        };
        yield {
          type: "system",
          subtype: "task_progress",
          session_id: "sdk-idle-wakeup",
          task_id: "idle-workflow-1",
          task_type: "local_workflow",
          workflow_name: "idle-review",
          description: "Review idle changes",
          workflow_progress: [
            { type: "workflow_agent", index: 0, state: "start", startedAt: 1, label: "idle:review" },
          ],
        };
        // Exercise the idle reader's completed-update preservation before its
        // terminal notification drains the synthetic workflow agent.
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-idle-wakeup",
          task_id: "idle-workflow-1",
          patch: { status: "completed" },
        };
        await idleWorkflowNotificationGate;
        yield {
          type: "system",
          subtype: "task_notification",
          session_id: "sdk-idle-wakeup",
          task_id: "idle-workflow-1",
          status: "completed",
          summary: "Idle review complete",
        };

        await finishBackgroundPromise;
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-idle-wakeup",
          task_id: "cron-task-1",
          task_type: "cron",
          parent_tool_use_id: "tool-wakeup-1",
          patch: { status: "completed" },
          summary: "CI passed.",
          agent_id: "agent-child-1",
          parent_agent_id: "agent-parent-1",
        };
        yield {
          type: "assistant",
          uuid: "assistant-idle-text",
          message: {
            id: "msg-idle-text",
            content: [{ type: "text", text: "CI passed." }],
            usage: { input_tokens: 2, output_tokens: 4 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-wakeup",
          usage: { input_tokens: 2, output_tokens: 4 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-wakeup",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Run CI and wake up when it finishes.",
      });
      expect(service.hasActiveWorkloads()).toBe(false);
      const wakeupId = `wakeup:${session.id}`;

      vi.mocked(runGit).mockClear();
      startBackground();
      await vi.waitFor(() => {
        expect(runGit).toHaveBeenCalledWith(["rev-parse", "HEAD"], expect.objectContaining({ timeoutMs: 8_000 }));
      });
      const wakeupEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId,
      );
      expect(wakeupEvent.event).toMatchObject({
        kind: "wakeup",
        status: "scheduled",
        origin: "schedule_wakeup",
        reason: "CI was still running",
        prompt: "Check CI again and report back.",
      });
      expect(wakeupEvent.event.turnId).toMatch(/^claude-idle-/);
      expect(service.hasActiveWorkloads()).toBe(true);

      const cronRunningEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId
          && event.event.status === "running",
      );
      expect(cronRunningEvent.event).toMatchObject({
        kind: "wakeup",
        origin: "cron",
        title: "Check CI again",
        sourceToolUseId: "tool-wakeup-1",
        sourceTaskId: "cron-task-1",
      });

      const idleWorkflowAgentResult = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "subagent_result"
          && (event.event as any).taskId === "idle-workflow-1::a0",
      );
      expect((idleWorkflowAgentResult.event as any).status).toBe("stopped");
      releaseIdleWorkflowNotification();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "subagent_result"
          && (event.event as any).taskId === "idle-workflow-1",
      );
      const idleWorkflowParentResult = events.find(
        (event) => event.sessionId === session.id
          && event.event.type === "subagent_result"
          && (event.event as any).taskId === "idle-workflow-1",
      );
      expect((idleWorkflowParentResult?.event as any)?.workflowProgress).toMatchObject({
        queuedCount: 0,
        runningCount: 0,
        agents: [expect.objectContaining({ status: "stopped" })],
      });

      finishBackground();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId
          && event.event.status === "completed",
      );
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "done"
          && event.event.turnId.startsWith("claude-idle-")
          && event.event.status === "completed",
      );
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("treats an idle-reader EDE diagnostic as internal lifecycle noise", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const diagnostic = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";
      let streamCall = 0;
      let releaseIdle!: () => void;
      const releaseIdlePromise = new Promise<void>((resolve) => { releaseIdle = resolve; });

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-idle-ede-diagnostic",
              slash_commands: [],
            };
            return;
          }

          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-idle-ede-diagnostic",
          };
          await releaseIdlePromise;
          yield {
            type: "assistant",
            uuid: "assistant-idle-ede-diagnostic",
            message: {
              id: "message-idle-ede-diagnostic",
              content: [{ type: "text", text: "Background work finished." }],
              usage: { input_tokens: 1, output_tokens: 3 },
            },
          };
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: [diagnostic],
            session_id: "sdk-idle-ede-diagnostic",
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-idle-ede-diagnostic",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service, logger } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Finish the foreground turn, then report background work.",
      });
      releaseIdle();

      const idleDone = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } => event.sessionId === session.id
          && event.event.type === "done"
          && event.event.turnId.startsWith("claude-idle-"),
      );
      expect(idleDone.event.status).toBe("completed");
      expect(events.some((event) => event.event.type === "error" && event.event.message.includes("[ede_diagnostic]"))).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith(
        "agent_chat.claude_internal_diagnostic",
        expect.objectContaining({
          source: "idle_reader",
          diagnostics: [diagnostic],
        }),
      );
    });

    it("groups idle-reader Claude deltas by the stable message id and suppresses the repeated snapshot", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      const messageId = "msg-idle-stable-stream";
      const fragments = ["Idle ", "Claude ", "text ", "stays ", "whole."];
      const fullText = fragments.join("");
      let streamCall = 0;
      let startIdle!: () => void;
      const startIdlePromise = new Promise<void>((resolve) => { startIdle = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-stable-stream",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-stable-stream",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startIdlePromise;
        yield {
          type: "stream_event",
          uuid: "wire-idle-message-start",
          event: {
            type: "message_start",
            message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
          },
        };
        for (const [index, text] of fragments.entries()) {
          yield {
            type: "stream_event",
            uuid: `wire-idle-delta-${index + 1}`,
            event: {
              type: "content_block_delta",
              index: 0,
              message: { id: messageId },
              delta: { type: "text_delta", text },
            },
          };
        }
        yield {
          type: "assistant",
          uuid: "wire-idle-assistant-snapshot",
          supersedes: ["superseded-idle-wire-message"],
          message: {
            id: messageId,
            content: [{ type: "text", text: fullText }],
            usage: { input_tokens: 1, output_tokens: 5 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-stable-stream",
          usage: { input_tokens: 1, output_tokens: 5 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-stable-stream",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Complete the foreground turn, then stream idle work.",
      });

      startIdle();
      const idleDone = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "done"
          && event.event.turnId.startsWith("claude-idle-")
          && event.event.status === "completed",
      );

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> =>
          event.type === "text" && event.turnId === idleDone.event.turnId
        );
      expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
      expect(new Set(textEvents.map((event) => event.messageId))).toEqual(new Set([messageId]));

      const retraction = events.find((event) =>
        event.event.type === "transcript_retraction"
        && event.event.turnId === idleDone.event.turnId
      );
      expect(retraction?.event).toMatchObject({
        type: "transcript_retraction",
        replacementMessageId: messageId,
      });
    });

    it("keeps idle skip_transcript tasks out of visible chat info", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startAmbient!: () => void;
      let ambientDrained = false;
      const startAmbientPromise = new Promise<void>((resolve) => { startAmbient = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-skip-transcript",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-skip-transcript",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startAmbientPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-skip-transcript",
          task_id: "task-ambient-idle-1",
          description: "Generate session title",
          task_type: "other",
          skip_transcript: true,
        };
        yield {
          type: "system",
          subtype: "task_progress",
          session_id: "sdk-idle-skip-transcript",
          task_id: "task-ambient-idle-1",
          summary: "thinking",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          session_id: "sdk-idle-skip-transcript",
          task_id: "task-ambient-idle-1",
          status: "completed",
          summary: "Done",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-skip-transcript",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        ambientDrained = true;
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-skip-transcript",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Complete a visible turn, then let idle housekeeping run.",
      });

      startAmbient();
      await vi.waitFor(() => {
        expect(ambientDrained).toBe(true);
      });

      expect(events.filter((event) =>
        event.sessionId === session.id
        && (event.event.type === "subagent_started"
          || event.event.type === "subagent_progress"
          || event.event.type === "subagent_result")
        && (event.event as { taskId?: string }).taskId === "task-ambient-idle-1",
      )).toEqual([]);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "status"
        && event.event.turnId?.startsWith("claude-idle-") === true,
      )).toBe(false);
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("keeps idle ambient tasks out of visible chat info", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startAmbient!: () => void;
      let holdAmbientComplete!: () => void;
      let ambientLive = false;
      let ambientDrained = false;
      const startAmbientPromise = new Promise<void>((resolve) => { startAmbient = resolve; });
      const holdAmbientCompletePromise = new Promise<void>((resolve) => { holdAmbientComplete = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-ambient",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-ambient",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startAmbientPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-ambient",
          task_id: "task-ambient-idle-true",
          description: "Generate session title",
          task_type: "other",
          ambient: true,
        };
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{
            task_id: "task-ambient-idle-true",
            description: "Generate session title",
            ambient: true,
          }],
        };
        ambientLive = true;
        await holdAmbientCompletePromise;
        yield {
          type: "system",
          subtype: "task_notification",
          session_id: "sdk-idle-ambient",
          task_id: "task-ambient-idle-true",
          status: "completed",
          summary: "Done",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-ambient",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        ambientDrained = true;
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-ambient",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Complete a visible turn, then let idle ambient housekeeping run.",
      });

      startAmbient();
      await vi.waitFor(() => {
        expect(ambientLive).toBe(true);
      });
      expect(events.filter((event) =>
        event.sessionId === session.id
        && (event.event.type === "subagent_started"
          || event.event.type === "subagent_progress"
          || event.event.type === "subagent_result")
        && (event.event as { taskId?: string }).taskId === "task-ambient-idle-true",
      )).toEqual([]);
      expect(service.hasActiveWorkloads()).toBe(false);

      holdAmbientComplete();
      await vi.waitFor(() => {
        expect(ambientDrained).toBe(true);
      });
    });

    it("delivers queued steers after an idle Claude turn completes", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startBackground!: () => void;
      let finishBackground!: () => void;
      const startBackgroundPromise = new Promise<void>((resolve) => { startBackground = resolve; });
      const finishBackgroundPromise = new Promise<void>((resolve) => { finishBackground = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-queued-steer",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-queued-steer",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startBackgroundPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-queued-steer",
          task_id: "idle-promoted-bash",
          task_type: "local_bash",
          description: "Idle promoted Bash",
          command: "sleep 10",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-idle-queued-steer",
          task_id: "idle-promoted-bash",
          patch: { status: "running", is_backgrounded: true },
        };
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-queued-steer",
          task_id: "cron-task-queued-steer",
          task_type: "cron",
          description: "Check queued steer",
        };
        yield {
          type: "assistant",
          uuid: "assistant-background-progress",
          message: {
            id: "msg-background-progress",
            content: [{ type: "text", text: "The background check is still running." }],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        };

        await finishBackgroundPromise;
        yield {
          type: "system",
          subtype: "task_notification",
          session_id: "sdk-idle-queued-steer",
          task_id: "idle-promoted-bash",
          status: "completed",
          summary: "Process exited",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-idle-queued-steer",
          task_id: "cron-task-queued-steer",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "Background task completed.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-queued-steer",
          usage: { input_tokens: 2, output_tokens: 3 },
        };

        yield {
          type: "assistant",
          uuid: "assistant-queued-steer",
          message: {
            id: "msg-queued-steer",
            content: [{ type: "text", text: "Queued steer delivered." }],
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-queued-steer",
          usage: { input_tokens: 3, output_tokens: 4 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-queued-steer",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start a scheduled check.",
      });

      startBackground();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === "background:idle-promoted-bash"
          && event.event.status === "running",
      );
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "text"
          && event.event.text.includes("background check is still running"),
      );

      const steerResult = await service.steer({
        sessionId: session.id,
        text: "Follow up after the background task.",
      });
      expect(steerResult.queued).toBe(true);

      finishBackground();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "text"
          && event.event.text.includes("Queued steer delivered."),
      );
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Follow up after the background task."));
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("mirrors Claude CronCreate without a durable flag and keys events by the provider cron id", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const scheduledWork = createScheduledWorkDb();
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-id",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          uuid: "assistant-cron-tools",
          message: {
            id: "msg-cron-tools",
            content: [
              {
                type: "tool_use",
                id: "tool-cron-create",
                name: "CronCreate",
                input: {
                  id: "cron-sdk-1",
                  cron: "*/15 * * * *",
                  prompt: "Check CI status.",
                },
              },
              {
                type: "tool_use",
                id: "tool-cron-delete",
                name: "CronDelete",
                input: {
                  id: "cron-sdk-1",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-id",
        setPermissionMode,
      } as any);

      const { service } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const postToolUseHook = opts?.hooks?.PostToolUse?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule and then cancel a CI cron.",
      });
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-cron-provider-id",
        tool_name: "CronCreate",
        tool_use_id: "tool-cron-create",
        tool_input: { cron: "*/15 * * * *", prompt: "Check CI status." },
        tool_response: { id: "cron-sdk-1", recurring: true, durable: false },
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: "cron-sdk-1",
          kind: "cron",
          cron: "*/15 * * * *",
          prompt: "Check CI status.",
          durable: true,
          provider: "claude",
          providerSessionId: "sdk-cron-provider-id",
          providerScheduleId: "cron-sdk-1",
          status: "scheduled",
        }),
      ]);
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        tool_name: "CronDelete",
        tool_use_id: "tool-cron-delete",
        tool_input: { id: "cron-sdk-1" },
        tool_response: { id: "cron-sdk-1" },
      });

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual(["cron-sdk-1", "cron-sdk-1"]);
      expect(scheduledEvents.map((event) => event.event.status)).toEqual(["scheduled", "cancelled"]);

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-sdk-1",
        status: "cancelled",
        cron: "*/15 * * * *",
        prompt: "Check CI status.",
        durable: true,
        sourceToolUseId: "tool-cron-delete",
      });
    });

    it("persists a long durable CronCreate only after PostToolUse returns the canonical provider id", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const scheduledWork = createScheduledWorkDb();
      const longPrompt = `Check CI status. ${"Preserve full watcher context. ".repeat(80)}`.trim();
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-provider-id",
            slash_commands: [],
          };
          return;
        }
        if (streamCall === 3) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-provider-next",
            slash_commands: [],
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-cron-provider-next",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }
        yield {
          type: "assistant",
          uuid: "assistant-cron-create-no-id",
          message: {
            id: "msg-cron-create-no-id",
            content: [
              {
                type: "tool_use",
                id: "tool-cron-create-no-id",
                name: "CronCreate",
                input: {
                  cron: "*/15 * * * *",
                  prompt: longPrompt,
                  durable: true,
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-provider-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-provider-id",
        setPermissionMode,
      } as any);

      const { service, sessionService } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];
      const postToolUseHook = opts?.hooks?.PostToolUse?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule a CI cron.",
      });

      expect(events.filter((event) =>
        event.sessionId === session.id
        && event.event.type === "scheduled_work_update"
        && event.event.kind === "cron",
      )).toEqual([]);

      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        tool_name: "CronCreate",
        tool_use_id: "tool-cron-create-no-id",
        tool_input: {
          cron: "*/15 * * * *",
          prompt: longPrompt,
          durable: true,
        },
        tool_response: {
          id: "cron-provider-1",
          recurring: true,
          durable: true,
        },
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_id: "sdk-cron-provider-id",
        session_crons: [{
          id: "cron-provider-1",
          schedule: "*/15 * * * *",
          prompt: `${longPrompt.slice(0, 1_000)}… [+${longPrompt.length - 1_000} chars]`,
          recurring: true,
        }],
      });

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-provider-1",
        status: "scheduled",
        cron: "*/15 * * * *",
        prompt: longPrompt,
        durable: true,
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: "cron-provider-1",
          prompt: longPrompt,
          durable: true,
          expiresAt: expect.any(Number),
          providerSessionId: "sdk-cron-provider-id",
        }),
      ]);
      expect(scheduledWork.readState()?.schedules.some((schedule) => schedule.id.startsWith("cron-tool:"))).toBe(false);

      const initialExpiresAt = scheduledWork.readState()?.schedules[0]?.expiresAt;
      const refreshNow = Date.now() + 60_000;
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(refreshNow);
      try {
        await stopHook?.({
          hook_event_name: "Stop",
          session_id: "sdk-cron-provider-id",
          session_crons: [{
            id: "cron-provider-1",
            schedule: "*/15 * * * *",
            prompt: `${longPrompt.slice(0, 1_000)}… [+${longPrompt.length - 1_000} chars]`,
            recurring: true,
          }],
        });
      } finally {
        dateNow.mockRestore();
      }
      expect(scheduledWork.readState()?.schedules[0]?.expiresAt).toBe(initialExpiresAt);

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Continue in the replacement Claude session.",
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: "cron-provider-1",
          status: "scheduled",
          pausedFlag: false,
          providerSessionId: "sdk-cron-provider-id",
        }),
      ]);
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-cron-provider-next",
        tool_name: "CronDelete",
        tool_use_id: "tool-delete-from-replacement-session",
        tool_input: { id: "cron-provider-1" },
        tool_response: { id: "cron-provider-1" },
      });
      await stopHook?.({
        hook_event_name: "Stop",
        session_id: "sdk-cron-provider-next",
        session_crons: [],
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: "cron-provider-1",
          status: "scheduled",
          providerSessionId: "sdk-cron-provider-id",
        }),
      ]);
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-cron-provider-next",
        tool_name: "CronCreate",
        tool_use_id: "tool-create-current-provider-cron",
        tool_input: {
          cron: "*/30 * * * *",
          prompt: "Check the current session's CI.",
          durable: true,
        },
        tool_response: {
          id: "cron-provider-current",
          recurring: true,
          durable: true,
        },
      });
      const archive = service.archiveSession({ sessionId: session.id });
      await vi.waitFor(() => {
        expect(scheduledWork.readState()?.schedules.find((schedule) =>
          schedule.id === "cron-provider-current")?.status).toBe("paused");
      });
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-cron-provider-next",
        tool_name: "CronDelete",
        tool_use_id: "tool-delete-current-provider-cron",
        tool_input: { id: "cron-provider-current" },
        tool_response: { id: "cron-provider-current" },
      });
      await archive;

      expect(sessionService.get(session.id)?.archivedAt).toEqual(expect.any(String));
      expect(scheduledWork.readState()?.schedules).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "cron-provider-1", status: "cancelled" }),
        expect.objectContaining({ id: "cron-provider-current", status: "cancelled" }),
      ]));
    });

    it("coalesces one-shot wakeup hook snapshots with the scheduled wakeup row", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let cancelWakeup!: () => void;
      const cancelWakeupPromise = new Promise<void>((resolve) => { cancelWakeup = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-wakeup-provider-id",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          uuid: "assistant-wakeup-provider-id",
          message: {
            id: "msg-wakeup-provider-id",
            content: [
              {
                type: "tool_use",
                id: "tool-wakeup-provider-id",
                name: "ScheduleWakeup",
                input: {
                  reason: "CI was still running",
                  prompt: "Check CI again.",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-wakeup-provider-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };

        await cancelWakeupPromise;
        yield {
          type: "assistant",
          uuid: "assistant-wakeup-provider-delete",
          message: {
            id: "msg-wakeup-provider-delete",
            content: [
              {
                type: "tool_use",
                id: "tool-wakeup-provider-delete",
                name: "CronDelete",
                input: {
                  id: "wakeup-provider-1",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-wakeup-provider-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-wakeup-provider-id",
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
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];
      const postToolUseHook = opts?.hooks?.PostToolUse?.[0]?.hooks[0];
      const wakeupId = `wakeup:${session.id}`;

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule a one-shot CI wakeup.",
      });

      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        tool_name: "ScheduleWakeup",
        tool_use_id: "tool-wakeup-provider-id",
        tool_input: {
          delaySeconds: 60,
          reason: "CI was still running",
          prompt: "Check CI again.",
        },
        tool_response: {
          scheduledFor: Date.now() + 60_000,
          clampedDelaySeconds: 60,
          wasClamped: false,
        },
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "wakeup-provider-1",
          schedule: "once",
          prompt: "Check CI again.",
          recurring: false,
        }],
      });

      cancelWakeup();
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        tool_name: "CronDelete",
        tool_use_id: "tool-wakeup-provider-delete",
        tool_input: { id: "wakeup-provider-1" },
        tool_response: { id: "wakeup-provider-1" },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId
          && event.event.status === "cancelled",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "wakeup");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual([wakeupId, wakeupId, wakeupId]);
      expect(scheduledEvents.map((event) => event.event.status)).toEqual(["scheduled", "scheduled", "cancelled"]);

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: wakeupId,
        kind: "wakeup",
        status: "cancelled",
        prompt: "Check CI again.",
        sourceTaskId: "wakeup-provider-1",
      });
    });

    it("reconciles missing provider wakeups and loops without cancelling ADE-local schedules", async () => {
      const sdkSessionId = "sdk-provider-snapshot-reconcile";
      const sdkHandle = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: sdkSessionId,
            slash_commands: [],
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: sdkSessionId,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);

      const original = createService().service;
      const session = await original.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        sdkSessionId,
      });
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [
          storedWakeup(session.id, {
            id: "provider-wakeup",
            prompt: "Check provider wakeup.",
            durable: true,
            provider: "claude",
            providerSessionId: sdkSessionId,
            providerScheduleId: "provider-wakeup-id",
          }),
          storedWakeup(session.id, {
            id: "provider-loop",
            kind: "loop",
            prompt: "Continue provider loop.",
            durable: true,
            provider: "claude",
            providerSessionId: sdkSessionId,
            providerScheduleId: "provider-loop-id",
          }),
          storedWakeup(session.id, {
            id: "ade-local-wakeup",
            prompt: "Run ADE-local work.",
            durable: true,
          }),
          storedWakeup(session.id, {
            id: "other-provider-wakeup",
            prompt: "Keep another provider session's work.",
            durable: true,
            provider: "claude",
            providerSessionId: "sdk-other-provider-session",
            providerScheduleId: "other-provider-wakeup-id",
          }),
        ],
        pausedSessionIds: [],
      });
      const resumed = createService({ db: scheduledWork.db }).service;
      await resumed.resumeSession({ sessionId: session.id });
      await resumed.runSessionTurn({
        sessionId: session.id,
        text: "Reconcile the provider's scheduled-work snapshot.",
      });
      const resumeOptions = vi.mocked(claudeSdkResumeSessionCompat).mock.calls.at(-1)?.[1] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const subagentStopHook = resumeOptions?.hooks?.SubagentStop?.[0]?.hooks[0];
      const stopHook = resumeOptions?.hooks?.Stop?.[0]?.hooks[0];

      await subagentStopHook?.({
        hook_event_name: "SubagentStop",
        session_id: sdkSessionId,
        agent_id: "agent-1",
        agent_type: "reviewer",
        last_assistant_message: "Review complete.",
        session_crons: [{
          id: "provider-loop-id",
          schedule: "once",
          prompt: "Continue provider loop.",
          recurring: false,
        }],
      });
      expect(scheduledWork.readState()?.schedules).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "provider-wakeup", status: "cancelled" }),
        expect.objectContaining({ id: "provider-loop", status: "scheduled" }),
        expect.objectContaining({ id: "ade-local-wakeup", status: "scheduled" }),
        expect.objectContaining({ id: "other-provider-wakeup", status: "scheduled" }),
      ]));

      await stopHook?.({
        hook_event_name: "Stop",
        session_id: sdkSessionId,
        session_crons: [],
      });
      expect(scheduledWork.readState()?.schedules).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "provider-loop", status: "cancelled" }),
        expect.objectContaining({ id: "ade-local-wakeup", status: "scheduled" }),
        expect.objectContaining({ id: "other-provider-wakeup", status: "scheduled" }),
      ]));
      resumed.forceDisposeAll();
      original.forceDisposeAll();
    });

    it("keeps a previous provider session's mirrored cron after a fresh session reports an empty snapshot", async () => {
      const previousProviderSessionId = "sdk-before-brain-restart";
      const currentProviderSessionId = "sdk-after-brain-restart";
      const sdkHandle = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: currentProviderSessionId,
            slash_commands: [],
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: currentProviderSessionId,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);

      const original = createService().service;
      const session = await original.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        sdkSessionId: previousProviderSessionId,
      });
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [storedWakeup(session.id, {
          id: "cron-survives-restart",
          kind: "cron",
          cron: "*/15 * * * *",
          durable: true,
          provider: "claude",
          providerSessionId: previousProviderSessionId,
          providerScheduleId: "cron-survives-restart",
        })],
        pausedSessionIds: [],
      });
      const resumed = createService({ db: scheduledWork.db }).service;
      await resumed.resumeSession({ sessionId: session.id });
      await resumed.runSessionTurn({
        sessionId: session.id,
        text: "Resume after the brain restart.",
      });
      const resumeOptions = vi.mocked(claudeSdkResumeSessionCompat).mock.calls.at(-1)?.[1] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = resumeOptions?.hooks?.Stop?.[0]?.hooks[0];

      await stopHook?.({
        hook_event_name: "Stop",
        session_id: currentProviderSessionId,
        session_crons: [],
      });

      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: "cron-survives-restart",
          status: "scheduled",
          pausedFlag: false,
          providerSessionId: previousProviderSessionId,
        }),
      ]);
      resumed.forceDisposeAll();
      original.forceDisposeAll();
    });

    it("cancels an unowned legacy wakeup when Claude confirms ScheduleWakeup stop", async () => {
      const sdkSessionId = "sdk-legacy-wakeup-stop";
      const sdkHandle = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: sdkSessionId,
            slash_commands: [],
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: sdkSessionId,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);

      const original = createService().service;
      const session = await original.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        sdkSessionId,
      });
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [storedWakeup(session.id, {
          durable: true,
          provider: "claude",
        })],
        pausedSessionIds: [],
      });
      const resumed = createService({ db: scheduledWork.db }).service;
      await resumed.resumeSession({ sessionId: session.id });
      await resumed.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the legacy wakeup.",
        timeoutMs: 15_000,
      });
      const resumeOptions = vi.mocked(claudeSdkResumeSessionCompat).mock.calls.at(-1)?.[1] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const postToolUseHook = resumeOptions?.hooks?.PostToolUse?.[0]?.hooks[0];
      expect(postToolUseHook).toEqual(expect.any(Function));

      await postToolUseHook!({
        hook_event_name: "PostToolUse",
        session_id: sdkSessionId,
        tool_name: "ScheduleWakeup",
        tool_use_id: "tool-stop-legacy-wakeup",
        tool_input: { stop: true },
        tool_response: { stopped: true },
      });

      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({
          id: `wakeup:${session.id}`,
          status: "cancelled",
        }),
      ]);
    });

    it("coalesces parentless recurring cron run events with the provider cron row", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-parentless-run",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-run",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-parentless-run",
          task_id: "cron-run-task-1",
          task_type: "cron",
          description: "Check CI status.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-parentless-run",
          task_id: "cron-run-task-1",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "CI passed.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-run",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-parentless-run",
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
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule a recurring CI cron.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "cron-provider-parentless-1",
          schedule: "*/15 * * * *",
          prompt: "Check CI status.",
          recurring: true,
        }],
      });

      startCronRun();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === "cron-provider-parentless-1"
          && event.event.status === "completed",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual([
        "cron-provider-parentless-1",
        "cron-provider-parentless-1",
        "cron-provider-parentless-1",
      ]);

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-provider-parentless-1",
        kind: "cron",
        status: "completed",
        sourceTaskId: "cron-run-task-1",
      });
    });

    it("matches parentless recurring cron runs by prompt when multiple provider crons are active", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-parentless-multiple",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-multiple",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-parentless-multiple",
          task_id: "cron-run-task-multiple",
          task_type: "cron",
          description: "Review issue comments.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-parentless-multiple",
          task_id: "cron-run-task-multiple",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "One new review comment was found.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-multiple",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-parentless-multiple",
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
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule two recurring crons.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [
          {
            id: "cron-provider-multiple-ci",
            schedule: "*/15 * * * *",
            prompt: "Check CI status.",
            recurring: true,
          },
          {
            id: "cron-provider-multiple-review",
            schedule: "*/20 * * * *",
            prompt: "Review issue comments.",
            recurring: true,
          },
        ],
      });

      startCronRun();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === "cron-provider-multiple-review"
          && event.event.status === "completed",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual([
        "cron-provider-multiple-ci",
        "cron-provider-multiple-review",
        "cron-provider-multiple-review",
        "cron-provider-multiple-review",
      ]);
      expect(scheduledEvents.map((event) => event.event.id)).not.toContain("cron-run-task-multiple");

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(2);
      expect(snapshots.find((snapshot) => snapshot.id === "cron-provider-multiple-ci")).toMatchObject({
        id: "cron-provider-multiple-ci",
        kind: "cron",
        status: "scheduled",
      });
      expect(snapshots.find((snapshot) => snapshot.id === "cron-provider-multiple-review")).toMatchObject({
        id: "cron-provider-multiple-review",
        kind: "cron",
        status: "completed",
        sourceTaskId: "cron-run-task-multiple",
      });
    });

    it("does not create task-id scheduled rows for ambiguous parentless cron runs", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-parentless-ambiguous",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-ambiguous",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-parentless-ambiguous",
          task_id: "cron-run-task-ambiguous",
          task_type: "cron",
          description: "Run scheduled maintenance.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-parentless-ambiguous",
          task_id: "cron-run-task-ambiguous",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "Finished scheduled maintenance.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-ambiguous",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-parentless-ambiguous",
        setPermissionMode,
      } as any);

      const { service } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await waitForFakeTimerPromise(
        service.runSessionTurn({
          sessionId: session.id,
          text: "Schedule two recurring crons.",
        }),
        "the cron setup turn to settle",
      );

      const postToolUseHook = opts?.hooks?.PostToolUse?.[0]?.hooks[0];
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-cron-parentless-ambiguous",
        tool_name: "CronCreate",
        tool_use_id: "tool-cron-ambiguous-ci",
        tool_input: { cron: "*/15 * * * *", prompt: "Check CI status." },
        tool_response: { id: "cron-provider-ambiguous-ci", recurring: true },
      });
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-cron-parentless-ambiguous",
        tool_name: "CronCreate",
        tool_use_id: "tool-cron-ambiguous-review",
        tool_input: { cron: "*/20 * * * *", prompt: "Review issue comments." },
        tool_response: { id: "cron-provider-ambiguous-review", recurring: true },
      });
      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [
          {
            id: "cron-provider-ambiguous-ci",
            schedule: "*/15 * * * *",
            prompt: "Check CI status.",
            recurring: true,
          },
          {
            id: "cron-provider-ambiguous-review",
            schedule: "*/20 * * * *",
            prompt: "Review issue comments.",
            recurring: true,
          },
        ],
      });

      vi.setSystemTime(SCHEDULE_TEST_START + 15 * 60_000);
      startCronRun();
      await waitForFakeTimerCondition(
        () => events.some((event) =>
          event.sessionId === session.id
          && event.event.type === "subagent_result"
          && event.event.taskId === "cron-run-task-ambiguous"
        ) && events.some((event) =>
          event.sessionId === session.id
          && event.event.type === "user_message"
          && event.event.metadata?.scheduledWake != null
        ),
        "the ambiguous cron result and scheduled-wake message",
      );
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "subagent_result"
        && event.event.taskId === "cron-run-task-ambiguous"
      )).toBe(true);

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).not.toContain("cron-run-task-ambiguous");
      expect(scheduledEvents.every((event) =>
        event.event.id === "cron-provider-ambiguous-ci"
        || event.event.id === "cron-provider-ambiguous-review"
      )).toBe(true);

      const scheduledWakeMessages = events.filter((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake != null
      );
      expect(scheduledWakeMessages).toHaveLength(1);
      expect(scheduledWakeMessages[0]?.event).toMatchObject({
        type: "user_message",
        metadata: {
          scheduledWake: { scheduleId: "cron-provider-ambiguous-ci" },
        },
      });

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((snapshot) => snapshot.status).sort()).toEqual(["scheduled", "scheduled"]);
      expect(scheduledWork.readState()?.schedules.find((item) =>
        item.id === "cron-provider-ambiguous-ci"
      )?.lastFiredAt).toEqual(expect.any(Number));
      service.forceDisposeAll();
    });

    it("claims a native cron when unrelated idle output already opened the turn", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let releaseIdle!: () => void;
      const idleGate = new Promise<void>((resolve) => { releaseIdle = resolve; });
      let releaseCron!: () => void;
      const cronGate = new Promise<void>((resolve) => { releaseCron = resolve; });
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-existing-idle-turn",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-existing-idle-turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        await idleGate;
        yield {
          type: "tool_progress",
          tool_name: "BackgroundTask",
          elapsed_time_seconds: 1,
        };
        await cronGate;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-existing-idle-turn",
          task_id: "cron-existing-idle-turn-task",
          task_type: "cron",
          description: "Check CI status.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-existing-idle-turn",
          task_id: "cron-existing-idle-turn-task",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "CI passed.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-existing-idle-turn",
          usage: { input_tokens: 2, output_tokens: 2 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-existing-idle-turn",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const options = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const postToolUseHook = options?.hooks?.PostToolUse?.[0]?.hooks[0];

      await waitForFakeTimerPromise(
        service.runSessionTurn({
          sessionId: session.id,
          text: "Keep watching CI in the background.",
        }),
        "the idle-output setup turn to settle",
      );
      await postToolUseHook?.({
        hook_event_name: "PostToolUse",
        session_id: "sdk-cron-existing-idle-turn",
        tool_name: "CronCreate",
        tool_use_id: "tool-cron-existing-idle-turn",
        tool_input: { cron: "*/15 * * * *", prompt: "Check CI status." },
        tool_response: { id: "cron-provider-existing-idle-turn", recurring: true },
      });
      await options?.hooks?.Stop?.[0]?.hooks[0]?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "cron-provider-existing-idle-turn",
          schedule: "*/15 * * * *",
          prompt: "Check CI status.",
          recurring: true,
        }],
      });
      releaseIdle();
      await waitForFakeTimerCondition(
        () => events.some((event) =>
          event.sessionId === session.id
          && event.event.type === "activity"
          && event.event.detail === "Tool 'BackgroundTask' running (1s)"
        ),
        "the unrelated idle activity",
      );
      const idleActivity = events.find((event) =>
        event.sessionId === session.id
        && event.event.type === "activity"
        && event.event.detail === "Tool 'BackgroundTask' running (1s)"
      );
      expect(idleActivity?.event.turnId).toBeTruthy();

      await vi.advanceTimersByTimeAsync(15 * 60_000);
      releaseCron();
      await waitForFakeTimerCondition(
        () => events.some((event) =>
          event.sessionId === session.id
          && event.event.type === "user_message"
          && event.event.metadata?.scheduledWake?.scheduleId === "cron-provider-existing-idle-turn"
        ),
        "the native cron scheduled-wake message",
      );

      const scheduledWake = events.find((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake?.scheduleId === "cron-provider-existing-idle-turn"
      );
      expect(scheduledWake?.event).toMatchObject({
        type: "user_message",
        turnId: idleActivity?.event.turnId,
      });
      const startedTurnIds = events
        .filter((event) => event.sessionId === session.id && event.event.type === "status" && event.event.turnStatus === "started")
        .map((event) => event.event.turnId);
      expect(new Set(startedTurnIds).size).toBe(2);
      service.forceDisposeAll();
    });

    it("does not create task-id scheduled rows for parentless cron runs when aliases are empty", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-empty-aliases",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-empty-aliases",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-empty-aliases",
          task_id: "cron-run-task-empty-aliases",
          task_type: "cron",
          description: "Check CI status.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-empty-aliases",
          task_id: "cron-run-task-empty-aliases",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "CI passed.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-empty-aliases",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-empty-aliases",
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
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Resume after a persisted cron was scheduled.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "cron-provider-empty-aliases",
          schedule: "*/15 * * * *",
          prompt: "Check CI status.",
          recurring: true,
        }],
      });
      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [],
      });

      startCronRun();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "subagent_result"
          && event.event.taskId === "cron-run-task-empty-aliases",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual(["cron-provider-empty-aliases"]);
      expect(scheduledEvents.map((event) => event.event.id)).not.toContain("cron-run-task-empty-aliases");

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-provider-empty-aliases",
        kind: "cron",
        status: "scheduled",
      });
    });
  });
});
