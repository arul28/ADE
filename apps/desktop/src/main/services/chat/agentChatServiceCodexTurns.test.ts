import {
  AgentChatEventEnvelope,
  createAgentChatService,
  createService,
  fs,
  mockState,
  path,
  query,
  readPersistedChatState,
  startup,
  tmpRoot,
  waitFor,
  waitForEvent,
  writePersistedChatState,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("Codex turns and streams", () => {
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
  });
});
