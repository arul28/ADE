import {
  AgentChatEventEnvelope,
  createAgentChatService,
  createService,
  fs,
  installRealTranscriptParser,
  mapPermissionToCodex,
  mockState,
  path,
  query,
  readPersistedChatState,
  spawn,
  startup,
  tmpRoot,
  waitFor,
  waitForEvent,
  waitForFakeTimerCondition,
  waitForFakeTimers,
  writePersistedChatState,
  writeTestTranscriptEnvelopes,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("Codex turn recovery", () => {
    it("re-arms a stalled Codex turn when recovery chooses Wait", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
        await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

        const result = await service.recoverCodexTurn({
          sessionId: session.id,
          turnId: "turn-1",
          action: "wait",
        });

        expect(result).toEqual({ action: "wait", turnId: "turn-1", status: "waiting" });
        expect(events.some((event) => event.event.type === "system_notice"
          && event.event.message === "Continuing to wait for Codex output.")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(false);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) => event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1")).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends a same-turn Codex status nudge from recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({ sessionId: session.id, turnId: "turn-1", action: "steer" });

      expect(result.status).toBe("nudged");
      const steerRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/steer");
      expect(steerRequest?.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
      expect(JSON.stringify(steerRequest?.params)).toContain("briefly report your current progress");
    });

    it("finalizes the adopted Codex turn before retrying recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });
      mockState.codexResponseOverrides.set("turn/interrupt", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return params.turnId === "turn-1"
          ? { error: { code: -32000, message: "expected active turn id turn-1 but found turn-real" } }
          : {};
      });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "interrupt_retry_same_thread",
      });

      expect(result.status).toBe("retrying");
      const interrupts = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt");
      expect(interrupts.map((payload) => (payload.params as Record<string, unknown>).turnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/start")).toHaveLength(1);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(false);
    });

    it("restarts app-server, resumes the Codex thread, and retries stalled work", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "restart_resume_thread",
      });

      expect(result.status).toBe("resumed");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume"
        && (payload.params as any)?.threadId === "thread-1")).toBe(true);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
    });

    it("aggregates optional Codex MCP startup failures and auto-recovers a silent first attempt once", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: {
            serverName: "local-tools",
            status: "failed",
            message: "http/request failed: error sending request",
          },
        });
        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: {
            serverName: "local-tools",
            status: "failed",
            message: "http/request failed: error sending request",
          },
        });

        await Promise.resolve();
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("Codex MCP server 'local-tools' is unavailable")
        )).toBe(false);
        expect(events.filter((event) =>
          event.event.type === "turn_diagnostics"
          && event.event.optionalIntegrationFailures?.some((failure) =>
            failure.integration === "local-tools"
          )
        )).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_recovery"
            && event.event.state === "recovered"
            && event.event.automatic
          )).toBe(true);
        });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("persists the Codex automatic-recovery guard across restart while keeping a new turn eligible", async () => {
      vi.useFakeTimers();
      try {
        const first = createService();
        const session = await first.service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await first.service.sendMessage({
          sessionId: session.id,
          text: "Keep this turn running.",
        }, { awaitDispatch: true });
        await first.service.recoverCodexTurn({
          sessionId: session.id,
          turnId: "turn-1",
          action: "wait",
        });

        expect(readPersistedChatState(session.id).codexAutomaticRecoveryAttempted)
          .toBe(true);
        first.service.forceDisposeAll();

        const restartedEvents: AgentChatEventEnvelope[] = [];
        const restarted = createService({
          onEvent: (event: AgentChatEventEnvelope) => restartedEvents.push(event),
        });
        await restarted.service.resumeSession({ sessionId: session.id });
        mockState.emitCodexPayload({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        });
        await Promise.resolve();
        const resumeRequestsBeforeWatchdog = mockState.codexRequestPayloads
          .filter((payload) => payload.method === "thread/resume").length;

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimerCondition(
          () => restartedEvents.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.automaticRecoveryAttempted === true),
          "the resumed turn to remain stalled without another automatic recovery",
        );

        expect(restartedEvents.some((event) =>
          event.event.type === "codex_turn_recovery"
          && event.event.turnId === "turn-1"
          && event.event.automatic)).toBe(false);
        expect(mockState.codexRequestPayloads
          .filter((payload) => payload.method === "thread/resume")).toHaveLength(
            resumeRequestsBeforeWatchdog,
          );

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", items: [] },
          },
        });
        await Promise.resolve();
        await restarted.service.sendMessage({
          sessionId: session.id,
          text: "Start a genuinely new turn.",
        }, { awaitDispatch: true });
        expect(readPersistedChatState(session.id).codexAutomaticRecoveryAttempted)
          .not.toBe(true);

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimerCondition(
          () => restartedEvents.some((event) =>
            event.event.type === "codex_turn_recovery"
            && event.event.turnId === "turn-2"
            && event.event.state === "recovered"
            && event.event.automatic),
          "the new turn to complete its first automatic recovery",
        );
        expect(readPersistedChatState(session.id).codexAutomaticRecoveryAttempted)
          .toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("warns without killing a Codex turn after ten minutes of mid-turn inactivity", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await service.sendMessage({ sessionId: session.id, text: "Run the task." }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: {
              id: "collab-1",
              type: "collabAgentToolCall",
              tool: "spawn_agent",
              prompt: "Inspect one bounded area.",
              status: "inProgress",
            },
          },
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("tracks accepted Codex follow-ups until the app-server proves they were processed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });

      sessionService.clearTurnStartMarkers.mockClear();
      const first = await service.steerUserMessage({
        sessionId: session.id,
        text: "First follow-up.",
      });
      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith(session.id);
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.steerId === first.steerId
        && event.event.deliveryState === "accepted"
        && event.event.processed === false
      )).toBe(true);

      sessionService.clearTurnStartMarkers.mockClear();
      mockState.codexResponseOverrides.set("turn/steer", {
        error: { code: -32603, message: "provider rejected steer" },
      });
      await expect(service.sendMessage({
        sessionId: session.id,
        text: "Rejected follow-up.",
      }, {
        routeActiveToSteer: true,
      })).rejects.toThrow("provider rejected steer");
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      mockState.codexResponseOverrides.delete("turn/steer");

      await service.steerUserMessage({
        sessionId: session.id,
        text: "   ",
      });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();

      await service.steer({
        sessionId: session.id,
        text: "Agent-originated follow-up.",
      });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();

      mockState.emitCodexPayload({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "user-followup-1",
            type: "userMessage",
            content: [{ type: "text", text: "First follow-up." }],
          },
        },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === first.steerId
          && event.event.deliveryState === "processed"
          && event.event.processed === true
        )).toBe(true);
      });

      sessionService.clearTurnStartMarkers.mockClear();
      const second = await service.steer({ sessionId: session.id, text: "Second follow-up." });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === second.steerId
          && event.event.deliveryState === "unprocessed"
          && event.event.processed === false
        )).toBe(true);
      });
    });

    it("correlates combined Codex user-message content without consuming another accepted steer", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });

      const first = await service.steer({ sessionId: session.id, text: "First follow-up." });
      const second = await service.steer({ sessionId: session.id, text: "Second follow-up." });

      mockState.emitCodexPayload({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "unmatched-user-followup",
            type: "userMessage",
            content: [{ type: "text", text: "A provider message unrelated to either steer." }],
          },
        },
      });
      mockState.emitCodexPayload({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "combined-user-followup",
            type: "userMessage",
            content: [
              { type: "text", text: "System context supplied by ADE." },
              { type: "text", text: "Second follow-up." },
            ],
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === second.steerId
          && event.event.deliveryState === "processed"
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.steerId === first.steerId
        && event.event.deliveryState === "processed"
      )).toBe(false);

      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === first.steerId
          && event.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.steerId === second.steerId
        && event.event.deliveryState === "unprocessed"
      )).toBe(false);
    });

    it("restores accepted Codex follow-ups from durable history after a runtime restart", async () => {
      installRealTranscriptParser();
      const first = createService();
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      const transcriptPath = first.sessionService.get(session.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      first.service.forceDisposeAll();
      fs.mkdirSync(path.dirname(String(transcriptPath)), { recursive: true });
      fs.writeFileSync(String(transcriptPath), [
        JSON.stringify({
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Persist this follow-up.",
            displayText: "Persist this follow-up.",
            steerId: "steer-restart-1",
            turnId: "turn-old",
            deliveryState: "accepted",
            processed: false,
          },
        }),
        JSON.stringify({
          sessionId: session.id,
          timestamp: "2026-07-25T05:21:00.000Z",
          sequence: 2,
          event: {
            type: "done",
            status: "interrupted",
            turnId: "turn-old",
          },
        }),
      ].join("\n") + "\n", "utf8");

      const events: AgentChatEventEnvelope[] = [];
      const second = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await second.service.resumeSession({ sessionId: session.id });

      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === "steer-restart-1"
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
    });

    // A Cursor / OpenCode / Pi row reads `accepted` only while this process
    // awaits the provider. A crash in that window leaves it "Steering…" for
    // good unless the next load fails it.
    it.each([
      { label: "fails a Cursor steer a crash left accepted", provider: "cursor", swept: true },
      { label: "leaves a Codex accepted steer to its own hydration", provider: "codex", swept: false },
      { label: "leaves a Cursor steer that is still on the restored queue", provider: "cursor", swept: false, onQueue: true },
      { label: "leaves a Cursor steer another ADE home's brain owns", provider: "cursor", swept: false, foreignOwner: true },
    ] as const)("on load, $label", async ({ provider, swept, ...fixture }) => {
      installRealTranscriptParser();
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const first = createService();
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider,
        model: provider === "codex" ? "gpt-5.5" : "composer-2",
        ...(provider === "cursor" ? { modelId: "cursor/composer-2" } : {}),
      });
      const transcriptPath = String(first.sessionService.get(session.id)?.transcriptPath);
      first.service.forceDisposeAll();
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${JSON.stringify({
        sessionId: session.id,
        timestamp: "2026-09-24T05:20:00.000Z",
        sequence: 1,
        event: {
          type: "user_message",
          text: "Steered right before the crash.",
          steerId: "steer-orphan",
          turnId: "turn-old",
          deliveryState: "accepted",
        },
      })}\n`, "utf8");
      const fireAt = Date.now() + 30 * 60_000;
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        // Armed by a usage limit: failing the row is not the chat doing work,
        // so it must not clear this.
        usageLimitResume: {
          state: "armed",
          provider,
          fireAt: new Date(fireAt).toISOString(),
          resetAt: new Date(fireAt - 90_000).toISOString(),
          scheduleId: `auto-resume:${session.id}`,
          attempts: 1,
          providerDetail: "100% utilized",
          turnId: "turn-old",
          updatedAt: new Date().toISOString(),
        },
        ...("onQueue" in fixture ? { pendingSteers: [{ steerId: "steer-orphan", text: "Steered right before the crash." }] } : {}),
        ...("foreignOwner" in fixture
          ? { runtimeOwner: { brainId: "other-brain", pid: 4242, startedAt: null, adeHome: "/elsewhere/.ade" } }
          : {}),
      });

      const events: AgentChatEventEnvelope[] = [];
      const second = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      await second.service.resumeSession({ sessionId: session.id });

      const failed = events.filter((entry) =>
        entry.event.type === "user_message"
        && entry.event.steerId === "steer-orphan"
        && entry.event.deliveryState === "failed");
      expect(failed).toHaveLength(swept ? 1 : 0);
      if (swept) {
        expect(failed[0]!.event).toMatchObject({ text: "Steered right before the crash.", turnId: "turn-old" });
        expect((await second.service.getSessionSummary(session.id))?.usageLimitResume ?? null).not.toBeNull();
      }
      second.service.forceDisposeAll();
    });

    it("runs an unprocessed Codex follow-up once and records an idempotent durable resolution", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });
      const followUp = await service.steer({ sessionId: session.id, text: "Run this exactly once." });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
      const turnStartsBefore = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length;

      const first = await service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });
      const second = await service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });

      expect(first).toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        status: "completed",
        replacementMessageId: expect.any(String),
      });
      expect(second).toEqual({
        ...first,
        status: "already_completed",
      });
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBefore + 1);
      expect(events.filter((entry) =>
        entry.event.type === "user_message"
        && entry.event.metadata?.replayedFromUnprocessedSteer?.sourceSteerId === followUp.steerId
      )).toHaveLength(1);
      expect(events.filter((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === followUp.steerId
        && entry.event.action === "run_next"
      )).toHaveLength(1);
    });

    it("does not treat optimistic replay rows as a durable backend dispatch after restart", async () => {
      installRealTranscriptParser();
      const first = createService();
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      first.service.forceDisposeAll();

      const sourceSteerId = "steer-restart-1";
      const optimisticReplacementMessageId = "replacement-before-backend-ack";
      writeTestTranscriptEnvelopes(session.id, [
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Run this after the current turn.",
            steerId: sourceSteerId,
            deliveryState: "unprocessed",
            processed: false,
            turnId: "turn-old",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:01.000Z",
          sequence: 2,
          event: {
            type: "user_message",
            text: "Run this after the current turn.",
            turnId: "optimistic-turn",
            metadata: {
              replayedFromUnprocessedSteer: {
                sourceSteerId,
                action: "run_next",
                replacementMessageId: optimisticReplacementMessageId,
              },
            },
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:01.001Z",
          sequence: 3,
          event: {
            type: "status",
            turnStatus: "started",
            turnId: "optimistic-turn",
          },
        },
      ]);

      const emitted: AgentChatEventEnvelope[] = [];
      const second = createService({
        onEvent: (event: AgentChatEventEnvelope) => emitted.push(event),
      });
      const turnStartsBefore = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      const retried = await second.service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: sourceSteerId,
        action: "run_next",
      });

      expect(retried).toMatchObject({
        steerId: sourceSteerId,
        action: "run_next",
        status: "completed",
        replacementMessageId: expect.any(String),
      });
      expect(retried.replacementMessageId).not.toBe(optimisticReplacementMessageId);
      expect(emitted.some((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === sourceSteerId
        && entry.event.action === "run_next"
      )).toBe(true);
      expect(emitted.some((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.replacementMessageId === retried.replacementMessageId
      )).toBe(true);
      expect(mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBefore + 1);
    });

    it("reconstructs a missing replay resolution from the durable backend dispatch receipt", async () => {
      installRealTranscriptParser();
      const firstEvents: AgentChatEventEnvelope[] = [];
      const first = createService({
        onEvent: (event: AgentChatEventEnvelope) => firstEvents.push(event),
      });
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await first.service.sendMessage(
        { sessionId: session.id, text: "Start." },
        { awaitDispatch: true },
      );
      const followUp = await first.service.steer({
        sessionId: session.id,
        text: "Run this once after restart.",
      });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(firstEvents.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });

      const dispatched = await first.service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });
      const persistedReceipt = readPersistedChatState(session.id)
        .unprocessedMessageResolutionReceipts
        ?.find((receipt: Record<string, unknown>) => receipt.steerId === followUp.steerId);
      expect(persistedReceipt).toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        state: "completed",
        replacementMessageId: dispatched.replacementMessageId,
      });

      first.service.forceDisposeAll();
      await new Promise((resolve) => setTimeout(resolve, 250));
      writeTestTranscriptEnvelopes(session.id, [
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Run this once after restart.",
            steerId: followUp.steerId,
            deliveryState: "unprocessed",
            processed: false,
            turnId: "turn-old",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:01.000Z",
          sequence: 2,
          event: {
            type: "user_message",
            text: "Run this once after restart.",
            metadata: {
              replayedFromUnprocessedSteer: {
                sourceSteerId: followUp.steerId,
                action: "run_next",
                replacementMessageId: dispatched.replacementMessageId!,
              },
            },
          },
        },
      ]);

      const restartedEvents: AgentChatEventEnvelope[] = [];
      const restarted = createService({
        onEvent: (event: AgentChatEventEnvelope) => restartedEvents.push(event),
      });
      const turnStartsBeforeRetry = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      const retried = await restarted.service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });

      expect(retried).toEqual({
        steerId: followUp.steerId,
        action: "run_next",
        status: "already_completed",
        replacementMessageId: dispatched.replacementMessageId,
      });
      expect(mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBeforeRetry);
      expect(restartedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message_resolution",
            steerId: followUp.steerId,
            action: "run_next",
            replacementMessageId: dispatched.replacementMessageId,
          }),
        }),
      ]));
    });

    it("allows Run next to retry when the optimistic replacement never reached the provider", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage(
        { sessionId: session.id, text: "Start." },
        { awaitDispatch: true },
      );
      const followUp = await service.steer({
        sessionId: session.id,
        text: "Retry me if the provider rejects the dispatch.",
      });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });

      mockState.codexResponseOverrides.set("turn/start", {
        error: { code: -32_000, message: "replay start exploded" },
      });
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).rejects.toThrow(/replay start exploded/i);
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "done"
          && entry.event.status === "failed"
        )).toBe(true);
      });

      mockState.codexResponseOverrides.delete("turn/start");
      const turnStartsBeforeRetry = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).resolves.toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        status: "completed",
        replacementMessageId: expect.any(String),
      });
      expect(mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBeforeRetry + 1);
    });

    it("keeps Run next retryable when storage pressure prevents backend dispatch", async () => {
      installRealTranscriptParser();
      let allowTurns = true;
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        diskPressureMonitor: {
          canPerform: vi.fn(() => allowTurns
            ? { allowed: true, state: "normal" }
            : {
                allowed: false,
                state: "exhausted",
                code: "disk_full",
                message: "Your computer is almost out of storage.",
              }),
        },
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage(
        { sessionId: session.id, text: "Start." },
        { awaitDispatch: true },
      );
      const followUp = await service.steer({
        sessionId: session.id,
        text: "Run this when storage is ready.",
      });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });

      allowTurns = false;
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).rejects.toThrow(/provider did not accept/i);
      expect(events.some((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === followUp.steerId
      )).toBe(false);

      allowTurns = true;
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).resolves.toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        status: "completed",
      });
    });

    it("dismisses an unprocessed Codex follow-up idempotently without starting a turn", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });
      const followUp = await service.steer({ sessionId: session.id, text: "Dismiss me." });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
      const turnStartsBefore = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length;

      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "dismiss",
      })).resolves.toMatchObject({ status: "completed", action: "dismiss" });
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "dismiss",
      })).resolves.toMatchObject({ status: "already_completed", action: "dismiss" });

      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBefore);
      expect(events.filter((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === followUp.steerId
        && entry.event.action === "dismiss"
      )).toHaveLength(1);
    });

    it("maps the provider-neutral recovery contract onto Codex recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      await expect(service.recoverTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "nudge",
      })).resolves.toEqual({
        action: "nudge",
        turnId: "turn-1",
        status: "nudged",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(true);
    });

    it("re-arms the Codex watchdog after the user answers a suspended approval", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await service.sendMessage(
          { sessionId: session.id, text: "Keep working." },
          { awaitDispatch: true },
        );
        mockState.emitCodexPayload({
          id: "approval-rearm-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-rearm-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: ".",
            reason: "Run tests",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-rearm-1"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
        // Let the suspended reconcile finish and drop its in-flight lock
        // before the answer re-arms the timer. Otherwise the second 10-minute
        // advance can no-op while that first reconcile is still awaiting a
        // thread/read microtask.
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

        await service.respondToInput({
          sessionId: session.id,
          itemId: "cmd-rearm-1",
          decision: "accept",
        });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-arms the Codex watchdog after full-auto resolves a suspended approval", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
          if (mode === "full-auto") {
            return { approvalPolicy: "never", sandbox: "danger-full-access" };
          }
          return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        });
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          permissionMode: "edit",
        });
        await service.sendMessage(
          { sessionId: session.id, text: "Keep working." },
          { awaitDispatch: true },
        );
        mockState.emitCodexPayload({
          id: "auto-resolved-approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-auto-resolved-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: tmpRoot,
            reason: "Run tests",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-auto-resolved-1"
          )).toBe(true);
        });

        await service.updateSession({
          sessionId: session.id,
          permissionMode: "full-auto",
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "pending_input_resolved"
            && event.event.itemId === "cmd-auto-resolved-1"
            && event.event.resolution === "accepted"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-arms the Codex watchdog when the app server resolves a suspended approval", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await service.sendMessage(
          { sessionId: session.id, text: "Keep working." },
          { awaitDispatch: true },
        );
        mockState.emitCodexPayload({
          id: "server-resolved-approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-server-resolved-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: ".",
            reason: "Run tests",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-server-resolved-1"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);

        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            requestId: "server-resolved-approval-1",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "pending_input_resolved"
            && event.event.itemId === "cmd-server-resolved-1"
          )).toBe(true);
        });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconciles a completed silent Codex turn from app-server state before reporting a stall", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 7, outputTokens: 3 },
              items: [
                {
                  id: "msg-1",
                  type: "agentMessage",
                  text: "Recovered assistant output.",
                },
              ],
            },
          ],
          nextCursor: null,
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed"
          )).toBe(true);
        });

        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/read")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/turns/list")).toBe(true);
        expect(events.some((event) =>
          event.event.type === "text"
          && event.event.text.includes("Recovered assistant output.")
        )).toBe(true);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not complete a reconciled MCP tool call while app-server still reports it running", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [
                {
                  id: "mcp-1",
                  type: "mcpToolCall",
                  server: "local-tools",
                  tool: "probe",
                  pluginId: "local-plugin",
                  appContext: {
                    connectorId: "local",
                    appName: "Local tools",
                    actionName: "Probe file",
                    resourceUri: "ui://local/probe",
                  },
                  status: "running",
                  arguments: { path: "README.md" },
                },
              ],
            },
          ],
          nextCursor: null,
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "tool_call"
            && event.event.itemId === "mcp-1"
            && event.event.mcp?.pluginId === "local-plugin"
            && event.event.mcp?.appContext?.appName === "Local tools"
          )).toBe(true);
        }, { steps: 200, realYield: true });

        expect(events.some((event) =>
          event.event.type === "tool_result"
          && event.event.itemId === "mcp-1"
        )).toBe(false);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves the Codex imageGeneration lifecycle and local output path", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Generate a tiny moon icon." }, { awaitDispatch: true });

      const item = {
        id: "image-1",
        type: "imageGeneration",
        status: "inProgress",
        prompt: "A tiny moon icon",
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item },
      });
      const started = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
          event.event.type === "codex_image_generation" && event.event.itemId === "image-1",
      );
      expect(started.event).toMatchObject({
        prompt: "A tiny moon icon",
        status: "running",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            ...item,
            status: "completed",
            revisedPrompt: "A crisp crescent moon icon",
            result: "/tmp/generated-moon.png",
          },
        },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "codex_image_generation"
          && event.event.itemId === "image-1"
          && event.event.status === "completed"
          && event.event.savedPath === "/tmp/generated-moon.png"
        )).toBe(true);
      });
    });

    it("preserves live Codex MCP app metadata for Sources aggregation", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "Use the docs connector." }, { awaitDispatch: true });

      const item = {
        id: "mcp-live-1",
        type: "mcpToolCall",
        server: "openaiDeveloperDocs",
        tool: "search",
        status: "inProgress",
        arguments: { query: "GPT-5.6" },
        pluginId: "openai-docs",
        appContext: {
          connectorId: "openai-docs",
          linkId: "docs-link",
          resourceUri: "ui://openai-docs/search",
          appName: "OpenAI Docs",
          templateId: "search-results",
          actionName: "Search documentation",
        },
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "tool_call" }> } =>
          event.event.type === "tool_call" && event.event.itemId === "mcp-live-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            ...item,
            status: "completed",
            result: { title: "GPT-5.6", url: "https://developers.openai.com/api/docs/models" },
          },
        },
      });
      const completed = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }> } =>
          event.event.type === "tool_result" && event.event.itemId === "mcp-live-1",
      );

      expect(completed.event).toMatchObject({
        tool: "openaiDeveloperDocs:search",
        status: "completed",
        mcp: {
          server: "openaiDeveloperDocs",
          tool: "search",
          pluginId: "openai-docs",
          resourceUri: "ui://openai-docs/search",
          appContext: {
            connectorId: "openai-docs",
            appName: "OpenAI Docs",
            actionName: "Search documentation",
          },
        },
      });
    });

    it("re-arms the Codex watchdog after partial same-thread recovery", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let turnsListCalls = 0;
        mockState.codexResponseOverrides.set("thread/turns/list", () => {
          turnsListCalls += 1;
          return {
            data: [
              {
                id: "turn-1",
                status: "inProgress",
                items: [
                  {
                    id: "reasoning-1",
                    type: "reasoning",
                    summary: ["Recovered partial reasoning."],
                  },
                ],
              },
            ],
            nextCursor: null,
          };
        });
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "reasoning"
            && event.event.text.includes("Recovered partial reasoning.")
          )).toBe(true);
        });
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
        expect(events.filter((event) =>
          event.event.type === "reasoning"
          && event.event.text.includes("Recovered partial reasoning.")
        )).toHaveLength(1);
        expect(turnsListCalls).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not double-finalize when a normal Codex completion wins the silent-turn reconciliation race", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.delayedCodexMethods.add("thread/turns/list");
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 7, outputTokens: 3 },
              items: [
                {
                  id: "msg-after-complete",
                  type: "agentMessage",
                  text: "Recovered after the normal completion.",
                },
              ],
            },
          ],
          nextCursor: null,
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(mockState.pendingCodexResponses).toHaveLength(1);
        });

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 11, outputTokens: 5 },
            },
          },
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed",
        );

        mockState.flushCodexResponses();
        await Promise.resolve();

        const doneEvents = events.filter((event) =>
          event.event.type === "done"
          && event.event.turnId === "turn-1"
          && event.event.status === "completed"
        );
        expect(doneEvents).toHaveLength(1);
        expect(events.some((event) =>
          event.event.type === "text"
          && event.event.text.includes("Recovered after the normal completion.")
        )).toBe(false);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not emit a stale stall when a normal Codex completion wins after turns-list fails", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.delayedCodexMethods.add("thread/turns/list");
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          error: { code: -32000, message: "thread state unavailable" },
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(mockState.pendingCodexResponses).toHaveLength(1);
        });

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 11, outputTokens: 5 },
            },
          },
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed",
        );

        mockState.flushCodexResponses();
        await Promise.resolve();

        expect(events.filter((event) =>
          event.event.type === "done"
          && event.event.turnId === "turn-1"
          && event.event.status === "completed"
        )).toHaveLength(1);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("routes structured Codex stall notices to a spawn parent without auto-handoff", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const parent = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        const child = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          orchestrationParentSessionId: parent.id,
          spawnKind: "subagent",
        });

        await service.sendMessage({
          sessionId: child.id,
          text: "Keep working.",
        }, { awaitDispatch: true });
        await service.recoverCodexTurn({
          sessionId: child.id,
          turnId: "turn-1",
          action: "wait",
        });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.sessionId === parent.id
            && event.event.type === "codex_turn_stalled"
            && event.event.sourceSessionId === child.id
          )).toBe(true);
        });

        expect(events.some((event) =>
          event.sessionId === child.id
          && event.event.type === "codex_turn_stalled"
          && event.event.reason === "no_output"
        )).toBe(true);
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "turn_health"
          && event.event.sourceSessionId === child.id
        )).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

  });
});
