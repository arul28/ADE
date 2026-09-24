import {
  AgentChatEventEnvelope,
  createAgentChatService,
  createMemoryTurnUsageLedger,
  createService,
  fs,
  mockState,
  path,
  spawn,
  startup,
  tmpHomeRoot,
  waitFor,
  waitForEvent,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("Codex subagents and usage", () => {
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

      // The harness mocks `node:readline`, so the read itself yields nothing here
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
  });
});
