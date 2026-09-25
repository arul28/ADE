import {
  AgentChatEventEnvelope,
  SCHEDULE_TEST_START,
  createAgentChatService,
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
  spawn,
  startOpenCodeSession,
  storedWakeup,
  streamText,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  waitForEvent,
  waitForFakeTimers,
} from "./agentChatService.testHarness";
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
  });
});
