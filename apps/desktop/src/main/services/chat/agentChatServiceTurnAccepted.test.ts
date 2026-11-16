import {
  type AgentChatEventEnvelope,
  createService,
  mockState,
} from "./agentChatService.testHarness";
import { TURN_ACCEPTED_START_TIMEOUT_MS } from "./agentChatService";
import { installProviderLoginGate } from "../providerLogins/providerLoginHooks";
import { afterEach, describe, expect, it, vi } from "vitest";

type ChatService = ReturnType<typeof createService>["service"];

afterEach(() => {
  installProviderLoginGate(null);
});

/**
 * Holds every turn before its provider starts, the way a cloud computer's
 * sign-in gate does while it fetches a fresh sign-in. The send is accepted but
 * its turn has not started or shown, so the chat reads idle with the marker.
 */
function holdTurnsAtSignInGate(): { release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  installProviderLoginGate(async () => {
    await held;
  });
  return { release };
}

/**
 * Sends a message that waits before its provider starts, and checks it is in
 * flight. The OpenCode session setup behind the gate never answers until the
 * test fails it. The caller enables fake timers and restores them.
 */
async function sendWhoseStartNeverAnswers(service: ChatService, sessionId: string) {
  const gate = holdTurnsAtSignInGate();
  let failSetup!: (error: Error) => void;
  mockState.openCodeSessionCreateBarrier = new Promise<void>((_resolve, reject) => {
    failSetup = reject;
  });
  await service.sendMessage({ sessionId, text: "Start the work." });
  expect((await service.getSessionSummary(sessionId))?.turnAcceptedAt).toBeTruthy();
  return { release: gate.release, failSetup };
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stuckStart!: Awaited<ReturnType<typeof sendWhoseStartNeverAnswers>>;
    try {
      stuckStart = await sendWhoseStartNeverAnswers(service, session.id);

      await vi.advanceTimersByTimeAsync(TURN_ACCEPTED_START_TIMEOUT_MS - 1);
      expect((await service.getSessionSummary(session.id))?.turnAcceptedAt).toBeTruthy();

      const eventsBeforeBound = events.length;
      await vi.advanceTimersByTimeAsync(1);
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.status).toBe("idle");
      expect(summary?.turnAcceptedAt).toBeUndefined();
      // The list is told to re-read the chat, so the row stops reading as working.
      expect(events.slice(eventsBeforeBound).some(isSessionMetaUpdated)).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // The bound only stops the row reading as working. The start goes on once
    // the gate lets it, and a start that then fails still reaches the chat.
    stuckStart.release();
    stuckStart.failSetup(new Error("OpenCode session setup failed."));
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
    let stuckStart: Awaited<ReturnType<typeof sendWhoseStartNeverAnswers>> | undefined;
    try {
      stuckStart = await sendWhoseStartNeverAnswers(service, session.id);
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
      stuckStart?.release();
      stuckStart?.failSetup(new Error("OpenCode session setup failed."));
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
    let stuckStart: Awaited<ReturnType<typeof sendWhoseStartNeverAnswers>> | undefined;
    try {
      stuckStart = await sendWhoseStartNeverAnswers(service, session.id);
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
      stuckStart?.release();
      stuckStart?.failSetup(new Error("OpenCode session setup failed."));
    }
  });
});

describe("a cold send whose provider is still starting", () => {
  it("is active at once, under the turn its start error later ends", async () => {
    // An OpenCode chat with no runtime: the session setup is slow, then fails.
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
    let failSetup!: (error: Error) => void;
    mockState.openCodeSessionCreateBarrier = new Promise<void>((_resolve, reject) => {
      failSetup = reject;
    });

    await service.sendMessage({ sessionId: session.id, text: "Start the work." });

    // The turn shows before the start answers: the message, then `started`, and
    // the chat reads as working, not as merely accepted.
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.status).toBe("active");
    expect(summary?.turnAcceptedAt).toBeUndefined();
    const started = events.find((envelope) =>
      envelope.event.type === "status" && envelope.event.turnStatus === "started");
    const turnId = (started?.event as { turnId?: string } | undefined)?.turnId;
    expect(turnId).toBeTruthy();
    expect(events.some((envelope) =>
      envelope.event.type === "user_message" && (envelope.event as { turnId?: string }).turnId === turnId)).toBe(true);

    // The start fails: that same turn ends with the error, and nothing is left working.
    failSetup(new Error("OpenCode session setup failed."));
    await vi.waitFor(() => {
      expect(events.some((envelope) => envelope.event.type === "done")).toBe(true);
    });
    const ofTurn = (type: string) => events.filter((envelope) => envelope.event.type === type)
      .map((envelope) => envelope.event as { turnId?: string; message?: string; status?: string });
    expect(ofTurn("error")).toEqual([expect.objectContaining({ turnId, message: "OpenCode session setup failed." })]);
    expect(ofTurn("done")).toEqual([expect.objectContaining({ turnId, status: "failed" })]);
    expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
  });
});
