import {
  AgentChatEventEnvelope,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createService,
  mockState,
  parkCursorSend,
  query,
  streamText,
  waitFor,
  waitForEvent,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("hasActiveWorkloads", () => {
    it("reports active Codex app-server turns so project rebalancing keeps their context alive", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(service.hasActiveWorkloads()).toBe(false);

      await service.sendMessage({
        sessionId: session.id,
        text: "Keep this turn alive during a project switch.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
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

      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("reports active Claude turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let finishTurn = () => {};
      const finishTurnPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-active-claude", slash_commands: [] };
            warmupComplete = true;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-active-claude",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "working" },
            },
          };
          await finishTurnPromise;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-active-claude",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-active-claude",
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

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Claude turn alive during a project switch.",
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "text"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("reports active opencode turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let finishTurn = () => {};
      const finishTurnPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "working" };
          await finishTurnPromise;
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this opencode turn alive during a project switch.",
        }, { awaitDispatch: true });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "text"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("reports active Cursor SDK turns so project switching does not close the chat runtime", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const finishTurn = parkCursorSend();
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Cursor turn alive during a project switch.",
        }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(0);
        });
        expect(mockState.cursorSdkSendCalls.at(-1)).toMatchObject({
          mode: "agent",
          idempotencyKey: expect.stringMatching(new RegExp(`^ade:${session.id}:.+:cursor-local:send$`)),
        });
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("reports active Droid SDK turns so project switching does not close the chat runtime", async () => {
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
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Droid turn alive during a project switch.",
        }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(mockState.droidPromptCalls.length).toBeGreaterThan(0);
        });
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("does not treat an idle reusable Claude query as an active workload", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-claude",
            slash_commands: [],
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-idle-claude",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-idle-claude",
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
        text: "Complete a short turn.",
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done"
          && event.event.status === "completed",
      );

      expect(service.hasActiveWorkloads()).toBe(false);
    });
  });
});
