import {
  AgentChatEventEnvelope,
  ChatScheduledWorkState,
  SCHEDULED_WORK_STATE_KEY,
  SessionTurnAbandonedError,
  createAgentChatService,
  createScheduledWorkDb,
  createService,
  installRealTranscriptParser,
  mockState,
  path,
  waitFor,
  waitForEvent,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("turn and usage limits", () => {
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
  });
});
