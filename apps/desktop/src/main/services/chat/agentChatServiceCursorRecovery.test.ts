import {
  AgentChatEventEnvelope,
  CROSS_PROVIDER_REPLAY_HEADER,
  CURSOR_SILENCE_WATCHDOG_TRIP_MS,
  acquireCursorSdkConnection,
  createAgentChatService,
  createService,
  flushCursorSdkSilenceRecycle,
  fs,
  mockState,
  parkCursorSend,
  path,
  readPersistedChatState,
  realSetImmediate,
  tmpRoot,
  waitFor,
  waitForEvent,
  waitForFakeTimers,
} from "./agentChatService.testHarness";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

const pumpRealNow = Date.now.bind(Date);

/**
 * How long `pumpUntil` waits in REAL time. The work it waits on is genuinely
 * async — fs reads for the injected Cursor system prompt, sqlite persistence —
 * so the budget has to be wall-clock. An iteration count is not a budget: with
 * no fake timer pending, one iteration costs microseconds, so a loaded runner
 * burns the whole thing while the very first read is still queued behind the
 * libuv pool. Locally the slowest of these waits converges in 11 iterations.
 */
const PUMP_REAL_BUDGET_MS = 5_000;
/**
 * Fake-clock advancing stays capped by iteration so 1ms-per-tick pumping can
 * never drift the virtual clock into the 90s silence watchdog by itself.
 */
const PUMP_FAKE_TICK_BUDGET = 800;
/** Real stall time before `pumpUntil` starts tripping the silence watchdog. */
const PUMP_WATCHDOG_STALL_MS = 1_000;

/**
 * Real async setup work still needs event-loop turns while the clock is faked,
 * so pump the fake clock instead of assuming a fixed number of ticks.
 *
 * Do not trip the silence watchdog while flushing that setup. On a slow
 * runner, jumping 90s during `first cursor send` recycled the turn before
 * the test queued its steer, and the later recovery wait timed out.
 */
const pumpUntil = async (label: string, ready: () => boolean): Promise<void> => {
  const startedAt = pumpRealNow();
  // A silence-watchdog recycle can arm the next attempt's timer after the first
  // 90s jump, so extra trips stay available — but keyed off real stall time
  // rather than a tick index. Tripping on a tick index recycles the runtime
  // whose recovery this is waiting for whenever the loop spins faster than the
  // pending I/O completes, which is exactly what a loaded runner does.
  let nextWatchdogTripAt = startedAt + PUMP_WATCHDOG_STALL_MS;
  let fakeTicksLeft = PUMP_FAKE_TICK_BUDGET;
  while (!ready() && pumpRealNow() - startedAt < PUMP_REAL_BUDGET_MS) {
    if (pumpRealNow() >= nextWatchdogTripAt) {
      nextWatchdogTripAt = pumpRealNow() + PUMP_WATCHDOG_STALL_MS;
      await vi.advanceTimersByTimeAsync(CURSOR_SILENCE_WATCHDOG_TRIP_MS);
      await flushCursorSdkSilenceRecycle();
    } else if (fakeTicksLeft > 0) {
      fakeTicksLeft -= 1;
      await vi.advanceTimersByTimeAsync(1);
    } else {
      // Fake budget spent: keep handing the real event loop turns so pending
      // fs/sqlite callbacks can still land, without moving the virtual clock.
      await new Promise<void>((resolve) => { realSetImmediate(resolve); });
    }
    await Promise.resolve();
  }
  if (!ready()) throw new Error(`pumpUntil timed out waiting for: ${label}`);
};

function parkCursorSteer(): () => void {
  let resolveGate = () => {};
  mockState.cursorSteerGate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const release = () => {
    resolveGate();
    if (mockState.cursorSteerGate) mockState.cursorSteerGate = null;
    const idx = mockState.cursorSteerParks.indexOf(release);
    if (idx >= 0) mockState.cursorSteerParks.splice(idx, 1);
  };
  mockState.cursorSteerParks.push(release);
  mockState.releaseCursorSteer = () => {
    const parks = mockState.cursorSteerParks.splice(0);
    for (const park of parks) park();
  };
  return release;
}

// ---------------------------------------------------------------------------
// vi.mock — external dependencies
// ---------------------------------------------------------------------------


const tripCursorSdkSilenceWatchAndRecycle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(CURSOR_SILENCE_WATCHDOG_TRIP_MS);
  await flushCursorSdkSilenceRecycle();
};

/**
 * Real wall clock and a real event-loop yield, captured before any test can
 * install fake timers. `vi.useFakeTimers()` replaces the global `Date` and
 * `setImmediate`, so a faked test that measures elapsed time or waits for the
 * poll phase has to hold the originals.
 */

describe("createAgentChatService", () => {
  describe("Cursor recovery and steering", () => {
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
  });
});
