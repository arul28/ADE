import { describe, expect, it, vi } from "vitest";
import { createCtoVoiceCallService, type CtoVoiceSocket } from "./ctoVoiceCallService";
import type { CtoVoiceState } from "../../../shared/types/ctoVoice";

/** A socket the test drives: records what was sent, replays what the API would say. */
function createFakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
  const socket: CtoVoiceSocket = {
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {},
    on: (event, handler) => { (handlers[event] = handlers[event] ?? []).push(handler); },
  };
  return {
    socket,
    sent,
    open: () => handlers.open?.forEach((h) => h()),
    receive: (event: unknown) => handlers.message?.forEach((h) => h(JSON.stringify(event))),
    typesSent: () => sent.map((m) => String(m.type)),
    lastOfType: (type: string) => [...sent].reverse().find((m) => m.type === type),
  };
}

function createService(overrides: Partial<Parameters<typeof createCtoVoiceCallService>[0]> = {}) {
  const fake = createFakeSocket();
  const states: CtoVoiceState[] = [];
  const service = createCtoVoiceCallService({
    getApiKey: async () => "sk-test",
    ctoName: () => "CTO",
    projectName: () => "ADE",
    backchannelsEnabled: () => true,
    runBackendTurn: async () => ({ spoken: "Three merged yesterday." }),
    persistCall: async () => {},
    onState: (state) => states.push(state),
    createWebSocket: () => fake.socket,
    ...overrides,
  });
  return { service, fake, states, latest: () => states[states.length - 1] };
}

describe("createCtoVoiceCallService", () => {
  it("refuses to start without a key, and says so", async () => {
    const { service, latest } = createService({ getApiKey: async () => null });
    const result = await service.start();
    expect(result).toEqual({ ok: false, error: "missing-key" });
    expect(latest().phase).toBe("failed");
    expect(latest().error).toContain("API key");
  });

  it("opens the session as client-delegated, so the brain stays ours", async () => {
    const { service, fake } = createService();
    await service.start();
    fake.open();
    const start = fake.lastOfType("session.start") as Record<string, any>;
    expect(start.session.model).toBe("gpt-live-1");
    expect(start.session.delegation).toEqual({ type: "client" });
    // Nothing in the session names a backend model — that is what keeps the
    // CTO's own thinking on whatever plan it already runs on.
    expect(JSON.stringify(start.session)).not.toContain("responses");
  });

  /**
   * The filler is the whole reason a call does not feel like a form submission:
   * it must be sent before the backend is even called, not after it returns.
   */
  it("speaks a filler before the backend work starts", async () => {
    const order: string[] = [];
    let releaseBackend: () => void = () => {};
    const { service, fake } = createService({
      runBackendTurn: async () => {
        order.push("backend-started");
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "Three merged yesterday." };
      },
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.input_transcript.delta", delta: "what merged yesterday" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1", target: "client" } });
    await Promise.resolve();

    const commentaryBefore = fake.sent.filter((m) => m.type === "session.commentary.append");
    expect(commentaryBefore.length).toBeGreaterThan(0);
    expect(order).toEqual(["backend-started"]);
    releaseBackend();
  });

  it("rebuilds the intent from the transcript, because the delegation carries none", async () => {
    const seen: string[] = [];
    const { service, fake } = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.input_transcript.delta", delta: "what is the " });
    fake.receive({ type: "session.input_transcript.delta", delta: "status of the PRs" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["what is the status of the PRs"]);
  });

  it("holds a mutation behind a confirmation instead of running it", async () => {
    const { service, fake, latest } = createService({
      runBackendTurn: async () => ({
        spoken: "I can open a pull request for that.",
        confirmation: { toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" },
      }),
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));

    expect(latest().phase).toBe("confirming");
    expect(latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(latest().pendingConfirmation?.destructive).toBe(false);
  });

  it("marks a history-rewriting tool destructive, so voice cannot approve it", async () => {
    const { service, fake, latest } = createService({
      runBackendTurn: async () => ({
        spoken: "That would force-push.",
        confirmation: { toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" },
      }),
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(latest().pendingConfirmation?.destructive).toBe(true);
  });

  it("shows a barge-in landing when the user talks over the answer", async () => {
    const { service, fake, latest } = createService();
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.output_transcript.delta", delta: "A deployment pipeline" });
    expect(latest().phase).toBe("speaking");
    fake.receive({ type: "session.input_transcript.delta", delta: "wait, stop" });
    expect(latest().interrupted).toBe(true);
    expect(latest().phase).toBe("listening");
  });

  it("writes the call down even when nothing else went right", async () => {
    const persistCall = vi.fn<[{ captions: unknown[] }], Promise<void>>(async () => {});
    const { service, fake } = createService({ persistCall });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.input_transcript.done", text: "hello" });
    await service.end();
    expect(persistCall).toHaveBeenCalledTimes(1);
    expect(persistCall.mock.calls[0]?.[0]?.captions.length).toBe(1);
  });

  it("stops sending audio while muted", async () => {
    const { service, fake } = createService();
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    service.setMuted(true);
    service.pushAudio("AAAA");
    expect(fake.typesSent()).not.toContain("session.input_audio.append");
    service.setMuted(false);
    service.pushAudio("AAAA");
    expect(fake.typesSent()).toContain("session.input_audio.append");
  });
});
