import {
  AgentChatEventEnvelope,
  SCHEDULE_TEST_START,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createMemoryTurnUsageLedger,
  createScheduledWorkDb,
  createService,
  fs,
  installClaudeResponseFixture,
  installClaudeWakeupFixture,
  makeLaneLinearIssue,
  makeLinearIssueContextAttachment,
  mockState,
  path,
  query,
  readPersistedChatState,
  spawn,
  startOpenCodeSession,
  startup,
  storedWakeup,
  streamText,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  waitForEvent,
  waitForFakeTimers,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("hasRetainableSessions", () => {
    it("is true while any chat session is open and false after it is closed", async () => {
      const { service } = createService();
      expect(service.hasRetainableSessions()).toBe(false);

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      // Idle session (no active turn, no pending input) — hasActiveWorkloads
      // is narrow and returns false. hasRetainableSessions must still report
      // true so project-context rebalancing keeps the agent runtime alive
      // for an instant resume after a project switch.
      expect(service.hasActiveWorkloads()).toBe(false);
      expect(service.hasRetainableSessions()).toBe(true);

      await service.dispose({ sessionId: session.id });
      expect(service.hasRetainableSessions()).toBe(false);
    });
  });

  describe("dispose", () => {
    it("only writes the persisted chat summary when the session is explicitly disposed", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Investigate the flaky login tests",
      });

      expect(sessionService.setSummary).not.toHaveBeenCalled();

      await service.dispose({ sessionId: session.id });

      expect(sessionService.setSummary).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining("Session closed"),
      );
    });

    it("disposes a session and marks it ended", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.dispose({ sessionId: session.id });

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it("dispose quarantines durable provider schedules instead of hiding live provider work", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-dispose-cancel",
        delaySeconds: 60,
      });
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Check CI again later.",
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: session.id, status: "scheduled" }),
      ]);

      await service.dispose({ sessionId: session.id });

      expect(sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "disposed",
        endedAt: expect.any(String),
      }));
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: session.id, status: "paused", pausedFlag: true }),
      ]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.id,
          event: expect.objectContaining({
            type: "scheduled_work_update",
            status: "paused",
          }),
        }),
      ]));
      service.forceDisposeAll();
    });

    it("a scheduled fire after dispose does not resume the session", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-dispose-no-fire",
        delaySeconds: 1,
      });
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Wake once to check CI.",
      });
      await service.dispose({ sessionId: session.id });
      const startedTurnsBeforeAdvance = events.filter((event) =>
        event.sessionId === session.id
        && event.event.type === "status"
        && event.event.turnStatus === "started"
      ).length;

      await vi.advanceTimersByTimeAsync(65_000);

      expect(sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "disposed",
        endedAt: expect.any(String),
      }));
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("paused");
      expect(events.filter((event) =>
        event.sessionId === session.id
        && event.event.type === "status"
        && event.event.turnStatus === "started"
      )).toHaveLength(startedTurnsBeforeAdvance);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake != null
      )).toBe(false);
      service.forceDisposeAll();
    });

    it("injects the overdue prompt when the live Claude native scheduler misses its tick", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      const { send } = installClaudeWakeupFixture({
        sdkSessionId: "sdk-backstop-input",
        delaySeconds: 60,
        prompt: "Deliver the missed native wake through ADE.",
        // The provider never emits a native cron turn after the foreground
        // result. ADE must push a real user message into this live query.
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
        text: "Schedule a native wake.",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await foregroundTurn;
      const sendsBeforeBackstop = send.mock.calls.length;
      await vi.advanceTimersByTimeAsync(149_000);
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("fired");
      expect(send).toHaveBeenCalledTimes(sendsBeforeBackstop + 1);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake?.reason === "Check PR CI"
        && event.event.text === "Deliver the missed native wake through ADE."
      )).toBe(true);

      await service.dispose({ sessionId: session.id });
      service.forceDisposeAll();
    });

    it("evicts disposed chats from the live managed session cache", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(service.getSlashCommands({ sessionId: session.id })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "/clear" }),
        ]),
      );

      await service.dispose({ sessionId: session.id });

      expect(service.getSlashCommands({ sessionId: session.id })).toEqual([]);
    });

    it("terminates the Codex runtime process tree when disposing a live Codex chat", async () => {
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);
      vi.useFakeTimers();
      try {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Inspect the repo",
        }, { awaitDispatch: true });

        await service.dispose({ sessionId: session.id });

        expect(spawn).toHaveBeenCalledWith(
          "codex",
          ["app-server"],
          expect.objectContaining({ detached: process.platform !== "win32" }),
        );
        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGTERM");

        await vi.advanceTimersByTimeAsync(1500);
        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws when disposing an unknown session", async () => {
      const { service } = createService();
      await expect(service.dispose({ sessionId: "no-such-session" })).rejects.toThrow(/not found/i);
    });

    it("maps an attach_failed OpenCode eviction reason to handle_close when tearing down the runtime", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Investigate the flaky login tests",
      });

      const startMock = vi.mocked(startOpenCodeSession);
      expect(startMock.mock.results.length).toBeGreaterThan(0);
      const handle = await startMock.mock.results.at(-1)!.value as {
        setEvictionHandler: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };

      const evictionCalls = handle.setEvictionHandler.mock.calls;
      // The most-recent non-null handler registration is the one that wires up teardown.
      const registrations = evictionCalls
        .map((args) => args[0])
        .filter((fn): fn is (reason: string) => void => typeof fn === "function");
      expect(registrations.length).toBeGreaterThan(0);
      const evictionHandler = registrations[registrations.length - 1]!;

      const closeCallsBefore = handle.close.mock.calls.length;
      await evictionHandler("attach_failed");

      const closeReasonsAfter = handle.close.mock.calls.slice(closeCallsBefore).map(([reason]) => reason);
      expect(closeReasonsAfter).toContain("handle_close");
      expect(closeReasonsAfter).not.toContain("attach_failed");
    });
  });

  describe("disposeAll", () => {
    it("disposes all active sessions without throwing", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      mockState.uuidCounter = 10; // avoid collision
      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      // Should not throw
      await expect(service.disposeAll()).resolves.toBeUndefined();
    });

    it("asks the Claude subprocess reaper to terminate remaining SDK children", async () => {
      const claudeSubprocessReaper = {
        register: vi.fn(),
        spawnClaudeCodeProcess: vi.fn(),
        reapForSession: vi.fn(),
        reapAll: vi.fn(),
        liveRecords: vi.fn(() => []),
      };
      const { service } = createService({ claudeSubprocessReaper });

      await expect(service.disposeAll()).resolves.toBeUndefined();

      expect(claudeSubprocessReaper.reapAll).toHaveBeenCalledWith("dispose_all");
    });

    it("disposeAll ends sessions as detached and preserves scheduled work", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-dispose-all-detached",
        delaySeconds: 60,
      });
      const { service, sessionService } = createService({ db: scheduledWork.db });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule work across restart.",
      });

      await service.disposeAll();

      expect(sessionService.end).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.id,
        status: "detached",
      }));
      expect(sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "detached",
        endedAt: expect.any(String),
      }));
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: session.id, status: "scheduled" }),
      ]);
    });

    it("scheduled fire into a detached session still delivers by cold resume", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-detached-cold-resume",
        delaySeconds: 60,
        prompt: "Deliver this wake after restart.",
      });
      const first = createService({ db: scheduledWork.db });
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await first.service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule restart work.",
      });
      await first.service.disposeAll();

      const events: AgentChatEventEnvelope[] = [];
      installClaudeResponseFixture({
        sdkSessionId: "sdk-detached-cold-resume",
        responseText: "Cold scheduled work delivered.",
      });
      const restarted = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await restarted.service.refreshScheduledWork();

      await vi.advanceTimersByTimeAsync(150_000);
      await waitForFakeTimers(() => {
        expect(events.some((event) =>
          event.sessionId === session.id
          && event.event.type === "user_message"
          && event.event.metadata?.scheduledWake?.reason === "Check PR CI"
        )).toBe(true);
      });

      expect(restarted.sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "running",
        endedAt: null,
      }));
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(true);
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("done");
      restarted.service.forceDisposeAll();
    });
  });

  describe("disposeForLane", () => {
    it("cancels schedules for lane sessions including unmanaged ones", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      mockState.sessions.set("unmanaged-lane-1", {
        id: "unmanaged-lane-1",
        laneId: "lane-1",
        toolType: "claude-chat",
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        archivedAt: null,
      });
      mockState.sessions.set("unmanaged-lane-2", {
        id: "unmanaged-lane-2",
        laneId: "lane-2",
        toolType: "claude-chat",
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        archivedAt: null,
      });
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [
          storedWakeup("unmanaged-lane-1"),
          storedWakeup("unmanaged-lane-2"),
          storedWakeup("missing-session"),
        ],
        pausedSessionIds: [],
      });
      const { service } = createService({ db: scheduledWork.db });

      await expect(service.disposeForLane("lane-1")).resolves.toBe(0);

      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: "missing-session", status: "cancelled" }),
        expect.objectContaining({ sessionId: "unmanaged-lane-1", status: "cancelled" }),
        expect.objectContaining({ sessionId: "unmanaged-lane-2", status: "scheduled" }),
      ]);
      service.forceDisposeAll();
    });
  });

  describe("forceDisposeAll", () => {
    it("rejects active runSessionTurn calls during shutdown", async () => {
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = () => resolve();
      });
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Still working" };
          await streamGate;
        })(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep running",
        timeoutMs: null,
      });
      const turnExpectation = expect(turn).rejects.toThrow(/shutdown/i);

      try {
        service.forceDisposeAll();
        await turnExpectation;
      } finally {
        releaseStream();
      }
    });

    it("marks an active Codex app-server turn interrupted during shutdown", async () => {
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
        text: "Start a turn that is still active during shutdown.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      service.forceDisposeAll();

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            message: expect.stringMatching(/stopped this Codex turn/i),
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "status",
            turnStatus: "interrupted",
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "done",
            status: "interrupted",
            turnId: "turn-1",
          }),
        }),
      ]));
    });
  });

  describe("deleteSession", () => {
    it.each([
      { action: "delete" as const, warning: "agent_chat.scheduled_work_cancel_before_delete_failed" },
      { action: "archive" as const, warning: "agent_chat.scheduled_work_cancel_before_archive_failed" },
    ])("honors $action when provider schedule cancellation times out", async ({ action, warning }) => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [storedWakeup("test-uuid-1", {
          provider: "claude",
          providerSessionId: "sdk-lifecycle-timeout",
          providerScheduleId: "provider-lifecycle-timeout",
          durable: true,
        })],
        pausedSessionIds: [],
      });
      installClaudeResponseFixture({
        sdkSessionId: "sdk-lifecycle-timeout",
        responseText: "I could not delete that schedule.",
      });
      const { service, sessionService, logger } = createService({ db: scheduledWork.db });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start the Claude session.",
      });

      const operation = action === "delete"
        ? service.deleteSession({ sessionId: session.id })
        : service.archiveSession({ sessionId: session.id });
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(operation).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        warning,
        expect.objectContaining({ sessionId: session.id }),
      );
      if (action === "delete") {
        expect(sessionService.get(session.id)).toBeNull();
      } else {
        expect(sessionService.get(session.id)?.archivedAt).toEqual(expect.any(String));
      }
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ status: "cancelled", terminalAt: expect.any(Number) }),
      ]);
      service.forceDisposeAll();
    });

    it("forgets the latest turn start of a deleted chat", async () => {
      installClaudeResponseFixture({
        sdkSessionId: "sdk-turn-start-delete",
        responseText: "Done.",
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({ sessionId: session.id, text: "Start the Claude session." });
      expect(service.getTurnStartedAt(session.id)).toEqual(expect.any(String));

      await service.deleteSession({ sessionId: session.id });

      expect(service.getTurnStartedAt(session.id)).toBeNull();
      service.forceDisposeAll();
    });

    it("removes persisted chat artifacts and the stored session row", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const metadataPath = path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${session.id}.json`);
      const dedicatedTranscriptPath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      const mainTranscriptPath = sessionService.get(session.id)?.transcriptPath ?? "";

      fs.writeFileSync(metadataPath, JSON.stringify({ sessionId: session.id }), "utf8");
      fs.mkdirSync(path.dirname(dedicatedTranscriptPath), { recursive: true });
      fs.writeFileSync(dedicatedTranscriptPath, "{\"event\":\"done\"}\n", "utf8");
      fs.mkdirSync(path.dirname(mainTranscriptPath), { recursive: true });
      fs.writeFileSync(mainTranscriptPath, "{\"event\":\"done\"}\n", "utf8");

      await service.dispose({ sessionId: session.id });
      await service.deleteSession({ sessionId: session.id });

      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
      expect(sessionService.get(session.id)).toBeNull();
      expect(fs.existsSync(metadataPath)).toBe(false);
      expect(fs.existsSync(dedicatedTranscriptPath)).toBe(false);
      expect(fs.existsSync(mainTranscriptPath)).toBe(false);
      await expect(service.getSessionSummary(session.id)).resolves.toBeNull();
    });

    it("disposes running chats before purging them", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.deleteSession({ sessionId: session.id });

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id }),
      );
      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
    });

    it("terminates an automation Codex provider and cancels its open automation run", async () => {
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);
      const cancelRunForDeletedChat = vi.fn();
      vi.useFakeTimers();
      try {
        const { service, sessionService } = createService({
          getAutomationService: () => ({
            list: () => [],
            triggerManually: vi.fn(),
            listRuns: () => [],
            cancelRunForDeletedChat,
          }),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
          surface: "automation",
          automationId: "release-ade",
          automationRunId: "run-release",
        });
        await service.sendMessage({
          sessionId: session.id,
          text: "Run the release.",
        }, { awaitDispatch: true });

        await service.deleteSession({ sessionId: session.id });

        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGTERM");
        expect(sessionService.get(session.id)).toBeNull();
        expect(cancelRunForDeletedChat).toHaveBeenCalledWith({
          sessionId: session.id,
          runId: "run-release",
        });

        await vi.advanceTimersByTimeAsync(1_500);
        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("purges a running Codex chat even when app-server interrupt and archive requests hang", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start a Codex turn.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.delayedCodexMethods.add("turn/interrupt");
      mockState.delayedCodexMethods.add("thread/archive");
      vi.useFakeTimers();
      try {
        const deleted = service.deleteSession({ sessionId: session.id });
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(deleted).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, status: "disposed" }),
      );
      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
      expect(sessionService.get(session.id)).toBeNull();
    });

    it("does not follow transcript symlinks outside ADE during purge", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const mainTranscriptPath = sessionService.get(session.id)?.transcriptPath ?? "";
      const outsideTranscriptPath = path.join(tmpHomeRoot, "outside-transcript.jsonl");
      fs.writeFileSync(outsideTranscriptPath, "{\"event\":\"done\"}\n", "utf8");
      fs.mkdirSync(path.dirname(mainTranscriptPath), { recursive: true });
      fs.rmSync(mainTranscriptPath, { force: true });
      fs.symlinkSync(outsideTranscriptPath, mainTranscriptPath);

      await service.deleteSession({ sessionId: session.id });

      expect(fs.existsSync(outsideTranscriptPath)).toBe(true);
      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
    });
  });

  // --------------------------------------------------------------------------
  // cleanupStaleAttachments
  // --------------------------------------------------------------------------

  describe("cleanupStaleAttachments", () => {
    it("does nothing when attachments directory does not exist", () => {
      const { service } = createService();
      // Should not throw
      expect(() => service.cleanupStaleAttachments()).not.toThrow();
    });

    it("removes files older than 7 days", () => {
      const { service } = createService();
      const attachDir = path.join(tmpRoot, ".ade", "attachments");
      fs.mkdirSync(attachDir, { recursive: true });

      // Create an old file
      const oldFile = path.join(attachDir, "old-attachment.txt");
      fs.writeFileSync(oldFile, "old data");
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

      // Create a recent file
      const recentFile = path.join(attachDir, "recent-attachment.txt");
      fs.writeFileSync(recentFile, "recent data");

      service.cleanupStaleAttachments();

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it("preserves old image files still referenced by a prompt stash", () => {
      const attachDir = path.join(tmpRoot, ".ade", "attachments");
      fs.mkdirSync(attachDir, { recursive: true });
      const stashedImage = path.join(attachDir, "stashed-image.png");
      fs.writeFileSync(stashedImage, "image data");
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(stashedImage, eightDaysAgo, eightDaysAgo);

      const { service } = createService({
        db: {
          getJson: vi.fn(),
          setJson: vi.fn(),
          run: vi.fn(),
          get: vi.fn().mockReturnValue({ site_id: "site-a" }),
          all: vi.fn().mockReturnValue([{
            attachments_json: JSON.stringify([{ path: stashedImage, type: "image" }]),
            attachment_origin_site_id: "site-a",
          }]),
        },
      });

      service.cleanupStaleAttachments();

      expect(fs.existsSync(stashedImage)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Multiple sessions lifecycle
  // --------------------------------------------------------------------------

  describe("session lifecycle", () => {
    it("creates multiple sessions and lists them independently", async () => {
      const { service } = createService();

      const s1 = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      mockState.uuidCounter = 100;
      const s2 = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(s1.id).not.toBe(s2.id);

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(2);
    });

    it("deduplicates Codex compatibility item notifications", async () => {
      const events: Array<{ type: string; tool?: string; itemId?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            tool: "tool" in event.event ? event.event.tool : undefined,
            itemId: "itemId" in event.event ? event.event.itemId : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Search the repo",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            arguments: { query: "AgentChatPane" },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "codex/event/item_started",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            arguments: { query: "AgentChatPane" },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            success: true,
            contentItems: [{ text: "Found matches" }],
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "codex/event/item_completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            success: true,
            contentItems: [{ text: "Found matches" }],
          },
        },
      });

      const toolCalls = events.filter((event) => event.type === "tool_call" && event.itemId === "item-1");
      const toolResults = events.filter((event) => event.type === "tool_result" && event.itemId === "item-1");

      expect(toolCalls).toHaveLength(1);
      expect(toolResults).toHaveLength(1);
    });

    it("normalizes and caps structured Codex web-search results", async () => {
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
        text: "Search the web.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      const validResults = Array.from({ length: 10 }, (_, index) => index === 0
        ? {
            link: " https://example.com/0 ",
            title: " Result 0 ",
            description: " Description 0 ",
            unknownFutureField: { nested: true },
          }
        : {
            url: `https://example.com/${index}`,
            title: `Result ${index}`,
            snippet: `Snippet ${index}`,
            resultType: "future",
          });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "web-search-results",
            type: "webSearch",
            query: "ADE",
            status: "completed",
            results: [
              ...validResults,
              { snippet: "missing url and title" },
              null,
              "garbage",
            ],
          },
        },
      });

      const resultsEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "web_search" }>;
        } => event.event.type === "web_search" && event.event.itemId === "web-search-results",
      );
      expect(resultsEvent.event.results).toHaveLength(8);
      expect(resultsEvent.event.resultsTotal).toBe(10);
      expect(resultsEvent.event.results?.[0]).toEqual({
        url: "https://example.com/0",
        title: "Result 0",
        snippet: "Description 0",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "web-search-garbage-results",
            type: "webSearch",
            query: "ADE",
            status: "completed",
            results: { url: "https://example.com/not-an-array" },
          },
        },
      });
      const garbageEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "web_search" }>;
        } => event.event.type === "web_search" && event.event.itemId === "web-search-garbage-results",
      );
      expect(garbageEvent.event.results).toBeUndefined();
      expect(garbageEvent.event.resultsTotal).toBeUndefined();
    });

    it("rejects attachments outside the project root before dispatch", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const threadsBefore = mockState.codexThreadCounter;
      const turnsBefore = mockState.codexTurnCounter;
      const outsidePath = path.join(process.cwd(), `.ade-agent-chat-outside-${Date.now()}.txt`);
      fs.writeFileSync(outsidePath, "secret", "utf8");
      try {
        await expect(service.sendMessage({
          sessionId: session.id,
          text: "Review this file",
          attachments: [{ path: outsidePath, type: "file" }],
        })).rejects.toThrow(/project root/);
      } finally {
        fs.rmSync(outsidePath, { force: true });
      }
      expect(mockState.codexThreadCounter).toBe(threadsBefore);
      expect(mockState.codexTurnCounter).toBe(turnsBefore);
    });

    it("keeps public attachment paths trimmed without exposing resolved filesystem paths", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      fs.writeFileSync(path.join(tmpRoot, "note.txt"), "hello", "utf8");

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const attachments = [{ path: " note.txt ", type: "file" as const }];
      await service.sendMessage({
        sessionId: session.id,
        text: "Review this file",
        attachments,
      });

      const userMessage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: { type: "user_message"; attachments?: Array<{ path: string; type: "file" | "image" }> } } =>
          event.event.type === "user_message",
      );

      expect(attachments[0]?.path).toBe(" note.txt ");
      expect(userMessage.event.attachments).toEqual([{ path: "note.txt", type: "file" }]);
    });

    it("injects Linear issue context into Codex prompts and public user events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const contextAttachment = makeLinearIssueContextAttachment(makeLaneLinearIssue(), "manual");

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the implementation.",
        contextAttachments: [contextAttachment],
      });

      const userMessage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: { type: "user_message"; contextAttachments?: unknown[] } } =>
          event.event.type === "user_message",
      );
      expect(userMessage.event.contextAttachments).toHaveLength(1);
      expect(userMessage.event.contextAttachments?.[0]).toMatchObject({
        type: "linear_issue",
        issue: {
          id: "issue-1",
          identifier: "ADE-123",
          title: "Attach Linear context to chat",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as { input?: Array<{ text?: unknown }> } | undefined;
      const textInput = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(textInput).toContain("Attached issue context");
      expect(textInput).toContain("- Identifier: ADE-123");
      expect(textInput).toContain("Attach Linear context to chat");
      expect(textInput).toContain("do not ask the user for a Linear API key");
      expect(textInput).toContain("Plan the implementation.");
    });

    it("dispatches context-only Linear issue sends with a fallback prompt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "",
        contextAttachments: [makeLinearIssueContextAttachment(makeLaneLinearIssue(), "manual")],
      });

      const userMessage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: { type: "user_message"; text: string; contextAttachments?: unknown[] } } =>
          event.event.type === "user_message",
      );
      expect(userMessage.event.text).toBe("Use the attached issue context.");
      expect(userMessage.event.contextAttachments).toHaveLength(1);

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as { input?: Array<{ text?: unknown }> } | undefined;
      const textInput = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(textInput).toContain("Attached issue context");
      expect(textInput).toContain("Use the attached issue context.");
    });

    it("prefers the canonical turn-scoped Codex text stream when item-scoped deltas also arrive", async () => {
      const textEvents: Array<{ text: string; itemId?: string; turnId?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          if (event.event.type !== "text") return;
          textEvents.push({
            text: event.event.text,
            itemId: event.event.itemId,
            turnId: event.event.turnId,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Say hello",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Hello",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Hello",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          itemId: "msg-1",
          delta: " world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: " world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Hello world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(textEvents).toEqual([
        {
          text: "Hello world",
          turnId: "turn-1",
        },
      ]);
    });

    it("keeps Codex reasoning deltas tied to the active turn and thinking activity", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Think through the options.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const eventsBeforeReasoningDelta = events.length;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/reasoning/summaryTextDelta",
        params: {
          itemId: "reasoning-1",
          delta: "Checking the relevant paths.",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "reasoning"
          && event.event.turnId === "turn-1"
          && event.event.itemId === "reasoning-1",
      );

      const newEvents = events.slice(eventsBeforeReasoningDelta);
      // The reasoning row must be produced by the post-delta boundary, not by
      // any earlier turn-start bookkeeping.
      expect(newEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "reasoning",
            text: "Checking the relevant paths.",
            itemId: "reasoning-1",
            turnId: "turn-1",
          }),
        }),
      ]));
      // And somewhere in the turn — coalescing across the initial turn-start
      // activity is fine — a thinking activity must be tied to the same turn.
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "activity",
            activity: "thinking",
            turnId: "turn-1",
          }),
        }),
      ]));
    });

    it("emits immediate startup activity for Codex before turn/start resolves", async () => {
      const events: AgentChatEventEnvelope[] = [];
      mockState.delayedCodexMethods.add("turn/start");
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      }, { awaitDispatch: true });
      let sendResolved = false;
      void sendPromise.then(() => {
        sendResolved = true;
      });

      const startedEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && !("turnId" in event.event),
      );
      const startupActivity = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
        } =>
          event.event.type === "activity"
          && !("turnId" in event.event)
          && (event.event.activity === "thinking" || event.event.activity === "working"),
      );

      expect(startedEvent.event.turnStatus).toBe("started");
      expect(startupActivity.event.detail).toBeTruthy();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      await Promise.resolve();
      expect(sendResolved).toBe(false);
      const noTurnStartedCount = events.filter((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "started"
        && !("turnId" in event.event)
      ).length;
      expect(noTurnStartedCount).toBe(1);

      mockState.flushCodexResponses();
      await sendPromise;
      expect(sendResolved).toBe(true);
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && "turnId" in event.event
          && event.event.turnId === "turn-1",
      );
    });

    it("emits only one user_message for a Codex send while turn/start is delayed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      mockState.delayedCodexMethods.add("turn/start");
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Fix the duplicate first message render.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && event.event.text === "Fix the duplicate first message render.",
      );
      expect(events.filter((event) => event.event.type === "user_message")).toHaveLength(1);

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.flushCodexResponses();
      await sendPromise;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Checking the renderer path.",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text"
          && event.event.text === "Checking the renderer path.",
      );
      expect(events.filter((event) => event.event.type === "user_message")).toHaveLength(1);
    });

    it("ignores unsolicited Codex turn notifications when no turn is active", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.resumeSession({ sessionId: session.id });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "foreign-turn",
            status: "inProgress",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "foreign-turn",
          delta: "This belongs to a different thread",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "foreign-turn",
            status: "completed",
          },
        },
      });

      expect(events.filter((event) => event.turnId === "foreign-turn")).toHaveLength(0);
    });

    it("attaches to in-progress Codex turn notifications after app-server resume", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        threadId: "thread-resumed",
      });

      await service.resumeSession({ sessionId: session.id });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "resumed-turn",
            status: "inProgress",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "resumed-turn",
          delta: "Continuing after reconnect",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "resumed-turn",
            status: "completed",
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "status", turnId: "resumed-turn", turnStatus: "started" }),
        expect.objectContaining({ type: "text", turnId: "resumed-turn", text: "Continuing after reconnect" }),
        expect.objectContaining({ type: "done", turnId: "resumed-turn", status: "completed" }),
      ]));
    });

    it("ignores late duplicate Codex turn/started notifications for a completed turn", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(1);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Planner started." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(firstTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Planner started.",
        turnId: "turn-1",
      }));

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });

      const secondTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Continue coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-2", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-2", delta: "Development started." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", status: "completed" } },
      });

      await expect(secondTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Development started.",
        turnId: "turn-2",
      }));
      expect(events.filter((event) => event.type === "status" && event.turnId === "turn-1" && event.turnStatus === "started")).toHaveLength(1);
    });

    it("closes the Codex resumed-turn attach gate after an expected turn completes", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        threadId: "thread-resumed",
      });
      await service.resumeSession({ sessionId: session.id });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Continue after resume.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Expected turn completed." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(turn).resolves.toEqual(expect.objectContaining({
        outputText: "Expected turn completed.",
        turnId: "turn-1",
      }));

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "ghost-resumed-turn", status: "inProgress" } },
      });

      expect(events.filter((event) => event.type === "status" && event.turnId === "ghost-resumed-turn")).toHaveLength(0);
    });

    it("persists terminal Codex turn ids across runtime recreation", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Persisted turn completed." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(firstTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Persisted turn completed.",
        turnId: "turn-1",
      }));

      service.forceDisposeAll();
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        threadId: "thread-resumed",
      });
      await service.resumeSession({ sessionId: session.id });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });

      expect(events.filter((event) => event.type === "status" && event.turnId === "turn-1" && event.turnStatus === "started")).toHaveLength(1);
    });

    it("does not reactivate a Codex turn when turn/start resolves after turn/completed", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });
      mockState.delayedCodexMethods.add("turn/start");

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(1);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Coordinator answered." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(firstTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Coordinator answered.",
        turnId: "turn-1",
      }));

      mockState.flushCodexResponses();
      await vi.waitFor(() => {
        expect(events.filter((event) => event.type === "status" && event.turnId === "turn-1" && event.turnStatus === "started")).toHaveLength(1);
      });

      const secondTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Continue coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      });
      mockState.flushCodexResponses();
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-2", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-2", delta: "Next turn started." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", status: "completed" } },
      });

      await expect(secondTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Next turn started.",
        turnId: "turn-2",
      }));
    });

    it("emits one Codex failure when error precedes turn/completed with the same payload", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Continue shipping the fix.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-capacity", status: "inProgress" } },
      });
      const error = {
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "error",
        params: { turnId: "turn-capacity", error, willRetry: false },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-capacity",
            status: "failed",
            error,
          },
        },
      });

      await expect(turn).resolves.toEqual(expect.objectContaining({ turnId: "turn-capacity" }));
      expect(events.filter((event) => event.event.type === "error")).toHaveLength(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "status",
            turnStatus: "failed",
            turnId: "turn-capacity",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "done",
            status: "failed",
            turnId: "turn-capacity",
          }),
        }),
      ]));
      await expect(service.getSessionSummary(session.id)).resolves.toEqual(
        expect.objectContaining({ status: "idle" }),
      );
    });

    it("keeps Codex willRetry errors non-terminal until turn/completed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const turn = service.runSessionTurn({ sessionId: session.id, text: "Retry transiently." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-retry", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "error",
        params: {
          turnId: "turn-retry",
          willRetry: true,
          error: { message: "Temporary upstream failure.", codexErrorInfo: "serverOverloaded" },
        },
      });

      expect(events.filter((event) => event.event.type === "error")).toHaveLength(0);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "activity",
            activity: "working",
            detail: "Retrying Codex",
            turnId: "turn-retry",
          }),
        }),
      ]));
      await expect(service.getSessionSummary(session.id)).resolves.toEqual(
        expect.objectContaining({ status: "active" }),
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-retry", status: "completed" } },
      });
      await expect(turn).resolves.toEqual(expect.objectContaining({ turnId: "turn-retry" }));
    });

    it("ignores stale Codex lifecycle notifications from a foreign turn", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "status" && event.turnId === "turn-1")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-stale",
            status: "completed",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: {
          turnId: "turn-stale",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Still streaming",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(events.filter((event) => event.type === "done").map((event) => event.turnId)).toEqual(["turn-1"]);
      expect(events.filter((event) => event.type === "status" && event.turnId === "turn-stale")).toHaveLength(0);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", turnId: "turn-1", text: "Still streaming" }),
      ]));
    });

    it("suppresses stale Codex turn notifications while waiting for turn/started", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      mockState.delayedCodexMethods.add("turn/start");
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-stale",
          delta: "This belongs to the previous turn",
        },
      });

      mockState.flushCodexResponses();
      await sendPromise;
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Fresh text",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.turnId === "turn-1" && event.event.text === "Fresh text",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(
        events.filter((event) => "turnId" in event.event && event.event.turnId === "turn-stale"),
      ).toHaveLength(0);
    });

    it("returns an explicit steer result and emits a delivered steer bubble for Codex", async () => {
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
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const result = await service.steer({
        sessionId: session.id,
        text: "Focus on the shared chat UI.",
      });

      expect(result.queued).toBe(false);
      expect(result.steerId).toMatch(/^test-uuid-/);
      expect(
        mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer"),
      ).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Focus on the shared chat UI.",
            deliveryState: "accepted",
            processed: false,
            steerId: result.steerId,
            turnId: "turn-1",
          }),
        }),
      ]));
    });

    // Regression: mention expansion once lived only in steerUserMessage, which
    // the daemon-routed exported steer() never calls — packaged builds shipped
    // raw chips. Expansion now sits in steerWithOptions, the single funnel, so
    // the exported steer must deliver <ade-mention> blocks to the provider
    // while the transcript keeps the user's literal chip text.
    it("expands @-mention chips on the exported steer path before provider delivery", async () => {
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
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const raw = "apply the fix from @chat:other-session-id";
      const result = await service.steer({ sessionId: session.id, text: raw });
      expect(result.queued).toBe(false);

      const steerPayload = mockState.codexRequestPayloads.find(
        (payload) => payload.method === "turn/steer",
      );
      expect(steerPayload, "steer must reach the provider").toBeTruthy();
      const providerText = JSON.stringify(steerPayload!.params);
      // The provider sees the pointer block (unresolved here — the fixture has
      // no such chat — which still proves expansion ran on this path).
      expect(providerText).toContain("<ade-mention");
      expect(providerText).toContain("other-session-id");
      // The transcript keeps the literal chip, not the expansion blob.
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: raw,
            steerId: result.steerId,
          }),
        }),
      ]));
    });

    it("adopts Codex active turn mismatches and retries delivered steers", async () => {
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
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/steer", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.expectedTurnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        return {};
      });

      const result = await service.steer({
        sessionId: session.id,
        text: "Keep going with the real turn.",
      });

      expect(result.queued).toBe(false);
      expect(attempts).toBe(2);
      const steerRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/steer");
      expect(steerRequests.map((payload) => (payload.params as Record<string, unknown>).expectedTurnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Keep going with the real turn.",
            deliveryState: "accepted",
            processed: false,
            steerId: result.steerId,
            turnId: "turn-real",
          }),
        }),
      ]));
    });

    it("adopts a Codex turn/started notification that corrects the active turn id", async () => {
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
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-real",
            status: "inProgress",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-real",
          delta: "Recovered text",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text"
          && event.event.turnId === "turn-real"
          && event.event.text === "Recovered text",
      );
    });

    it("does not retry Codex active turn mismatches more than once", async () => {
      const { service } = createService();

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/steer", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.expectedTurnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        if (params.expectedTurnId === "turn-real") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-real but found turn-newer",
            },
          };
        }
        return {};
      });

      await expect(service.steer({
        sessionId: session.id,
        text: "Keep going with the real turn.",
      })).rejects.toThrow("expected active turn id turn-real but found turn-newer");

      expect(attempts).toBe(2);
      const steerRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/steer");
      expect(steerRequests.map((payload) => (payload.params as Record<string, unknown>).expectedTurnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
    });

    it("starts a normal Codex turn when steering stale active UI state", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const result = await service.steer({
        sessionId: session.id,
        text: "Recover from a stale active marker.",
      });

      expect(result.queued).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Recover from a stale active marker.",
          }),
        }),
      ]));
    });

    it("sends Codex image steer payloads as localImage input blocks", async () => {
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
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const imagePath = path.join(tmpRoot, "codex-steer-image.png");
      fs.writeFileSync(imagePath, "fake-image-bytes");

      const result = await service.steer({
        sessionId: session.id,
        text: "Use this screenshot while you keep going.",
        attachments: [{ path: imagePath, type: "image" }],
      });

      expect(result.queued).toBe(false);
      const steerRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/steer");
      expect(steerRequest).toBeTruthy();
      expect(steerRequest).toEqual(expect.objectContaining({
        method: "turn/steer",
        params: expect.objectContaining({
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: "Use this screenshot while you keep going.",
            }),
            expect.objectContaining({
              type: "localImage",
              path: expect.stringContaining("codex-steer-image.png"),
            }),
          ]),
        }),
      }));

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Use this screenshot while you keep going.",
            attachments: [{ path: imagePath, type: "image" }],
            deliveryState: "accepted",
            processed: false,
            steerId: result.steerId,
            turnId: "turn-1",
          }),
        }),
      ]));
    });

    it("adopts Codex active turn mismatches and retries interrupt", async () => {
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
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/interrupt", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.turnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        return {};
      });

      await service.interrupt({ sessionId: session.id });

      expect(attempts).toBe(2);
      const interruptRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt");
      expect(interruptRequests.map((payload) => (payload.params as Record<string, unknown>).turnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
    });

    it("adopts Codex active turn mismatches and retries dispose interrupt", async () => {
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
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/interrupt", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.turnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        return {};
      });

      await service.dispose({ sessionId: session.id });

      expect(attempts).toBe(2);
      const interruptRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt");
      expect(interruptRequests.map((payload) => (payload.params as Record<string, unknown>).turnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
    });

    it("interrupts active Codex subagents and ignores updates after child abort", async () => {
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
        text: "Run a parallel code search.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabToolCall",
            tool: "spawn_agent",
            newThreadId: "agent-thread-1",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      await service.interrupt({ sessionId: session.id });

      expect(
        mockState.codexRequestPayloads.some((payload) =>
          payload.method === "turn/interrupt"
          && (payload.params as Record<string, unknown>).threadId === "thread-1"
          && (payload.params as Record<string, unknown>).turnId === "turn-1"
        ),
      ).toBe(true);
      expect(
        (await service.listSubagents({ sessionId: session.id })).find((snapshot) => snapshot.taskId === "agent-thread-1")?.status,
      ).toBe("running");

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-1",
          turn: { id: "late-agent-turn", status: "inProgress" },
        },
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
          expect.objectContaining({
            method: "turn/interrupt",
            params: {
              threadId: "agent-thread-1",
              turnId: "late-agent-turn",
            },
          }),
        ]));
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: {
          threadId: "agent-thread-1",
          turnId: "late-agent-turn",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_result"
          && event.event.taskId === "agent-thread-1"
          && event.event.status === "stopped",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabToolCall",
            tool: "wait",
            agentsStates: [
              {
                threadId: "agent-thread-1",
                status: "completed",
                summary: "Finished after the interrupt.",
              },
            ],
          },
        },
      });

      const completedResults = events.filter((event) =>
        event.event.type === "subagent_result"
        && event.event.taskId === "agent-thread-1"
        && event.event.status === "completed",
      );
      expect(completedResults).toHaveLength(0);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-1",
          turn: { id: "later-agent-turn", status: "inProgress" },
        },
      });

      expect(events.some((event) =>
        event.event.type === "subagent_progress"
        && event.event.taskId === "agent-thread-1"
        && event.event.summary === "Agent resumed"
      )).toBe(false);
      expect(
        (await service.listSubagents({ sessionId: session.id })).find((snapshot) => snapshot.taskId === "agent-thread-1")?.status,
      ).toBe("stopped");
    });

    it("emits Codex subagent events for current collabAgentToolCall app-server items", async () => {
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
        text: "Run parallel repository scans.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
            agentsStates: {},
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_started",
            taskId: "agent-thread-1",
            description: "Inspect the shared chat renderer",
            turnId: "turn-1",
          }),
        }),
      ]));
      expect(
        (await service.listSubagents({ sessionId: session.id })).find((snapshot) => snapshot.taskId === "agent-thread-1")?.status,
      ).toBe("running");

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-thread-1"],
            prompt: null,
            agentsStates: {
              "agent-thread-1": {
                status: "completed",
                message: "Renderer path mapped.",
              },
            },
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "agent-thread-1",
            status: "completed",
            summary: "Renderer path mapped.",
            turnId: "turn-1",
          }),
        }),
      ]));
      expect(
        (await service.listSubagents({ sessionId: session.id })).find((snapshot) => snapshot.taskId === "agent-thread-1")?.status,
      ).toBe("completed");
    });

    it("assigns Codex desktop-style fallback labels to collab agents in turn-spawn order", async () => {
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
        text: "Spawn two parallel agents.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-a"],
            prompt: "Inspect the renderer",
            agentsStates: {},
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-b"],
            prompt: "Inspect the main process",
            agentsStates: {},
          },
        },
      });

      const startedEvents = events.filter((envelope) =>
        envelope.event.type === "subagent_started"
        && (envelope.event.taskId === "agent-thread-a" || envelope.event.taskId === "agent-thread-b"),
      );

      expect(startedEvents).toHaveLength(2);
      expect(startedEvents[0]!.event).toMatchObject({
        type: "subagent_started",
        taskId: "agent-thread-a",
        agentId: "agent-thread-a",
        agentType: "Sagan",
      });
      expect(startedEvents[1]!.event).toMatchObject({
        type: "subagent_started",
        taskId: "agent-thread-b",
        agentId: "agent-thread-b",
        agentType: "Beauvoir",
      });
    });

    it("filters codex parent stream by threadId when fetching subagent transcript", async () => {
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
        text: "Run a parallel agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-filter"],
            prompt: "Focused investigation",
            agentsStates: {},
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-filter"],
            agentsStates: {
              "agent-thread-filter": {
                status: "completed",
                message: "Investigation complete.",
              },
            },
          },
        },
      });

      const transcript = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "agent-thread-filter",
      });
      expect(transcript).not.toBeNull();
      expect(transcript!.length).toBeGreaterThanOrEqual(2);
      const types = transcript!.map((m) => (m.message as { type: string }).type);
      expect(types).toContain("subagent_started");
      expect(types).toContain("subagent_result");
      // Filter must reject envelopes that don't carry this threadId.
      expect(transcript!.every((m) => {
        const event = m.message as { taskId?: string };
        return event.taskId === "agent-thread-filter";
      })).toBe(true);

      // A different threadId returns an empty (but non-null) array.
      const empty = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "some-other-thread",
      });
      expect(empty).toEqual([]);
    });

    it("pulls codex subagent transcript live from the app-server via thread/turns/list", async () => {
      // When the codex runtime is alive, getSubagentTranscript should ask
      // codex's app-server for the subagent thread's own turns/items —
      // matching what the Codex desktop app does — instead of falling back
      // to filtering ADE's parent event history.
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      // Track every request to the codex app-server so we can prove we
      // actually called `thread/turns/list` instead of staying in the
      // event-history fallback.
      const appServerCalls: Array<{ method: string; params: unknown }> = [];
      mockState.codexResponseOverrides.set("thread/turns/list", (payload) => {
        appServerCalls.push({ method: "thread/turns/list", params: payload.params });
        return {
          data: [
            {
              id: "turn-sub-1",
              startedAt: 1,
              completedAt: 2,
              durationMs: 1000,
              status: "completed",
              error: null,
              itemsView: "full",
              items: [
                {
                  id: "item-reasoning",
                  type: "reasoning",
                  summary: ["Mapping the dependency graph."],
                  content: ["Need to confirm the call sites use the new helper."],
                },
                {
                  id: "item-command",
                  type: "commandExecution",
                  command: "rg --files-with-matches \"oldFn\"",
                  cwd: "/Users/admin/Projects/ADE",
                  aggregatedOutput: "src/foo.ts\nsrc/bar.ts\n",
                  exitCode: 0,
                  durationMs: 35,
                  status: "completed",
                  commandActions: [],
                  source: "shell",
                  processId: null,
                },
                {
                  id: "item-file",
                  type: "fileChange",
                  status: "completed",
                  changes: [
                    { path: "src/foo.ts", unifiedDiff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-foo\n+bar\n", kind: "modify" },
                  ],
                },
                {
                  id: "item-text",
                  type: "agentMessage",
                  text: "Investigation complete. Two call sites updated.",
                  phase: null,
                  memoryCitation: null,
                },
              ],
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      });

      // Announce the subagent thread on the parent stream so ADE registers
      // an active subagent the client can drill into. ADE only needs the
      // threadId — the actual transcript will be pulled from the app-server.
      await service.sendMessage({
        sessionId: session.id,
        text: "Spawn an investigation agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-live"],
            prompt: "Investigate dependencies.",
            agentsStates: {},
          },
        },
      });

      const transcript = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "agent-thread-live",
      });

      expect(appServerCalls.length).toBeGreaterThanOrEqual(1);
      expect(appServerCalls[0].method).toBe("thread/turns/list");
      expect((appServerCalls[0].params as { threadId: string }).threadId).toBe("agent-thread-live");
      expect((appServerCalls[0].params as { itemsView: string }).itemsView).toBe("full");

      expect(transcript).not.toBeNull();
      const types = transcript!.map((m) => (m.message as { type: string }).type);
      expect(types).toEqual(["reasoning", "command", "file_change", "text"]);
      const commandEvent = transcript!.find((m) => (m.message as { type: string }).type === "command")!.message as {
        type: "command";
        command: string;
        output: string;
        status: string;
        exitCode: number;
      };
      expect(commandEvent.command).toContain("oldFn");
      expect(commandEvent.output).toContain("src/foo.ts");
      expect(commandEvent.status).toBe("completed");
      expect(commandEvent.exitCode).toBe(0);
      const fileEvent = transcript!.find((m) => (m.message as { type: string }).type === "file_change")!.message as {
        type: "file_change";
        path: string;
        diff: string;
        kind: string;
      };
      expect(fileEvent.path).toBe("src/foo.ts");
      expect(fileEvent.diff).toContain("+bar");
      expect(fileEvent.kind).toBe("modify");
    });

    it("captures Codex subagent transcript rows from live child-thread notifications", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      mockState.codexResponseOverrides.set("thread/turns/list", () => ({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      }));
      mockState.codexResponseOverrides.set("thread/read", () => ({
        thread: {
          id: "agent-thread-live-capture",
          preview: "Live child output.",
          model: "gpt-5.4",
          source: {
            subAgent: {
              parentThreadId: "thread-1",
              agentNickname: "Scout",
              agentRole: "reviewer",
            },
          },
        },
      }));

      await service.sendMessage({
        sessionId: session.id,
        text: "Spawn a child agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-live-capture",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-live-capture"],
            prompt: "Inspect streamed child output.",
            agentsStates: {},
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-live-capture",
          turn: { id: "sub-turn-1", status: "inProgress" },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: "agent-thread-live-capture",
          turnId: "sub-turn-1",
          itemId: "sub-message-1",
          delta: "Live child output.",
        },
      });

      let transcript: Awaited<ReturnType<typeof service.getSubagentTranscript>> = null;
      await vi.waitFor(async () => {
        transcript = await service.getSubagentTranscript({
          sessionId: session.id,
          agentId: "agent-thread-live-capture",
        });
        expect(transcript).not.toBeNull();
        expect(transcript!.some((message) => message.text === "Live child output.")).toBe(true);
        expect(transcript!.find((message) => message.text === "Live child output.")?.subagentMetadata).toMatchObject({
          threadId: "agent-thread-live-capture",
          agentNickname: "Scout",
          agentRole: "reviewer",
          model: "gpt-5.4",
        });
      });

      expect(events.some((event) =>
        event.event.type === "text"
        && event.event.text === "Live child output."
      )).toBe(false);
      const parentHistory = await service.getChatEventHistory(session.id);
      expect(parentHistory.events.some((event) =>
        event.event.type === "text"
        && event.event.text === "Live child output."
      )).toBe(false);
      expect(transcript!.map((message) => (message.message as { type: string }).type)).toContain("text");
    });

    it("falls back to event-history filter when codex app-server fails on thread/turns/list", async () => {
      // Older codex builds may not support `thread/turns/list` for spawned
      // subagent threads. The transcript pipe must still return data — fall
      // back to ADE's aggregated `subagent_*` envelopes from the parent
      // stream.
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      mockState.codexResponseOverrides.set("thread/turns/list", () => ({
        error: { code: -32601, message: "Method not found" },
      }));

      await service.sendMessage({
        sessionId: session.id,
        text: "Spawn an investigation agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-fallback"],
            prompt: "Investigate.",
            agentsStates: {},
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-fallback"],
            agentsStates: {
              "agent-thread-fallback": {
                status: "completed",
                message: "Investigation summary recorded.",
              },
            },
          },
        },
      });

      const transcript = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "agent-thread-fallback",
      });
      expect(transcript).not.toBeNull();
      expect(transcript!.length).toBeGreaterThanOrEqual(2);
      const types = transcript!.map((m) => (m.message as { type: string }).type);
      expect(types).toContain("subagent_started");
      expect(types).toContain("subagent_result");
    });

    it("coalesces Codex spawn placeholders when the app-server reveals the agent thread later", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "call-spawn-1",
          parentToolUseId: "call-spawn-1",
          status: "running",
        }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "completed",
            newThreadId: "agent-thread-1",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          parentToolUseId: "call-spawn-1",
          status: "running",
        }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-wait-1",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            agentsStates: {
              "agent-thread-1": {
                status: "completed",
                message: "Renderer path mapped.",
              },
            },
          },
        },
      });

      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          parentToolUseId: "call-spawn-1",
          status: "completed",
          summary: "Renderer path mapped.",
        }),
      ]);
    });

    it("marks optimistic Codex spawn placeholders failed when the app-server rejects the tool call", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "call-spawn-1",
          parentToolUseId: "call-spawn-1",
          status: "running",
        }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "rejected",
            error: { message: "spawn_agent is not available in this runtime" },
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "call-spawn-1",
            parentToolUseId: "call-spawn-1",
            status: "failed",
            summary: "spawn_agent is not available in this runtime",
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "error",
            message: "Codex parallel agent failed: spawn_agent is not available in this runtime",
            turnId: "turn-1",
          }),
        }),
      ]));
      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "call-spawn-1",
          status: "failed",
          summary: "spawn_agent is not available in this runtime",
        }),
      ]);
      expect((await service.listSubagents({ sessionId: session.id })).some((snapshot) => snapshot.status === "running")).toBe(false);
    });

    it("uses content text instead of object stringification for Codex spawn failures", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "rejected",
            result: { reason: "runtime_missing" },
            contentItems: [{ text: "spawn_agent is not available in this runtime" }],
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "call-spawn-1",
            status: "failed",
            summary: "spawn_agent is not available in this runtime",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "error",
            message: "Codex parallel agent failed: spawn_agent is not available in this runtime",
          }),
        }),
      ]));
      expect(events.some((event) =>
        event.event.type === "subagent_result"
        && event.event.summary === "[object Object]"
      )).toBe(false);
    });

    it("reports stopped Codex subagents without error severity", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "cancelled",
            result: "User cancelled",
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "call-spawn-1",
            status: "stopped",
            summary: "User cancelled",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "info",
            severity: "info",
            message: "Codex parallel agent stopped: User cancelled",
          }),
        }),
      ]));
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.noticeKind === "error"
        && event.event.message === "Codex parallel agent stopped: User cancelled"
      )).toBe(false);
    });

    it("keeps Codex subagents active after the parent turn and settles them from the child turn", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-1",
          turn: { id: "agent-turn-1", status: "inProgress" },
        },
      });

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

      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          parentToolUseId: "call-spawn-1",
          status: "running",
        }),
      ]);
      expect(service.hasActiveWorkloads()).toBe(true);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "agent-thread-1",
          turn: {
            id: "agent-turn-1",
            status: "completed",
            items: [{
              id: "agent-message-1",
              type: "agentMessage",
              text: "The renderer lifecycle is correct.",
            }],
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_result"
          && event.event.taskId === "agent-thread-1"
          && event.event.status === "completed",
      );

      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          parentToolUseId: "call-spawn-1",
          status: "completed",
          summary: "The renderer lifecycle is correct.",
          finalSummary: "The renderer lifecycle is correct.",
        }),
      ]);
      expect(service.hasActiveWorkloads()).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "close-call-1",
            type: "collabAgentToolCall",
            tool: "close_agent",
            receiverThreadIds: ["agent-thread-1"],
            status: "completed",
          },
        },
      });

      expect(events.filter((event) =>
        event.event.type === "subagent_result" && event.event.taskId === "agent-thread-1"
      )).toHaveLength(1);
      expect((await service.listSubagents({ sessionId: session.id }))[0]).toMatchObject({
        status: "completed",
        finalSummary: "The renderer lifecycle is correct.",
      });
    });

    it("attributes a Codex close_agent result to the provider", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-close-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            receiverThreadIds: ["agent-thread-close"],
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-close",
          turn: { id: "agent-turn-close", status: "inProgress" },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "close-call-1",
            type: "collabAgentToolCall",
            tool: "close_agent",
            receiverThreadIds: ["agent-thread-close"],
            status: "completed",
          },
        },
      });

      const stopped = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_result"
          && event.event.taskId === "agent-thread-close"
          && event.event.status === "stopped",
      );
      expect(stopped.event).toMatchObject({
        summary: "Agent closed",
        stopSource: "provider",
        stopReason: "the provider ended the turn",
      });
    });

    it("interrupts a Codex child turn after the parent turn has completed", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-1",
          turn: { id: "agent-turn-1", status: "inProgress" },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      await service.interrupt({ sessionId: session.id });

      expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "turn/interrupt",
          params: {
            threadId: "agent-thread-1",
            turnId: "agent-turn-1",
          },
        }),
      ]));

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: {
          threadId: "agent-thread-1",
          turnId: "agent-turn-1",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_result"
          && event.event.taskId === "agent-thread-1"
          && event.event.status === "stopped",
      );
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("interrupts an older Codex child when stopping a newer parent turn", async () => {
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
        text: "Start a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-1",
          turn: { id: "agent-turn-1", status: "inProgress" },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === "turn-1",
      );

      await service.sendMessage({
        sessionId: session.id,
        text: "Start the next parent task.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-2",
      );

      mockState.codexRequestPayloads = [];
      await service.interrupt({ sessionId: session.id });

      const interruptRequests = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/interrupt")
        .map((payload) => payload.params);
      expect(interruptRequests).toEqual([
        { threadId: "thread-1", turnId: "turn-2" },
        { threadId: "agent-thread-1", turnId: "agent-turn-1" },
      ]);
      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({ taskId: "agent-thread-1", status: "running" }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: { turnId: "turn-2" },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done"
          && event.event.turnId === "turn-2"
          && event.event.status === "interrupted",
      );
      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({ taskId: "agent-thread-1", status: "running" }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: {
          threadId: "agent-thread-1",
          turnId: "agent-turn-1",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_result"
          && event.event.taskId === "agent-thread-1"
          && event.event.status === "stopped",
      );
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("interrupts a Codex child when disposing after the parent turn completes", async () => {
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
        text: "Start a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-1",
          turn: { id: "agent-turn-1", status: "inProgress" },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      await service.dispose({ sessionId: session.id });

      expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "turn/interrupt",
          params: {
            threadId: "agent-thread-1",
            turnId: "agent-turn-1",
          },
        }),
      ]));
      expect(mockState.codexRequestPayloads.some((payload) =>
        payload.method === "turn/interrupt"
        && (payload.params as Record<string, unknown>).threadId === "thread-1"
      )).toBe(false);
    });

    it("interrupts a Codex child whose turn starts after the parent and Stop complete", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      await service.interrupt({ sessionId: session.id });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-1",
          turn: { id: "delayed-agent-turn", status: "inProgress" },
        },
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
          expect.objectContaining({
            method: "turn/interrupt",
            params: {
              threadId: "agent-thread-1",
              turnId: "delayed-agent-turn",
            },
          }),
        ]));
      });
      expect(events.some((event) =>
        event.event.type === "subagent_progress"
        && event.event.taskId === "agent-thread-1"
        && event.event.summary === "Agent resumed"
      )).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: {
          threadId: "agent-thread-1",
          turnId: "delayed-agent-turn",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_result"
          && event.event.taskId === "agent-thread-1"
          && event.event.status === "stopped",
      );
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("does not add Codex cache breakdown tokens to derived totals", async () => {
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
        text: "Track token usage.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: {
            total: {
              inputTokens: 1_000,
              outputTokens: 250,
              cacheReadTokens: 700,
              cacheWriteInputTokens: 50,
              reasoningOutputTokens: 75,
            },
          },
        },
      });

      const usageEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "codex_token_usage" }>;
        } => event.event.type === "codex_token_usage",
      );
      expect(usageEvent.event.usage.total).toEqual(expect.objectContaining({
        inputTokens: 1_000,
        outputTokens: 250,
        cacheReadTokens: 700,
        cacheWriteTokens: 50,
        reasoningTokens: 75,
        totalTokens: 1_250,
      }));
    });

    it("keeps a Codex subagent's token usage on its own card, not the parent's meter", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      await service.sendMessage({ sessionId: session.id, text: "Spawn a scanner." }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started" && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Scan the renderer",
            agentsStates: {},
          },
        },
      });

      // The subagent thread's own cumulative counter (Codex input includes the cached part).
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "agent-thread-1",
          turnId: "agent-turn-1",
          tokenUsage: {
            total: { inputTokens: 28_004, cachedInputTokens: 27_392, outputTokens: 508, reasoningOutputTokens: 241, totalTokens: 28_512 },
            last: { inputTokens: 28_004, cachedInputTokens: 27_392, outputTokens: 508, reasoningOutputTokens: 241, totalTokens: 28_512 },
            modelContextWindow: 258_400,
          },
        },
      });
      const progress = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "subagent_progress" }>;
        } => event.event.type === "subagent_progress" && event.event.taskId === "agent-thread-1" && event.event.usage != null,
      );
      expect(progress.event.usage).toEqual({
        inputTokens: 612,
        outputTokens: 508,
        cacheReadTokens: 27_392,
        reasoningTokens: 241,
        totalTokens: 28_512,
      });
      expect(progress.event.turnId).toBe("turn-1");
      expect(events.some((event) => event.event.type === "codex_token_usage")).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-thread-1"],
            prompt: null,
            agentsStates: { "agent-thread-1": { status: "completed", message: "Renderer scanned." } },
          },
        },
      });
      const result = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "subagent_result" }>;
        } => event.event.type === "subagent_result" && event.event.taskId === "agent-thread-1",
      );
      expect(result.event.usage).toMatchObject({ inputTokens: 612, cacheReadTokens: 27_392, totalTokens: 28_512 });
      expect(result.event.usage?.usageConfidence).toBeUndefined();

      // A late counter for a settled subagent must not reopen its card.
      const progressCount = events.filter((event) => event.event.type === "subagent_progress").length;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "agent-thread-1", tokenUsage: { total: { inputTokens: 30_000, outputTokens: 600 } } },
      });
      expect(events.filter((event) => event.event.type === "subagent_progress")).toHaveLength(progressCount);
    });

    it("drops a Codex subagent result that waited on its rollout if the agent resumed meanwhile", async () => {
      process.env.CODEX_HOME = path.join(tmpHomeRoot, "codex-subagent-rollout");
      // Real UUIDv7 ids: created 2026-09-21T00:39:15.014Z.
      const finishedId = "01a0c167-1b46-7d11-8257-d9827213c3db";
      const resumedId = "01a0c167-1b46-7d11-8257-d9827213c3dc";
      const created = new Date(1_789_951_155_014);
      const pad = (value: number) => String(value).padStart(2, "0");
      const dayDir = path.join(
        process.env.CODEX_HOME,
        "sessions",
        String(created.getFullYear()),
        pad(created.getMonth() + 1),
        pad(created.getDate()),
      );
      fs.mkdirSync(dayDir, { recursive: true });
      for (const threadId of [finishedId, resumedId]) {
        fs.writeFileSync(path.join(dayDir, `rollout-2026-09-20T20-39-15-${threadId}.jsonl`), `${JSON.stringify({
          type: "token_usage_record",
          payload: {
            thread_id: threadId,
            usage: { input_tokens: 1_000, cached_input_tokens: 800, output_tokens: 100, total_tokens: 1_100 },
          },
        })}\n`);
      }
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      await service.sendMessage({ sessionId: session.id, text: "Spawn two scanners." }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started" && event.event.turnId === "turn-1",
      );
      const collab = (id: string, tool: string, status: "inProgress" | "completed", extra: Record<string, unknown>) =>
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: status === "inProgress" ? "item/started" : "item/completed",
          params: {
            turnId: "turn-1",
            item: { id, type: "collabAgentToolCall", tool, status, senderThreadId: "thread-1", prompt: null, ...extra },
          },
        });
      collab("spawn-1", "spawnAgent", "inProgress", { receiverThreadIds: [finishedId], prompt: "Scan A", agentsStates: {} });
      collab("spawn-2", "spawnAgent", "inProgress", { receiverThreadIds: [resumedId], prompt: "Scan B", agentsStates: {} });
      collab("wait-1", "wait", "completed", {
        receiverThreadIds: [finishedId, resumedId],
        agentsStates: {
          [finishedId]: { status: "completed", message: "A scanned." },
          [resumedId]: { status: "completed", message: "B scanned." },
        },
      });
      // No live counter arrived, so both results wait on a rollout read. One
      // agent is resumed before its read can finish.
      collab("send-1", "sendInput", "completed", { receiverThreadIds: [resumedId], prompt: "One more pass" });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: resumedId, turn: { id: "resumed-turn", status: "inProgress" } },
      });

      // This file mocks `node:readline`, so the read itself yields nothing here
      // (codexSubagentUsage.test.ts covers the sums); the ordering is the point.
      const result = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "subagent_result" }>;
        } => event.event.type === "subagent_result" && event.event.taskId === finishedId,
      );
      expect(result.event.status).toBe("completed");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events.some((event) => event.event.type === "subagent_result" && event.event.taskId === resumedId)).toBe(false);
      expect(
        (await service.listSubagents({ sessionId: session.id })).find((snapshot) => snapshot.taskId === resumedId)?.status,
      ).toBe("running");
    });

    it("reports a Codex model reroute as a notice and as the turn's served model", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      await service.sendMessage({ sessionId: session.id, text: "Do the risky thing." }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started" && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "model/rerouted",
        params: { threadId: "thread-1", turnId: "turn-1", fromModel: "gpt-5.4", toModel: "gpt-5.4-safe", reason: "highRiskCyberActivity" },
      });
      const notice = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }>;
        } => event.event.type === "system_notice" && event.event.message.includes("rerouted"),
      );
      expect(notice.event.message).toBe("Codex rerouted this turn from gpt-5.4 to gpt-5.4-safe.");
      expect(notice.event.turnId).toBe("turn-1");

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      });
      const done = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } => event.event.type === "done" && event.event.turnId === "turn-1",
      );
      expect(done.event.servedModel).toBe("gpt-5.4-safe");
      expect(done.event.account).toMatchObject({ provider: "codex" });
    });

    it("gives the usage ledger a Codex turn's thread-total delta, context, served model, and account", async () => {
      // `codex app-server` 0.153 answers `account/read` like this for an API key;
      // it sends no `account/updated` at startup, so the read is the only report.
      mockState.codexResponseOverrides.set("account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: true });
      const { ledger, rows } = createMemoryTurnUsageLedger();
      const events: AgentChatEventEnvelope[] = [];
      const { service, logger } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        turnUsageLedger: ledger,
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      await service.sendMessage({ sessionId: session.id, text: "Refactor the parser." }, { awaitDispatch: true });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "account/read")?.params)
        .toEqual({ refreshToken: false });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started" && event.event.turnId === "turn-1",
      );
      const breakdown = (input: number, cached: number, output: number, reasoning: number) => ({
        totalTokens: input + output,
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: reasoning,
      });
      // Thread totals run across turns: 5,000 input (4,000 cached) came before
      // this turn. Two requests follow; the turn is the delta.
      const usageUpdate = (total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) =>
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "thread/tokenUsage/updated",
          params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total, last, modelContextWindow: 258_000 } },
        });
      usageUpdate(breakdown(6_200, 5_000, 380, 130), breakdown(1_200, 1_000, 80, 30));
      usageUpdate(breakdown(7_700, 6_300, 500, 170), breakdown(1_500, 1_300, 120, 40));
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "model/rerouted",
        params: { threadId: "thread-1", turnId: "turn-1", fromModel: "gpt-5.4", toModel: "gpt-5.4-safe", reason: "highRiskCyberActivity" },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      });
      const done = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } => event.event.type === "done" && event.event.turnId === "turn-1",
      );
      const usageEvents = events.filter((event) => event.event.type === "codex_token_usage");
      expect(usageEvents.map((event) => (event.event as { turnId?: string }).turnId)).toEqual(["turn-1", "turn-1"]);
      expect(done.event).toMatchObject({
        servedModel: "gpt-5.4-safe",
        account: { provider: "codex", kind: "api_key" },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "codex",
        requestedModel: "openai/gpt-5.4",
        servedModel: "gpt-5.4-safe",
        // 2,700 input of which 2,300 cached, 200 output, 70 reasoning.
        inputTokens: 400,
        cacheReadTokens: 2_300,
        outputTokens: 200,
        reasoningTokens: 70,
        // The last request's input side, in the model's window.
        contextTokens: 1_500,
        contextWindow: 258_000,
        usageConfidence: "derived",
        account: { provider: "codex", kind: "api_key" },
      });
      // A reroute to another model is worth one log line.
      expect(logger.warn).toHaveBeenCalledWith("agent_chat.served_model_mismatch", expect.objectContaining({
        sessionId: session.id,
        provider: "codex",
        requestedModel: "gpt-5.4",
        servedModel: "gpt-5.4-safe",
      }));
    });

    it("switches the Claude SDK session into plan mode before a plan turn", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
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
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan ready" }],
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
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan ready");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("does not reapply unchanged Claude permission controls during session updates", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-stable-permission",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Ready" }],
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
        sessionId: "sdk-session-stable-permission",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "bypassPermissions",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Confirm readiness.",
      });
      expect(setPermissionMode).toHaveBeenCalledWith("bypassPermissions");

      setPermissionMode.mockClear();
      const updated = await service.updateSession({
        sessionId: session.id,
        claudePermissionMode: "bypassPermissions",
      });

      expect(updated.claudePermissionMode).toBe("bypassPermissions");
      expect(setPermissionMode).not.toHaveBeenCalled();
    });

    it("uses Claude SDK query controls for plan mode when the wrapper lacks setPermissionMode", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-query-plan",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan via query control" }],
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
        sessionId: "sdk-session-query-plan",
        query: {
          setPermissionMode,
        },
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan via query control");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("shows a plan approval card even when the session is in bypassPermissions", async () => {
      // The reported bug: a full-auto / bypassPermissions session entered plan
      // mode, and ExitPlanMode auto-approved 13ms later with no card ever
      // rendered — because the gate read the access mode, which entering plan
      // mode had left on "bypassPermissions".
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let service: ReturnType<typeof createService>["service"];
      let sessionId = "";
      let sawApprovalCard = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-plan-bypass",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan-bypass",
        });

        const entered = await service.getSessionSummary(sessionId);
        // Genuinely in plan mode — nothing still reads as bypass.
        expect(entered?.claudePermissionMode).toBe("plan");
        expect(entered?.permissionMode).toBe("plan");

        const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
          planDescription: "Plan that must be approved, not auto-accepted.",
        }, {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-plan-bypass",
        });

        const approvalEvent = await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope & {
            event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
          } =>
            event.event.type === "approval_request"
            && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
        );
        sawApprovalCard = true;

        await service.approveToolUse({
          sessionId,
          itemId: approvalEvent.event.itemId,
          decision: "accept",
        });
        await exitPromise;

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Approved by a human." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-plan-bypass",
        setPermissionMode,
      } as any);

      ({ service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      }));

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        permissionMode: "full-auto",
        claudePermissionMode: "bypassPermissions",
      });
      sessionId = session.id;

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Plan something, then exit plan mode.",
      });

      expect(sawApprovalCard).toBe(true);
      // Leaving plan mode puts the session back where it was.
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.claudePermissionMode).toBe("bypassPermissions");
      expect(summary?.permissionMode).toBe("full-auto");
    });

    it("fences a mutating tool call in plan mode even when bypass sits underneath", async () => {
      // A full-auto session that entered plan mode still has bypass as its
      // access mode. The CLI handles most plan-mode enforcement itself, but a
      // deferred mutating call reaches canUseTool — and a host that answers
      // `allow` silently lifts the fence the session just raised. The fence is
      // an allowlist, so a Windows shell and a mutating MCP tool are refused
      // even though neither name matches the legacy mutating heuristic.
      const events: AgentChatEventEnvelope[] = [];
      let enterResult: Record<string, unknown> | undefined;
      let writeResult: Record<string, unknown> | undefined;
      let readResult: Record<string, unknown> | undefined;
      let powershellResult: Record<string, unknown> | undefined;
      let mcpDeleteResult: Record<string, unknown> | undefined;
      let agentResult: Record<string, unknown> | undefined;
      let streamCall = 0;
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-plan-fence",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        const options = { signal: new AbortController().signal };
        enterResult = await sessionOpts.canUseTool("EnterPlanMode", {}, {
          ...options,
          toolUseID: "tool-plan-fence-enter",
        });
        writeResult = await sessionOpts.canUseTool(
          "Write",
          { file_path: "src/app.ts", content: "x" },
          { ...options, toolUseID: "tool-plan-fence-write" },
        );
        powershellResult = await sessionOpts.canUseTool(
          "PowerShell",
          { command: "Remove-Item -Recurse ./build" },
          { ...options, toolUseID: "tool-plan-fence-powershell" },
        );
        mcpDeleteResult = await sessionOpts.canUseTool(
          "mcp__filesystem__delete_file",
          { path: "src/app.ts" },
          {
            ...options,
            toolUseID: "tool-plan-fence-mcp",
            mcpServer: { name: "filesystem", source: "user" },
          },
        );
        agentResult = await sessionOpts.canUseTool(
          "Agent",
          { description: "explore", prompt: "find the entry point" },
          { ...options, toolUseID: "tool-plan-fence-agent" },
        );
        readResult = await sessionOpts.canUseTool(
          "Read",
          { file_path: "src/app.ts" },
          { ...options, toolUseID: "tool-plan-fence-read" },
        );

        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-plan-fence",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        permissionMode: "full-auto",
        claudePermissionMode: "bypassPermissions",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Plan, then try to write before exiting plan mode.",
      });

      expect(enterResult).toMatchObject({ behavior: "allow" });
      expect(writeResult).toMatchObject({ behavior: "deny" });
      expect(powershellResult).toMatchObject({ behavior: "deny" });
      expect(mcpDeleteResult).toMatchObject({ behavior: "deny" });
      // Subagent exploration is part of plan mode's own allowlist.
      expect(agentResult).toMatchObject({ behavior: "allow" });
      // Read-only built-ins stay usable: plan mode is inspect-only, not inert.
      expect(readResult).toMatchObject({ behavior: "allow" });
      const planned = await service.getSessionSummary(session.id);
      expect(planned?.claudePermissionMode).toBe("plan");
    });

    it("preserves Claude access overrides when entering and exiting plan mode", async () => {
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
            session_id: "sdk-session-plan-preserve",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        const enterResult = await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan",
        });
        expect(enterResult).toMatchObject({ behavior: "allow" });

        const entered = await service.getSessionSummary(sessionId);
        expect(entered?.permissionMode).toBe("plan");
        // While in plan mode the access mode is "plan" too. It used to stay on
        // the pre-plan value, which is what let a bypassPermissions session
        // auto-approve its own plan and kept the composer chip on Bypass. The
        // pre-plan mode is stashed and restored on exit (asserted below).
        expect(entered?.claudePermissionMode).toBe("plan");

        const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
          planDescription: "Ship the approved Claude changes.",
        }, {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-plan",
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

        const exitResult = await exitPromise;
        expect(exitResult).toMatchObject({
          behavior: "allow",
        });

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan approved and preserved." }],
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
        sessionId: "sdk-session-plan-preserve",
        setPermissionMode,
      } as any);

      ({ service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      }));

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        permissionMode: "edit",
        claudePermissionMode: "acceptEdits",
      });
      sessionId = session.id;

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Enter plan mode, then exit it after approval.",
      });

      expect(result.outputText).toContain("Plan approved and preserved.");
      expect(setPermissionMode).toHaveBeenCalledWith("acceptEdits");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("edit");
      expect(summary?.claudePermissionMode).toBe("acceptEdits");
    });

    it("syncs session permissionMode and emits a plan-mode notice when the SDK status message reports a transition", async () => {
      // The Claude Agent SDK handles EnterPlanMode/ExitPlanMode internally in
      // the bundled `claude` binary and signals the host via an SDKStatusMessage
      // (type: "system", subtype: "status") carrying the new permissionMode.
      // ADE must update its session state and emit the standard plan-mode
      // notice from this branch — without it, the renderer's prompt-box
      // permission badge never reflects the SDK-side transition.
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
            session_id: "sdk-session-status-plan",
            slash_commands: [],
          };
          return;
        }

        // SDK reports the internal EnterPlanMode transition via a status
        // message instead of routing through canUseTool.
        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "plan",
        };

        // SDK later reports ExitPlanMode the same way.
        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
        };

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan flow completed via status." }],
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
        sessionId: "sdk-session-status-plan",
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
        text: "Drive plan mode via status messages.",
      });

      const planTransitionNotices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice"
          && (event.detail as { permissionModeTransition?: string } | undefined)?.permissionModeTransition !== undefined,
        );
      expect(planTransitionNotices.map((notice) =>
        (notice.detail as { permissionModeTransition: string }).permissionModeTransition,
      )).toEqual(["entered_plan_mode", "exited_plan_mode"]);

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).not.toBe("plan");
    });

    it("ignores SDK status messages whose permissionMode matches the session's current mode", async () => {
      // Status messages can arrive frequently. Only the transitions should
      // emit notices — a redundant `permissionMode: "default"` while the
      // session is already in a non-plan mode must be a no-op.
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
            session_id: "sdk-session-status-noop",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
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
        sessionId: "sdk-session-status-noop",
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
        text: "Status message must not spuriously toggle plan mode.",
      });

      const planTransitionNotices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice"
          && (event.detail as { permissionModeTransition?: string } | undefined)?.permissionModeTransition !== undefined,
        );
      expect(planTransitionNotices).toHaveLength(0);
    });

    it("emits todo_update events for Claude TodoWrite tool uses", async () => {
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
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "todo-call-1",
              name: "TodoWrite",
              input: {
                todos: [
                  {
                    content: "Inspect Claude task rendering",
                    activeForm: "Inspecting Claude task rendering",
                    status: "completed",
                  },
                  {
                    content: "Render ADE task list UI",
                    activeForm: "Rendering ADE task list UI",
                    status: "in_progress",
                  },
                ],
              },
            }],
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
        sessionId: "sdk-session-1",
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
        text: "Track the current task list.",
      });

      const todoEvent = events.find((event) => event.event.type === "todo_update");
      expect(todoEvent).toBeTruthy();
      expect(todoEvent?.event).toMatchObject({
        type: "todo_update",
        items: [
          {
            id: "todo-0",
            description: "Inspect Claude task rendering",
            status: "completed",
          },
          {
            id: "todo-1",
            description: "Render ADE task list UI",
            status: "in_progress",
          },
        ],
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_call",
            tool: "TodoWrite",
            itemId: "todo-call-1",
          }),
        }),
      ]));
    });

    it("emits todo_update events for Claude TaskCreate and TaskUpdate tool uses", async () => {
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
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "task-create-1",
                name: "TaskCreate",
                input: {
                  subject: "Inspect SDK changes",
                  description: "Inspect the latest Claude Agent SDK changes",
                  activeForm: "Inspecting SDK changes",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          parent_tool_use_id: "task-create-1",
          description: "Inspect SDK changes",
          task_type: "other",
        };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "task-update-1",
                name: "TaskUpdate",
                input: {
                  taskId: "task-1",
                  status: "in_progress",
                  activeForm: "Applying SDK changes",
                },
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
        sessionId: "sdk-session-1",
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
        text: "Track the SDK task list.",
      });

      const todoEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "todo_update" }> =>
          event.type === "todo_update",
        );
      expect(todoEvents.length).toBeGreaterThanOrEqual(3);
      expect(todoEvents.at(-1)).toMatchObject({
        type: "todo_update",
        items: [
          {
            id: "task-1",
            description: "Applying SDK changes",
            status: "in_progress",
          },
        ],
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_call",
            tool: "TaskCreate",
            itemId: "task-create-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_call",
            tool: "TaskUpdate",
            itemId: "task-update-1",
          }),
        }),
      ]));
    });

    it("applies Claude task_started updates when the SDK task id matches the tool use id", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
          slash_commands: [],
        };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "task-1",
                name: "TaskCreate",
                input: {
                  subject: "Inspect SDK changes",
                  activeForm: "Inspecting SDK changes",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          parent_tool_use_id: "task-1",
          description: "Inspect SDK changes",
          task_type: "other",
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
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
        text: "Track the SDK task list.",
      });

      const todoEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "todo_update" }> =>
          event.type === "todo_update",
        );

      expect(todoEvents.at(-1)).toMatchObject({
        type: "todo_update",
        items: [
          {
            id: "task-1",
            description: "Inspect SDK changes",
            status: "in_progress",
          },
        ],
      });
    });
  });

  // --------------------------------------------------------------------------
  // setComputerUseArtifactBrokerService
  // --------------------------------------------------------------------------
});
