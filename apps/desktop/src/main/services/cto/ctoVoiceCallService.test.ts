import { describe, expect, it, vi } from "vitest";
import type { CtoVoiceBackendResult } from "./ctoVoiceCallService";
import {
  CTO_VOICE_END_CALL_AUDIO_TAIL_MS,
  CTO_VOICE_MODEL,
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

