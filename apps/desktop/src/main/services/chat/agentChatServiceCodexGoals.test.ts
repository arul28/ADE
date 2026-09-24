import {
  AgentChatEventEnvelope,
  PendingInputRequest,
  createAgentChatService,
  createService,
  mockState,
  readPersistedChatState,
  waitFor,
  waitForEvent,
  waitForFakeTimers,
} from "./agentChatService.testHarness";
import { describe, expect, it, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("Codex goals", () => {
    it("routes Codex /goal pause and resume commands to app-server goal RPCs", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: null,
            tokensUsed: 25,
            timeUsedSeconds: 60,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_001,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal pause",
      }, { awaitDispatch: true });

      const pauseRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(pauseRequest?.params).toMatchObject({
        threadId: expect.any(String),
        status: "paused",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "/goal resume",
      }, { awaitDispatch: true });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        status: "active",
      });
    });

    it("sets typed Codex /goal text and starts a real app-server turn", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
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
        text: "/goal Ship CLI parity",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const goalRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(goalRequest?.params).toMatchObject({
        threadId: expect.any(String),
        objective: "Ship CLI parity",
        status: "active",
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as { input?: Array<{ text?: unknown }> } | undefined;
      const turnInputText = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(turnInputText).toContain("Ship CLI parity");
      expect(turnInputText).not.toContain("/goal");
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.text.includes("/goal")
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(false);
    });

    it("seeds create-time ADE goals into the Codex app-server goal before the first turn", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        goal: "Run quality, tests, ship, merge, and release.",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Continue the work.",
      }, { awaitDispatch: true });

      const goalRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/goal/set");
      const turnRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "turn/start");
      expect(goalRequestIndex).toBeGreaterThan(-1);
      expect(turnRequestIndex).toBeGreaterThan(-1);
      expect(goalRequestIndex).toBeLessThan(turnRequestIndex);
      expect(mockState.codexRequestPayloads[goalRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Run quality, tests, ship, merge, and release.",
        status: "active",
        tokenBudget: null,
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Run quality, tests, ship, merge, and release.",
        status: "active",
        tokenBudget: null,
      });
    });

    it("exposes typed Codex goal controls with unlimited budgets and persisted summaries", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective ?? "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
            tokensUsed: 42,
            timeUsedSeconds: 12,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const goal = await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(goal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
        tokensUsed: 42,
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
      expect(readPersistedChatState(session.id).codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });

      mockState.codexRequestPayloads = [];
      await service.setCodexGoalStatus({
        sessionId: session.id,
        status: "paused",
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        status: "paused",
        tokenBudget: null,
      });

      mockState.codexRequestPayloads = [];
      await service.clearCodexGoal({ sessionId: session.id });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/clear")?.params).toMatchObject({
        threadId: "thread-1",
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("does not emit a visible Codex goal-clear event when no goal was known", async () => {
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
        text: "Start a normal turn.",
      }, { awaitDispatch: true });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/cleared",
        params: { threadId: "thread-1" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) => event.event.type === "codex_goal_cleared")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("emits a Codex goal-clear event when a known goal is cleared by app-server", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/cleared",
        params: { threadId: "thread-1" },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_cleared",
      );
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("deduplicates repeated Codex goal updates while retaining latest usage state", async () => {
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
        text: "Start working.",
      }, { awaitDispatch: true });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
            tokensUsed: 25,
            updatedAt: 1_760_000_001,
          },
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_updated"
          && event.event.goal?.objective === "Ship CLI parity",
      );
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
            tokensUsed: 50,
            timeUsedSeconds: 12,
            updatedAt: 1_760_000_002,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) => event.event.type === "codex_goal_updated")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
        tokensUsed: 50,
        timeUsedSeconds: 12,
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "paused",
            tokenBudget: null,
            tokensUsed: 51,
            updatedAt: 1_760_000_003,
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_updated"
          && event.event.goal?.status === "paused",
      );
    });

    it("refreshes a missing Codex goal without emitting a misleading goal-update chip", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: "active",
            tokenBudget: null,
          },
        };
      });
      mockState.codexResponseOverrides.set("thread/goal/get", () => ({
        goal: null,
      }));
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      events.length = 0;

      await expect(service.getCodexGoal({ sessionId: session.id })).resolves.toBeNull();

      expect(events.some((event) => event.event.type === "codex_goal_updated")).toBe(false);
      expect(events.some((event) => event.event.type === "codex_goal_cleared")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("clears persisted Codex goals after restart by resuming the thread first", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      expect(readPersistedChatState(session.id)).toMatchObject({
        threadId: "thread-1",
        codexGoal: {
          objective: "Ship CLI parity",
          status: "active",
          tokenBudget: null,
        },
      });

      mockState.codexRequestPayloads = [];
      const resumed = createService().service;
      await resumed.clearCodexGoal({ sessionId: session.id });

      const resumeRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/resume");
      const clearRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/goal/clear");
      expect(resumeRequestIndex).toBeGreaterThanOrEqual(0);
      expect(clearRequestIndex).toBeGreaterThan(resumeRequestIndex);
      expect(mockState.codexRequestPayloads[resumeRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
        excludeTurns: true,
      });
      expect(mockState.codexRequestPayloads[clearRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
      expect((await resumed.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("does not rotate to a fresh Codex thread when a goal-only resume fails", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      expect(readPersistedChatState(session.id).threadId).toBe("thread-1");

      mockState.codexRequestPayloads = [];
      mockState.codexResponseOverrides.set("thread/resume", {
        error: { code: -32000, message: "resume unavailable" },
      });
      const resumed = createService().service;

      await expect(resumed.setCodexGoal({
        sessionId: session.id,
        objective: "Keep shipping",
      })).rejects.toThrow("Could not resume this Codex thread for goal controls");

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
      expect(readPersistedChatState(session.id).threadId).toBe("thread-1");
      expect((await resumed.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
    });

    it("adopts the plan mode a resumed Codex thread reports (0.156+)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({ sessionId: session.id, objective: "Ship CLI parity" });
      expect((await service.getSessionSummary(session.id))?.interactionMode ?? "default").toBe("default");

      mockState.codexResponseOverrides.set("thread/resume", {
        thread: { id: "thread-1" },
        collaborationMode: { mode: "plan", settings: {} },
      });
      const resumed = createService().service;
      await resumed.setCodexGoal({ sessionId: session.id, objective: "Keep shipping" });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      expect((await resumed.getSessionSummary(session.id))?.interactionMode).toBe("plan");
    });

    it("rejects Codex goals over the app-server objective limit", async () => {
      const tooLongGoal = "x".repeat(4_001);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await expect(service.setCodexGoal({
        sessionId: session.id,
        objective: tooLongGoal,
      })).rejects.toThrow("Goal is too long. Keep it under 4,000 characters.");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);

      await service.sendMessage({
        sessionId: session.id,
        text: `/goal ${tooLongGoal}`,
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Goal is too long. Keep it under 4,000 characters."
      )).toBe(true);
    });

    it("asks before replacing an existing typed Codex goal", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
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
        text: "/goal set Existing goal",
      }, { awaitDispatch: true });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal Replacement goal",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: PendingInputRequest } | undefined)
            : undefined;
          return event.event.type === "approval_request"
            && detail?.request?.providerMetadata?.kind === "codex_goal_replace";
        },
      );
      const request = (approvalEvent.event.detail as { request?: PendingInputRequest } | undefined)?.request;
      expect(request?.questions[0]?.options?.map((option) => option.value)).toEqual(["update_goal", "clear_goal"]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        answers: {
          goal_action: "update_goal",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) =>
          payload.method === "thread/goal/set"
          && (payload.params as { objective?: unknown } | undefined)?.objective === "Replacement goal"
        )).toBe(true);
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
    });

    it("automatically removes incoming Codex goal token limits and resumes limited goals", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective ?? "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: Object.prototype.hasOwnProperty.call(params, "tokenBudget") ? params.tokenBudget : 5000,
            tokensUsed: 125,
            timeUsedSeconds: 90,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_010,
          },
        };
      });

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
        text: "Start working.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.codexRequestPayloads = [];

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "budgetLimited",
            tokenBudget: 5000,
            tokensUsed: 125,
            timeUsedSeconds: 90,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_001,
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const clearRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(clearRequest?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message === "Goal limit removed. ADE keeps goals unlimited."
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "codex_goal_updated"
        && event.event.goal?.status === "budget_limited"
      )).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "codex_goal_updated",
            goal: expect.objectContaining({
              status: "active",
              tokenBudget: null,
              timeUsedSeconds: 90,
            }),
          }),
        }),
      ]));
    });

    it("backs off automatic Codex goal budget clearing after app-server failures", async () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      mockState.delayedCodexMethods.add("thread/goal/set");

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
        text: "Start working.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.codexRequestPayloads = [];

      const emitBudgetLimitedGoal = () => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "thread/goal/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            goal: {
              objective: "Ship CLI parity",
              status: "budgetLimited",
              tokenBudget: 5000,
              tokensUsed: 125,
              timeUsedSeconds: 90,
              createdAt: 1_760_000_000,
              updatedAt: 1_760_000_001,
            },
          },
        });
      };

      emitBudgetLimitedGoal();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/goal/set")).toHaveLength(1);
      });

      const clearRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: clearRequest?.id,
        error: { code: -32001, message: "goal RPC failed" },
      });
      mockState.pendingCodexResponses = [];

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message === "Goal update failed: goal RPC failed"
        )).toBe(true);
      });

      mockState.codexRequestPayloads = [];
      emitBudgetLimitedGoal();
      await Promise.resolve();
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);

      nowSpy.mockReturnValue(1_031_000);
      emitBudgetLimitedGoal();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const retryRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: retryRequest?.id,
        result: {
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
          },
        },
      });
      mockState.pendingCodexResponses = [];
    });

    it("treats /goal set reserved words as objective text", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal set clear",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        threadId: expect.any(String),
        objective: "clear",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/clear")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("reports Codex /goal slash command failures without completing a fake slash turn", async () => {
      mockState.delayedCodexMethods.add("thread/goal/set");
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "/goal status paused",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const goalRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(goalRequest?.id).toBeTruthy();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: goalRequest?.id,
        error: { code: -32001, message: "goal RPC failed" },
      });
      await sendPromise;

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Goal update failed: goal RPC failed"
      )).toBe(true);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(false);
    });

    it("reports Codex /goal slash timeouts without tearing down the runtime", async () => {
      mockState.delayedCodexMethods.add("thread/goal/set");
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => {
            events.push(event);
          },
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        const sendPromise = service.sendMessage({
          sessionId: session.id,
          text: "/goal status paused",
        }, { awaitDispatch: true });

        await waitForFakeTimers(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
        });
        await vi.advanceTimersByTimeAsync(10_050);
        await sendPromise;

        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("timed out")
        )).toBe(true);

        mockState.delayedCodexMethods.clear();
        mockState.codexRequestPayloads = [];
        await service.sendMessage({
          sessionId: session.id,
          text: "Continue after the slash timeout.",
        }, { awaitDispatch: true });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("routes Codex goal edits through goal RPC while a turn is active instead of turn steer", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start a long-running turn.",
      }, { awaitDispatch: true });

      mockState.codexRequestPayloads = [];
      await service.steer({
        sessionId: session.id,
        text: "/goal set Updated from UI",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        objective: "Updated from UI",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);
    });
  });
});
