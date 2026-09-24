import {
  AgentChatCreateScheduledWorkArgs,
  AgentChatEventEnvelope,
  PTY_SEND_PRE_DELIVERY_ERROR_CODE,
  SCHEDULE_TEST_START,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createScheduledWorkDb,
  createService,
  deriveScheduledWorkSnapshots,
  installClaudeResponseFixture,
  installClaudeWakeupFixture,
  path,
  readPersistedChatState,
  runGit,
  storedWakeup,
  waitFor,
  waitForEvent,
  waitForFakeTimerCondition,
  writePersistedChatState,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

async function waitForFakeTimerPromise<T>(
  promise: Promise<T>,
  description: string,
): Promise<T> {
  let settled = false;
  const trackedPromise = promise.finally(() => { settled = true; });
  void trackedPromise.catch(() => undefined);
  await waitForFakeTimerCondition(() => settled, description);
  return trackedPromise;
}


describe("createAgentChatService", () => {
  describe("scheduled work", () => {
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

    it.each([
      {
        flag: "skip_transcript",
        taskFlags: { task_type: "other", skip_transcript: true },
        progress: { type: "system", subtype: "task_progress", task_id: "task-ambient-idle", summary: "thinking" },
      },
      {
        flag: "ambient",
        taskFlags: { task_type: "other", ambient: true },
        progress: {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-ambient-idle", description: "Generate session title", ambient: true }],
        },
      },
    ])("keeps idle $flag tasks out of visible chat info", async ({ taskFlags, progress }) => {
      const events: AgentChatEventEnvelope[] = [];
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
          yield { type: "system", subtype: "init", session_id: "sdk-idle-ambient", slash_commands: [] };
          return;
        }
        yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-idle-ambient", usage: { input_tokens: 1, output_tokens: 1 } };

        await startAmbientPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-ambient",
          task_id: "task-ambient-idle",
          description: "Generate session title",
          ...taskFlags,
        };
        yield { session_id: "sdk-idle-ambient", ...progress };
        ambientLive = true;
        await holdAmbientCompletePromise;
        yield {
          type: "system",
          subtype: "task_notification",
          session_id: "sdk-idle-ambient",
          task_id: "task-ambient-idle",
          status: "completed",
          summary: "Done",
        };
        yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-idle-ambient", usage: { input_tokens: 1, output_tokens: 1 } };
        ambientDrained = true;
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-ambient",
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
        text: "Complete a visible turn, then let idle housekeeping run.",
      });

      const visibleAmbientInfo = () => events.filter((event) =>
        event.sessionId === session.id
        && (event.event.type === "subagent_started"
          || event.event.type === "subagent_progress"
          || event.event.type === "subagent_result")
        && (event.event as { taskId?: string }).taskId === "task-ambient-idle");

      startAmbient();
      await vi.waitFor(() => {
        expect(ambientLive).toBe(true);
      });
      expect(visibleAmbientInfo()).toEqual([]);
      expect(service.hasActiveWorkloads()).toBe(false);

      holdAmbientComplete();
      await vi.waitFor(() => {
        expect(ambientDrained).toBe(true);
      });
      expect(visibleAmbientInfo()).toEqual([]);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "status"
        && event.event.turnId?.startsWith("claude-idle-") === true,
      )).toBe(false);
      expect(service.hasActiveWorkloads()).toBe(false);
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
