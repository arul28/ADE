import { describe, expect, it, vi } from "vitest";
import type { CtoVoiceBackendResult } from "./ctoVoiceCallService";
import {
  CTO_VOICE_END_CALL_AUDIO_TAIL_MS,
  CTO_VOICE_MODEL,
  CTO_VOICE_TURN_BURST_COOLDOWN_MS,
  CTO_VOICE_TURN_BURST_LIMIT,
  CTO_VOICE_TURN_BURST_WINDOW_MS,
  CTO_VOICE_SAMPLE_RATE,
  ctoVoiceStatusLine,
  ctoVoiceTranscriptHasSpeech,
} from "../../../shared/types/ctoVoice";
import { buildCtoVoiceSessionUpdate } from "../../../shared/types/ctoVoiceSession";
import { createFakeSocket } from "./ctoVoiceTestDoubles";
import {
  askCto,
  callTool,
  createService,
  functionOutputs,
  hearMic,
  modelResponses,
  openCall,
  spoken,
  tick,
  utter,
} from "./ctoVoiceCallHarness";
import { createResponseQueue } from "./ctoVoiceResponseQueue";
import { createTranscriptBurstValve } from "./ctoVoiceTurnBurst";
import { createTurnTimingRecorder } from "./ctoVoiceTurnTiming";

describe("createCtoVoiceCallService", () => {
  it("refuses to start without a key, and says so", async () => {
    const { service, latest } = createService({ getApiKey: async () => null });
    const result = await service.start();
    expect(result).toEqual({ ok: false, error: "missing-key" });
    expect(latest().phase).toBe("failed");
    expect(latest().error).toContain("API key");
  });

  it("opens the realtime endpoint with the model as its one query parameter", async () => {
    const urls: string[] = [];
    const fake = createFakeSocket();
    const { service } = createService({
      createWebSocket: (url: string) => { urls.push(url); return fake.socket; },
    });
    await service.start();
    expect(urls).toEqual([`wss://api.openai.com/v1/realtime?model=${CTO_VOICE_MODEL}`]);
  });

  /**
   * What the payload IS belongs to `ctoVoiceSession.test.ts`. What the CALL
   * owns is that the built event is what reaches the wire the moment the socket
   * opens — stamped with an id, and carrying what this service was asked for
   * its context block and its voice. Anything the model says before its
   * instructions land is said by a stranger.
   */
  it("sends the built session update the moment the socket opens", async () => {
    const harness = createService({
      voice: () => "cedar",
      context: async () => "Who you are\n- Name: Ada",
    });
    await harness.service.start();
    harness.fake.open();

    expect(harness.fake.lastOfType("session.update")).toEqual({
      ...buildCtoVoiceSessionUpdate({
        ctoName: "CTO",
        projectName: "ADE",
        context: "Who you are\n- Name: Ada",
        acknowledgeAloud: true,
        voice: "cedar",
      }),
      event_id: expect.any(String),
    });
  });

  it("starts the clock when OpenAI answers with a session", async () => {
    const harness = createService();
    await harness.service.start();
    harness.fake.open();
    expect(harness.latest().phase).toBe("connecting");
    harness.fake.receive({ type: "session.created", session: { id: "sess_1" } });
    expect(harness.latest().phase).toBe("listening");
  });

  it("sends microphone audio as input_audio_buffer.append", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.sent.length = 0;
    harness.service.pushAudio("AAAA");
    const appended = harness.fake.sent.filter((m) => m.type === "input_audio_buffer.append");
    expect(appended.map((m) => m.audio)).toEqual(["AAAA"]);
  });

  /**
   * A plain transcript is no longer an instruction to anyone.
   *
   * Under the old protocol every accepted transcript became a CTO turn, which
   * is what made "hello" cost three to five seconds. The model hears the audio
   * itself now and decides; ADE only writes the caption down.
   */
  it("never starts a CTO turn from a transcript alone", async () => {
    const intents: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { intents.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    utter(harness, "hello, who are you");
    await tick();

    expect(intents).toEqual([]);
    expect(spoken(harness.fake)).toEqual([]);
    // The caption is still written: the call record is what the gate guards.
    expect(harness.latest().captions.map((caption) => caption.text))
      .toEqual(["hello, who are you"]);
  });

  it("says nothing of its own while the CTO works", async () => {
    const order: string[] = [];
    let releaseBackend: () => void = () => {};
    const harness = createService({
      runBackendTurn: async () => {
        order.push("backend-started");
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "Three merged yesterday." };
      },
    });
    await openCall(harness);
    askCto(harness, "how many lanes do we have");
    await tick();

    // The acknowledgement is the MODEL's, said in the same turn as the call —
    // ADE has no line here, and a fixed filler is exactly what the owner hated.
    expect(spoken(harness.fake)).toEqual([]);
    expect(order).toEqual(["backend-started"]);
    expect(harness.latest().phase).toBe("thinking");
    releaseBackend();
  });

  it("hands the answer back as a function result and lets the model speak it", async () => {
    const harness = createService();
    await openCall(harness);
    askCto(harness, "how many lanes do we have");
    await tick();

    expect(functionOutputs(harness.fake))
      .toEqual([{ status: "ok", answer: "Three merged yesterday." }]);
    // Asked for IN the conversation, deliberately: the model has to see the
    // call it made in order to relay the answer to it.
    expect(modelResponses(harness.fake)).toBe(1);
    expect(spoken(harness.fake)).toEqual([]);
  });

  /**
   * Cheap and worth it: the facts in the context block are exactly the ones a
   * turn is most likely to have just changed, and a model answering "nine
   * lanes" straight after creating the tenth is worse than one that asks.
   */
  it("re-sends the context block after a completed ask_cto", async () => {
    let contexts = 0;
    const harness = createService({
      context: async () => `Who you are\n- Name: Ada (read ${(contexts += 1)})`,
    });
    await openCall(harness);
    expect(harness.fake.sent.filter((message) => message.type === "session.update")).toHaveLength(1);

    askCto(harness, "how many lanes do we have");
    await tick();
    await tick();

    const updates = harness.fake.sent.filter((message) => message.type === "session.update");
    expect(updates).toHaveLength(2);
    expect(String((updates[1]!.session as Record<string, unknown>).instructions))
      .toContain("- Name: Ada (read 2)");
  });

  it("does not refresh the context for a turn that was superseded", async () => {
    let contexts = 0;
    const release: Array<() => void> = [];
    const harness = createService({
      context: async () => `Who you are\n- Name: Ada (read ${(contexts += 1)})`,
      runBackendTurn: async ({ intent }: { intent: string }) => {
        if (intent.includes("first")) {
          await new Promise<void>((r) => release.push(r));
          return { spoken: "STALE" };
        }
        return { spoken: "FRESH" };
      },
    });
    await openCall(harness);
    askCto(harness, "the first question", { callId: "call_1" });
    await tick();
    askCto(harness, "the second question", { callId: "call_2" });
    await tick();
    await tick();
    release.forEach((fn) => fn());
    await tick();
    await tick();

    // One refresh, for the turn that actually answered.
    expect(harness.fake.sent.filter((message) => message.type === "session.update"))
      .toHaveLength(2);
  });

  /**
   * The two response shapes, and why they are not one.
   *
   * ADE's own lines must be read word for word, and inside the conversation the
   * user's audio outweighs the instruction: measured against the live API on
   * 2026-09-16, 6 of 8 in-conversation read-alouds were hijacked into
   * self-answers ("I'm ChatGPT…") and out-of-band read 24 of 24 word for word.
   * A function result is the opposite case — out-of-band it would be generated
   * with no conversation at all, so the model would have nothing to relay.
   */
  it("keeps ADE's own lines out-of-band and the function result in conversation", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    const ade = harness.fake.sent
      .filter((message) => message.type === "response.create")
      .map((message) => message.response as Record<string, unknown> | undefined)
      .filter((response): response is Record<string, unknown> => response !== undefined);
    expect(ade).toHaveLength(1);
    expect(ade[0]!.conversation).toBe("none");
    expect(ade[0]!.input).toEqual([]);
    expect(String(ade[0]!.instructions)).toContain("word for word");

    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    askCto(harness, "how many lanes do we have");
    await tick();
    expect(modelResponses(harness.fake)).toBe(1);
  });


  it("stops the running work on cancel_work, and says nothing_running when there is none", async () => {
    const seenSignal: { current: AbortSignal | null } = { current: null };
    let releaseBackend: () => void = () => {};
    const harness = createService({
      runBackendTurn: async ({ signal }) => {
        seenSignal.current = signal;
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "STALE ANSWER" };
      },
    });
    await openCall(harness);
    askCto(harness, "run the tests");
    await tick();
    expect(seenSignal.current?.aborted).toBe(false);

    callTool(harness, "cancel_work", "call_cancel");
    await tick();
    expect(seenSignal.current?.aborted).toBe(true);
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "cancelled" });
    expect(harness.latest().phase).toBe("listening");

    releaseBackend();
    await tick();
    // The stale answer answers its own call so the conversation is not left
    // dangling, and nobody is asked to speak about it.
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "superseded", answer: "" });
    expect(modelResponses(harness.fake)).toBe(1);

    callTool(harness, "cancel_work", "call_cancel_2");
    await tick();
    expect(functionOutputs(harness.fake).at(-1)).toEqual({ status: "nothing_running" });
  });


  it("asks the CTO exactly what the model passed, in the user's own words", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    askCto(harness, "what is the status of the PRs");
    await tick();
    expect(seen).toEqual(["what is the status of the PRs"]);
  });

  it("refuses an empty request rather than asking the CTO nothing", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    harness.fake.receive({
      type: "response.done",
      response: {
        id: "resp_fn",
        status: "completed",
        output: [{ type: "function_call", name: "ask_cto", call_id: "call_1", arguments: "{}" }],
      },
    });
    await tick();
    expect(seen).toEqual([]);
    expect(functionOutputs(harness.fake)[0]).toMatchObject({ status: "failed" });
  });


  it("says it did not catch a turn the transcriber could not read", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    await tick();

    // No turn was burned on a question nobody could read...
    expect(seen).toEqual([]);
    // ...and the call did not simply go quiet.
    expect(spoken(harness.fake).join("\n")).toContain("didn't catch that");
  });

  it("holds a mutation behind a confirmation instead of running it", async () => {
    // The confirmation comes from the CTO thread's own approval — the turn is
    // parked inside `canUseTool` — not from a field on the turn's result.
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });

    expect(harness.latest().phase).toBe("confirming");
    expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(harness.latest().pendingConfirmation?.destructive).toBe(false);
  });

  it("drops a replaced answer instead of speaking it over the next one", async () => {
    // The user asks, then corrects themselves. The model calls `ask_cto` again
    // with `mode: "replace"`; the first turn is still running, and when it
    // finishes its answer is to a question the user has moved on from. Reading
    // the abort flag off the module binding asked the WRONG controller — by
    // then it named the replacing turn — so the stale answer was spoken over
    // the live one.
    const release: Array<() => void> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      runBackendTurn: async ({ intent }) => {
        if (intent.includes("first")) {
          await new Promise<void>((r) => release.push(r));
          return { spoken: "STALE ANSWER" };
        }
        return { spoken: "FRESH ANSWER" };
      },
    });
    await openCall(harness);

    askCto(harness, "the first question", { callId: "call_1" });
    await tick();
    askCto(harness, "no wait, the second question", { callId: "call_2", mode: "replace" });
    await tick();

    // The first turn only finishes now, after it was replaced.
    release.forEach((fn) => fn());
    await tick();

    const results = functionOutputs(harness.fake);
    expect(results).toContainEqual({ status: "ok", answer: "FRESH ANSWER" });
    expect(JSON.stringify(results)).not.toContain("STALE ANSWER");
    // The superseded call is still answered — an unanswered `function_call` sits
    // in the conversation forever — and nobody is asked to speak about it.
    expect(results).toContainEqual({ status: "superseded", answer: "" });
    expect(modelResponses(harness.fake)).toBe(1);
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
    const harness = createService();
    await openCall(harness);
    harness.service.setMuted(true);
    harness.fake.sent.length = 0;
    harness.service.pushAudio("AAAA");
    expect(harness.fake.typesSent()).not.toContain("input_audio_buffer.append");
    harness.service.setMuted(false);
    harness.service.pushAudio("AAAA");
    expect(harness.fake.typesSent()).toContain("input_audio_buffer.append");
  });
});


/**
 * The CTO row's second line, during a call and after it.
 *
 * The owner watched it read "hey there?" while the call moved on through several
 * exchanges: the generated status line takes a model round trip per settled turn
 * and a spoken turn takes one second. A call therefore reports its own progress.
 */
describe("what a call tells the CTO row", () => {
  it("counts exchanges as they happen, and closes with the truth", async () => {
    const reports: Array<{ exchanges: number; live: boolean }> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      onExchange: (args: { exchanges: number; live: boolean }) => reports.push(args),
    });
    await openCall(harness);

    utter(harness, "hey there");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    utter(harness, "what is this project");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    utter(harness, "what should I do next");
    await tick();

    expect(reports).toEqual([
      { exchanges: 1, live: true },
      { exchanges: 2, live: true },
      { exchanges: 3, live: true },
    ]);

    await harness.service.end();
    expect(reports.at(-1)).toEqual({ exchanges: 3, live: false });
  });

  /**
   * An exchange is a transcript with words in it, and nothing else.
   *
   * The meter used to decide this too, and on the call of 2026-09-16 it
   * subtracted three sentences the user really said from a count the CTO row
   * shows them. Silence the transcriber wrote punctuation for is still not an
   * exchange, because there is nothing in it.
   */
  it("counts every transcript with words in it, and nothing without", async () => {
    const reports: Array<{ exchanges: number; live: boolean }> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: { info: vi.fn(), warn: vi.fn() },
      onExchange: (args: { exchanges: number; live: boolean }) => reports.push(args),
    });
    await openCall(harness);

    utter(harness, "hey there");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    // A sentence the meter did not hear is still a sentence the user said.
    utter(harness, "what's going on", { level: 0 });
    await tick();
    utter(harness, " … ");
    await tick();

    expect(reports).toEqual([{ exchanges: 1, live: true }, { exchanges: 2, live: true }]);
  });

  it("reads as one exchange in the singular, and as none before anything is said", async () => {
    expect(ctoVoiceStatusLine({ exchanges: 0, live: true })).toBe("Voice call");
    expect(ctoVoiceStatusLine({ exchanges: 1, live: true })).toBe("Voice call · 1 exchange");
    expect(ctoVoiceStatusLine({ exchanges: 4, live: true })).toBe("Voice call · 4 exchanges");
    expect(ctoVoiceStatusLine({ exchanges: 0, live: false })).toBe("Voice call ended");
    expect(ctoVoiceStatusLine({ exchanges: 2, live: false }))
      .toBe("Voice call ended · 2 exchanges");
  });
});

/**
 * The words appearing as they are heard.
 *
 * A final transcript can land seconds after the sentence, and on the call of
 * 2026-09-16 the owner repeated themselves into a HUD that showed nothing until
 * it did.
 */
describe("the live partial caption", () => {
  it("shows what is being heard, and clears it when the transcript lands", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "what merged",
    });
    expect(harness.latest().pendingUserText).toBe("what merged");
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.delta",
      delta: " yesterday",
    });
    expect(harness.latest().pendingUserText).toBe("what merged yesterday");

    hearMic(harness);
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "what merged yesterday",
    });
    await tick();

    expect(harness.latest().pendingUserText).toBeNull();
    expect(harness.latest().captions.map((caption) => caption.text))
      .toEqual(["what merged yesterday"]);
  });

  it("clears the partial when the transcription fails", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "what mer",
    });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    await tick();

    expect(harness.latest().pendingUserText).toBeNull();
  });

  /**
   * Some surfaces deliver a transcript as one `.completed` with no deltas at
   * all, and nothing about the captions may depend on the deltas arriving.
   */
  it("changes nothing when the API sends no deltas", async () => {
    const harness = createService();
    await openCall(harness);

    utter(harness, "what merged yesterday");
    await tick();

    expect(harness.latest().pendingUserText).toBeNull();
    expect(harness.latest().captions.map((caption) => caption.text))
      .toEqual(["what merged yesterday"]);
  });
});

/**
 * A call the CTO can end.
 *
 * On the call of 2026-09-16 the user said "close yourself now" and the model
 * answered that it could not — there was no tool for it, so the only way out of
 * a call was the End button.
 */
describe("end_call", () => {
  /** The audio one second of PCM16 at the session rate is carried in. */
  const ONE_SECOND_OF_AUDIO = Buffer.alloc(CTO_VOICE_SAMPLE_RATE * 2).toString("base64");

  function endCallOnWire(harness: ReturnType<typeof createService>) {
    harness.fake.receive({
      type: "response.done",
      response: {
        id: "resp_bye",
        status: "completed",
        output: [{ type: "function_call", name: "end_call", call_id: "call_bye", arguments: "{}" }],
      },
    });
  }

  it("says goodbye, waits for the audio, then ends the call as a normal ending", async () => {
    vi.useFakeTimers();
    try {
      const ended: string[] = [];
      const harness = createService({
        logger: {
          info: (event: string, meta?: unknown) => {
            if (event === "cto_voice.call_end") ended.push(String((meta as { reason?: unknown }).reason));
          },
          warn: vi.fn(),
        },
      });
      await openCall(harness);

      // The goodbye is spoken in the same response the call arrives in, so its
      // audio is already on the wire when the call is dispatched.
      harness.fake.receive({ type: "response.created", response: { id: "resp_bye" } });
      harness.fake.receive({ type: "response.output_audio.delta", delta: ONE_SECOND_OF_AUDIO });
      endCallOnWire(harness);
      await vi.advanceTimersByTimeAsync(0);

      // The call answers its own function call and does not ask for a second
      // response to talk over the goodbye.
      const outputs = harness.fake.sent.filter((message) => {
        const item = message.item as { type?: unknown } | undefined;
        return item?.type === "function_call_output";
      });
      expect(outputs).toHaveLength(1);

      // Still up while the goodbye is playing: hanging up on `response.done`
      // cuts the one sentence the user is guaranteed to be listening to.
      expect(harness.latest().phase).not.toBe("ended");
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.latest().phase).not.toBe("ended");

      await vi.advanceTimersByTimeAsync(100 + CTO_VOICE_END_CALL_AUDIO_TAIL_MS);
      expect(harness.latest().phase).toBe("ended");
      expect(harness.latest().error).toBeNull();
      expect(ended).toEqual(["assistant_end"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends after the tail alone when the model said goodbye without audio", async () => {
    vi.useFakeTimers();
    try {
      const harness = createService();
      await openCall(harness);

      endCallOnWire(harness);
      await vi.advanceTimersByTimeAsync(CTO_VOICE_END_CALL_AUDIO_TAIL_MS + 1);

      expect(harness.latest().phase).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms one hang-up however many times the model asks for it", async () => {
    vi.useFakeTimers();
    try {
      const persistCall = vi.fn(async () => {});
      const harness = createService({ persistCall });
      await openCall(harness);

      endCallOnWire(harness);
      harness.fake.receive({
        type: "response.function_call_arguments.done",
        name: "end_call",
        call_id: "call_bye_2",
        arguments: "{}",
      });
      await vi.advanceTimersByTimeAsync(CTO_VOICE_END_CALL_AUDIO_TAIL_MS + 1);

      expect(persistCall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A caption that was cut off says so.
 *
 * A barge-in truncates the response mid-word and the transcript that arrives is
 * whatever had been said — "I'm the CTO" for a sentence going somewhere else —
 * so the record has to carry the fact that the user stopped it.
 */
describe("an interrupted caption", () => {
  it("marks the assistant caption the user talked over", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "response.output_audio_transcript.delta", delta: "I'm" });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "response.output_audio_transcript.done",
      transcript: "I'm the CTO",
    });
    await tick();

    expect(harness.latest().captions.at(-1)).toMatchObject({
      role: "assistant",
      text: "I'm the CTO",
      interrupted: true,
    });
  });

  it("leaves an ordinary answer unmarked", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({
      type: "response.output_audio_transcript.done",
      transcript: "Three merged yesterday.",
    });
    await tick();

    expect(harness.latest().captions.at(-1)?.interrupted).toBeUndefined();
  });
});


/** Words, or a transcriber filling silence with punctuation. */
describe("ctoVoiceTranscriptHasSpeech", () => {
  it("counts letters and digits in any script, and nothing else", () => {
    expect(ctoVoiceTranscriptHasSpeech("what merged yesterday")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("好好好")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("아니")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("3")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("")).toBe(false);
    expect(ctoVoiceTranscriptHasSpeech("   ")).toBe(false);
    expect(ctoVoiceTranscriptHasSpeech("…")).toBe(false);
    expect(ctoVoiceTranscriptHasSpeech(" ... !? ")).toBe(false);
  });
});


describe("a question raised before the socket opened", () => {
  it("is still asked out loud once the session exists", async () => {
    // `watchApprovals` is attached before the connection is made, so a tool
    // that asks during the handshake has a question waiting with nowhere to go.
    const harness = createService();
    await harness.service.start();
    harness.service.raiseApproval({
      itemId: "item-early",
      toolName: "openPr",
      prompt: "Open a pull request?",
    });
    expect(harness.fake.typesSent()).toEqual([]);

    harness.fake.open();
    const asked = harness.fake.sent
      .filter((message) => message.type === "response.create")
      .map((message) => String((message.response as { instructions?: unknown }).instructions ?? ""));
    expect(asked.join("\n")).toContain("Open a pull request?");
  });
});

/**
 * What must not survive a hang-up.
 *
 * A call is a socket, a lock, a queue and four flags, and every one of them
 * used to outlive the call that made it: `ws` delivers whatever it had already
 * queued after the close, and nothing detached the message listener.
 */
describe("a call that is over", () => {
  it("does not start a CTO turn for a function call delivered after hang-up", async () => {
    const runBackendTurn = vi.fn(async () => ({ spoken: "too late" }));
    const harness = createService({ runBackendTurn });
    await openCall(harness);
    await harness.service.end("owner_end");

    // Exactly what `ws` does with the frames it had already buffered.
    askCto(harness, "what merged yesterday");
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      response_id: "resp_late",
      call_id: "call_late",
      name: "ask_cto",
      arguments: JSON.stringify({ request: "and this one", mode: "queue" }),
    });
    await tick();

    expect(runBackendTurn).not.toHaveBeenCalled();
  });

  it("leaves the next call no opinion about a response it never created", async () => {
    // The queue's `pendingOurs` is set on the send and cleared on
    // `response.created`, a round trip later. A hang-up in that gap must not
    // carry it into the next call: there it would make the FIRST server
    // response look like one of ADE's own, and the first barge-in would cancel
    // a response the server was already truncating itself.
    const sockets = [createFakeSocket(), createFakeSocket()];
    let index = 0;
    const harness = createService({ createWebSocket: () => sockets[index++]!.socket });

    await harness.service.start();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "session.created", session: { id: "sess_1" } });
    // A line ADE asked for and the server never named.
    harness.service.raiseApproval({
      itemId: "item-1",
      toolName: "openPr",
      prompt: "Open a pull request?",
    });
    expect(sockets[0]!.typesSent()).toContain("response.create");
    await harness.service.end("owner_end");

    await harness.service.start();
    sockets[1]!.open();
    sockets[1]!.receive({ type: "session.created", session: { id: "sess_2" } });
    // The server's own response, and the user talking over it.
    sockets[1]!.receive({ type: "response.created", response: { id: "resp_server" } });
    sockets[1]!.receive({ type: "input_audio_buffer.speech_started" });

    expect(sockets[1]!.typesSent()).not.toContain("response.cancel");
  });
});


describe("the scene on the HUD", () => {
  it("belongs to the answer being spoken, and is cleared by one that drew nothing", async () => {
    const answers = [
      { spoken: "Here is what I drew.", sceneSource: "<p>chart</p>" },
      { spoken: "Three merged yesterday." },
    ];
    const harness = createService({ runBackendTurn: async () => answers.shift()! });
    await openCall(harness);

    askCto(harness, "show me the prs", { callId: "call_1", responseId: "resp_1" });
    await tick();
    expect(harness.latest().sceneSource).toBe("<p>chart</p>");

    askCto(harness, "and what merged", { callId: "call_2", responseId: "resp_2" });
    await tick();
    // The picture from four turns ago used to stay on screen for the rest of
    // the call, because only a result WITH a scene ever wrote this field.
    expect(harness.latest().sceneSource).toBeNull();
  });
});

describe("the interrupted flag", () => {
  it("falls back between utterances, so the next barge-in is still an edge", async () => {
    // The runtime drops its queued output audio on the false→true EDGE. A flag
    // left true by an earlier barge-in makes the next one drop nothing at all,
    // and the CTO carries on over the user with twenty seconds of stale answer.
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(true);

    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio was unintelligible" },
    });
    expect(harness.latest().interrupted).toBe(false);
  });

  it("falls back when a transcript arrives with no words in it at all", async () => {
    // The empty-transcript path must clear the interrupted flag before it
    // returns, or a second barge-in has no false→true edge and the runtime
    // keeps the stale answer queued and talks over the user with it.
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(true);

    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "...",
    });
    expect(harness.latest().interrupted).toBe(false);
  });

  it("falls back when the next utterance opens over nothing", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(true);
    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_1", status: "completed", output: [] },
    });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(false);
  });
});

describe("a picture already on the HUD", () => {
  it("survives a turn that failed, because that turn drew nothing of its own", async () => {
    const answers: CtoVoiceBackendResult[] = [
      { spoken: "Here is what I drew.", sceneSource: "<p>chart</p>" },
      { spoken: "", status: "failed", reason: "The CTO could not be reached." },
    ];
    const harness = createService({ runBackendTurn: async () => answers.shift()! });
    await openCall(harness);

    askCto(harness, "show me the prs", { callId: "call_1", responseId: "resp_1" });
    await tick();
    expect(harness.latest().sceneSource).toBe("<p>chart</p>");

    // The status is read before the scene is blanked: a turn that never
    // answered must not take away the chart the user is still reading.
    askCto(harness, "and the checks", { callId: "call_2", responseId: "resp_2" });
    await tick();
    expect(harness.latest().sceneSource).toBe("<p>chart</p>");
  });
});


/* --- Two requests at once — the ask queue the call service owns. --- */

/**
 * Two requests at once, and who decides what happens to the first.
 *
 * Both used to be lost: the second one's `runSessionTurn` was attempted before
 * the first had been interrupted, threw "Session already has an active
 * background turn", and the abort landed three milliseconds later. The user
 * heard that the CTO could not be reached, twice.
 */
describe("two requests at once", () => {
  /**
   * A harness whose backend records when each turn starts and finishes, and
   * releases them one at a time.
   */
  function createSerialHarness() {
    const events: string[] = [];
    const release = new Map<string, () => void>();
    const harness = createService({
      backchannelsEnabled: () => false,
      runBackendTurn: async ({ intent, signal }) => {
        const name = intent.split(" ")[0] ?? intent;
        events.push(`start:${name}`);
        await new Promise<void>((resolve) => release.set(name, resolve));
        events.push(`end:${name}`);
        if (signal.aborted) return { spoken: "", status: "interrupted" as const };
        return { spoken: `${name} answer` };
      },
    });
    return {
      ...harness,
      events,
      finish: async (name: string) => {
        release.get(name)?.();
        await tick();
      },
    };
  }

  it("replaces the running request, and does not start the new one until it has unwound", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A the open PRs", { callId: "call_a" });
    await tick();
    expect(harness.events).toEqual(["start:A"]);

    askCto(harness, "B no wait the merged ones", { callId: "call_b", mode: "replace" });
    await tick();
    // The correction does NOT start here. The aborted turn is still unwinding
    // on the one CTO session, and starting on top of it is the bug.
    expect(harness.events).toEqual(["start:A"]);

    await harness.finish("A");
    expect(harness.events).toEqual(["start:A", "end:A", "start:B"]);

    await harness.finish("B");
    const results = functionOutputs(harness.fake);
    expect(results).toContainEqual({ status: "superseded", answer: "" });
    expect(results).toContainEqual({ status: "ok", answer: "B answer" });
    // Only the surviving answer is spoken about.
    expect(modelResponses(harness.fake)).toBe(1);
  });

  it("queues an additional request and answers both, in order", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A the open PRs", { callId: "call_a" });
    await tick();
    askCto(harness, "B run the tests", { callId: "call_b", mode: "queue" });
    await tick();
    // Queued, not started: the CTO thread is one session.
    expect(harness.events).toEqual(["start:A"]);

    await harness.finish("A");
    expect(harness.events).toEqual(["start:A", "end:A", "start:B"]);
    // A's answer is being relayed; one response at a time, so B's relay waits
    // for it exactly as any other queued response does.
    expect(modelResponses(harness.fake)).toBe(1);
    await harness.finish("B");
    harness.fake.receive({ type: "response.done", response: { id: "resp_relay_a", status: "completed", output: [] } });
    await tick();

    expect(functionOutputs(harness.fake)).toEqual([
      { status: "ok", answer: "A answer" },
      { status: "ok", answer: "B answer" },
    ]);
    // Each answer is relayed on its own, as it lands.
    expect(modelResponses(harness.fake)).toBe(2);
  });

  it("refuses a third waiting request rather than stacking it", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    askCto(harness, "B two", { callId: "call_b", mode: "queue" });
    askCto(harness, "C three", { callId: "call_c", mode: "queue" });
    askCto(harness, "D four", { callId: "call_d", mode: "queue" });
    await tick();

    const busy = functionOutputs(harness.fake).filter((row) => row.status === "busy");
    expect(busy).toHaveLength(1);
    expect(String(busy[0]!.reason)).toContain("already waiting");
    expect(harness.events).toEqual(["start:A"]);
  });

  it("treats a request with no usable mode as an additional one", async () => {
    // Nothing is thrown away by guessing "queue": the worst case is an answer
    // a few seconds late. Guessing "replace" throws a running turn's work out.
    const harness = createSerialHarness();
    await openCall(harness);
    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    harness.fake.receive({
      type: "response.done",
      response: {
        id: "resp_nomode",
        status: "completed",
        output: [{
          type: "function_call",
          name: "ask_cto",
          call_id: "call_b",
          arguments: JSON.stringify({ request: "B two" }),
        }],
      },
    });
    await tick();
    expect(harness.events).toEqual(["start:A"]);
    await harness.finish("A");
    expect(harness.events).toContain("start:B");
    await harness.finish("B");
  });

  it("cancel_work stops the running request and drops the queue", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    askCto(harness, "B two", { callId: "call_b", mode: "queue" });
    await tick();

    callTool(harness, "cancel_work", "call_cancel");
    await tick();
    // The queued one is answered immediately — an unanswered `function_call`
    // sits in the conversation forever — and never runs.
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "cancelled", answer: "" });

    await harness.finish("A");
    expect(harness.events).toEqual(["start:A", "end:A"]);
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "cancelled" });
  });

  /**
   * Hang-up stops the queue, not just the turn that is running.
   *
   * The drain loop reads the queue again the moment the aborted turn unwinds,
   * which is after the call is over: a request left there is a full CTO turn —
   * its own session, its own tools — run for a call the user has hung up.
   */
  it("a queued request does not run after hang-up", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    askCto(harness, "B two", { callId: "call_b", mode: "queue" });
    await tick();
    expect(harness.events).toEqual(["start:A"]);

    await harness.service.end("owner_end");
    // The aborted turn unwinds AFTER the call ended, which is where the loop
    // picks the queue back up.
    await harness.finish("A");

    expect(harness.events).toEqual(["start:A", "end:A"]);
  });

  /**
   * A new call does not inherit the last one's drain loop.
   *
   * The loop's "I own this" flag lives on the per-call record, so a new call
   * clears it while the old loop is still awaiting an aborted turn. The new
   * call then starts a loop of its own, the old one wakes up on the new call's
   * queue, and two turns run on the one CTO session.
   */
  it("a new call does not start a second drain loop", async () => {
    const events: string[] = [];
    const release = new Map<string, () => void>();
    const sockets = [createFakeSocket(), createFakeSocket()];
    let index = 0;
    const harness = createService({
      backchannelsEnabled: () => false,
      createWebSocket: () => sockets[index]!.socket,
      runBackendTurn: async ({ intent, signal }) => {
        const name = intent.split(" ")[0] ?? intent;
        events.push(`start:${name}`);
        await new Promise<void>((resolve) => release.set(name, resolve));
        events.push(`end:${name}`);
        if (signal.aborted) return { spoken: "", status: "interrupted" as const };
        return { spoken: `${name} answer` };
      },
    });
    const first = { ...harness, fake: sockets[0]! };
    await openCall(first);
    askCto(first, "A one", { callId: "call_a" });
    await tick();
    await harness.service.end("owner_end");

    index = 1;
    const second = { ...harness, fake: sockets[1]! };
    await openCall(second);
    askCto(second, "B two", { callId: "call_b" });
    await tick();
    askCto(second, "C three", { callId: "call_c", mode: "queue" });
    await tick();
    expect(events).toEqual(["start:A", "start:B"]);

    // The first call's loop wakes up here, with the second call's queue in
    // front of it and that call's own turn still running.
    release.get("A")?.();
    await tick();

    expect(events).toEqual(["start:A", "start:B", "end:A"]);
    release.get("B")?.();
    await tick();
    await harness.service.end("owner_end");
  });
});

it("accepts a spoken yes from the utterance after the question", async () => {
  const harness = createService();
  await openCall(harness);

  utter(harness, "open a pr for the sync lane");
  await tick();
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
  expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");

  utter(harness, "yes");
  await tick();
  expect(harness.latest().pendingConfirmation).toBeNull();
});

it("never lets the utterance that raised a question also answer it", async () => {
  const harness = createService();
  await openCall(harness);

  // One utterance that both asks and sounds like consent. The approval lands
  // while that turn is still open, so it is bound to the same utterance id.
  harness.fake.receive({ type: "input_audio_buffer.speech_started" });
  hearMic(harness);
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
  harness.fake.receive({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "open a pr, yes do it",
  });
  await tick();
  expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
});

it("refuses a second ask_cto while one is parked on a confirmation", async () => {
  // The turn that raised the question is still inside `canUseTool`. A second
  // turn on the same session would collide with it, so the model is told the
  // seam is busy rather than being allowed to open one.
  const intents: string[] = [];
  const harness = createService({
    runBackendTurn: async ({ intent }) => { intents.push(intent); return { spoken: "ok" }; },
  });
  await openCall(harness);
  askCto(harness, "open a pr for the sync lane", { callId: "call_1" });
  await tick();
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request?" });

  askCto(harness, "what time is it", { callId: "call_2" });
  await tick();

  expect(intents).toEqual(["open a pr for the sync lane"]);
  expect(functionOutputs(harness.fake).at(-1)).toMatchObject({ status: "busy", answer: "" });
  expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
});

/**
 * Two things hear the same "yes" now: the transcript parser, and the model
 * calling `approve_pending_action`. Whichever lands first decides; the second
 * must be a no-op rather than a second decision on a gate that is already open.
 */
it("lets the model approve a pending action, once, however many hear the yes", async () => {
  const resolved: Array<{ itemId: string; approved: boolean }> = [];
  const harness = createService({
    resolveApproval: async (args: { itemId: string; approved: boolean }) => { resolved.push(args); },
  });
  await openCall(harness);
  harness.fake.receive({ type: "input_audio_buffer.speech_started" });
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request?" });
  // The model is told, silently, that a question is open — without that it
  // hears the user say "yes" to nothing it can see.
  const note = harness.fake.sent
    .filter((message) => message.type === "conversation.item.create")
    .map((message) => JSON.stringify(message.item))
    .join("\n");
  expect(note).toContain("approve_pending_action");

  callTool(harness, "approve_pending_action", "call_a");
  await tick();
  // And again, as the parser would: the same spoken word, heard twice.
  utter(harness, "yes");
  await tick();

  expect(resolved).toEqual([{ itemId: "item-1", approved: true }]);
  expect(functionOutputs(harness.fake)).toContainEqual({ status: "ok" });
});

it("will not let the model approve a destructive action either", async () => {
  const resolved: Array<{ itemId: string; approved: boolean }> = [];
  const harness = createService({
    resolveApproval: async (args: { itemId: string; approved: boolean }) => { resolved.push(args); },
  });
  await openCall(harness);
  harness.fake.receive({ type: "input_audio_buffer.speech_started" });
  harness.service.raiseApproval({
    itemId: "item-1",
    toolName: "gitForcePush",
    prompt: "Force-push ade/sync-fix?",
  });

  callTool(harness, "approve_pending_action", "call_a");
  await tick();

  expect(resolved).toEqual([]);
  expect(harness.latest().pendingConfirmation?.id).toBeTruthy();
  expect(functionOutputs(harness.fake).at(-1)).toMatchObject({ status: "needs_tap" });
});


/* --- The transcript burst valve (ctoVoiceTurnBurst.ts). --- */

/**
 * The gate exists for one thing: a transcript source that runs away must not be
 * able to answer a permission question. What matters about it is therefore not
 * that it shuts, but that it opens again — a valve that latches shut turns every
 * later spoken yes into "runaway" for the rest of the call.
 */
describe("the transcript burst valve", () => {
  function createValve() {
    const events: string[] = [];
    let clock = 1_000;
    const valve = createTranscriptBurstValve({
      now: () => clock,
      log: (event) => events.push(event),
    });
    return {
      valve,
      events,
      advance: (ms: number) => { clock += ms; },
      at: () => clock,
    };
  }

  it("lets an ordinary conversation through", () => {
    const { valve, advance, at } = createValve();
    for (let turn = 0; turn < CTO_VOICE_TURN_BURST_LIMIT; turn += 1) {
      expect(valve.isShut()).toBe(false);
      valve.noteAccepted(at());
      advance(1_000);
    }
    expect(valve.isShut()).toBe(false);
  });

  it("shuts once more turns than the limit are accepted inside the window", () => {
    const { valve, events, advance, at } = createValve();
    for (let turn = 0; turn <= CTO_VOICE_TURN_BURST_LIMIT; turn += 1) {
      valve.isShut();
      valve.noteAccepted(at());
      advance(10);
    }

    expect(valve.isShut()).toBe(true);
    expect(events).toEqual(["cto_voice.transcript_valve_tripped"]);
  });

  it("opens again after a quiet stretch, whether or not a question is open", () => {
    const { valve, events, advance, at } = createValve();
    for (let turn = 0; turn <= CTO_VOICE_TURN_BURST_LIMIT; turn += 1) {
      valve.isShut();
      valve.noteAccepted(at());
      advance(10);
    }
    expect(valve.isShut()).toBe(true);

    // Quiet is measured from the last transcript of ANY kind, including the one
    // the shut valve just refused.
    advance(CTO_VOICE_TURN_BURST_COOLDOWN_MS);
    expect(valve.isShut()).toBe(false);
    expect(events).toContain("cto_voice.transcript_valve_cleared");
    // And the run that shut it is forgotten, so the next turn does not re-trip it.
    valve.noteAccepted(at());
    expect(valve.isShut()).toBe(false);
  });

  it("forgets turns that fall out of the window", () => {
    const { valve, events, advance, at } = createValve();
    for (let turn = 0; turn <= CTO_VOICE_TURN_BURST_LIMIT; turn += 1) {
      valve.isShut();
      valve.noteAccepted(at());
      advance(CTO_VOICE_TURN_BURST_WINDOW_MS);
    }

    expect(valve.isShut()).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not let one call's burst shut the next call's gate", () => {
    const { valve, advance, at } = createValve();
    for (let turn = 0; turn <= CTO_VOICE_TURN_BURST_LIMIT; turn += 1) {
      valve.isShut();
      valve.noteAccepted(at());
      advance(10);
    }
    expect(valve.isShut()).toBe(true);

    valve.reset();

    expect(valve.isShut()).toBe(false);
  });

  /**
   * Quiet is measured off the last transcript, and an empty transcript is not
   * one: a transcriber that keeps emitting silence would otherwise restart the
   * cooldown on every hiccup and latch the gate shut for the rest of the call —
   * with no spoken yes able to answer a permission question again.
   */
  it("does not let empty transcripts hold the cooldown open", async () => {
    let clock = 1_000;
    const events: string[] = [];
    const harness = createService({
      now: () => clock,
      logger: {
        info: (event: string) => events.push(event),
        warn: () => {},
      },
    });
    await openCall(harness);

    for (let turn = 0; turn <= CTO_VOICE_TURN_BURST_LIMIT; turn += 1) {
      utter(harness, `turn ${turn}`);
      clock += 10;
    }
    expect(events).toContain("cto_voice.transcript_valve_tripped");

    // Half the cooldown of quiet, one transcript with nothing in it, then the
    // rest of the cooldown. The silence is still silence.
    clock += CTO_VOICE_TURN_BURST_COOLDOWN_MS / 2;
    utter(harness, "...");
    clock += CTO_VOICE_TURN_BURST_COOLDOWN_MS / 2 + 10;
    utter(harness, "yes");

    expect(events).toContain("cto_voice.transcript_valve_cleared");
  });
});


/* --- The function-call ledger (ctoVoiceToolCalls.ts). --- */

describe("a call the model made", () => {
  /**
   * A function result may only be written once the response that asked for it
   * is finished. The fast tools answer a beat before that — they are dispatched
   * off `response.function_call_arguments.done` — and an output naming a
   * `call_id` the conversation has not finished writing is refused.
   */
  it("holds a function result until the response that asked for it is done", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "response.created", response: { id: "resp_fn" } });
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      name: "cancel_work",
      call_id: "call_c",
      arguments: "{}",
    });
    expect(functionOutputs(harness.fake)).toEqual([]);

    harness.fake.receive({ type: "response.done", response: { id: "resp_fn", status: "completed" } });
    expect(functionOutputs(harness.fake)).toEqual([{ status: "nothing_running" }]);
  });

  /**
   * The same call arrives twice: once as `response.function_call_arguments.done`
   * and again inside `response.done`'s output list. Both are handled, because
   * which one a surface sends is not a thing to guess at — so the `call_id` is
   * what stops one request running the CTO twice.
   */
  it("runs one function call exactly once, however many times it is delivered", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      name: "ask_cto",
      call_id: "call_1",
      arguments: JSON.stringify({ request: "how many lanes" }),
    });
    askCto(harness, "how many lanes", { callId: "call_1" });
    await tick();
    expect(seen).toEqual(["how many lanes"]);
  });

  /**
   * A turn can outlive the call it was asked on: the user hangs up, the CTO
   * session keeps unwinding, and by the time it does the user has called back
   * and the socket is a DIFFERENT realtime session. Its `superseded` answer
   * still names the old call id, which the new session never wrote — and an
   * output naming an unknown `call_id` is refused, taking the new call with it.
   */
  it("does not answer a call id the new session never heard of", async () => {
    const turn: { finish?: (result: CtoVoiceBackendResult) => void } = {};
    const harness = createService({
      runBackendTurn: () => new Promise<CtoVoiceBackendResult>((resolve) => { turn.finish = resolve; }),
    });
    await openCall(harness);
    askCto(harness, "what merged yesterday", { callId: "call_old" });
    await tick();

    await harness.service.end("owner_end");
    await harness.service.start();
    harness.fake.open();
    harness.fake.receive({ type: "session.created", session: { id: "sess_2" } });
    const answeredOnTheOldCall = functionOutputs(harness.fake).length;

    // Not `finish?.()`: if the backend turn never ran, the assertion below
    // would hold for the wrong reason and the test would prove nothing.
    expect(turn.finish).toBeDefined();
    turn.finish?.({ spoken: "Three merged yesterday." });
    await tick();

    expect(functionOutputs(harness.fake)).toHaveLength(answeredOnTheOldCall);
  });
});

describe("a function result waiting on the response that asked for it", () => {
  it("waits for ITS OWN response to finish, not for any response at all", async () => {
    const harness = createService();
    await openCall(harness);

    // The call arrives a beat before its own `response.done`, so the
    // conversation has not written it yet and its result has to wait.
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      response_id: "resp_tool",
      call_id: "call_tool",
      name: "cancel_work",
      arguments: "{}",
    });
    expect(functionOutputs(harness.fake)).toHaveLength(0);

    // A DIFFERENT response finishing says nothing about this call: the old code
    // cleared every unsettled id here and handed the result over early, where
    // OpenAI refuses it for naming a `call_id` it has not written.
    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_other", status: "completed", output: [] },
    });
    expect(functionOutputs(harness.fake)).toHaveLength(0);

    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_tool", status: "completed", output: [] },
    });
    expect(functionOutputs(harness.fake)).toHaveLength(1);
  });
});

describe("a response that finished without naming itself", () => {
  it("releases everything it was holding, rather than stranding it forever", async () => {
    const harness = createService();
    await openCall(harness);

    // The call names the response that made it, so its result waits.
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      response_id: "resp_tool",
      call_id: "call_tool",
      name: "cancel_work",
      arguments: "{}",
    });
    expect(functionOutputs(harness.fake)).toHaveLength(0);

    // A done with no `response.id` on it is the only done this call will ever
    // see for what it was generating. Matching on the id alone left the result
    // waiting for a name that was never coming, and the model went on referring
    // to a `function_call` it never saw answered.
    harness.fake.receive({ type: "response.done", response: { status: "completed", output: [] } });
    expect(functionOutputs(harness.fake)).toHaveLength(1);
  });
});


/* --- Turn timing records (ctoVoiceTurnTiming.ts). --- */

describe("a turn's timing record", () => {
  /**
   * One line per turn, and it has to name every leg — a call that feels slow is
   * a different bug depending on which of them is the seconds. The measured
   * failure it exists for: three to five seconds from an accepted transcript to
   * the CTO's first word, with no way to tell the transcriber's round trip from
   * ADE's own work from the model's.
   */
  it("writes one turn_timing line naming every leg of the wait", async () => {
    let clock = 1_000;
    const lines: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const harness = createService({
      now: () => clock,
      logger: {
        info: (event: string, meta?: unknown) => lines.push({
          event,
          meta: (meta ?? {}) as Record<string, unknown>,
        }),
        warn: () => {},
      },
      runBackendTurn: async () => {
        clock += 800;
        return { spoken: "Three merged yesterday.", firstTextMs: 500, toolCalls: 2 };
      },
    });
    await openCall(harness);

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    hearMic(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_stopped" });
    // The transcriber's own round trip: the one leg that is entirely OpenAI's.
    clock += 300;
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "what merged yesterday",
    });
    // The model heard the same words and decided this one needs the CTO.
    askCto(harness, "what merged yesterday");
    await tick();
    // Nothing has been heard yet — the line is not written until it has.
    expect(lines.filter((line) => line.event === "cto_voice.turn_timing")).toHaveLength(0);

    clock += 200;
    harness.fake.receive({ type: "response.output_audio.delta", delta: "AAAA" });

    const timing = lines.filter((line) => line.event === "cto_voice.turn_timing");
    expect(timing).toHaveLength(1);
    expect(timing[0]!.meta).toMatchObject({
      outcome: "spoken",
      speechStoppedToTranscriptMs: 300,
      acceptToTurnStartMs: 0,
      turnStartToFirstTextMs: 500,
      turnStartToBackendDoneMs: 800,
      firstSpeakToFirstAudioMs: 200,
      totalMs: 1_000,
      toolCalls: 2,
    });
  });

  it("still measures a turn that never made a sound", async () => {
    const lines: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const harness = createService({
      logger: {
        info: (event: string, meta?: unknown) => lines.push({
          event,
          meta: (meta ?? {}) as Record<string, unknown>,
        }),
        warn: () => {},
      },
      // A turn that answers with nothing. A timing line that only appears for
      // the happy path cannot tell you which turns were slow, so this one is
      // written too.
      runBackendTurn: async () => ({ spoken: "" }),
    });
    await openCall(harness);
    utter(harness, "never mind");
    askCto(harness, "never mind");
    await tick();

    const timing = lines.filter((line) => line.event === "cto_voice.turn_timing");
    expect(timing).toHaveLength(1);
    expect(timing[0]!.meta.outcome).toBe("silent");
    expect(timing[0]!.meta.firstSpeakToFirstAudioMs).toBeNull();
  });

  /**
   * A barge-in that merely stops the audio is not an abandoned turn. The live
   * call wrote `outcome: "abandoned"` for a request the CTO was still working
   * on twenty-five seconds later, purely because the user spoke again.
   */
  it("leaves a running turn's timing record open when the user talks over it", async () => {
    const lines: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const release: Array<() => void> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: {
        info: (event: string, meta?: unknown) => lines.push({
          event,
          meta: (meta ?? {}) as Record<string, unknown>,
        }),
        warn: () => {},
      },
      runBackendTurn: async () => {
        await new Promise<void>((resolve) => release.push(resolve));
        return { spoken: "Three merged yesterday." };
      },
    });
    await openCall(harness);

    utter(harness, "what merged yesterday");
    askCto(harness, "what merged yesterday", { callId: "call_a" });
    await tick();

    // The user thinks out loud while the work runs. Nothing is aborted.
    utter(harness, "actually never mind the ordering");
    await tick();
    const outcomes = () => lines
      .filter((line) => line.event === "cto_voice.turn_timing")
      .map((line) => String(line.meta.outcome));
    expect(outcomes()).not.toContain("abandoned");

    release.forEach((fn) => fn());
    await tick();
    harness.fake.receive({ type: "response.output_audio.delta", delta: "AAAA" });
    expect(outcomes()).toContain("spoken");
  });

  it("records a replaced turn as superseded, not abandoned", async () => {
    const lines: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: {
        info: (event: string, meta?: unknown) => lines.push({
          event,
          meta: (meta ?? {}) as Record<string, unknown>,
        }),
        warn: () => {},
      },
      runBackendTurn: async ({ signal }) => {
        if (signal.aborted) return { spoken: "", status: "interrupted" as const };
        await tick();
        return signal.aborted
          ? { spoken: "", status: "interrupted" as const }
          : { spoken: "ok" };
      },
    });
    await openCall(harness);
    askCto(harness, "A one", { callId: "call_a" });
    askCto(harness, "B two", { callId: "call_b", mode: "replace" });
    await tick();
    await tick();

    const outcomes = lines
      .filter((line) => line.event === "cto_voice.turn_timing")
      .map((line) => String(line.meta.outcome));
    expect(outcomes).toContain("superseded");
    expect(outcomes).not.toContain("abandoned");
  });

  /**
   * The last leg of a turn arrives after the turn is over, and a turn can be
   * still unwinding when the user calls back. Reading the call id at WRITE time
   * filed the slow turn that ended call one under call two, which is the one
   * thing that makes these lines unreadable: the call you are investigating
   * shows a turn that never happened on it.
   */
  it("files a record under the call it was opened on, not the call it is written on", () => {
    const lines: Array<Record<string, unknown>> = [];
    let callId = "call-1";
    const timings = createTurnTimingRecorder({
      now: () => 1_000,
      callId: () => callId,
      log: (line) => lines.push(line),
    });

    timings.open(1_000);
    const timing = timings.take();
    callId = "call-2";
    timings.close(timing, "superseded");

    expect(lines).toHaveLength(1);
    expect(lines[0].callId).toBe("call-1");
  });
});


/* --- The one-at-a-time response lock (ctoVoiceResponseQueue.ts). --- */

/**
 * One response at a time, and which side asked for it.
 *
 * The Realtime API allows exactly one response to be generating, so everything
 * ADE asks to have said goes through one lock. What these cases are about is
 * what happens at the edges of that lock: a line held behind a response in
 * flight, a barge-in that lands before the server has named what it is
 * cancelling, and a create the server refuses outright.
 */

describe("the response lock", () => {
  /**
   * One response at a time is an API rule, not a style choice: a second
   * `response.create` while one is generating is answered with an error instead
   * of with speech, so the line would simply never be heard.
   */
  it("holds one of ADE's own lines until the response in flight is over", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });

    expect(spoken(harness.fake)).toEqual([]);

    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    expect(spoken(harness.fake)).toHaveLength(1);
    expect(spoken(harness.fake)[0]).toContain("didn't catch that");
  });

  /**
   * Barge-in is split now, and this is the half that is NOT ours.
   *
   * The session runs with `interrupt_response: true`, so the server truncates
   * its own response the moment it hears speech — a round trip sooner than ADE
   * could, and sending our own cancel at it as well races that truncation and
   * comes back as "no active response".
   */
  it("leaves a server response for the server to truncate", async () => {
    const harness = createService();
    await openCall(harness);
    // A response the SERVER created: nothing ADE sent asked for it.
    harness.fake.receive({ type: "response.created", response: { id: "resp_model" } });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });

    expect(harness.fake.typesSent()).not.toContain("response.cancel");
    expect(harness.latest().interrupted).toBe(true);
  });

  /**
   * And this is the half that IS ours, and why the work behind it keeps going.
   *
   * Talking while the CTO works is ordinary on a hybrid call — a follow-up, or
   * thinking out loud — so killing the turn for it would make the call
   * unusable. Work stops two ways and only two: `cancel_work`, and a new
   * `ask_cto` superseding it.
   */
  it("stops ADE's own line but not the work behind it", async () => {
    const seenSignal: { current: AbortSignal | null } = { current: null };
    let releaseBackend: () => void = () => {};
    const harness = createService({
      runBackendTurn: async ({ signal }) => {
        seenSignal.current = signal;
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "An answer." };
      },
    });
    await openCall(harness);
    askCto(harness, "run the tests");
    await tick();
    // ADE says something of its own, and the server names that response.
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    harness.fake.receive({ type: "response.created", response: { id: "resp_ade" } });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });

    const cancel = harness.fake.lastOfType("response.cancel") as Record<string, unknown>;
    expect(cancel).toBeTruthy();
    // A cancel has to NAME the response: a bare one is understood as "cancel
    // the response in the DEFAULT conversation", where an out-of-band one never
    // is, and every barge-in failed silently while the CTO talked on.
    expect(cancel.response_id).toBe("resp_ade");
    expect(seenSignal.current?.aborted).toBe(false);
    expect(harness.latest().interrupted).toBe(true);
    // Still thinking, because the work is still running.
    expect(harness.latest().phase).toBe("thinking");

    // And a cancelled response releases the lock exactly like a completed one.
    harness.fake.receive({ type: "response.done", response: { status: "cancelled" } });
    releaseBackend();
    await tick();
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "ok", answer: "An answer." });
  });

  /**
   * `response.create` and `response.created` are a round trip apart, and the
   * user can talk inside it. Dropping the cancel there loses the one thing a
   * call must always honour, so it waits for the name instead.
   */
  it("holds a barge-in that arrived before the response had a name, and sends it when it does", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });

    // The line has been asked for, and the server has not named it yet.
    expect(harness.fake.typesSent()).toContain("response.create");
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.fake.typesSent()).not.toContain("response.cancel");

    harness.fake.receive({ type: "response.created", response: { id: "resp_late" } });

    const cancel = harness.fake.lastOfType("response.cancel") as Record<string, unknown>;
    expect(cancel).toBeTruthy();
    expect(cancel.response_id).toBe("resp_late");
    // And only once: the flag is cleared, so the next response is not cancelled
    // by an interruption the user already made.
    harness.fake.receive({ type: "response.done", response: { status: "cancelled" } });
    harness.fake.receive({ type: "response.created", response: { id: "resp_next" } });
    expect(harness.fake.sent.filter((message) => message.type === "response.cancel"))
      .toHaveLength(1);
  });

  it("does not cancel a response that is not running", async () => {
    // `response.cancel` with nothing in flight is an error event, and an error
    // event is a banner over a call that is working perfectly.
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.fake.typesSent()).not.toContain("response.cancel");
  });
});

/**
 * The two errors this service's own timing causes, and why they are not one.
 *
 * Both are benign and neither is worth a banner, but they say opposite things
 * about the response lock — and treating them the same burned the whole queue.
 */
describe("the benign server errors", () => {
  /** Two lines ADE wrote: one in flight, one behind it. */
  async function twoQueuedLines() {
    const harness = createService();
    await openCall(harness);
    harness.service.raiseApproval({ itemId: "a", toolName: "openPr", prompt: "First question?" });
    harness.service.raiseApproval({ itemId: "b", toolName: "openPr", prompt: "Second question?" });
    return harness;
  }

  it("releases the lock when a cancel arrived after the response was over", async () => {
    const harness = await twoQueuedLines();
    expect(spoken(harness.fake)).toHaveLength(1);

    harness.fake.receive({
      type: "error",
      error: { message: "Cancellation failed: no active response found" },
    });

    // The lock was stale, so the line waiting behind it goes now.
    expect(spoken(harness.fake).join("\n")).toContain("Second question?");
    expect(harness.latest().error).toBeNull();
  });

  it("keeps the line, and the lock, when the server is still generating", async () => {
    const harness = await twoQueuedLines();

    harness.fake.receive({
      type: "error",
      error: { message: "Conversation already has an active response" },
    });
    // Nothing else is sent into a server that just said it is busy.
    expect(spoken(harness.fake)).toHaveLength(1);

    // And when its own response finishes, the refused line is asked for again,
    // ahead of the one that was queued behind it.
    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_server", status: "completed", output: [] },
    });
    const asked = spoken(harness.fake);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("First question?");

    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_first", status: "completed", output: [] },
    });
    expect(spoken(harness.fake)[2]).toContain("Second question?");
  });
});

describe("a create the server refused", () => {
  function createQueue() {
    const sent: Array<Record<string, unknown>> = [];
    const queue = createResponseQueue({ send: (payload) => sent.push(payload), isOpen: () => true });
    return { queue, sent };
  }

  it("puts back exactly the line that was refused, and nothing else", () => {
    const { queue, sent } = createQueue();
    queue.speak("Shall I open the PR?");
    expect(sent).toHaveLength(1);

    queue.requeueRefused();
    // The lock is still real: nothing goes out until the response in flight is
    // over, and then the refused line — not a fresh one — is what is said.
    expect(sent).toHaveLength(1);
    queue.release();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toContain("Shall I open the PR?");
  });

  it("stops claiming the refusing response as ADE's own", () => {
    const { queue, sent } = createQueue();
    queue.speak("Shall I open the PR?");
    queue.requeueRefused();

    // The response that refused us is the SERVER's, and the server truncates
    // its own on a barge-in. Leaving the flag set had the next `response.created`
    // recorded as ADE's, and the barge-in then raced that truncation with a
    // cancel of its own.
    queue.noteCreated("resp_server");
    sent.length = 0;
    queue.stopSpeaking();
    expect(sent).toHaveLength(0);
  });
});
