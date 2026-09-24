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
  });
});
