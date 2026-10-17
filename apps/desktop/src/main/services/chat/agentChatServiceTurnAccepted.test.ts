import {
  type AgentChatEventEnvelope,
  createService,
  mockState,
} from "./agentChatService.testHarness";
import { TURN_ACCEPTED_START_TIMEOUT_MS } from "./agentChatService";
import { describe, expect, it, vi } from "vitest";

type ChatService = ReturnType<typeof createService>["service"];

/**
 * Sends a message whose provider start never answers, and checks it is in
 * flight. The caller enables fake timers and restores them.
 */
async function sendWhoseStartNeverAnswers(service: ChatService, sessionId: string) {
  // The OpenCode runtime is still starting: its session setup never answers.
  let failSetup!: (error: Error) => void;
  mockState.openCodeSessionCreateBarrier = new Promise<void>((_resolve, reject) => {
    failSetup = reject;
  });
  await service.sendMessage({ sessionId, text: "Start the work." });
  expect((await service.getSessionSummary(sessionId))?.turnAcceptedAt).toBeTruthy();
  return { failSetup };
}

const isSessionMetaUpdated = (envelope: AgentChatEventEnvelope): boolean =>
  envelope.event.type === "session_meta_updated";

describe("an accepted send whose provider start never completes", () => {
  it("stops reading as in flight once the bound passes, and still reports a start error that lands later", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "",
      modelId: "opencode/anthropic/claude-sonnet-5",
    });
    // The OpenCode runtime is still starting: its session setup never answers.
    let failSetup!: (error: Error) => void;
    mockState.openCodeSessionCreateBarrier = new Promise<void>((_resolve, reject) => {
      failSetup = reject;
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await service.sendMessage({ sessionId: session.id, text: "Start the work." });

      // The start moves on the fake clock. Count every advance, so the bound is
      // measured from acceptance.
      let elapsedMs = 0;
      const advance = async (ms: number): Promise<void> => {
        await vi.advanceTimersByTimeAsync(ms);
        elapsedMs += ms;
      };
      for (let i = 0; i < 100 && mockState.openCodeServeLaunches === 0; i += 1) {
        await advance(100);
      }
      expect(mockState.openCodeServeLaunches).toBe(1);
      expect((await service.getSessionSummary(session.id))?.turnAcceptedAt).toBeTruthy();

      await advance(TURN_ACCEPTED_START_TIMEOUT_MS - 1 - elapsedMs);
      expect((await service.getSessionSummary(session.id))?.turnAcceptedAt).toBeTruthy();

      const eventsBeforeBound = events.length;
      await advance(1);
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.status).toBe("idle");
      expect(summary?.turnAcceptedAt).toBeUndefined();
      // The list is told to re-read the chat, so the row stops reading as working.
      expect(events.slice(eventsBeforeBound).some(isSessionMetaUpdated)).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // The bound only stops the row reading as working. The start that never
    // answered still fails eventually, and that failure still reaches the chat.
    failSetup(new Error("OpenCode session setup failed."));
    await vi.waitFor(() => {
      expect(events.some((envelope) =>
        envelope.event.type === "error" && envelope.event.message === "OpenCode session setup failed.",
      )).toBe(true);
    });
  });

  it("does not re-read a chat that was archived before the bound passed", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "",
      modelId: "opencode/anthropic/claude-sonnet-5",
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let failSetup: ((error: Error) => void) | undefined;
    try {
      const stuckStart = await sendWhoseStartNeverAnswers(service, session.id);
      failSetup = stuckStart.failSetup;
      // Half the bound in: the chat still reads as in flight.
      await vi.advanceTimersByTimeAsync(TURN_ACCEPTED_START_TIMEOUT_MS / 2);
      expect((await service.getSessionSummary(session.id))?.turnAcceptedAt).toBeTruthy();

      await service.archiveSession({ sessionId: session.id });
      // The archived chat's marker and bound go with it.
      expect((await service.getSessionSummary(session.id))?.turnAcceptedAt).toBeUndefined();

      // Well past the bound: nothing re-reads the archived chat.
      const eventsAfterArchive = events.length;
      await vi.advanceTimersByTimeAsync(TURN_ACCEPTED_START_TIMEOUT_MS * 2);
      expect(events.slice(eventsAfterArchive).some(isSessionMetaUpdated)).toBe(false);
    } finally {
      vi.useRealTimers();
      failSetup?.(new Error("OpenCode session setup failed."));
    }
  });

  it("cancels the bound when the service is disposed, so nothing fires into a disposed service", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "",
      modelId: "opencode/anthropic/claude-sonnet-5",
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let failSetup: ((error: Error) => void) | undefined;
    try {
      const stuckStart = await sendWhoseStartNeverAnswers(service, session.id);
      failSetup = stuckStart.failSetup;
      await vi.advanceTimersByTimeAsync(TURN_ACCEPTED_START_TIMEOUT_MS / 2);

      // The bound is the timer still pending for the chat. Dispose cancels it.
      const pendingBeforeDispose = vi.getTimerCount();
      await service.disposeAll();
      expect(vi.getTimerCount()).toBeLessThan(pendingBeforeDispose);

      // Well past the bound: the disposed service emits nothing for the chat.
      const eventsAfterDispose = events.length;
      await vi.advanceTimersByTimeAsync(TURN_ACCEPTED_START_TIMEOUT_MS * 2);
      expect(events.slice(eventsAfterDispose).some(isSessionMetaUpdated)).toBe(false);
    } finally {
      vi.useRealTimers();
      failSetup?.(new Error("OpenCode session setup failed."));
    }
  });
});
