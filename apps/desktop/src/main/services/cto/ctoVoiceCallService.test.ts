import { describe, expect, it, vi } from "vitest";
import {
  createCtoVoiceCallService,
  describeCtoVoiceSocketFailure,
  forwardUnexpectedResponse,
  type CtoVoiceSocket,
} from "./ctoVoiceCallService";
import type { CtoVoiceState } from "../../../shared/types/ctoVoice";
import { createFakeSocket } from "./ctoVoiceTestDoubles";

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
    // The confirmation comes from the CTO thread's own approval — the turn is
    // parked inside `canUseTool` — not from a field on the turn's result.
    const { service, fake, latest } = createService();
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.input_transcript.delta", delta: "open a pr for the sync lane" });
    service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });

    expect(latest().phase).toBe("confirming");
    expect(latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(latest().pendingConfirmation?.destructive).toBe(false);
  });

  it("drops a superseded answer instead of speaking it over the next one", async () => {
    // The user asks, then interrupts and asks something else. The first turn is
    // still running; when it finishes, its answer is to a question the user has
    // moved on from. Reading the abort flag off the module binding asked the
    // WRONG controller — by then it named the superseding turn — so the stale
    // answer was spoken over the live one.
    const release: Array<() => void> = [];
    const { service, fake } = createService({
      runBackendTurn: async ({ intent }) => {
        if (intent.includes("first")) {
          await new Promise<void>((r) => release.push(r));
          return { spoken: "STALE ANSWER" };
        }
        return { spoken: "FRESH ANSWER" };
      },
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });

    fake.receive({ type: "session.input_transcript.delta", delta: "the first question" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));

    fake.receive({ type: "session.input_transcript.done", text: "the first question" });
    fake.receive({ type: "session.input_transcript.delta", delta: "no wait, the second question" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d2" } });
    await new Promise((r) => setTimeout(r, 0));

    // The first turn only finishes now, after it was superseded.
    release.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));

    const spoken = fake.sent
      .filter((m) => m.type === "session.commentary.append")
      .map((m) => String(m.content));
    expect(spoken).toContain("FRESH ANSWER");
    expect(spoken).not.toContain("STALE ANSWER");
  });

  it("answers a delegation it has no transcript for, rather than going silent", async () => {
    // Every other path replies to the delegation. One that returns without a
    // commentary or thinking append leaves the voice model waiting on a client
    // that never speaks, and the user hearing nothing at all.
    const intents: string[] = [];
    const { service, fake } = createService({
      runBackendTurn: async ({ intent }) => {
        intents.push(intent);
        return { spoken: "ok" };
      },
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    // No transcript at all before the delegation.
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));

    // No turn was burned on an empty question...
    expect(intents).toEqual([]);
    // ...but the delegation was still answered.
    const spoken = fake.lastOfType("session.commentary.append") as Record<string, unknown>;
    expect(spoken?.delegation_id).toBe("d1");
    expect(String(spoken?.content)).toContain("didn't catch that");
  });

  it("still knows what was asked when the delegation lands after the transcript closes", async () => {
    // The two events are independent on the wire. Clearing the transcript on
    // `done` and reading it on delegation meant that in this ordering the CTO
    // thread was handed an empty intent and asked nothing at all.
    const intents: string[] = [];
    const { service, fake } = createService({
      runBackendTurn: async ({ intent }) => {
        intents.push(intent);
        return { spoken: "Three merged yesterday." };
      },
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.input_transcript.delta", delta: "what merged yesterday" });
    fake.receive({ type: "session.input_transcript.done", text: "what merged yesterday" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(intents).toEqual(["what merged yesterday"]);
  });

  it("does not glue a self-answered utterance onto the next intent", async () => {
    const intents: string[] = [];
    const { service, fake } = createService({
      runBackendTurn: async ({ intent }) => {
        intents.push(intent);
        return { spoken: "ok" };
      },
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    // The voice model answers this one itself: no delegation follows.
    fake.receive({ type: "session.input_transcript.delta", delta: "thanks" });
    fake.receive({ type: "session.input_transcript.done", text: "thanks" });
    // A later utterance that does delegate must carry only its own words.
    fake.receive({ type: "session.input_transcript.delta", delta: "what is the PR status" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(intents).toEqual(["what is the PR status"]);
  });

  it("accepts a spoken yes when the delegation lands after the transcript closes", async () => {
    // The two events are independent, so either order is legal on the wire.
    // Closing the transcript first used to rotate the utterance id BEFORE the
    // confirmation captured it, binding the question to the id the reply would
    // carry — and the "same utterance" guard then rejected every spoken yes.
    const { service, fake, latest } = createService();
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });

    fake.receive({ type: "session.input_transcript.delta", delta: "open a pr for the sync lane" });
    fake.receive({ type: "session.input_transcript.done", text: "open a pr for the sync lane" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));
    service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
    expect(latest().pendingConfirmation?.toolName).toBe("openPr");

    fake.receive({ type: "session.input_transcript.delta", delta: "yes" });
    fake.receive({ type: "session.input_transcript.done", text: "yes" });
    await new Promise((r) => setTimeout(r, 0));
    expect(latest().pendingConfirmation).toBeNull();
  });

  it("never lets the utterance that raised a question also answer it", async () => {
    const { service, fake, latest } = createService();
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });

    // One utterance that both asks and sounds like consent.
    fake.receive({ type: "session.input_transcript.delta", delta: "open a pr, yes do it" });
    service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
    await new Promise((r) => setTimeout(r, 0));
    fake.receive({ type: "session.input_transcript.done", text: "open a pr, yes do it" });
    await new Promise((r) => setTimeout(r, 0));
    expect(latest().pendingConfirmation?.toolName).toBe("openPr");
  });

  /**
   * The whole point of the call being able to act.
   *
   * The CTO's turn parks inside `canUseTool` when it reaches a tool that
   * writes. Nothing comes back through `runBackendTurn` to say so, so the call
   * learns about it from the chat's own approval event — and a spoken yes has
   * to reach that waiter, or the user hears "doing that now" and nothing runs.
   */
  describe("acting on a call", () => {
    function createCallWithApprovals(overrides: Record<string, unknown> = {}) {
      let raise: ((a: { itemId: string; toolName: string; prompt: string }) => void) | null = null;
      const resolved: Array<{ itemId: string; approved: boolean }> = [];
      let watcherReleased = false;
      const harness = createService({
        watchApprovals: (onApproval: (a: { itemId: string; toolName: string; prompt: string }) => void) => {
          raise = onApproval;
          return () => { watcherReleased = true; };
        },
        resolveApproval: async (args: { itemId: string; approved: boolean }) => { resolved.push(args); },
        ...overrides,
      } as never);
      return {
        ...harness,
        resolved,
        raise: (a: { itemId: string; toolName: string; prompt: string }) => raise?.(a),
        wasWatcherReleased: () => watcherReleased,
      };
    }

    it("asks out loud, then lets the blocked turn through on a spoken yes", async () => {
      const { service, fake, latest, resolved, raise } = createCallWithApprovals();
      await service.start();
      fake.open();
      fake.receive({ type: "session.started" });
      fake.receive({ type: "session.input_transcript.delta", delta: "open a pr for the sync lane" });
      fake.receive({ type: "session.input_transcript.done", text: "open a pr for the sync lane" });

      raise({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
      expect(latest().phase).toBe("confirming");
      expect(latest().pendingConfirmation?.prompt).toContain("pull request");
      // The user has to HEAR the question, not find it in the chat.
      const asked = fake.lastOfType("session.commentary.append") as Record<string, unknown>;
      expect(String(asked.content)).toContain("pull request");

      fake.receive({ type: "session.input_transcript.delta", delta: "yes" });
      fake.receive({ type: "session.input_transcript.done", text: "yes" });
      await new Promise((r) => setTimeout(r, 0));

      expect(latest().pendingConfirmation).toBeNull();
      expect(resolved).toEqual([{ itemId: "item-1", approved: true }]);
    });

    it("turns the tool away on a spoken no", async () => {
      const { service, fake, latest, resolved, raise } = createCallWithApprovals();
      await service.start();
      fake.open();
      fake.receive({ type: "session.started" });
      fake.receive({ type: "session.input_transcript.delta", delta: "clean up the branch" });
      fake.receive({ type: "session.input_transcript.done", text: "clean up the branch" });

      raise({ itemId: "item-2", toolName: "openPr", prompt: "Open a pull request?" });
      fake.receive({ type: "session.input_transcript.delta", delta: "no, don't" });
      fake.receive({ type: "session.input_transcript.done", text: "no, don't" });
      await new Promise((r) => setTimeout(r, 0));

      expect(latest().pendingConfirmation).toBeNull();
      expect(resolved).toEqual([{ itemId: "item-2", approved: false }]);
    });

    it("will not let a voice approve a force-push, however clearly it is said", async () => {
      const { service, fake, latest, resolved, raise } = createCallWithApprovals();
      await service.start();
      fake.open();
      fake.receive({ type: "session.started" });
      fake.receive({ type: "session.input_transcript.delta", delta: "force push it" });
      fake.receive({ type: "session.input_transcript.done", text: "force push it" });

      raise({ itemId: "item-3", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
      expect(latest().pendingConfirmation?.destructive).toBe(true);

      fake.receive({ type: "session.input_transcript.delta", delta: "yes do it" });
      fake.receive({ type: "session.input_transcript.done", text: "yes do it" });
      await new Promise((r) => setTimeout(r, 0));

      // Still waiting on a tap, and nothing was released.
      expect(latest().pendingConfirmation?.id).toBeTruthy();
      expect(resolved).toEqual([]);

      // The card is the only way through.
      service.approve(latest().pendingConfirmation!.id);
      await new Promise((r) => setTimeout(r, 0));
      expect(resolved).toEqual([{ itemId: "item-3", approved: true }]);
    });

    it("stops watching the chat when the call ends", async () => {
      const { service, fake, wasWatcherReleased } = createCallWithApprovals();
      await service.start();
      fake.open();
      fake.receive({ type: "session.started" });
      expect(wasWatcherReleased()).toBe(false);
      await service.end();
      expect(wasWatcherReleased()).toBe(true);
    });
  });

  it("marks a history-rewriting tool destructive, so voice cannot approve it", async () => {
    const { service, fake, latest } = createService();
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.input_transcript.delta", delta: "force-push the sync lane" });
    service.raiseApproval({ itemId: "item-1", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
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

  it("restores the CTO's mode when the call is ended before its socket opens", async () => {
    // The renderer opens the microphone as soon as the phase is `connecting`,
    // and a denied microphone hangs up immediately. Tearing down on the socket
    // alone missed that window and left the CTO unable to write for the life of
    // the process.
    const readOnly: boolean[] = [];
    const { service, fake } = createService({
      setCallConfirmMode: async (value: boolean) => { readOnly.push(value); },
    });
    await service.start();
    // No `fake.open()`: the socket exists but has never opened.
    await service.end();
    expect(readOnly).toEqual([true, false]);
    fake.open();
  });

  it("refuses to open a socket for a call that was ended while connecting", async () => {
    let ended = false;
    const { service } = createService({
      setCallConfirmMode: async (value: boolean) => {
        // Hang up from inside the await `start` is blocked on.
        if (value && !ended) { ended = true; await service.end(); }
      },
    });
    const result = await service.start();
    expect(result.ok).toBe(false);
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

  /**
   * GPT Live's client-delegation appends carry a plain string, so the voice
   * model cannot read an image. The only place a captured window can actually
   * be looked at is the backend that does the thinking.
   */
  it("sends a captured image to the backend, not to the voice model", async () => {
    const seen: Array<string | null | undefined> = [];
    const { service, fake } = createService({
      runBackendTurn: async ({ imageBase64 }) => { seen.push(imageBase64); return { spoken: "ok" }; },
    });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });

    service.attachImage({ pngBase64: "PNGDATA", note: "the CI run" });
    // The model is told it happened, and told in the silent channel.
    const think = fake.lastOfType("session.thinking.append") as Record<string, unknown>;
    expect(String(think.content)).toContain("the CI run");
    expect(JSON.stringify(fake.sent)).not.toContain("PNGDATA");

    fake.receive({ type: "session.input_transcript.delta", delta: "what is this showing" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d1" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["PNGDATA"]);

    // One capture, one delegation: it must not ride along on the next turn too.
    fake.receive({ type: "session.input_transcript.done", text: "what is this showing" });
    fake.receive({ type: "session.input_transcript.delta", delta: "and the one before it" });
    fake.receive({ type: "session.delegation.created", delegation: { id: "d2" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["PNGDATA", null]);
  });

  it("hands output audio straight to the renderer", async () => {
    const chunks: string[] = [];
    const { service, fake } = createService({ onOutputAudio: (b64) => chunks.push(b64) });
    await service.start();
    fake.open();
    fake.receive({ type: "session.started" });
    fake.receive({ type: "session.output_audio.delta", delta: "AAAB" });
    fake.receive({ type: "session.output_audio.delta", delta: "AAAC" });
    expect(chunks).toEqual(["AAAB", "AAAC"]);
  });

  /**
   * The safety property of the whole feature. A call shares the CTO's one
   * session and there is no per-turn permission argument, so the only place the
   * guarantee can live is a window held open for the call. If this test ever
   * goes red, a spoken sentence can reach a tool that writes.
   */
  it("puts the CTO in confirm-first mode for the life of the call, and restores it after", async () => {
    const calls: boolean[] = [];
    const { service, fake } = createService({ setCallConfirmMode: async (v) => { calls.push(v); } });

    await service.start();
    // Read-only is on BEFORE the socket exists — no audio may be in flight
    // while the CTO can still write.
    expect(calls).toEqual([true]);

    fake.open();
    fake.receive({ type: "session.started" });
    await service.end();
    expect(calls).toEqual([true, false]);
  });

  it("refuses to start a call whose permissions it cannot set", async () => {
    const { service, latest } = createService({
      setCallConfirmMode: async () => { throw new Error("session is busy"); },
    });
    const result = await service.start();
    expect(result.ok).toBe(false);
    expect(latest().phase).toBe("failed");
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

describe("describeCtoVoiceSocketFailure", () => {
  it("names a rejected key, because that is the one the user can fix", () => {
    for (const status of [401, 403]) {
      expect(describeCtoVoiceSocketFailure({ status })).toEqual({
        message: "OpenAI rejected this key. Check it under CTO settings, Voice.",
        status,
        code: null,
      });
    }
  });

  it("recovers the status ws buries in its own message", () => {
    // With no `unexpected-response` listener this is all that survives, and it
    // is what a build that forgot one would have to work from.
    expect(describeCtoVoiceSocketFailure({ message: "Unexpected server response: 401" }).message)
      .toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(describeCtoVoiceSocketFailure({ message: "Unexpected server response: 429" }).status)
      .toBe(429);
  });

  it("separates throttling from rejection, because waiting fixes one and not the other", () => {
    expect(describeCtoVoiceSocketFailure({ status: 429 }).message)
      .toBe("OpenAI is rate limiting this key. Try again in a minute.");
  });

  it("blames the network only when there was no response at all", () => {
    expect(describeCtoVoiceSocketFailure({ code: "ENOTFOUND" }).message)
      .toBe("ADE could not reach OpenAI. Check your internet connection.");
    expect(describeCtoVoiceSocketFailure({ code: "ECONNREFUSED" }).message)
      .toBe("ADE could not reach OpenAI. Check your internet connection.");
    // Read out of the text when the code rides there instead of on the error.
    expect(describeCtoVoiceSocketFailure({ message: "getaddrinfo ENOTFOUND api.openai.com" }).message)
      .toBe("ADE could not reach OpenAI. Check your internet connection.");
    // A 500 is OpenAI answering. Telling the user to check their wifi would
    // send them to fix something that is not broken.
    expect(describeCtoVoiceSocketFailure({ status: 500, code: "ECONNRESET" }).message)
      .toBe("The voice connection failed.");
  });

  it("keeps the old sentence for a failure it cannot explain", () => {
    expect(describeCtoVoiceSocketFailure()).toEqual({
      message: "The voice connection failed.",
      status: null,
      code: null,
    });
    expect(describeCtoVoiceSocketFailure({ message: "socket hang up" }).message)
      .toBe("The voice connection failed.");
    expect(describeCtoVoiceSocketFailure({ status: 503 }).message)
      .toBe("The voice connection failed.");
  });
});

describe("forwardUnexpectedResponse", () => {
  it("reports the status before it releases the request", () => {
    // Releasing first makes `ws` emit "closed before the connection was
    // established" synchronously, and that error knows nothing about the 401
    // that caused it — so it won the race and the user was told the generic
    // sentence for a key OpenAI had plainly refused.
    const order: string[] = [];
    forwardUnexpectedResponse(
      () => order.push("handler"),
      { destroy: () => order.push("destroy") },
      { statusCode: 401 },
    );
    expect(order).toEqual(["handler", "destroy"]);
  });

  it("still releases the request when the handler throws", () => {
    const destroy = vi.fn();
    expect(() => forwardUnexpectedResponse(
      () => { throw new Error("boom"); },
      { destroy },
      { statusCode: 401 },
    )).toThrow("boom");
    expect(destroy).toHaveBeenCalled();
  });

  it("survives a response and a request that carry nothing", () => {
    const handler = vi.fn();
    forwardUnexpectedResponse(handler, null, null);
    expect(handler).toHaveBeenCalledWith({ statusCode: null });
  });
});

describe("a call that never connects", () => {
  it("surfaces a rejected key in the state the HUD reads, and logs the status", async () => {
    const warn = vi.fn();
    const { service, fake, states } = createService({
      logger: { info: () => {}, warn },
    });
    await service.start();

    fake.rejectUpgrade(401);

    const failed = states.find((state) => state.phase === "failed");
    expect(failed?.error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_rejected",
      expect.objectContaining({ status: 401 }),
    );
  });

  it("keeps the rejected-key sentence when tearing the socket down emits its own error", async () => {
    // The real shape of the regression: closing a CONNECTING socket makes `ws`
    // emit "WebSocket was closed before the connection was established" inside
    // the same tick, and that generic error must not win.
    const warn = vi.fn();
    const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
    const emitError = () => handlers.error?.forEach((h) => h(
      new Error("WebSocket was closed before the connection was established"),
    ));
    const socket: CtoVoiceSocket = {
      send: () => {},
      // Both doors: an explicit close and a destroy behave the same way.
      close: () => emitError(),
      on: (event, handler) => { (handlers[event] = handlers[event] ?? []).push(handler); },
    };
    const states: CtoVoiceState[] = [];
    const service = createCtoVoiceCallService({
      getApiKey: async () => "sk-test",
      ctoName: () => "CTO",
      projectName: () => "ADE",
      backchannelsEnabled: () => true,
      runBackendTurn: async () => ({ spoken: "" }),
      persistCall: async () => {},
      onState: (state) => states.push(state),
      logger: { info: () => {}, warn },
      createWebSocket: () => socket,
    });
    await service.start();

    handlers["unexpected-response"]?.forEach((h) => h({ statusCode: 401 }));
    await Promise.resolve();

    const failed = states.find((state) => state.phase === "failed");
    expect(failed?.error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(service.getState().error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    // The trace still names the status, which is what the log is for.
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_rejected",
      expect.objectContaining({ status: 401 }),
    );
    // The teardown's own error is recorded, and marked as the follow-on it is.
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_error",
      expect.objectContaining({ suppressed: true }),
    );
  });

  it("does not let a late generic error overwrite the reason it already found", async () => {
    // `ws` can follow a rejected upgrade with an error that knows nothing.
    const { service, fake } = createService();
    await service.start();

    fake.rejectUpgrade(401);
    fake.fail(new Error("socket hang up"));

    expect(service.getState().error)
      .toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
  });

  it("does not blame OpenAI for a hang-up ADE asked for", async () => {
    // The production symptom: something ends the call ~150 ms in, while the
    // socket is still CONNECTING. `ws` reports that close as "WebSocket was
    // closed before the connection was established" — indistinguishable, from
    // the error alone, from a connection that failed on its own. Describing it
    // as one is how a call hung up by ADE came back as
    // "The voice connection failed." and buried the real cause.
    const warn = vi.fn();
    const info = vi.fn();
    const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
    const socket: CtoVoiceSocket = {
      send: () => {},
      close: () => handlers.error?.forEach((h) => h(
        new Error("WebSocket was closed before the connection was established"),
      )),
      on: (event, handler) => { (handlers[event] = handlers[event] ?? []).push(handler); },
    };
    const states: CtoVoiceState[] = [];
    const service = createCtoVoiceCallService({
      getApiKey: async () => "sk-test",
      ctoName: () => "CTO",
      projectName: () => "ADE",
      backchannelsEnabled: () => true,
      runBackendTurn: async () => ({ spoken: "" }),
      persistCall: async () => {},
      onState: (state) => states.push(state),
      logger: { info, warn },
      createWebSocket: () => socket,
    });
    await service.start();
    // Never opened: exactly the window the real hang-up lands in.
    expect(states.at(-1)?.phase).toBe("connecting");

    await service.end("owner_end");

    expect(states.some((state) => state.phase === "failed")).toBe(false);
    expect(states.at(-1)?.phase).toBe("ended");
    expect(states.at(-1)?.error).toBeNull();
    // And the trace says who ended it, which is the whole point.
    expect(info).toHaveBeenCalledWith(
      "cto_voice.call_end",
      expect.objectContaining({ reason: "owner_end", socketOpen: false }),
    );
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_error",
      expect.objectContaining({ deliberate: true }),
    );
  });

  it("names the teardown path on every call end", async () => {
    const info = vi.fn();
    const { service, fake } = createService({ logger: { info, warn: () => {} } });
    await service.start();

    fake.rejectUpgrade(401);
    await Promise.resolve();

    expect(info).toHaveBeenCalledWith(
      "cto_voice.call_end",
      expect.objectContaining({ reason: "socket_rejected" }),
    );
  });

  it("tells an offline machine it is offline", async () => {
    const { service, fake, states } = createService();
    await service.start();

    fake.fail(Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" }));

    const failed = states.find((state) => state.phase === "failed");
    expect(failed?.error).toBe("ADE could not reach OpenAI. Check your internet connection.");
  });
});
