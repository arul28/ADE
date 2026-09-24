import {
  AgentChatEventEnvelope,
  ChatScheduledWorkRecord,
  SCHEDULED_WORK_STATE_KEY,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createScheduledWorkDb,
  createService,
  fs,
  installRealTranscriptParser,
  legacyClaudeSendPayload,
  path,
  query,
  readPersistedChatState,
  streamText,
  tmpRoot,
  waitFor,
  waitForEvent,
  writePersistedChatState,
  writeTestTranscriptEnvelopes,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("compaction flush", () => {
    it("emits context_compact without a user_message carrying the flush prompt", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-compact",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "system",
          subtype: "compact_boundary",
          session_id: "sdk-session-compact",
          compact_metadata: { trigger: "auto", pre_tokens: 150_000 },
        };
        yield {
          type: "assistant",
          session_id: "sdk-session-compact",
          message: {
            content: [{ type: "text", text: "Continuing after compaction" }],
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
        sessionId: "sdk-session-compact",
        setPermissionMode,
      } as any);

      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "keep going",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const compactEvents = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "context_compact");
      expect(compactEvents).toHaveLength(1);
      expect(compactEvents[0].event).toMatchObject({
        type: "context_compact",
        trigger: "auto",
        preTokens: 150_000,
      });

      const leakedUserMessages = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) =>
          env?.event?.type === "user_message"
          && typeof env.event.text === "string"
          && env.event.text.includes("Before context compaction runs"),
        );
      expect(leakedUserMessages).toHaveLength(0);

      // Defence in depth: the pre-fix leak happened when main.ts reacted to
      // the context_compact chat event by calling steer(), which pushed the
      // flush prompt to the SDK via send(). Assert the SDK never received a
      // turn whose payload contains the flush-prompt text, regardless of
      // whether the leak originated from the SDK side or a downstream handler.
      const flushedSends = send.mock.calls.filter(([payload]) =>
        typeof payload === "string"
          ? payload.includes("Before context compaction runs")
          : JSON.stringify(payload ?? "").includes("Before context compaction runs"),
      );
      expect(flushedSends).toHaveLength(0);
    });

    it("emits a context_compact begin (started) when Claude reports compacting status", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-session-compacting", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Begin: SDK status flips to "compacting" before the boundary lands.
        yield { type: "system", subtype: "status", session_id: "sdk-session-compacting", status: "compacting" };
        // End: the compact boundary marks completion with the real trigger/tokens.
        yield {
          type: "system",
          subtype: "compact_boundary",
          session_id: "sdk-session-compacting",
          compact_metadata: {
            trigger: "manual",
            pre_tokens: 120_000,
            post_tokens: 18_000,
            duration_ms: 1_250,
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-compacting",
        setPermissionMode,
      } as any);

      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.runSessionTurn({ sessionId: session.id, text: "keep going", timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const compactEvents = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "context_compact")
        .map((env: any) => env.event);
      // A live begin, then a completed end — no longer a plain gray "Compacting..." notice.
      expect(compactEvents).toEqual([
        expect.objectContaining({ type: "context_compact", state: "started" }),
        expect.objectContaining({
          type: "context_compact",
          state: "completed",
          trigger: "manual",
          preTokens: 120_000,
          postTokens: 18_000,
          durationMs: 1_250,
        }),
      ]);
      const compactingNotices = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "system_notice"
          && typeof env.event.message === "string"
          && env.event.message.includes("Compacting conversation context"));
      expect(compactingNotices).toHaveLength(0);
    });

    it("emits a rate-limit notice when the Claude SDK reports usage pressure", async () => {
      vi.useFakeTimers();
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "rate_limit_event",
          session_id: "sdk-session-rate-limit",
          rate_limit_info: {
            status: "allowed_warning",
            utilization: 0.82,
            resetsAt: 1_770_000_000,
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        // The idle reader can receive the same provider warning after the
        // foreground turn has ended. The producer must keep this at one notice.
        yield {
          type: "rate_limit_event",
          session_id: "sdk-session-rate-limit",
          rate_limit_info: {
            status: "allowed_warning",
            utilization: 0.82,
            resetsAt: 1_770_000_000,
          },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-rate-limit",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-rate-limit",
      } as any);

      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      try {
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "show usage pressure",
          timeoutMs: 15_000,
        });

        let rateLimitNotices = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice" && env.event.noticeKind === "rate_limit");
        expect(rateLimitNotices).toHaveLength(1);
        expect(rateLimitNotices[0].event).toMatchObject({
          type: "system_notice",
          noticeKind: "rate_limit",
          severity: "info",
          status: "allowed_warning",
          message: "Approaching Claude plan limit",
        });
        expect(rateLimitNotices[0].event.detail).toContain("82% utilized");
        expect(rateLimitNotices[0].event.detail).toContain("resets");

        await vi.advanceTimersByTimeAsync(6 * 60_000);
        expect(close).toHaveBeenCalledTimes(1);

        await service.runSessionTurn({
          sessionId: session.id,
          text: "show usage pressure again",
          timeoutMs: 15_000,
        });

        rateLimitNotices = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice" && env.event.noticeKind === "rate_limit");
        expect(rateLimitNotices).toHaveLength(1);
        expect(claudeSdkCreateSessionCompat.mock.calls.some(([options]) =>
          options?.pathToClaudeCodeExecutable === "/usr/local/bin/claude",
        )).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("emits a sticky session-quota card and reaps so the next send resumes the same UUID", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "rate_limit_event",
            session_id: "sdk-session-quota",
            rate_limit_info: {
              status: "rejected",
              utilization: 1,
              resetsAt: 1_770_000_000,
            },
          };
          yield {
            type: "assistant",
            session_id: "sdk-session-quota",
            message: {
              content: [{ type: "text", text: "You've hit your session limit · resets 7pm (America/New_York)" }],
            },
          };
          yield {
            type: "result",
            is_error: true,
            errors: ["You've hit your session limit · resets 7pm (America/New_York)"],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-quota",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-quota",
      } as any);

      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "keep going",
        timeoutMs: 15_000,
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "continue after limit",
        timeoutMs: 15_000,
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "resumed after reset",
        timeoutMs: 15_000,
      });

      const quotaCards = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "ade_card" && env.event.variant === "claude_session_quota")
        .map((env: any) => env.event);
      expect(quotaCards.length).toBeGreaterThan(1);
      expect(quotaCards[0]).toMatchObject({
        variant: "claude_session_quota",
        state: "live",
      });
      expect(quotaCards[0].actions).toEqual([
        { id: "fork-local", label: "Fork in this lane", kind: "primary" },
      ]);
      expect(quotaCards.at(-1)).toMatchObject({
        variant: "claude_session_quota",
        state: "terminal",
        title: "Claude session resumed",
      });
      const limitNotices = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "system_notice" && env.event.noticeKind === "rate_limit" && env.event.severity === "error");
      expect(limitNotices).toHaveLength(0);
      expect(close.mock.calls.length).toBeGreaterThan(0);
    });

    it("parks the session while Claude waits on a usage-limit reset and clears park on opt-out", async () => {
      const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "rate_limit_event",
          session_id: "sdk-session-park",
          rate_limit_info: {
            status: "rejected",
            utilization: 1,
            resetsAt,
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close, sessionId: "sdk-session-park",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send, stream, close, sessionId: "sdk-session-park",
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "hit the limit",
        timeoutMs: 15_000,
      });
      const parked = await service.getSessionSummary(session.id);
      expect(parked?.usageLimitParkedUntil).toEqual(expect.any(String));
      expect(Date.parse(parked!.usageLimitParkedUntil!)).toBeGreaterThan(Date.now());

      await service.updateSession({
        sessionId: session.id,
        autoContinueAtUsageLimit: false,
      });
      const optedOut = await service.getSessionSummary(session.id);
      expect(optedOut?.autoContinueAtUsageLimit).toBe(false);
      expect(optedOut?.usageLimitParkedUntil ?? null).toBeNull();
    });

    /**
     * Claude's structured usage limit, end to end.
     *
     * Both halves of this were broken in production on 2026-09-07: a real limit
     * armed nothing (the service parked instead of arming, and reaped the query
     * before anything could be written), and an assistant reply that merely
     * QUOTED a limit message tripped the whole quota path on a completed turn.
     */
    describe("claude usage-limit durable resume", () => {
      const claudeQuotaRejectionStream = (sessionId: string, resetsAtSeconds: number) => {
        let streamCall = 0;
        return vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }
          yield {
            type: "rate_limit_event",
            session_id: sessionId,
            rate_limit_info: { status: "rejected", utilization: 1, resetsAt: resetsAtSeconds },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })());
      };

      it("claude usage limit arms the durable auto-resume row before the query reset", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetAtMs = Date.now() + 3_600_000;
        const resetsAt = Math.floor(resetAtMs / 1000);
        // The durable row as it stood the first time the query was reaped. The
        // reset used to run first and tear the runtime down mid-upsert, which
        // is exactly how a real limit ended up resuming nothing.
        let stateAtFirstClose: ReturnType<typeof scheduledWork.readState> | undefined;
        const close = vi.fn(() => {
          if (stateAtFirstClose === undefined) stateAtFirstClose = scheduledWork.readState();
        });
        const send = vi.fn().mockResolvedValue(undefined);
        const stream = claudeQuotaRejectionStream("sdk-session-arm", resetsAt);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-arm",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-arm",
        } as any);

        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });

        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });
        const [schedule] = await service.listScheduledWork({ sessionId: session.id });
        expect(schedule).toMatchObject({
          id: `auto-resume:${session.id}`,
          source: "auto_resume_limit",
          status: "scheduled",
        });
        expect(Date.parse(schedule.nextRunAt ?? "")).toBe(
          Math.floor(resetAtMs / 1000) * 1000 + 90_000,
        );
        expect(close.mock.calls.length).toBeGreaterThan(0);
        expect(stateAtFirstClose?.schedules).toEqual([
          expect.objectContaining({ id: `auto-resume:${session.id}` }),
        ]);

        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume).toMatchObject({
          state: "armed",
          provider: "claude",
          scheduleId: `auto-resume:${session.id}`,
          attempts: 1,
        });
        // The deprecated mirror follows the resume state; new clients ignore it.
        expect(summary?.usageLimitParkedUntil).toBe(summary?.usageLimitResume?.fireAt);
      });

      it("assistant prose quoting a session limit does not trip the quota path", async () => {
        const events: AgentChatEventEnvelope[] = [];
        const close = vi.fn();
        const send = vi.fn().mockResolvedValue(undefined);
        let streamCall = 0;
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }
          yield {
            type: "assistant",
            message: {
              content: [{
                type: "text",
                // Verbatim from the transcript that reproduced the bug: the
                // agent was REPORTING a limit, not hitting one.
                text: "The log says: You've hit your session limit \u00b7 resets 7:30pm (America/New_York)",
              }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-prose",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-prose",
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
          text: "what does the log say?",
          timeoutMs: 15_000,
        });

        const done = events.filter((event) => event.event.type === "done").at(-1);
        expect(done?.event).toMatchObject({ type: "done", status: "completed" });
        expect(events.filter((event) =>
          event.event.type === "ade_card"
          && (event.event as any).variant === "claude_session_quota")).toEqual([]);
        expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume ?? null).toBeNull();
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
        // The turn completed, so nothing may have reaped the query underneath it.
        expect(close).not.toHaveBeenCalled();
      });

      it("stale park with no structured limit heals on hydration", async () => {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        // Dispose first: a live service keeps writing its own persisted state,
        // and the stale row below has to be what the next hydration reads.
        await service.dispose({ sessionId: session.id });
        // Exactly what the old prose scan left behind: a park instant, no
        // durable row, and no record that a structured limit ever happened.
        writePersistedChatState(session.id, {
          ...readPersistedChatState(session.id),
          usageLimitParkedUntil: new Date(Date.now() + 3_600_000).toISOString(),
        });

        const { service: restarted } = createService();
        // The cheapest call that hydrates the chat; it changes nothing itself.
        await restarted.updateSession({ sessionId: session.id });
        await vi.waitFor(() => {
          expect(readPersistedChatState(session.id).usageLimitParkedUntil ?? null).toBeNull();
        });
        const summary = await restarted.getSessionSummary(session.id);
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
        expect(summary?.usageLimitResume ?? null).toBeNull();
      });

      it("resumeUsageLimitNow cancels the row and sends the continue prompt", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = claudeQuotaRejectionStream("sdk-session-resume-now", resetsAt);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-now",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-now",
        } as any);

        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
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
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        const result = await service.resumeUsageLimitNow({ sessionId: session.id });
        expect(result.ok).toBe(true);

        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        });
        const resumeMessage = events.findLast((event) =>
          event.event.type === "user_message"
          && (event.event as any).metadata?.usageLimitResume === "manual");
        expect((resumeMessage?.event as any)?.text).toContain(
          "Continue the interrupted task from where it stopped",
        );
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume ?? null).toBeNull();
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
      });

      it("resumeUsageLimitNow awaits row cancellation before sending", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = claudeQuotaRejectionStream("sdk-session-resume-order", resetsAt);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-order",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-order",
        } as any);

        // The durable row exactly as it stood when the manual prompt was
        // emitted. A row still pending at that instant is a row the scheduler
        // can also deliver, which is the double-prompt this ordering forbids.
        const rowsAtDispatch: ChatScheduledWorkRecord[][] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => {
            if (rowsAtDispatch.length > 0) return;
            if (event.event.type !== "user_message") return;
            if ((event.event as any).metadata?.usageLimitResume !== "manual") return;
            rowsAtDispatch.push(scheduledWork.readState()?.schedules ?? []);
          },
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        const result = await service.resumeUsageLimitNow({ sessionId: session.id });
        expect(result.ok).toBe(true);

        // No waitFor: the cancellation is awaited, so the row is already gone
        // the moment the call resolves rather than shortly afterwards.
        expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        expect(rowsAtDispatch).toHaveLength(1);
        expect((rowsAtDispatch[0] ?? []).filter((row) =>
          row.id === `auto-resume:${session.id}`
          && (row.status === "scheduled" || row.status === "paused"))).toEqual([]);
      });

      it("resumeUsageLimitNow restores the armed state when the send fails", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = claudeQuotaRejectionStream("sdk-session-resume-fail", resetsAt);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-fail",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-fail",
        } as any);

        // The send is refused only once the chat is armed: the limit turn below
        // has to run normally first.
        let sendsAllowed = true;
        const { service } = createService({
          db: scheduledWork.db,
          diskPressureMonitor: {
            canPerform: vi.fn(() => (sendsAllowed ? { allowed: true } : {
              allowed: false,
              state: "exhausted",
              code: "disk_full",
              message: "Your computer is almost out of storage.",
            })),
          },
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });
        const armed = (await service.getSessionSummary(session.id))?.usageLimitResume;
        expect(armed).toMatchObject({ state: "armed" });

        // Nothing dispatches, so the trade the manual resume made (row
        // cancelled, visible state cleared) bought nothing and must be given
        // back rather than leaving the chat with neither the manual turn nor
        // its automatic recovery.
        sendsAllowed = false;
        await expect(service.resumeUsageLimitNow({ sessionId: session.id }))
          .rejects.toThrow(/could not start the resume turn/);

        const restored = await service.getSessionSummary(session.id);
        expect(restored?.usageLimitResume).toMatchObject({
          state: "armed",
          provider: "claude",
          fireAt: armed?.fireAt,
          scheduleId: `auto-resume:${session.id}`,
        });
        // The deprecated mirror is restored with it, through the same writer.
        expect(restored?.usageLimitParkedUntil).toBe(armed?.fireAt);
        const rows = await service.listScheduledWork({ sessionId: session.id });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: `auto-resume:${session.id}`,
          status: "scheduled",
          nextRunAt: armed?.fireAt,
        });
      });

      it("resumeUsageLimitNow does not restore after a concurrent scheduled-work pause", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = claudeQuotaRejectionStream("sdk-session-resume-pause-race", resetsAt);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-pause-race",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-pause-race",
        } as any);

        let refuseSends = false;
        let pause: Promise<unknown> | null = null;
        let serviceRef: ReturnType<typeof createService>["service"] | null = null;
        let sessionIdForPauseRace = "";
        const { service } = createService({
          db: scheduledWork.db,
          diskPressureMonitor: {
            canPerform: vi.fn(() => {
              if (!refuseSends) return { allowed: true };
              // The user pauses after Resume now has cancelled its row but
              // before the refused send's restore can run. The pause method
              // records that decision synchronously before awaiting the
              // scheduler, so the restore must see a newer epoch.
              pause ??= serviceRef!.setScheduledWorkPaused({
                sessionId: sessionIdForPauseRace,
                paused: true,
              });
              return {
                allowed: false,
                state: "exhausted",
                code: "disk_full",
                message: "Your computer is almost out of storage.",
              };
            }),
          },
        });
        serviceRef = service;
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        sessionIdForPauseRace = session.id;
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        refuseSends = true;
        await expect(service.resumeUsageLimitNow({ sessionId: session.id }))
          .rejects.toThrow(/could not start the resume turn/);
        expect(pause).not.toBeNull();
        await pause;

        // The pause won the race. A failed manual resume must not put the
        // cancelled row or the cleared state back behind that decision.
        expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        expect((await service.getSessionSummary(session.id))?.usageLimitResume ?? null).toBeNull();
      });

      it("resumeUsageLimitNow does not re-arm after a mid-flight Don't continue", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = claudeQuotaRejectionStream("sdk-session-resume-optout", resetsAt);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-optout",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-resume-optout",
        } as any);

        // Don't continue lands WHILE the manual send is in flight: the gate that
        // refuses the send is also what turns auto-continue off, so the restore
        // that follows is looking at a chat the user has since opted out of.
        let refuseSends = false;
        let optOut: Promise<unknown> | null = null;
        let sessionId = "";
        let serviceRef: ReturnType<typeof createService>["service"] | null = null;
        const { service } = createService({
          db: scheduledWork.db,
          diskPressureMonitor: {
            canPerform: vi.fn(() => {
              if (!refuseSends) return { allowed: true };
              optOut ??= serviceRef!.updateSession({
                sessionId,
                autoContinueAtUsageLimit: false,
              });
              return {
                allowed: false,
                state: "exhausted",
                code: "disk_full",
                message: "Your computer is almost out of storage.",
              };
            }),
          },
        });
        serviceRef = service;
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        sessionId = session.id;
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        refuseSends = true;
        await expect(service.resumeUsageLimitNow({ sessionId: session.id }))
          .rejects.toThrow(/could not start the resume turn/);
        expect(optOut).not.toBeNull();
        await optOut;

        // The opt-out is newer than the state the restore was undoing, so it
        // stands: no armed state, no mirror, and no resurrected row.
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.autoContinueAtUsageLimit).toBe(false);
        expect(summary?.usageLimitResume).toMatchObject({ state: "opted_out", fireAt: null });
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
        expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
      });

      /**
       * A stream that rejects EVERY query with the same limit, unlike
       * `claudeQuotaRejectionStream`, whose first call is the session warm-up.
       * A turn dispatched after an earlier limit builds a brand new query, so
       * its first stream call IS the turn and has to carry the rejection.
       */
      const alwaysQuotaRejectionStream = (sessionId: string, resetsAtSeconds: number) =>
        vi.fn(() => (async function* () {
          yield {
            type: "rate_limit_event",
            session_id: sessionId,
            rate_limit_info: { status: "rejected", utilization: 1, resetsAt: resetsAtSeconds },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })());

      /**
       * Points the Claude SDK mocks at a query that dies at `resetsAtSeconds`.
       * `warmedUp: false` uses the warm-up-aware stream, which is right only for
       * the FIRST limit of a chat; every later turn builds a fresh query whose
       * first stream call is the turn itself.
       */
      const installClaudeLimitStream = (
        label: string,
        resetsAtSeconds: number,
        warmedUp = true,
      ) => {
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = warmedUp
          ? alwaysQuotaRejectionStream(label, resetsAtSeconds)
          : claudeQuotaRejectionStream(label, resetsAtSeconds);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: label,
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: label,
        } as any);
      };

      /**
       * A repeat limit that arrives on a scheduler-dispatched turn, without the
       * user-message sweep an ordinary send would run. It is the only way a
       * second arm can count against the two-arm cap, so the tests that care
       * about the cap have to dispatch this way rather than through a normal
       * send.
       */
      const scheduledWakeMetadata = (sessionId: string) => ({
        scheduledWake: {
          scheduleId: `auto-resume:${sessionId}`,
          kind: "wakeup" as const,
          firedAt: new Date().toISOString(),
          reason: "Auto-resume after usage limit reset",
        },
      });

      it("resumeUsageLimitNow keeps the two-arm cap when the send fails", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        let resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const armedNotices = () => events.filter((event) =>
          event.event.type === "system_notice"
          && typeof (event.event as any).message === "string"
          && /^Resumes at /.test((event.event as any).message));

        installClaudeLimitStream("sdk-session-cap-1", resetsAt, false);
        let refuseSends = false;
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
          diskPressureMonitor: {
            canPerform: vi.fn(() => (refuseSends ? {
              allowed: false,
              state: "exhausted",
              code: "disk_full",
              message: "Your computer is almost out of storage.",
            } : { allowed: true })),
          },
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(() => expect(armedNotices()).toHaveLength(1));

        // The manual resume never dispatches, so it is not the intervening
        // event the cap waits for: the one arm already spent has to survive it.
        refuseSends = true;
        await expect(service.resumeUsageLimitNow({ sessionId: session.id }))
          .rejects.toThrow(/could not start the resume turn/);
        refuseSends = false;
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        // Second arm, on a scheduler-dispatched turn (no user sweep to reset
        // the streak). This is the last one the cap allows.
        resetsAt = Math.floor((Date.now() + 7_200_000) / 1000);
        installClaudeLimitStream("sdk-session-cap-2", resetsAt);
        await service.sendMessage({
          sessionId: session.id,
          text: "continue",
          metadata: scheduledWakeMetadata(session.id),
        });
        await vi.waitFor(() => expect(armedNotices()).toHaveLength(2));

        // Third limit, same path: the cap is spent, so this one pauses instead
        // of arming a third window and burning another turn.
        resetsAt = Math.floor((Date.now() + 10_800_000) / 1000);
        installClaudeLimitStream("sdk-session-cap-3", resetsAt);
        await service.sendMessage({
          sessionId: session.id,
          text: "continue",
          metadata: scheduledWakeMetadata(session.id),
        });
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "system_notice"
            && (event.event as any).message === "Paused after 2 tries")).toBe(true);
        });
        expect(armedNotices()).toHaveLength(2);
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume).toMatchObject({ state: "paused", attempts: 2 });
      });

      it("a paused auto-resume row survives a repeat limit with no countdown", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        let resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);

        installClaudeLimitStream("sdk-session-paused-1", resetsAt, false);
        const { service } = createService({
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
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });
        const [armed] = await service.listScheduledWork({ sessionId: session.id });
        const armedFireAt = armed?.nextRunAt;
        expect(armedFireAt).toEqual(expect.any(String));

        // The user pauses this chat's scheduled work. A later limit must not
        // quietly un-pause the row by upserting over it.
        await service.setScheduledWorkPaused({ sessionId: session.id, paused: true });
        resetsAt = Math.floor((Date.now() + 7_200_000) / 1000);
        installClaudeLimitStream("sdk-session-paused-2", resetsAt);
        const doneBefore = events.filter((event) => event.event.type === "done").length;
        await service.sendMessage({
          sessionId: session.id,
          text: "continue",
          metadata: scheduledWakeMetadata(session.id),
        });
        // The turn's own completion is the barrier: the quota-reject teardown
        // waits for the arm decision before it reaps the query, so a `done`
        // here means the arm path has already run (and, with a paused row,
        // decided to do nothing).
        await vi.waitFor(() => {
          expect(events.filter((event) => event.event.type === "done").length)
            .toBeGreaterThan(doneBefore);
        });

        const rows = await service.listScheduledWork({ sessionId: session.id });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: `auto-resume:${session.id}`, status: "paused" });
        // Same instant as before: the second limit neither rescheduled the row
        // nor re-armed its timer.
        expect(rows[0]?.nextRunAt).toBe(armedFireAt);
        // And no countdown: a paused row reports `no_reset`, so the pill offers
        // Retry instead of ticking down to an instant nothing happens at.
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume).toMatchObject({
          state: "no_reset",
          fireAt: null,
          scheduleId: null,
        });
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
      });

      it("Turn on after a failed manual resume clears the restored cap", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        let resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const armedNotices = () => events.filter((event) =>
          event.event.type === "system_notice"
          && typeof (event.event as any).message === "string"
          && /^Resumes at /.test((event.event as any).message));
        const pausedNotices = () => events.filter((event) =>
          event.event.type === "system_notice"
          && (event.event as any).message === "Paused after 2 tries");
        const doneCount = () => events.filter((event) => event.event.type === "done").length;

        installClaudeLimitStream("sdk-session-turnon-1", resetsAt, false);
        let refuseSends = false;
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
          diskPressureMonitor: {
            canPerform: vi.fn(() => (refuseSends ? {
              allowed: false,
              state: "exhausted",
              code: "disk_full",
              message: "Your computer is almost out of storage.",
            } : { allowed: true })),
          },
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        const wakeLimit = async (label: string) => {
          resetsAt += 3_600;
          installClaudeLimitStream(label, resetsAt);
          const before = doneCount();
          await service.sendMessage({
            sessionId: session.id,
            text: "continue",
            metadata: scheduledWakeMetadata(session.id),
          });
          await vi.waitFor(() => expect(doneCount()).toBeGreaterThan(before));
        };

        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(() => expect(armedNotices()).toHaveLength(1));
        // Spend the whole cap, so the chat is paused and the failed resume
        // below has a capped streak to hand back.
        await wakeLimit("sdk-session-turnon-2");
        await vi.waitFor(() => expect(armedNotices()).toHaveLength(2));
        await wakeLimit("sdk-session-turnon-3");
        await vi.waitFor(() => expect(pausedNotices()).toHaveLength(1));

        refuseSends = true;
        await expect(service.resumeUsageLimitNow({ sessionId: session.id }))
          .rejects.toThrow(/could not start the resume turn/);
        refuseSends = false;

        // Try again is the human override: it clears the streak the failed
        // resume just restored (and bumps the cancel epoch so no later undo can
        // put it back), so the next limit arms instead of pausing again.
        await service.updateSession({
          sessionId: session.id,
          autoContinueAtUsageLimit: true,
        });
        await vi.waitFor(() => expect(armedNotices()).toHaveLength(3));
        await wakeLimit("sdk-session-turnon-4");
        await vi.waitFor(() => expect(armedNotices()).toHaveLength(4));
        expect(pausedNotices()).toHaveLength(1);
        expect((await service.getSessionSummary(session.id))?.usageLimitResume)
          .toMatchObject({ state: "armed", attempts: 2 });
      });

      it("a user message during a failed manual resume keeps the streak reset", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        installClaudeLimitStream("sdk-session-takeover-1", resetsAt, false);
        let refusedOnce = false;
        let takeover: Promise<unknown> | null = null;
        let sessionId = "";
        let serviceRef: ReturnType<typeof createService>["service"] | null = null;
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
          diskPressureMonitor: {
            canPerform: vi.fn(() => {
              // Only the manual resume is refused; the user's own takeover
              // message that lands during it must go through.
              if (!refusedOnce) return { allowed: true };
              refusedOnce = false;
              takeover ??= serviceRef!.sendMessage({
                sessionId,
                text: "I'm back, taking this over.",
              });
              return {
                allowed: false,
                state: "exhausted",
                code: "disk_full",
                message: "Your computer is almost out of storage.",
              };
            }),
          },
        });
        serviceRef = service;
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        sessionId = session.id;
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        refusedOnce = true;
        await expect(service.resumeUsageLimitNow({ sessionId: session.id }))
          .rejects.toThrow(/could not start the resume turn/);
        expect(takeover).not.toBeNull();
        await takeover;

        // The user took the chat over: their message cancelled the resume, and
        // the undo must not put it back behind them.
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        });
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume ?? null).toBeNull();
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
      });

      it("pausing the auto-resume row reports no_reset and still allows Resume now", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        installClaudeLimitStream("sdk-session-pause-state-1", resetsAt, false);
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect((await service.getSessionSummary(session.id))?.usageLimitResume)
            .toMatchObject({ state: "armed" });
        });
        const armedState = (await service.getSessionSummary(session.id))?.usageLimitResume;

        await service.setScheduledWorkPaused({ sessionId: session.id, paused: true });

        // A paused row is not going to fire, so the chat stops counting down to
        // it: no fire time, no schedule id, and the provider detail kept so the
        // pill still explains which limit this is.
        const paused = await service.getSessionSummary(session.id);
        expect(paused?.usageLimitResume).toMatchObject({
          state: "no_reset",
          fireAt: null,
          scheduleId: null,
          provider: "claude",
          turnId: armedState?.turnId ?? null,
        });
        expect(paused?.usageLimitParkedUntil ?? null).toBeNull();

        // And Resume now still works: a paused resume is exactly the case where
        // sending by hand is the chat's only way forward.
        installClaudeLimitStream("sdk-session-pause-state-2", resetsAt);
        const resumed = await service.resumeUsageLimitNow({ sessionId: session.id });
        expect(resumed.ok).toBe(true);
      });

      it("un-pausing the auto-resume row reports armed again", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        installClaudeLimitStream("sdk-session-unpause-1", resetsAt, false);
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect((await service.getSessionSummary(session.id))?.usageLimitResume)
            .toMatchObject({ state: "armed" });
        });
        const armedFireAt = (await service.getSessionSummary(session.id))?.usageLimitResume?.fireAt;

        await service.setScheduledWorkPaused({ sessionId: session.id, paused: true });
        expect((await service.getSessionSummary(session.id))?.usageLimitResume)
          .toMatchObject({ state: "no_reset", fireAt: null });

        await service.setScheduledWorkPaused({ sessionId: session.id, paused: false });
        const resumedState = await service.getSessionSummary(session.id);
        expect(resumedState?.usageLimitResume).toMatchObject({
          state: "armed",
          fireAt: armedFireAt,
          scheduleId: `auto-resume:${session.id}`,
        });
        expect(resumedState?.usageLimitParkedUntil).toBe(armedFireAt);
      });

      it("a durable row with no stored state still reports the countdown", async () => {
        const scheduledWork = createScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        const fireAt = Date.now() + 30 * 60_000;
        const createdAt = Date.now() - 60_000;
        // The row outlives the state: an arm reported while the chat was not
        // resident in memory writes the row and drops the state, and the
        // countdown a client renders has to survive that.
        scheduledWork.db.setJson(SCHEDULED_WORK_STATE_KEY, {
          version: 1,
          schedules: [{
            id: `auto-resume:${session.id}`,
            sessionId: session.id,
            kind: "wakeup",
            prompt: "Continue the interrupted task from where it stopped.",
            reason: "Auto-resume after usage limit reset",
            fireAt,
            createdAt,
            status: "scheduled",
            pausedFlag: false,
            lateFlag: false,
            durable: true,
            source: "auto_resume_limit",
          }],
          pausedSessionIds: [],
        });

        const { service: restarted } = createService({ db: scheduledWork.db });
        await restarted.updateSession({ sessionId: session.id });
        const summary = await restarted.getSessionSummary(session.id);
        expect(summary?.usageLimitResume).toMatchObject({
          state: "armed",
          provider: "claude",
          fireAt: new Date(fireAt).toISOString(),
          scheduleId: `auto-resume:${session.id}`,
          // Stamped from the row, so an unchanged resume does not look like a
          // change on every summary read.
          updatedAt: new Date(createdAt).toISOString(),
        });
        expect(summary?.usageLimitParkedUntil).toBe(new Date(fireAt).toISOString());
        restarted.forceDisposeAll();
        service.forceDisposeAll();
      });

      it("a paused durable row with no stored state synthesizes nothing", async () => {
        const scheduledWork = createScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        scheduledWork.db.setJson(SCHEDULED_WORK_STATE_KEY, {
          version: 1,
          schedules: [{
            id: `auto-resume:${session.id}`,
            sessionId: session.id,
            kind: "wakeup",
            prompt: "Continue the interrupted task from where it stopped.",
            reason: "Auto-resume after usage limit reset",
            fireAt: Date.now() + 30 * 60_000,
            createdAt: Date.now() - 60_000,
            status: "paused",
            pausedFlag: true,
            lateFlag: false,
            durable: true,
            source: "auto_resume_limit",
          }],
          pausedSessionIds: [],
        });

        const { service: restarted } = createService({ db: scheduledWork.db });
        await restarted.updateSession({ sessionId: session.id });
        const summary = await restarted.getSessionSummary(session.id);
        // A paused row is not a countdown, and there is no stored state to
        // project it onto, so the chat reports no resume at all.
        expect(summary?.usageLimitResume ?? null).toBeNull();
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
        restarted.forceDisposeAll();
        service.forceDisposeAll();
      });

      it("a wedged auto-resume arm releases the turn at the deadline", async () => {
        // The scheduler never finishes loading, so the arm never settles. The
        // wait that orders the reap after the arm has to give up: losing an arm
        // is recoverable, a chat stuck busy behind a pending promise is not.
        const backing = createScheduledWorkDb();
        const neverBoots = {
          ...backing.db,
          getJson: vi.fn((key: string) => (key === SCHEDULED_WORK_STATE_KEY
            ? new Promise(() => undefined)
            : backing.db.getJson(key))),
        };
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        installClaudeLimitStream("sdk-session-wedged-arm", resetsAt, false);
        const events: AgentChatEventEnvelope[] = [];
        const { service, logger } = createService({
          db: neverBoots,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        vi.useFakeTimers();
        try {
          const turn = service.runSessionTurn({
            sessionId: session.id,
            text: "hit the limit",
            timeoutMs: 60_000,
          });
          const settled = turn.then(() => "settled" as const, () => "settled" as const);
          // Everything up to the bounded wait is promise work; the deadline is
          // the only timer between the limit and the finished turn.
          await vi.advanceTimersByTimeAsync(10_000);
          await expect(Promise.race([
            settled,
            Promise.resolve().then(() => "pending" as const),
          ])).resolves.toBe("settled");
          expect(logger.warn).toHaveBeenCalledWith(
            "agent_chat.auto_resume_arm_wait_timeout",
            expect.objectContaining({ sessionId: session.id, waitMs: 5_000 }),
          );
          // The deadline timer is cleared rather than left to fire into a
          // disposed service.
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
          service.forceDisposeAll();
        }
      });

      it("a limit on a chat whose scheduled work is already paused arms nothing", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        installClaudeLimitStream("sdk-session-prepaused", resetsAt, false);
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        // Paused BEFORE the limit: the scheduler accepts the row and parks it,
        // so the arm has to notice that what it just wrote will never fire.
        await service.setScheduledWorkPaused({ sessionId: session.id, paused: true });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });

        await vi.waitFor(async () => {
          expect((await service.getSessionSummary(session.id))?.usageLimitResume)
            .toMatchObject({ state: "no_reset" });
        });
        const summary = await service.getSessionSummary(session.id);
        // No countdown, no promise in the transcript, and no attempt spent
        // against the two-arm cap.
        expect(summary?.usageLimitResume).toMatchObject({
          state: "no_reset",
          fireAt: null,
          scheduleId: null,
          attempts: 0,
          provider: "claude",
        });
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
        expect(events.filter((event) =>
          event.event.type === "system_notice"
          && typeof (event.event as any).message === "string"
          && /^Resumes at /.test((event.event as any).message))).toEqual([]);
      });

      it("a paused row reports no_reset for a chat that is not resident", async () => {
        const scheduledWork = createScheduledWorkDb();
        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        // Stop the first service writing before seeding, without ending the
        // session: the scheduler cancels rows belonging to a session that is
        // no longer active, and this chat is meant to be merely non-resident.
        service.forceDisposeAll();
        const fireAt = Date.now() + 30 * 60_000;
        // A row parked by a project-wide pause (or parked before the last
        // restart) plus the armed state stored before it: the transition-time
        // projection never ran for this chat, so the read has to do it.
        writePersistedChatState(session.id, {
          ...readPersistedChatState(session.id),
          usageLimitResume: {
            state: "armed",
            provider: "claude",
            fireAt: new Date(fireAt).toISOString(),
            resetAt: new Date(fireAt - 90_000).toISOString(),
            scheduleId: `auto-resume:${session.id}`,
            attempts: 1,
            providerDetail: "100% utilized",
            turnId: "turn-limit",
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        });
        scheduledWork.db.setJson(SCHEDULED_WORK_STATE_KEY, {
          version: 1,
          schedules: [{
            id: `auto-resume:${session.id}`,
            sessionId: session.id,
            kind: "wakeup",
            prompt: "Continue the interrupted task from where it stopped.",
            reason: "Auto-resume after usage limit reset",
            fireAt,
            createdAt: Date.now() - 60_000,
            status: "paused",
            pausedFlag: true,
            lateFlag: false,
            durable: true,
            source: "auto_resume_limit",
          }],
          pausedSessionIds: [],
        });

        const { service: restarted } = createService({ db: scheduledWork.db });
        const summary = await restarted.getSessionSummary(session.id);
        expect(summary?.usageLimitResume).toMatchObject({
          state: "no_reset",
          fireAt: null,
          scheduleId: null,
          providerDetail: "100% utilized",
          turnId: "turn-limit",
        });
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
        restarted.forceDisposeAll();
      });

      it("resumeUsageLimitNow refuses when no usage limit is live", async () => {
        const scheduledWork = createScheduledWorkDb();
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          db: scheduledWork.db,
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        // Resume now spends a real turn. A stale button, a replayed action, or a
        // chat that already recovered must not be able to spend one.
        const refused = await service.resumeUsageLimitNow({ sessionId: session.id });
        expect(refused).toEqual({
          ok: false,
          reason: "no_live_usage_limit",
          message: "No usage limit is live for this chat.",
        });
        expect(events.some((event) =>
          event.event.type === "user_message"
          && (event.event as any).metadata?.usageLimitResume === "manual")).toBe(false);
        expect(scheduledWork.readState()?.schedules ?? []).toEqual([]);
      });

      it("resumeUsageLimitNow refuses while the armed row is already delivering", async () => {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        // Dispose first: a live service keeps writing its own persisted state,
        // and the seeded row below has to be what the next hydration reads.
        await service.dispose({ sessionId: session.id });
        // A row whose fire time has passed resolves to `resuming`: the scheduler
        // is delivering it at the next turn boundary, so a manual send here
        // would race it into a double prompt.
        writePersistedChatState(session.id, {
          ...readPersistedChatState(session.id),
          usageLimitResume: {
            state: "armed",
            provider: "claude",
            fireAt: new Date(Date.now() - 60_000).toISOString(),
            resetAt: new Date(Date.now() - 150_000).toISOString(),
            scheduleId: `auto-resume:${session.id}`,
            attempts: 1,
            providerDetail: null,
            turnId: "turn-limit",
            updatedAt: new Date(Date.now() - 150_000).toISOString(),
          },
        });

        const { service: restarted } = createService();
        const refused = await restarted.resumeUsageLimitNow({ sessionId: session.id });
        expect(refused).toEqual({
          ok: false,
          reason: "resume_in_flight",
          message: "This chat is already resuming. Wait for the current turn to start.",
        });
      });

      it("re-enabling auto-continue re-arms", async () => {
        const scheduledWork = createScheduledWorkDb();
        const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = claudeQuotaRejectionStream("sdk-session-rearm", resetsAt);
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-rearm",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-rearm",
        } as any);

        const { service } = createService({ db: scheduledWork.db });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "hit the limit",
          timeoutMs: 15_000,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        });

        await service.updateSession({
          sessionId: session.id,
          autoContinueAtUsageLimit: false,
        });
        await vi.waitFor(async () => {
          expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        });
        // Don't continue does not end the limit — it ends ADE's answer to it.
        expect((await service.getSessionSummary(session.id))?.usageLimitResume)
          .toMatchObject({ state: "opted_out", fireAt: null });

        await service.updateSession({
          sessionId: session.id,
          autoContinueAtUsageLimit: true,
        });
        // Arming is asynchronous (it waits on the scheduler), so the state — not
        // the row — is what proves the re-arm landed: the row appears one step
        // earlier, at the upsert.
        await vi.waitFor(async () => {
          expect((await service.getSessionSummary(session.id))?.usageLimitResume)
            .toMatchObject({
              state: "armed",
              scheduleId: `auto-resume:${session.id}`,
              attempts: 1,
            });
        });
        expect(await service.listScheduledWork({ sessionId: session.id })).toHaveLength(1);
        expect((await service.getSessionSummary(session.id))?.autoContinueAtUsageLimit).toBe(true);
      });

      it("an ordinary send on a never-limited chat broadcasts no usage-limit meta event", async () => {
        // Every user message cancels any pending auto-resume, and the cancel
        // reports "no limit governs this chat" whether or not one ever did. The
        // first compare was a `JSON.stringify` one, so `undefined` (never
        // limited) and `null` (cleared) read as a change: every send on every
        // chat pushed a transient `session_meta_updated` to every viewer and
        // rewrote chat state to disk for a state that had not moved.
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "done" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-quiet",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-session-quiet",
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
          text: "first",
          timeoutMs: 15_000,
        });
        await service.runSessionTurn({
          sessionId: session.id,
          text: "second",
          timeoutMs: 15_000,
        });

        // Precondition: both turns really ran, so the cancel path really fired.
        expect(events.filter((event) =>
          event.event.type === "done" && event.event.status === "completed").length)
          .toBeGreaterThanOrEqual(2);
        const usageLimitMeta = events.filter((event) =>
          event.event.type === "session_meta_updated"
          && Object.prototype.hasOwnProperty.call(event.event, "usageLimitResume"));
        expect(usageLimitMeta).toEqual([]);
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume ?? null).toBeNull();
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
      });

      it("assistant prose reaching the idle reader does not trip the quota path", async () => {
        // The other half of the 2026-09-07 bug: the same text scan ran in the
        // idle reader, where a quoted limit both minted the card and settled the
        // open idle turn as interrupted. Structured limits still settle it (see
        // the idle-reader quota-rejection test above); prose must not.
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let warmupComplete = false;
        const send = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-idle-prose", slash_commands: [] };
            warmupComplete = true;
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }
          // Same frame shape as the idle-reader quota test: the kick-off turn
          // ends at its result, an unrecognized frame stops the foreground
          // pump, and everything after it is read by the idle reader.
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          yield { type: "mystery_unrecognized_frame" };
          yield {
            type: "assistant",
            session_id: "sdk-idle-prose",
            message: {
              id: "msg-idle-prose",
              content: [{
                type: "text",
                text: "The log says: You've hit your session limit · resets 7:30pm (America/New_York)",
              }],
            },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send, stream, close, sessionId: "sdk-idle-prose",
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
        await service.runSessionTurn({
          sessionId: session.id,
          text: "kick off background work",
          timeoutMs: 15_000,
        });

        // Precondition: the quoted sentence really did reach the idle reader.
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "text"
            && String((event.event as any).text ?? "").includes("hit your session limit"))).toBe(true);
        }, 3000);

        expect(events.filter((event) =>
          event.event.type === "ade_card"
          && (event.event as any).variant === "claude_session_quota")).toEqual([]);
        expect(events.filter((event) =>
          event.event.type === "done" && event.event.status === "interrupted")).toEqual([]);
        expect(await service.listScheduledWork({ sessionId: session.id })).toEqual([]);
        const summary = await service.getSessionSummary(session.id);
        expect(summary?.usageLimitResume ?? null).toBeNull();
        expect(summary?.usageLimitParkedUntil ?? null).toBeNull();
      });
    });

    it("Don't continue interrupts a busy Claude query without closing the session", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const close = vi.fn();
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-opt-out-busy", slash_commands: [] };
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
        sessionId: "sdk-opt-out-busy",
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
      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Please keep working",
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => event.event.type === "text",
      );

      await service.updateSession({
        sessionId: session.id,
        autoContinueAtUsageLimit: false,
      });

      const optedOut = await service.getSessionSummary(session.id);
      expect(optedOut?.autoContinueAtUsageLimit).toBe(false);
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "interrupted",
      );
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.status === "interrupted",
      );
      const interruptedStatuses = events.filter(
        (event) => event.event.type === "status" && event.event.turnStatus === "interrupted",
      );
      const interruptedDone = events.filter(
        (event) => event.event.type === "done" && event.event.status === "interrupted",
      );
      expect(interruptedStatuses.length).toBeGreaterThan(0);
      expect(interruptedDone.length).toBeGreaterThan(0);
      expect(close).not.toHaveBeenCalled();

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("clears usage-limit park on a user send without notifying", async () => {
      const onUsageLimitAutoResumed = vi.fn();
      const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "rate_limit_event",
          session_id: "sdk-session-park-notify",
          rate_limit_info: {
            status: "rejected",
            utilization: 1,
            resetsAt,
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close, sessionId: "sdk-session-park-notify",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send, stream, close, sessionId: "sdk-session-park-notify",
      } as any);

      const { service } = createService({ onUsageLimitAutoResumed });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "hit the limit",
        timeoutMs: 15_000,
      });
      const parked = await service.getSessionSummary(session.id);
      expect(Date.parse(parked!.usageLimitParkedUntil!)).toBeGreaterThan(Date.now());

      await service.sendMessage({
        sessionId: session.id,
        text: "I'll take it from here.",
      });
      const afterSend = await service.getSessionSummary(session.id);
      expect(afterSend?.usageLimitParkedUntil ?? null).toBeNull();
      expect(onUsageLimitAutoResumed).not.toHaveBeenCalled();
    });

    it("settles the idle turn, its subagents, and stays forkable when the idle reader hits a quota rejection", async () => {
      // Regression (Versic 21559791): a plan-limit rejection received by the
      // idle reader reset the query but never finalized the open idle turn —
      // busy/activeTurnId stayed set for two hours and every fork attempt was
      // refused with "Wait for the current response to finish". The settlement
      // pass also raced the emittedSubagentStartIds clear, so the running
      // subagent row never got its stopped result.
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          // Warmup.
          yield { type: "system", subtype: "init", session_id: "sdk-quota-idle", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // The kick-off turn ends at its result. An unrecognized post-result
        // frame stops the foreground pump, so the remaining frames — a
        // background wake opening an idle turn, a native subagent row, then
        // the plan-limit rejection — are consumed by the idle reader. That is
        // the exact shape that wedged Versic session 21559791 for two hours.
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: "mystery_unrecognized_frame" };
        yield {
          type: "assistant",
          session_id: "sdk-quota-idle",
          message: {
            id: "msg-idle-wake",
            content: [{ type: "text", text: "Resuming background work." }],
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "sub-quota-1",
          parent_tool_use_id: "toolu_idle_sub_1",
          subagent_type: "general-purpose",
          description: "Root-cause bug 12 disk twins",
        };
        yield {
          type: "assistant",
          session_id: "sdk-quota-idle",
          message: {
            id: "msg-idle-task-input",
            content: [{
              type: "tool_use",
              id: "toolu_idle_sub_1",
              name: "Agent",
              input: {
                subagent_type: "Explore",
                description: "Root-cause bug 12 disk twins",
                prompt: "Inspect the disk twins.",
                model: "opus",
              },
            }],
          },
        };
        yield {
          type: "rate_limit_event",
          session_id: "sdk-quota-idle",
          rate_limit_info: {
            status: "rejected",
            utilization: 1,
            resetsAt: 1_770_000_000,
          },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-quota-idle",
      } as any);

      const onEvent = vi.fn((event: AgentChatEventEnvelope) => { events.push(event); });
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "kick off background work",
        timeoutMs: 15_000,
      });

      let doneInterrupted: AgentChatEventEnvelope | null = null;
      await vi.waitFor(() => {
        doneInterrupted = events.find(
          (e): e is AgentChatEventEnvelope =>
            e.event.type === "done" && e.event.status === "interrupted",
        ) ?? null;
        expect(doneInterrupted).toBeTruthy();
      }, 3000);
      // The interrupted turn is the idle turn, not the foreground kick-off.
      expect(doneInterrupted!.event.turnId).toMatch(/^claude-idle-/);

      const stoppedSubagent = events.find(
        (e) => e.event.type === "subagent_result" && (e.event as any).taskId === "sub-quota-1",
      );
      expect(stoppedSubagent).toBeTruthy();
      expect((stoppedSubagent!.event as any).status).toBe("stopped");
      expect((stoppedSubagent!.event as any).agentType).toBe("Explore");
      expect((stoppedSubagent!.event as any).model).toBe("opus");
      expect((stoppedSubagent!.event as any).finalSummary).toContain("restarted");

      // With the turn settled, the advertised "fork this thread" escape
      // hatch must actually work instead of refusing the handoff.
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      const handoff = await service.handoffSession({
        sourceSessionId: session.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
        mode: "brief",
      });
      expect(handoff.session.id).toBeTruthy();
      expect(handoff.session.id).not.toBe(session.id);
    });

    it("recovers a persisted quota-wedged chat at handoff time when no runtime is attached", async () => {
      // Post-restart shape of the same wedge: the transcript holds a started
      // turn with no terminal pair plus a live quota card, and the fresh
      // process has no runtime for the source yet. Fork must settle it rather
      // than refuse forever.
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const wedgedId = "wedged-quota-claude";
      const { service, sessionService } = createService();
      installRealTranscriptParser();
      sessionService.create({
        sessionId: wedgedId,
        laneId: "lane-1",
        toolType: "claude-chat",
        title: "Wedged claude chat",
        startedAt: "2026-03-25T00:00:00.000Z",
      });
      writePersistedChatState(wedgedId, {
        version: 2,
        sessionId: wedgedId,
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        updatedAt: "2026-03-25T00:05:00.000Z",
      });
      writeTestTranscriptEnvelopes(wedgedId, [
        {
          sessionId: wedgedId,
          timestamp: "2026-03-25T00:01:00.000Z",
          event: { type: "user_message", text: "keep going", turnId: "turn-wedge" } as any,
        },
        {
          sessionId: wedgedId,
          timestamp: "2026-03-25T00:01:00.100Z",
          event: { type: "status", turnStatus: "started", turnId: "turn-wedge" } as any,
        },
        {
          sessionId: wedgedId,
          timestamp: "2026-03-25T00:01:00.200Z",
          event: {
            type: "subagent_started",
            taskId: "sub-wedge-1",
            agentId: "sub-wedge-1",
            agentType: "general-purpose",
            parentToolUseId: null,
            description: "Root-cause bug 12 disk twins",
            background: false,
            turnId: "turn-wedge",
          } as any,
        },
        {
          sessionId: wedgedId,
          timestamp: "2026-03-25T00:02:00.000Z",
          event: {
            type: "ade_card",
            cardId: `claude-session-quota:${wedgedId}`,
            variant: "claude_session_quota",
            state: "live",
            title: "Claude session limit · resets 10:20 PM",
            subtitle: "Send again after reset, or fork this thread.",
            fallbackText: "Claude session limit reached.",
          } as any,
        },
      ]);

      const handoff = await service.handoffSession({
        sourceSessionId: wedgedId,
        targetModelId: "opencode/openai/gpt-5.4-mini",
        mode: "brief",
      });
      expect(handoff.session.id).toBeTruthy();

      // The wedge was terminalized from the transcript: the turn's terminal
      // pair is exact, and the transcript-derived running subagent row settled.
      const raw = fs.readFileSync(
        path.join(tmpRoot, ".ade", "transcripts", "chat", `${wedgedId}.jsonl`),
        "utf8",
      );
      const settledEvents = raw.trim().split("\n").map((line) => JSON.parse(line) as AgentChatEventEnvelope);
      const wedgedDone = settledEvents.find((e) => e.event.type === "done" && (e.event as any).turnId === "turn-wedge");
      expect(wedgedDone?.event).toMatchObject({ type: "done", status: "interrupted", turnId: "turn-wedge" });
      expect(settledEvents.some((e) => e.event.type === "status" && (e.event as any).turnStatus === "interrupted")).toBe(true);
      const orphanResult = settledEvents.find(
        (e) => e.event.type === "subagent_result" && (e.event as any).taskId === "sub-wedge-1",
      );
      expect(orphanResult?.event).toMatchObject({ type: "subagent_result", status: "stopped" });
    });

    it("still refuses handoff for a dead claude run when no live quota card proves the wedge", async () => {
      const wedgedId = "wedged-no-quota-claude";
      const { service, sessionService } = createService();
      installRealTranscriptParser();
      sessionService.create({
        sessionId: wedgedId,
        laneId: "lane-1",
        toolType: "claude-chat",
        title: "Wedged claude chat without quota proof",
        startedAt: "2026-03-25T00:00:00.000Z",
      });
      writePersistedChatState(wedgedId, {
        version: 2,
        sessionId: wedgedId,
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        updatedAt: "2026-03-25T00:05:00.000Z",
      });
      writeTestTranscriptEnvelopes(wedgedId, [
        {
          sessionId: wedgedId,
          timestamp: "2026-03-25T00:01:00.000Z",
          event: { type: "user_message", text: "keep going", turnId: "turn-wedge" } as any,
        },
        {
          sessionId: wedgedId,
          timestamp: "2026-03-25T00:01:00.100Z",
          event: { type: "status", turnStatus: "started", turnId: "turn-wedge" } as any,
        },
      ]);

      const debugTranscriptPath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${wedgedId}.jsonl`);
      const rawBefore = fs.readFileSync(debugTranscriptPath, "utf8");

      await expect(
        service.handoffSession({
          sourceSessionId: wedgedId,
          targetModelId: "opencode/openai/gpt-5.4-mini",
          mode: "brief",
        }),
      ).rejects.toThrow("Wait for the current response to finish before handing off this chat.");
      // A refused handoff must not mutate the transcript.
      expect(fs.readFileSync(debugTranscriptPath, "utf8")).toBe(rawBefore);
    });

    it("surfaces Claude SDK retry, refusal fallback, informational, memory, notification, mirror, and denial events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        if (streamCall === 2) {
          yield {
            type: "system",
            subtype: "api_retry",
            session_id: "sdk-session-events",
            attempt: 1,
            max_retries: 3,
            retry_delay_ms: 2_000,
            error_status: 529,
            error: "overloaded",
          };
          yield {
            type: "system",
            subtype: "informational",
            session_id: "sdk-session-events",
            content: "Prompt blocked by hook",
            level: "warning",
            prevent_continuation: true,
          };
          yield {
            type: "system",
            subtype: "permission_denied",
            session_id: "sdk-session-events",
            tool_name: "Bash",
            tool_use_id: "tool-denied-direct",
            decision_reason_type: "classifier",
            decision_reason: "blocked by safety policy",
            message: "Denied",
          };
          yield {
            type: "system",
            subtype: "model_refusal_fallback",
            session_id: "sdk-session-events",
            original_model: "claude-opus-4-8",
            fallback_model: "claude-sonnet-5",
            api_refusal_category: "cyber",
            api_refusal_explanation: "The original model refused.",
            content: "Retrying on fallback model.",
            retracted_message_uuids: ["refused-message-1", "refused-tool-result-1"],
          };
          yield {
            type: "system",
            subtype: "notification",
            session_id: "sdk-session-events",
            key: "heads-up",
            text: "Background monitor finished",
            priority: "high",
          };
          yield {
            type: "system",
            subtype: "memory_recall",
            session_id: "sdk-session-events",
            mode: "select",
            memories: [{
              path: "/tmp/memory.md",
              scope: "personal",
              content: "Prefer small focused patches.",
            }],
          };
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-events",
            error: "store unavailable",
          };
          // This replayed/historical shutdown should be ignored because a
          // result follows it in the same stream.
          yield {
            type: "system",
            subtype: "worker_shutting_down",
            session_id: "sdk-session-events",
            reason: "host_exit",
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
            permission_denials: [
              { tool_name: "Bash", tool_use_id: "tool-denied-direct" },
            ],
          };
          return;
        }

        return;
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-events",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-events",
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
        text: "show new sdk event handling",
        timeoutMs: 15_000,
      });

      const notices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice",
        );
      expect(events.some((envelope) => envelope.event.type === "activity"
        && envelope.event.activity === "working"
        && envelope.event.detail === "Retrying Claude · attempt 1 of 3 · retrying in 2s")).toBe(true);
      expect(notices.some((event) =>
        event.noticeKind === "warning"
        && event.message === "Prompt blocked by hook",
      )).toBe(true);
      expect(notices.some((event) =>
        event.message === "Claude denied Bash: blocked by safety policy"
        && event.detail === "classifier",
      )).toBe(true);
      expect(notices.some((event) =>
        event.status === "model_refusal_fallback"
        && event.message === "Claude retried with claude-sonnet-5 after claude-opus-4-8 refused the request.",
      )).toBe(true);
      const refusalFallbackNotice = notices.find((event) => event.status === "model_refusal_fallback");
      expect(refusalFallbackNotice?.detail).toContain("retracted 2 SDK messages: refused-message-1, refused-tool-result-1");
      expect(notices.some((event) =>
        event.status === "notification"
        && event.noticeKind === "warning"
        && event.message === "Background monitor finished",
      )).toBe(true);
      expect(notices.some((event) =>
        event.status === "memory_recall"
        && event.message === "Claude recalled 1 memory.",
      )).toBe(true);
      expect(notices.some((event) =>
        event.status === "mirror_error"
        && event.noticeKind === "error"
        && event.detail === "store unavailable",
      )).toBe(true);
      expect(notices.filter((event) => event.message.includes("denied this turn"))).toHaveLength(0);
      expect(notices.filter((event) => event.status === "worker_shutting_down")).toHaveLength(0);
    });

    it("surfaces Claude prompt suggestions emitted after the result message", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        yield {
          type: "prompt_suggestion",
          session_id: "sdk-session-prompt-suggestion",
          uuid: "suggestion-1",
          suggestion: "Audit the Work tab",
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-prompt-suggestion",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-prompt-suggestion",
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
        text: "suggest the next prompt",
        timeoutMs: 15_000,
      });

      const eventTypes = events.map((envelope) => envelope.event.type);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "prompt_suggestion",
            suggestion: "Audit the Work tab",
          }),
        }),
      ]));
      expect(eventTypes.indexOf("prompt_suggestion")).toBeLessThan(eventTypes.indexOf("done"));
      expect((await service.getChatEventHistory(session.id, { maxEvents: 50 })).events
        .some((event) => event.event.type === "prompt_suggestion")).toBe(false);
    });

    it("continues draining stale post-result tail messages after a prompt suggestion", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let releaseFollowUpStream!: () => void;
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after the drained suggestion")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-drain-after-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          yield {
            type: "prompt_suggestion",
            session_id: "sdk-session-drain-after-suggestion",
            uuid: "suggestion-tail-1",
            suggestion: "Audit the next action",
          };
          yield {
            type: "tool_use_summary",
            session_id: "sdk-session-drain-after-suggestion",
            summary: "This stale summary should stay out of the next turn",
            preceding_tool_use_ids: ["stale-tool-use-1"],
          };
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-drain-after-suggestion",
            error: "stale mirror error after suggestion",
          };
          await followUpStreamReady;
          yield {
            type: "assistant",
            session_id: "sdk-session-drain-after-suggestion",
            message: {
              content: [{ type: "text", text: "Still on the same Claude query after draining." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-drain-after-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-drain-after-suggestion",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-drain-after-suggestion",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "suggest the next prompt and drain stale tail",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        expect(events.filter((event) => event.event.type === "prompt_suggestion")).toHaveLength(1);

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after the drained suggestion",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("same Claude query after draining");
        expect(events.filter((event) => event.event.type === "tool_use_summary")).toHaveLength(0);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "mirror_error"
          && event.event.detail === "stale mirror error after suggestion",
        )).toBe(false);
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps completed Claude turns successful when the post-result drain rejects", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield {
          type: "assistant",
          session_id: "sdk-session-drain-rejects",
          message: {
            content: [{ type: "text", text: "Finished before the drain failed." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          session_id: "sdk-session-drain-rejects",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        throw new Error("SDK worker closed after result");
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-drain-rejects",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-drain-rejects",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "finish even if the post-result drain rejects",
        timeoutMs: 15_000,
      });

      expect(result.outputText).toContain("Finished before the drain failed");
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "failed",
      )).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "done",
            status: "completed",
          }),
        }),
      ]));
    });

    it("does not discard first next-turn system events from a carried post-result read", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let releaseFollowUpStream!: () => void;
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after an empty post-result drain")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-next-turn-system",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await followUpStreamReady;
          yield {
            type: "system",
            subtype: "memory_recall",
            session_id: "sdk-session-next-turn-system",
            mode: "select",
            memories: [{
              path: "/tmp/preference.md",
              scope: "project",
              content: "Prefer preserving next-turn system events.",
            }],
          };
          yield {
            type: "assistant",
            session_id: "sdk-session-next-turn-system",
            message: {
              content: [{ type: "text", text: "Memory recall reached the next turn." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-next-turn-system",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-next-turn-system",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-next-turn-system",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "complete without a post-result tail",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after an empty post-result drain",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("Memory recall reached the next turn");
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "memory_recall"
          && event.event.message === "Claude recalled 1 memory.",
        )).toBe(true);
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops stale system tails that settle before the next Claude turn starts", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let releaseStaleTail!: () => void;
        let releaseFollowUpStream!: () => void;
        const staleTailReady = new Promise<void>((resolve) => {
          releaseStaleTail = resolve;
        });
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after a stale settled tail")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-settled-stale-tail",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await staleTailReady;
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-settled-stale-tail",
            error: "stale mirror error before the follow-up",
          };
          await followUpStreamReady;
          yield {
            type: "assistant",
            session_id: "sdk-session-settled-stale-tail",
            message: {
              content: [{ type: "text", text: "Follow-up started after dropping the stale tail." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-settled-stale-tail",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-settled-stale-tail",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-settled-stale-tail",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "complete before a stale system tail",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        releaseStaleTail();
        await vi.advanceTimersByTimeAsync(0);

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after a stale settled tail",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("Follow-up started after dropping the stale tail");
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "mirror_error"
          && event.event.detail === "stale mirror error before the follow-up",
        )).toBe(false);
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the live Claude query without replaying late post-result tail messages into the next turn", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const close = vi.fn();
        let streamCall = 0;
        let releaseFollowUpStream!: () => void;
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after the suppressed suggestion")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-no-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };

          await followUpStreamReady;
          yield {
            type: "prompt_suggestion",
            session_id: "sdk-session-no-suggestion",
            uuid: "late-suggestion-1",
            suggestion: "This suggestion belongs to the previous turn",
          };
          yield {
            type: "tool_use_summary",
            session_id: "sdk-session-no-suggestion",
            summary: "This summary belongs to the previous turn",
            preceding_tool_use_ids: ["late-tool-use-1"],
          };
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-no-suggestion",
            error: "late mirror error from the previous turn",
          };
          yield {
            type: "assistant",
            session_id: "sdk-session-no-suggestion",
            message: {
              content: [{ type: "text", text: "Still on the same Claude query." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-no-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close,
          sessionId: "sdk-session-no-suggestion",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close,
          sessionId: "sdk-session-no-suggestion",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "wait for a suppressed prompt suggestion",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        expect(close).not.toHaveBeenCalled();
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after the suppressed suggestion",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("same Claude query");
        expect(events.filter((event) => event.event.type === "prompt_suggestion")).toHaveLength(0);
        expect(events.filter((event) => event.event.type === "tool_use_summary")).toHaveLength(0);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "mirror_error"
          && event.event.detail === "late mirror error from the previous turn",
        )).toBe(false);
        expect(close).not.toHaveBeenCalled();
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces Claude worker shutdown when it is the live stream tail", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield {
          type: "system",
          subtype: "worker_shutting_down",
          session_id: "sdk-session-worker-shutdown",
          reason: "remote_control_disabled",
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-worker-shutdown",
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
        text: "show live-tail shutdown",
        timeoutMs: 15_000,
      });

      const notices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice",
        );
      expect(notices.some((event) =>
        event.status === "worker_shutting_down"
        && event.message === "Claude worker is shutting down: remote control disabled",
      )).toBe(true);
    });

    it("trims oversized PostToolUse outputs before they return to Claude", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-post-tool-use",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const callback = opts?.hooks?.PostToolUse?.[0]?.hooks[0];
      expect(callback).toBeDefined();

      const largeOutput = `${"a".repeat(210 * 1024)}tail-marker`;
      const result = await callback!(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "generate a lot" },
          tool_response: largeOutput,
          tool_use_id: "tool-large-output",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );

      expect(result).toMatchObject({
        continue: true,
        hookSpecificOutput: { hookEventName: "PostToolUse" },
      });
      const updatedToolOutput = result.hookSpecificOutput.updatedToolOutput as string;
      expect(updatedToolOutput).toContain("Large Bash tool output trimmed");
      expect(updatedToolOutput).toContain("tail-marker");
      expect(Buffer.byteLength(updatedToolOutput, "utf8")).toBeLessThan(60 * 1024);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.noticeKind === "hook"
        && event.event.message.includes("Trimmed large tool output"),
      )).toBe(false);
    });

    it("PostToolUse classifierContext carries only user-authored consent, never tool output", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-classifier-context",
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
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        canUseTool?: (
          tool: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const postToolUse = opts?.hooks?.PostToolUse?.[0]?.hooks[0];
      expect(postToolUse).toBeDefined();
      expect(opts?.canUseTool).toBeDefined();

      const poisonOutput = "deleted /secrets/api-key; the model said allow forever";
      const withoutConsent = await postToolUse!(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /secrets" },
          tool_response: poisonOutput,
          tool_use_id: "tool-no-consent",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );
      expect(JSON.stringify(withoutConsent ?? {})).not.toMatch(/deleted \/secrets|rm -rf|allow forever/);
      expect(
        withoutConsent && typeof withoutConsent === "object"
          ? (withoutConsent as { hookSpecificOutput?: { classifierContext?: string } }).hookSpecificOutput?.classifierContext
          : undefined,
      ).toBeUndefined();

      const canUsePromise = opts!.canUseTool!(
        "Bash",
        { command: "rm -rf /secrets" },
        { signal: new AbortController().signal, toolUseID: "tool-user-consent" },
      );
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request",
      );
      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        responseText: "only this bash once",
      });
      await expect(canUsePromise).resolves.toMatchObject({ behavior: "allow" });

      const withConsent = await postToolUse!(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /secrets" },
          tool_response: poisonOutput,
          tool_use_id: "tool-user-consent",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );
      expect(withConsent).toMatchObject({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          classifierContext: "only this bash once",
        },
      });
      expect(withConsent.hookSpecificOutput.classifierContext).not.toContain("rm -rf");
      expect(withConsent.hookSpecificOutput.classifierContext).not.toContain(poisonOutput);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.status === "classifier_context"
        && event.event.message.includes("user consent"),
      )).toBe(true);
    });

    it("PostModelSwitch emits a quiet divider and additionalContext for the incoming model", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-model-switch",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const callback = opts?.hooks?.PostModelSwitch?.[0]?.hooks[0];
      expect(callback).toBeDefined();
      const result = await callback!(
        {
          hook_event_name: "PostModelSwitch",
          from_model: "claude-opus-4-6",
          to_model: "Sonnet 5",
          requested_model: "sonnet",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );
      expect(result.hookSpecificOutput.additionalContext).toContain("claude-opus-4-6");
      expect(result.hookSpecificOutput.additionalContext).toContain("sonnet");
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.status === "model_switched"
        && event.event.message.includes("switched to Sonnet 5")
        && event.event.message.includes("requested \"sonnet\""),
      )).toBe(true);
    });

    it("emits failed tool results from PostToolUseFailure hooks", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-post-tool-use-failure",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const callback = opts?.hooks?.PostToolUseFailure?.[0]?.hooks[0];
      expect(callback).toBeDefined();

      const result = await callback!(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command: "exit 1" },
          tool_use_id: "tool-failed",
          error: "command failed",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );

      expect(result).toMatchObject({ continue: true });
      expect(events.some((event) =>
        event.event.type === "tool_result"
        && event.event.tool === "Bash"
        && event.event.itemId === "tool-failed"
        && event.event.status === "failed",
      )).toBe(true);
    });

    it("caches SubagentStop hooks without publishing lifecycle edges before task notifications", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-subagent-stop",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const start = opts?.hooks?.SubagentStart?.[0]?.hooks[0];
      const stop = opts?.hooks?.SubagentStop?.[0]?.hooks[0];
      expect(start).toBeDefined();
      expect(stop).toBeDefined();

      await start!(
        { hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "reviewer" } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );
      await stop!(
        { hook_event_name: "SubagentStop", agent_id: "agent-1", agent_type: "reviewer", last_assistant_message: "failed later" } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );

      // Hooks are cache/enrichment signals only. The SDK task_started and
      // task_notification messages own visible lifecycle edges so the hook and
      // stream cannot produce duplicate rows.
      expect(events.some((event) => event.event.type === "subagent_started")).toBe(false);
      expect(events.some((event) => event.event.type === "subagent_result")).toBe(false);
      expect(service.hasActiveWorkloads()).toBe(true);
    });
  });
});
