import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
  CTO_VOICE_SPOKEN_CONTEXT_OVERFLOW,
  CTO_VOICE_SPOKEN_TURN_FAILED,
  isVoiceCallLive,
  type CtoVoiceState,
} from "../../../shared/types/ctoVoice";
import { createCtoVoiceRuntimeService, splitSpokenSceneAnswer } from "./ctoVoiceRuntimeService";
import {
  createFakeSocket,
  createVoiceRuntimeHost,
  pushedPhases,
} from "./ctoVoiceTestDoubles";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { initApiKeyStore } from "../ai/apiKeyStore";
import { getAdeActionDomainServices } from "../adeActions/registry";
import type { CtoVoiceSocket } from "./ctoVoiceCallService";
/**
 * One microphone frame at the renderer's size: 2048 samples of PCM16, ~85 ms.
 * The transcript gate reads a segment's length out of these bytes.
 */
const MIC_FRAME = Buffer.alloc(2048 * 2).toString("base64");

/** Ten milliseconds of nothing: enough for every queued microtask to run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createCtoVoiceRuntimeService", () => {
  it("says in plain language that the machine has no OpenAI key", async () => {
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, { getApiKey: async () => null });

    const result = await voice.start({ ownerToken: "owner-1" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing-key");
    expect(result.detail).toBe("no OpenAI key on this machine");
  });

  it("names the chat service, not a 'service not ready' shrug, when the CTO thread is missing", async () => {
    const { host } = createVoiceRuntimeHost({ agentChatService: null });
    const voice = createCtoVoiceRuntimeService(host, { getApiKey: async () => "sk-test" });

    const result = await voice.start({ ownerToken: "owner-1" });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("the CTO chat session is not ready on this machine");
    expect(result.detail).not.toContain("service not ready");
  });

  it("refuses a caller that does not identify itself as the call owner", async () => {
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, { getApiKey: async () => "sk-test" });

    expect((await voice.start({})).error).toBe("bad-request");
  });

  it("drains queued output audio exactly once, and only for the owner", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({ ok: true });
    fake.open();
    fake.receive({ type: "response.output_audio.delta", delta: "AAAA" });
    fake.receive({ type: "response.output_audio.delta", delta: "BBBB" });

    // A window that does not hold the call cannot drain its audio out from
    // under the one that does.
    const thief = voice.pullAudio({ ownerToken: "owner-2" });
    expect(thief.ok).toBe(false);
    expect(thief.chunks).toEqual([]);

    const first = voice.pullAudio({ ownerToken: "owner-1" });
    expect(first.chunks).toEqual(["AAAA", "BBBB"]);
    expect(first.dropped).toBe(0);
    // Drained, not copied: a second pull must not replay the same audio.
    expect(voice.pullAudio({ ownerToken: "owner-1" }).chunks).toEqual([]);
  });

  it("takes microphone frames while the socket is still opening, and never throws", async () => {
    // The HUD opens the microphone the moment Talk is pressed, so frames arrive
    // during the handshake — and `ws` throws on any send before `open`. That
    // throw used to reject the pushAudio ACTION, which the desktop pump read as
    // "the runtime is gone" and tore the call down before the runtime's own
    // failure could reach the renderer.
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => {
        const socket = fake.socket;
        return {
          ...socket,
          send: () => { throw new Error("WebSocket is not open: readyState 0 (CONNECTING)"); },
        };
      },
    });

    await voice.start({ ownerToken: "owner-1" });
    // A real level, not zero: the meter emit is part of the same call path.
    expect(voice.pushAudio({ ownerToken: "owner-1", chunks: ["aaa", "bbb"], level: 0.42 }))
      .toEqual({ ok: true });
    expect(voice.getState().inputLevel).toBeCloseTo(0.42);
    // The call is still live; nothing was torn down by a frame.
    expect(isVoiceCallLive(voice.getState().phase)).toBe(true);
  });

  it("still reaches failed and then ended when the key is refused mid-handshake", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    // Frames arrive during the handshake, exactly as the renderer sends them.
    voice.pushAudio({ ownerToken: "owner-1", chunks: ["aaa"], level: 0.3 });
    fake.rejectUpgrade(401);
    await Promise.resolve();
    await Promise.resolve();

    const phases = [...new Set(pushedPhases(host))];
    expect(phases).toContain("failed");
    expect(voice.getState().error)
      .toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(isVoiceCallLive(voice.getState().phase)).toBe(false);
  });

  it("publishes exactly one ended after a failed, because failed is not finished", async () => {
    // `failed` keeps the HUD on screen by design — it is what the user reads.
    // The `ended` that follows is what takes it back off. Suppressing it left
    // the pill showing a rejected key forever, and the page notice (which only
    // appears once the HUD unmounts) never arrived at all.
    const fake = createFakeSocket();
    const { host, pushed } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.rejectUpgrade(401);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const phases = pushedPhases(host);
    expect(phases).toContain("failed");
    expect(phases.filter((phase) => phase === "ended")).toHaveLength(1);
    // Order matters: the reason first, the dismissal after it.
    expect(phases.lastIndexOf("failed")).toBeLessThan(phases.indexOf("ended"));
    // And the sentence survives onto the terminal state.
    const ended = pushed
      .map((event) => (event.payload as { state: { phase: string; error: string | null } }).state)
      .find((state) => state.phase === "ended");
    expect(ended?.error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
  });

  it("still ends a call the owner hangs up on after it failed", async () => {
    // The same rule through the other door: suppression is keyed on the REASON,
    // never on "the phase is already terminal".
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.fail(new Error("The voice connection failed."));
    expect(voice.getState().phase).toBe("failed");

    await voice.end({ ownerToken: "owner-1" });

    const phases = pushedPhases(host);
    expect(phases.filter((phase) => phase === "ended")).toHaveLength(1);
    expect(voice.getState().phase).toBe("ended");
  });

  it("clears a dead call silently, so the next call's first word is its own", async () => {
    // The desktop subscribes before it calls `start`, so anything published
    // while a dead service is being cleared lands on the NEW call's slot.
    const first = createFakeSocket();
    const second = createFakeSocket();
    const sockets = [first.socket, second.socket];
    const { host, pushed } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => sockets.shift()!,
    });

    await voice.start({ ownerToken: "owner-1" });
    // A socket error with no `close` behind it: the call is failed, and its
    // service is still sitting there un-torn-down. That is the shape the next
    // start meets in production, and the shape whose teardown used to speak.
    first.fail(new Error("The voice connection failed."));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deadCallId = voice.getState().callId;
    expect(voice.getState().phase).toBe("failed");
    expect(isVoiceCallLive(voice.getState().phase)).toBe(false);

    const before = pushed.length;
    expect(await voice.start({ ownerToken: "owner-2" })).toEqual({ ok: true });

    const after = pushed.slice(before).map((event) => (event.payload as {
      state: { phase: string; callId: string | null };
    }).state);
    // Not one extra terminal state for the call that was already over.
    expect(after.filter((state) => !isVoiceCallLive(state.phase))).toEqual([]);
    // The new call's first word is its own `connecting`, under a fresh id.
    expect(after[0]?.phase).toBe("connecting");
    expect(after[0]?.callId).not.toBe(deadCallId);
    expect(after[0]?.callId).toBeTruthy();
  });

  it("publishes call state on the cto_voice event category, and never audio", async () => {
    const fake = createFakeSocket();
    const { host, pushed } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    fake.receive({ type: "response.output_audio.delta", delta: "AAAA" });

    expect(pushed.length).toBeGreaterThan(0);
    expect(new Set(pushed.map((event) => event.category))).toEqual(new Set(["cto_voice"]));
    for (const event of pushed) {
      expect(event.payload.type).toBe("cto_voice_state");
      // The one thing this category must never carry.
      expect(JSON.stringify(event.payload)).not.toContain("AAAA");
    }
  });

  /**
   * The owner's third complaint: the CTO row still read "hey there?" while the
   * call had moved on through several exchanges. The generated status line takes
   * a model round trip per settled turn; a spoken turn takes one second. So the
   * call writes the line itself, and writes a truthful one on the way out.
   */
  it("tracks the call on the CTO row, and closes the line when it ends", async () => {
    const fake = createFakeSocket();
    const setStatusNote = vi.fn(() => true);
    const { host } = createVoiceRuntimeHost({ sessionService: { setStatusNote } as never });
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    fake.receive({ type: "session.created", session: { id: "sess_1" } });

    for (const said of ["hey there", "what is this project", "what should I do next"]) {
      fake.receive({ type: "input_audio_buffer.speech_started" });
      voice.pushAudio({
        ownerToken: "owner-1",
        chunks: Array.from({ length: 5 }, () => MIC_FRAME),
        level: 0.4,
      });
      fake.receive({ type: "input_audio_buffer.speech_stopped" });
      fake.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: said,
        transcript: said,
      });
      await tick();
      await tick();
      fake.receive({ type: "response.done", response: { status: "completed" } });
    }

    expect(setStatusNote.mock.calls).toEqual([
      ["session-1", "Voice call · 1 exchange"],
      ["session-1", "Voice call · 2 exchanges"],
      ["session-1", "Voice call · 3 exchanges"],
    ]);

    await voice.end({ ownerToken: "owner-1" });
    // The closing line survives the confirm-hold release that clears the call's
    // session binding — that release runs first, on the way out of the teardown.
    expect(setStatusNote.mock.calls.at(-1))
      .toEqual(["session-1", "Voice call ended · 3 exchanges"]);
    voice.dispose();
  });

  it("pushes batched microphone chunks into the live call", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    fake.sent.length = 0;
    voice.pushAudio({ ownerToken: "owner-1", chunks: ["one", "two"], level: 0.4 });

    const appended = fake.sent.filter((m) => m.type === "input_audio_buffer.append");
    expect(appended.map((m) => m.audio)).toEqual(["one", "two"]);
    expect(voice.getState().inputLevel).toBeCloseTo(0.4);
  });

  /**
   * Each frame is credited its own level. The batch maximum used to be replayed
   * onto every frame in the batch, so one transient read as a whole batch of
   * speech — half of why a hallucinated transcript passed the gate.
   */
  it("credits each microphone frame the level it arrived with", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    voice.pushAudio({
      ownerToken: "owner-1",
      chunks: [MIC_FRAME, MIC_FRAME, MIC_FRAME],
      level: 0.6,
      levels: [0.01, 0.6, 0.02],
    });

    // The meter ends on the LAST frame's level, not the batch maximum: the
    // state the HUD shows is the state the gate measured.
    expect(voice.getState().inputLevel).toBeCloseTo(0.02);
    voice.dispose();
  });

  it("falls back to the batch level when an older desktop sends no per-frame levels", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    voice.pushAudio({ ownerToken: "owner-1", chunks: [MIC_FRAME, MIC_FRAME], level: 0.4 });

    expect(voice.getState().inputLevel).toBeCloseTo(0.4);
    voice.dispose();
  });

  it("hands a spoken decision to the chat approval the turn is parked on", async () => {
    const fake = createFakeSocket();
    const approveToolUse = vi.fn(async () => undefined);
    const { host } = createVoiceRuntimeHost();
    (host.agentChatService as unknown as { approveToolUse: unknown }).approveToolUse = approveToolUse;
    const raiser: { fn: ((a: { itemId: string; toolName: string; prompt: string }) => void) | null } = { fn: null };
    (host.agentChatService as unknown as { subscribeToEvents: unknown }).subscribeToEvents = (
      handler: (envelope: { sessionId: string; event: Record<string, unknown> }) => void,
    ) => {
      raiser.fn = (approval) => handler({
        sessionId: "session-1",
        event: {
          type: "approval_request",
          itemId: approval.itemId,
          kind: approval.toolName,
          description: approval.prompt,
        },
      });
      return () => {};
    };
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    raiser.fn?.({ itemId: "item-1", toolName: "Write", prompt: "Write the file?" });
    const pending = voice.getState().pendingConfirmation;
    expect(pending?.approvalItemId).toBe("item-1");

    await voice.resolveApproval({ ownerToken: "owner-1", approvalId: pending!.id, approved: true });
    expect(approveToolUse).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-1", decision: "accept" }),
    );
  });

  /**
   * The other half of the barge-in, and the half that used to be missing.
   *
   * The renderer flushes its own playback graph, but the runtime keeps up to
   * twenty seconds of already-generated answer in the pull queue — so the very
   * next drain handed the speaker back the sentence the user just talked over.
   */
  it("throws away queued output audio the moment a barge-in lands", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    fake.receive({ type: "session.created", session: { id: "sess_1" } });
    fake.receive({ type: "response.created", response: { id: "resp_1" } });
    fake.receive({ type: "response.output_audio.delta", delta: "AAAA" });
    fake.receive({ type: "response.output_audio.delta", delta: "BBBB" });

    fake.receive({ type: "input_audio_buffer.speech_started" });

    expect(voice.getState().interrupted).toBe(true);
    const drained = voice.pullAudio({ ownerToken: "owner-1" });
    expect(drained.chunks).toEqual([]);
    // Cancelled, not lost: the owner is not told audio went missing.
    expect(drained.dropped).toBe(0);
    voice.dispose();
  });

  /**
   * The session is resolved once, before the socket opens, and that resolution
   * is what the confirm-first hold is keyed on. Re-resolving it per turn walked
   * the lane list and re-normalized the session again between the user
   * finishing a sentence and the provider seeing it.
   */
  it("reuses the session the call already resolved instead of resolving one per turn", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const chat = host.agentChatService as unknown as Record<string, unknown>;
    const ensureIdentitySession = vi.fn(async () => ({ id: "session-1" }));
    chat.ensureIdentitySession = ensureIdentitySession;
    const runSessionTurn = vi.fn(async () => ({ outputText: "Nine lanes.", status: "completed" }));
    chat.runSessionTurn = runSessionTurn;
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    fake.receive({ type: "session.created", session: { id: "sess_1" } });
    await tick();
    const resolvedBeforeTheTurn = ensureIdentitySession.mock.calls.length;

    fake.receive({ type: "input_audio_buffer.speech_started" });
    voice.pushAudio({ ownerToken: "owner-1", chunks: [MIC_FRAME, MIC_FRAME, MIC_FRAME, MIC_FRAME], level: 0.5 });
    fake.receive({ type: "input_audio_buffer.speech_stopped" });
    fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "how many lanes",
    });
    await tick();

    expect(runSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(ensureIdentitySession.mock.calls.length).toBe(resolvedBeforeTheTurn);
    voice.dispose();
  });

  /**
   * The two numbers `cto_voice.turn_timing` cannot see from the call service:
   * only this side is watching the thread's event stream, and "the model was
   * slow" and "the tools were slow" have different fixes.
   */
  it("reports the turn's first text and its tool calls back to the call", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const chat = host.agentChatService as unknown as Record<string, unknown>;
    const listeners = new Set<(envelope: unknown) => void>();
    chat.subscribeToEvents = (handler: (envelope: unknown) => void) => {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    };
    chat.runSessionTurn = async (args: { voiceCallId?: string }) => {
      const provenance = { voiceCallId: args.voiceCallId ?? null };
      for (const listener of listeners) {
        listener({ sessionId: "session-1", provenance, event: { type: "text", text: "Nine" } });
        listener({ sessionId: "session-1", provenance, event: { type: "tool_call", tool: "listLanes" } });
        listener({ sessionId: "session-1", provenance, event: { type: "text", text: " lanes." } });
        // Another chat on the same thread. A voice turn's measurements are the
        // voice turn's, so this one must not be counted.
        listener({ sessionId: "session-1", provenance: {}, event: { type: "tool_call", tool: "bash" } });
      }
      return { outputText: "Nine lanes.", status: "completed" };
    };
    const lines: Array<{ event: string; meta: Record<string, unknown> }> = [];
    host.logger = {
      info: (event: string, meta?: Record<string, unknown>) => lines.push({ event, meta: meta ?? {} }),
      warn: () => {},
    };
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.open();
    fake.receive({ type: "session.created", session: { id: "sess_1" } });
    fake.receive({ type: "input_audio_buffer.speech_started" });
    voice.pushAudio({ ownerToken: "owner-1", chunks: [MIC_FRAME, MIC_FRAME, MIC_FRAME, MIC_FRAME], level: 0.5 });
    fake.receive({ type: "input_audio_buffer.speech_stopped" });
    fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "how many lanes",
    });
    await tick();
    // The answer is spoken, and the audio for it is what closes the timing line.
    fake.receive({ type: "response.output_audio.delta", delta: "AAAA" });

    const timing = lines.find((line) => line.event === "cto_voice.turn_timing");
    expect(timing).toBeDefined();
    expect(timing?.meta.toolCalls).toBe(1);
    expect(timing?.meta.turnStartToFirstTextMs).toEqual(expect.any(Number));
    voice.dispose();
  });

  it("hangs up a call whose owning window has gone quiet", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeSocket();
      const { host } = createVoiceRuntimeHost();
      let clock = 1_000;
      const voice = createCtoVoiceRuntimeService(host, {
        getApiKey: async () => "sk-test",
        createWebSocket: () => fake.socket,
        now: () => clock,
      });

      await voice.start({ ownerToken: "owner-1" });
      fake.open();
      expect(voice.getState().phase).not.toBe("ended");

      clock += 60_000;
      await vi.advanceTimersByTimeAsync(2_000);
      // The teardown is serialized behind the watchdog's own promise chain.
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      const state: CtoVoiceState = voice.getState();
      expect(state.phase).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("splitSpokenSceneAnswer", () => {
  it("lifts the one scene fence out of what gets spoken", () => {
    // The HUD renders `sceneSource` in the same sandbox the transcript uses. If
    // the fence stayed in the spoken half the voice model would read HTML aloud.
    const result = splitSpokenSceneAnswer([
      "Three lanes are ahead of main.",
      "",
      "```scene",
      "<div>chart</div>",
      "```",
    ].join("\n"));

    expect(result.spoken).toBe("Three lanes are ahead of main.");
    expect(result.sceneSource).toContain("<div>chart</div>");
  });

  it("says something when the answer was only a picture", () => {
    // A `response.create` whose instructions are empty produces no audio at all,
    // and the HUD then sits in `speaking` with nothing to hear and no way out.
    const result = splitSpokenSceneAnswer("\`\`\`scene\n<div>chart</div>\n\`\`\`");
    expect(result.sceneSource).toContain("<div>chart</div>");
    expect(result.spoken).toBe("Here is what I drew.");
  });

  it("strips a second scene fence instead of reading it aloud", () => {
    const result = splitSpokenSceneAnswer([
      "One.",
      "\`\`\`scene",
      "<p>first</p>",
      "\`\`\`",
      "Two.",
      "\`\`\`scene",
      "<p>second</p>",
      "\`\`\`",
    ].join("\n"));
    expect(result.sceneSource).toContain("first");
    expect(result.spoken).not.toContain("scene");
    expect(result.spoken).not.toContain("second");
    expect(result.spoken).toBe("One.\nTwo.");
  });

  it("leaves an answer with no fence exactly as it was", () => {
    expect(splitSpokenSceneAnswer("  Three merged yesterday.  "))
      .toEqual({ spoken: "Three merged yesterday." });
  });

  it("keeps a malformed fence in the prose rather than dropping it silently", () => {
    // An empty fence is not a scene. Speaking something odd beats a picture
    // that never appears and text that never mentions it.
    const text = "Here you go.\n\n```scene\n\n```";
    const result = splitSpokenSceneAnswer(text);
    expect(result.sceneSource).toBeUndefined();
    expect(result.spoken).toContain("```scene");
  });

  it("takes only the first fence, because the prompt allows exactly one", () => {
    const result = splitSpokenSceneAnswer([
      "One.",
      "```scene",
      "<p>first</p>",
      "```",
      "```scene",
      "<p>second</p>",
      "```",
    ].join("\n"));
    expect(result.sceneSource).toContain("first");
    expect(result.sceneSource).not.toContain("second");
  });
});

describe("the approvals a call hears about", () => {
  it("marks a force-push destructive, so a spoken yes cannot release it", async () => {
    // End to end through the real event shape: `kind: "command"`, an object
    // `detail`, and the command only visible in the description.
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const raise: { fn: ((event: unknown) => void) | null } = { fn: null };
    (host.agentChatService as unknown as { subscribeToEvents: unknown }).subscribeToEvents = (
      handler: (envelope: { sessionId: string; event: Record<string, unknown> }) => void,
    ) => {
      raise.fn = (event) => handler({ sessionId: "session-1", event: event as Record<string, unknown> });
      return () => {};
    };
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });
    await voice.start({ ownerToken: "owner-1" });
    fake.open();

    raise.fn?.({
      type: "approval_request",
      itemId: "item-1",
      kind: "command",
      description: "Run command: git push --force origin main",
      detail: { tool: "Bash" },
    });

    const confirmation = voice.getState().pendingConfirmation;
    expect(confirmation?.toolName).toBe("Bash");
    expect(confirmation?.destructive).toBe(true);
  });

  it("leaves a read answerable by voice", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const raise: { fn: ((event: unknown) => void) | null } = { fn: null };
    (host.agentChatService as unknown as { subscribeToEvents: unknown }).subscribeToEvents = (
      handler: (envelope: { sessionId: string; event: Record<string, unknown> }) => void,
    ) => {
      raise.fn = (event) => handler({ sessionId: "session-1", event: event as Record<string, unknown> });
      return () => {};
    };
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });
    await voice.start({ ownerToken: "owner-1" });
    fake.open();

    raise.fn?.({
      type: "approval_request",
      itemId: "item-2",
      kind: "command",
      description: "Run command: git status",
      detail: { tool: "Bash" },
    });

    expect(voice.getState().pendingConfirmation?.destructive).toBe(false);
  });
});

describe("what a call reports when it ends", () => {
  function analytics() {
    const captured: Array<Record<string, unknown>> = [];
    return {
      captureInternal: (message: Record<string, unknown>) => {
        captured.push(message);
        return { accepted: true, reason: "accepted" };
      },
      captured,
    };
  }

  it("reports a refused key as a coarse outcome, never as the sentence", async () => {
    const fake = createFakeSocket();
    const spy = analytics();
    const { host } = createVoiceRuntimeHost({ productAnalyticsService: spy as never });
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.rejectUpgrade(401);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0]).toMatchObject({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "cto",
        action: "voice_call",
        outcome: "rejected_key",
        duration_bucket: "under_1m",
      },
    });
    // The user-facing sentence names a provider and a settings pane.
    expect(JSON.stringify(spy.captured)).not.toContain("OpenAI");
  });

  it("reports exactly one event per call, whichever teardown ran", async () => {
    // A failed call publishes TWO terminal states — `failed` then `ended` — and
    // they are one product fact.
    const fake = createFakeSocket();
    const spy = analytics();
    const { host } = createVoiceRuntimeHost({ productAnalyticsService: spy as never });
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    fake.fail(new Error("The voice connection failed."));
    await voice.end({ ownerToken: "owner-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0]?.dedupeKey).toMatch(/^cto_voice_call:/);
    expect((spy.captured[0] as { properties: { outcome: string } }).properties.outcome)
      .toBe("connection_failed");
  });

  it("takes the microphone verdict from the caller's coarse kind", async () => {
    const fake = createFakeSocket();
    const spy = analytics();
    const { host } = createVoiceRuntimeHost({ productAnalyticsService: spy as never });
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    await voice.start({ ownerToken: "owner-1" });
    await voice.end({ ownerToken: "owner-1", endKind: "microphone_unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((spy.captured[0] as { properties: { outcome: string } }).properties.outcome)
      .toBe("microphone_unavailable");
  });

  it("stays silent when the runtime has no analytics service", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost();
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });
    await voice.start({ ownerToken: "owner-1" });
    await expect(voice.end({ ownerToken: "owner-1" })).resolves.toEqual({ ok: true });
  });
});

/**
 * One store, end to end inside ONE process.
 *
 * `ai.storeMachineApiKey` and `cto_voice.hasKey` are two actions on the same
 * runtime, and they have to read the same credential store: desktop main writes
 * through Electron `safeStorage` and the runtime reads through
 * `EncryptedFileCredentialStore`, so a key that lands in the wrong one leaves
 * Settings reporting `configured: true` while Talk answers "no OpenAI key on
 * this machine".
 */
describe("a key stored on the runtime is a key the voice call can use", () => {
  const originalEnv = { ...process.env };
  let machineHome: string;
  let projectRoot: string;

  beforeEach(() => {
    machineHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-voice-key-machine-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-voice-key-project-"));
    process.env = {
      ...originalEnv,
      ADE_HOME: machineHome,
      // The Keychain tier would answer for the real machine, not this fixture.
      ADE_API_KEY_STORE_DISABLE_KEYCHAIN: "1",
    };
    delete process.env.OPENAI_API_KEY;
    initApiKeyStore(projectRoot, {
      credentialStore: new EncryptedFileCredentialStore({
        secretsDir: resolveMachineAdeLayout().secretsDir,
      }),
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(machineHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    // Leave no fixture store bound to the next test in this process.
    initApiKeyStore(process.cwd());
  });

  function createStubSocket(): CtoVoiceSocket {
    return { send: () => {}, close: () => {}, on: () => {} };
  }

  it("goes from missing-key to a live call once ai.storeMachineApiKey has run", async () => {
    const ai = getAdeActionDomainServices({
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      aiIntegrationService: {
        listApiKeys: () => [],
        invalidateProviderReadinessCaches: () => {},
      },
      projectConfigService: {},
    } as never).ai as unknown as {
      getMachineApiKeyStatus: (args: { provider: string }) => { configured: boolean; source: string | null };
      storeMachineApiKey: (args: { provider: string; key: string }) => { configured: boolean; source: string | null };
      deleteMachineApiKey: (args: { provider: string }) => { configured: boolean; source: string | null };
    };
    expect(ai).toBeTruthy();

    const voice = createCtoVoiceRuntimeService(
      createVoiceRuntimeHost({ projectRoot, ctoMemoryService: null }).host,
      {
        createWebSocket: () => createStubSocket(),
      },
    );

    // Before: the honest refusal, in the words the user sees.
    expect(await voice.hasKey()).toBe(false);
    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({
      ok: false,
      error: "missing-key",
      detail: "no OpenAI key on this machine",
    });

    // The write the renderer now makes: the SAME runtime, not desktop main.
    expect(ai.storeMachineApiKey({ provider: "openai", key: "sk-stored-here" }))
      .toMatchObject({ configured: true, source: "store" });

    // After: no re-init, no restart. The voice service's own `getMachineApiKey`
    // sees it, which is the whole point of putting the write on the runtime.
    expect(await voice.hasKey()).toBe(true);
    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({ ok: true });
    await voice.end({ ownerToken: "owner-1" });

    // And the reverse state: deleting takes the call away again.
    expect(ai.deleteMachineApiKey({ provider: "openai" })).toMatchObject({ configured: false });
    expect(await voice.hasKey()).toBe(false);
    voice.dispose();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   A failed turn is not an answer

   The owner pressed Talk, said "hi", and heard the CTO say "Prompt is too
   long" in its own voice — because `runBackendTurn` returned `outputText` no
   matter how the turn ended, and on a failed turn that string is the provider's
   error. These tests hold the line by CAUSE, never by matching the words.
   ──────────────────────────────────────────────────────────────────────────── */
describe("what a call says when the turn did not answer", () => {
  /** Every response this call asked for, as the text it was told to read. */
  function spoken(fake: ReturnType<typeof createFakeSocket>): string[] {
    return fake.sent
      .filter((message) => message.type === "response.create")
      .map((message) => String((message.response as { instructions?: unknown }).instructions ?? ""));
  }

  async function runOneUtterance(runSessionTurn: (args: unknown) => Promise<unknown>) {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost({
      agentChatService: {
        ensureIdentitySession: async () => ({ id: "session-1" }),
        updateSession: async () => undefined,
        approveToolUse: async () => undefined,
        subscribeToEvents: () => () => {},
        runSessionTurn,
        interrupt: async () => undefined,
        getSessionTurnHealth: () => ({
          sessionId: "session-1",
          canTakeTurn: true,
          blockedReason: null,
          lastTurnFailure: null,
          context: null,
          rotationAdvised: false,
        }),
      } as never,
      // Backchannels would put a second, unrelated sentence on the wire; this
      // suite is about what a call says when the TURN did not answer.
      ctoStateService: { getIdentity: () => ({ name: "Ada", voiceBackchannels: false, voiceName: "marin" }) } as never,
      ctoMemoryService: null,
    });
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });
    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({ ok: true });
    fake.open();
    fake.receive({ type: "session.created", session: { id: "sess_1" } });
    fake.receive({ type: "input_audio_buffer.speech_started" });
    // The microphone has to agree that a person spoke: a transcript with no
    // energy behind it is a hallucination and never becomes a turn.
    voice.pushAudio({
      ownerToken: "owner-1",
      chunks: Array.from({ length: 5 }, () => MIC_FRAME),
      level: 0.4,
    });
    fake.receive({ type: "input_audio_buffer.speech_stopped" });
    fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "hi",
    });
    await tick();
    await tick();
    return { voice, fake, state: voice.getState() };
  }

  it("speaks one human sentence, not the provider's error, when the thread is over its limit", async () => {
    const { voice, fake } = await runOneUtterance(async () => ({
      // Exactly what the owner's thread returned: a failed turn whose
      // `outputText` fell through to the session preview, which is the error.
      outputText: "Prompt is too long",
      status: "failed",
      errorMessage: "Prompt is too long",
    }));

    expect(spoken(fake)).toHaveLength(1);
    expect(spoken(fake)[0]).toContain(CTO_VOICE_SPOKEN_CONTEXT_OVERFLOW);
    expect(spoken(fake).join(" ")).not.toContain("Prompt is too long");
    voice.dispose();
  });

  it("speaks the generic sentence for a failure that is not about context", async () => {
    const { voice, fake } = await runOneUtterance(async () => ({
      outputText: "ECONNRESET while talking to the provider",
      status: "failed",
      errorMessage: "ECONNRESET while talking to the provider",
    }));

    expect(spoken(fake)).toHaveLength(1);
    expect(spoken(fake)[0]).toContain(CTO_VOICE_SPOKEN_TURN_FAILED);
    expect(spoken(fake).join(" ")).not.toContain("ECONNRESET");
    voice.dispose();
  });

  it("says nothing at all when the user interrupted the turn themselves", async () => {
    const { voice, fake } = await runOneUtterance(async () => ({
      outputText: "",
      status: "interrupted",
      errorMessage: null,
    }));

    expect(spoken(fake)).toEqual([]);
    // And the call is listening again rather than stuck waiting for audio that
    // an empty commentary would never produce.
    expect(voice.getState().phase).toBe("listening");
    voice.dispose();
  });

  it("tags the turn with the call it belongs to, so the transcript can fold it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { voice } = await runOneUtterance(async (args) => {
      seen.push(args as Record<string, unknown>);
      return { outputText: "Three merged yesterday.", status: "completed" };
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.voiceCallId).toBe(voice.getState().callId);
    expect(String(seen[0]!.voiceCallId ?? "")).not.toHaveLength(0);
    voice.dispose();
  });

  /**
   * The session transcribes English and the voice reads English. A CTO that
   * answered in another language would be read aloud by an English voice — which
   * is what a real call did, replying in Chinese to a hallucinated "好".
   */
  it("asks the CTO for an English answer, because that is what the call can speak", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { voice } = await runOneUtterance(async (args) => {
      seen.push(args as Record<string, unknown>);
      return { outputText: "Three merged yesterday.", status: "completed" };
    });

    expect(seen).toHaveLength(1);
    expect(String(seen[0]!.text ?? "")).toContain("Answer in English.");
    voice.dispose();
  });
});

describe("the pre-flight before a call is opened", () => {
  it("refuses a call the CTO thread cannot answer, and names the way out", async () => {
    const createWebSocket = vi.fn(() => createFakeSocket().socket);
    const { host } = createVoiceRuntimeHost({
      agentChatService: {
        ensureIdentitySession: async () => ({ id: "session-1" }),
        updateSession: async () => undefined,
        approveToolUse: async () => undefined,
        subscribeToEvents: () => () => {},
        runSessionTurn: async () => ({ outputText: "", status: "completed" }),
        interrupt: async () => undefined,
        getSessionTurnHealth: () => ({
          sessionId: "session-1",
          canTakeTurn: false,
          blockedReason: "context_overflow",
          lastTurnFailure: { kind: "context_overflow", message: "Prompt is too long", at: "2026-09-16T00:00:00.000Z" },
          context: null,
          rotationAdvised: true,
        }),
      } as never,
      ctoMemoryService: null,
    });
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket,
    });

    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({
      ok: false,
      error: "chat-unavailable",
      detail: CTO_VOICE_CHAT_OVER_LIMIT_DETAIL,
    });
    // Refused BEFORE the billed socket: nothing was opened.
    expect(createWebSocket).not.toHaveBeenCalled();
    voice.dispose();
  });

  it("opens the call when the thread can still take a turn", async () => {
    const fake = createFakeSocket();
    const { host } = createVoiceRuntimeHost({ ctoMemoryService: null });
    const voice = createCtoVoiceRuntimeService(host, {
      getApiKey: async () => "sk-test",
      createWebSocket: () => fake.socket,
    });

    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({ ok: true });
    voice.dispose();
  });
});
