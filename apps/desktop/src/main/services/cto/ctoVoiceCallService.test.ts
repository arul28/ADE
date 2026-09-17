import { describe, expect, it, vi } from "vitest";
import {
  createCtoVoiceCallService,
  type CtoVoiceApprovalNotice,
  type CtoVoiceSocket,
} from "./ctoVoiceCallService";
import {
  ctoVoiceFrameDurationMs,
  describeCtoVoiceServerError,
  describeCtoVoiceSocketFailure,
  forwardUnexpectedResponse,
} from "./ctoVoiceFailures";
import {
  CTO_VOICE_END_CALL_AUDIO_TAIL_MS,
  CTO_VOICE_MIN_SPEECH_MS,
  CTO_VOICE_MODEL,
  CTO_VOICE_SAMPLE_RATE,
  CTO_VOICE_TRANSCRIBE_LANGUAGE,
  CTO_VOICE_TRANSCRIBE_MODEL,
  CTO_VOICE_TRANSCRIBE_PROMPT,
  CTO_VOICE_TURN_BURST_COOLDOWN_MS,
  ctoVoiceStatusLine,
  ctoVoiceTranscriptHasSpeech,
  type CtoVoiceState,
} from "../../../shared/types/ctoVoice";
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

/** Ten milliseconds of silence is enough to let every queued microtask run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Bring a call up to the point where OpenAI has answered with a session. */
async function openCall(harness: ReturnType<typeof createService>) {
  await harness.service.start();
  harness.fake.open();
  harness.fake.receive({ type: "session.created", session: { id: "sess_1" } });
}

/**
 * One microphone frame, the size the renderer actually produces.
 *
 * 2048 samples of PCM16 at the session rate — about 85 ms — because the
 * transcript gate measures a segment's length off the audio's own byte count
 * rather than off a clock.
 */
const MIC_FRAME = Buffer.alloc(2048 * 2).toString("base64");

/** Peak level a close-mic sentence reaches with the capture chain's AGC on. */
const SPEAKING_LEVEL = 0.4;

/** Peak level a quiet room produces after noise suppression: not speech. */
const ROOM_NOISE_LEVEL = 0.01;

/** Feed the call frames, exactly as the renderer's meter would. */
function hearMic(
  harness: ReturnType<typeof createService>,
  options: { level?: number; frames?: number } = {},
) {
  const level = options.level ?? SPEAKING_LEVEL;
  const frames = options.frames ?? 5;
  for (let i = 0; i < frames; i += 1) harness.service.pushAudio(MIC_FRAME, level);
}

/**
 * One user turn, exactly as the wire delivers it: VAD opens the turn, the
 * microphone carries the speech, VAD closes it, and the transcription lands
 * separately.
 *
 * The frames are not decoration. A transcript with no microphone energy behind it
 * is a hallucination and is thrown away, so a test that means "the user said
 * this" has to say it out loud.
 */
function utter(
  harness: ReturnType<typeof createService>,
  transcript: string,
  options: { level?: number; frames?: number } = {},
) {
  const fake = harness.fake;
  fake.receive({ type: "input_audio_buffer.speech_started" });
  hearMic(harness, options);
  fake.receive({ type: "input_audio_buffer.speech_stopped" });
  fake.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-1",
    transcript,
  });
}

/**
 * Every line ADE asked to have read out, as the text it handed over.
 *
 * Only the out-of-band ones: a response with no `response` object at all is the
 * model speaking for itself, which is most of a hybrid call and is never a
 * sentence ADE wrote.
 */
function spoken(fake: ReturnType<typeof createFakeSocket>): string[] {
  return fake.sent
    .filter((message) => message.type === "response.create")
    .map((message) => (message.response as { instructions?: unknown } | undefined)?.instructions)
    .filter((value): value is string => typeof value === "string");
}

/** Responses the model was asked to generate for itself, in the conversation. */
function modelResponses(fake: ReturnType<typeof createFakeSocket>): number {
  return fake.sent
    .filter((message) => message.type === "response.create" && message.response === undefined)
    .length;
}

/**
 * The model asks the CTO, exactly as the wire delivers it: a finished response
 * whose output carries a `function_call` item.
 */
function askCto(
  harness: ReturnType<typeof createService>,
  request: string,
  options: { callId?: string; responseId?: string; mode?: "replace" | "queue" } = {},
) {
  harness.fake.receive({
    type: "response.done",
    response: {
      id: options.responseId ?? "resp_fn",
      status: "completed",
      output: [{
        type: "function_call",
        name: "ask_cto",
        call_id: options.callId ?? "call_1",
        arguments: JSON.stringify({ request, mode: options.mode ?? "queue" }),
      }],
    },
  });
}

/** One tool call with no arguments — `cancel_work` and the two approvals. */
function callTool(
  harness: ReturnType<typeof createService>,
  name: string,
  callId = "call_tool",
) {
  harness.fake.receive({
    type: "response.done",
    response: {
      id: `resp_${callId}`,
      status: "completed",
      output: [{ type: "function_call", name, call_id: callId, arguments: "{}" }],
    },
  });
}

/** Every function result this call handed back, parsed. */
function functionOutputs(
  fake: ReturnType<typeof createFakeSocket>,
): Array<Record<string, unknown>> {
  return fake.sent
    .filter((message) => {
      const item = message.item as { type?: unknown } | undefined;
      return message.type === "conversation.item.create" && item?.type === "function_call_output";
    })
    .map((message) =>
      JSON.parse(String((message.item as { output?: unknown }).output)) as Record<string, unknown>);
}

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
   * The event that decides whether this is a CTO call or a chat with a
   * stranger. The model composes its own speech now — it has to, or a call
   * cannot be a conversation — so what keeps it honest is the tool list and
   * the instruction that
   * goes with it: it may answer from its context and it may not invent a
   * project fact. If `tools` ever goes missing from this event, the model has
   * no way to reach the CTO at all and will answer everything itself.
   */
  it("configures the session as a conversational front with one seam to the CTO", async () => {
    const harness = createService({
      voice: () => "cedar",
      context: async () => "Who you are\n- Name: Ada",
    });
    await harness.service.start();
    harness.fake.open();

    const update = harness.fake.lastOfType("session.update") as Record<string, any>;
    expect(update).toBeTruthy();
    expect(update.session.type).toBe("realtime");
    expect(update.session.output_modalities).toEqual(["audio"]);
    expect(update.session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      create_response: true,
      interrupt_response: true,
    });
    // The five functions, and nothing else: everything a call can DO happens on
    // the other side of `ask_cto`.
    expect(update.session.tool_choice).toBe("auto");
    // Written out rather than compared to a constant: a list checked against
    // itself agrees with any change, including one that takes a tool away.
    expect((update.session.tools as Array<{ name: string }>).map((tool) => tool.name))
      .toEqual(["ask_cto", "cancel_work", "approve_pending_action", "deny_pending_action", "end_call"]);
    // The context block rides in the session prompt, so the model can answer
    // "who are you" without a round trip through the CTO thread.
    expect(String(update.session.instructions)).toContain("- Name: Ada");
    // Without transcription there are no captions and no spoken yes/no, and
    // without a language the transcriber guesses per utterance — which is how a
    // phantom "好" reached the CTO and came back as a reply in Chinese.
    expect(update.session.audio.input.transcription).toEqual({
      model: CTO_VOICE_TRANSCRIBE_MODEL,
      language: CTO_VOICE_TRANSCRIBE_LANGUAGE,
      prompt: CTO_VOICE_TRANSCRIBE_PROMPT,
    });
    expect(update.session.audio.input.format)
      .toEqual({ type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE });
    expect(update.session.audio.output.format)
      .toEqual({ type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE });
    expect(update.session.audio.output.voice).toBe("cedar");
    // Nothing in the session names a backend model — that is what keeps the
    // CTO's own thinking on whatever plan it already runs on.
    expect(JSON.stringify(update.session)).not.toContain("responses");
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

  /**
   * Two requests at once, and who decides what happens to the first.
   *
   * On the live call of 2026-09-16 both requests were lost: the second one's
   * `runSessionTurn` was attempted before the first had been interrupted, threw
   * "Session already has an active background turn", and the abort landed three
   * milliseconds later. The user heard that the CTO could not be reached, twice.
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

  /**
   * The whole point of the call being able to act.
   *
   * The CTO's turn parks inside `canUseTool` when it reaches a tool that
   * writes. Nothing comes back through `runBackendTurn` to say so, so the call
   * learns about it from the chat's own approval event — and a spoken yes has
   * to reach that waiter, or the user hears "doing that now" and nothing runs.
   */
  describe("acting on a call", () => {
    function createCallWithApprovals(
      overrides: Partial<Parameters<typeof createCtoVoiceCallService>[0]> = {},
    ) {
      // The service's own notice type, so a field added to an approval breaks
      // these tests rather than being quietly dropped by a narrower shape.
      let raise: ((notice: CtoVoiceApprovalNotice) => void) | null = null;
      const resolved: Array<{ itemId: string; approved: boolean }> = [];
      let watcherReleased = false;
      const harness = createService({
        watchApprovals: (onApproval) => {
          raise = onApproval;
          return () => { watcherReleased = true; };
        },
        resolveApproval: async (args) => { resolved.push(args); },
        ...overrides,
      });
      return {
        ...harness,
        resolved,
        raise: (notice: CtoVoiceApprovalNotice) => raise?.(notice),
        wasWatcherReleased: () => watcherReleased,
      };
    }

    it("asks out loud, then lets the blocked turn through on a spoken yes", async () => {
      // The real sequence: the turn is still running — parked inside
      // `canUseTool` — when the approval is raised, so it has not returned an
      // answer and the question is the only thing ADE has said.
      let releaseBackend: () => void = () => {};
      const harness = createCallWithApprovals({
        runBackendTurn: async () => {
          await new Promise<void>((resolve) => { releaseBackend = resolve; });
          return { spoken: "Opened it." };
        },
      });
      await openCall(harness);
      askCto(harness, "open a pr for the sync lane");
      await tick();

      harness.raise({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
      expect(harness.latest().phase).toBe("confirming");
      expect(harness.latest().pendingConfirmation?.prompt).toContain("pull request");
      // The user has to HEAR the question, not find it in the chat.
      expect(spoken(harness.fake).join("\n")).toContain("pull request");

      utter(harness, "yes");
      await tick();

      expect(harness.latest().pendingConfirmation).toBeNull();
      expect(harness.resolved).toEqual([{ itemId: "item-1", approved: true }]);
      releaseBackend();
    });

    /**
     * Answering out loud while the CTO is still reading the question is the
     * ordinary case, not an edge one. The audio has to stop — but the turn
     * behind it is the one parked on this very approval, and aborting it would
     * kill the work the "yes" exists to release.
     */
    it("does not abandon the parked turn when the user answers over the question", async () => {
      const seenSignal: { current: AbortSignal | null } = { current: null };
      let releaseBackend: () => void = () => {};
      const harness = createCallWithApprovals({
        runBackendTurn: async ({ signal }: { signal: AbortSignal }) => {
          seenSignal.current = signal;
          await new Promise<void>((resolve) => { releaseBackend = resolve; });
          return { spoken: "Opened it." };
        },
      });
      await openCall(harness);
      askCto(harness, "open a pr for the sync lane");
      await tick();

      harness.raise({ itemId: "item-9", toolName: "openPr", prompt: "Open a pull request?" });
      harness.fake.receive({ type: "response.created", response: { id: "resp_q" } });

      // Talking over the question: the audio stops, the card stays, the turn lives.
      harness.fake.receive({ type: "input_audio_buffer.speech_started" });
      expect(harness.fake.typesSent()).toContain("response.cancel");
      expect(seenSignal.current?.aborted).toBe(false);
      expect(harness.latest().phase).toBe("confirming");
      expect(harness.latest().pendingConfirmation?.id).toBeTruthy();

      // Spoken over ADE's own voice and still accepted: a segment that carries
      // real energy is a barge-in, not the microphone hearing the CTO.
      hearMic(harness);
      harness.fake.receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "yes",
      });
      await tick();
      expect(harness.resolved).toEqual([{ itemId: "item-9", approved: true }]);
      releaseBackend();
    });

    it("turns the tool away on a spoken no", async () => {
      const harness = createCallWithApprovals();
      await openCall(harness);
      utter(harness, "clean up the branch");
      await tick();

      harness.raise({ itemId: "item-2", toolName: "openPr", prompt: "Open a pull request?" });
      utter(harness, "no, don't");
      await tick();

      expect(harness.latest().pendingConfirmation).toBeNull();
      expect(harness.resolved).toEqual([{ itemId: "item-2", approved: false }]);
    });

    it("will not let a voice approve a force-push, however clearly it is said", async () => {
      const harness = createCallWithApprovals();
      await openCall(harness);
      utter(harness, "force push it");
      await tick();

      harness.raise({ itemId: "item-3", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
      expect(harness.latest().pendingConfirmation?.destructive).toBe(true);

      utter(harness, "yes do it");
      await tick();

      // Still waiting on a tap, and nothing was released.
      expect(harness.latest().pendingConfirmation?.id).toBeTruthy();
      expect(harness.resolved).toEqual([]);

      // The card is the only way through.
      harness.service.approve(harness.latest().pendingConfirmation!.id);
      await tick();
      expect(harness.resolved).toEqual([{ itemId: "item-3", approved: true }]);
    });

    it("stops watching the chat when the call ends", async () => {
      const harness = createCallWithApprovals();
      await openCall(harness);
      expect(harness.wasWatcherReleased()).toBe(false);
      await harness.service.end();
      expect(harness.wasWatcherReleased()).toBe(true);
    });
  });

  it("marks a history-rewriting tool destructive, so voice cannot approve it", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.service.raiseApproval({ itemId: "item-1", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
    expect(harness.latest().pendingConfirmation?.destructive).toBe(true);
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
    const harness = createService({ persistCall });
    await openCall(harness);
    utter(harness, "hello");
    await harness.service.end();
    expect(persistCall).toHaveBeenCalledTimes(1);
    expect(persistCall.mock.calls[0]?.[0]?.captions.length).toBe(1);
  });

  it("captions what the CTO said from the response transcript", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "response.output_audio_transcript.delta", delta: "Three" });
    expect(harness.latest().phase).toBe("speaking");
    harness.fake.receive({
      type: "response.output_audio_transcript.done",
      transcript: "Three merged yesterday.",
    });
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    expect(harness.latest().captions.at(-1))
      .toMatchObject({ role: "assistant", text: "Three merged yesterday." });
    expect(harness.latest().phase).toBe("listening");
  });

  /**
   * The realtime model cannot read an image. The only place a captured window
   * can actually be looked at is the CTO thread behind `ask_cto`.
   */
  it("sends a captured image to the backend, not to the voice model", async () => {
    const seen: Array<string | null | undefined> = [];
    const harness = createService({
      runBackendTurn: async ({ imageBase64 }) => { seen.push(imageBase64); return { spoken: "ok" }; },
    });
    await openCall(harness);

    harness.service.attachImage({ pngBase64: "PNGDATA", note: "the CI run" });
    // The model is told it happened, and told in the silent channel: a
    // conversation item, with no response asked for, so nothing is read out.
    const item = harness.fake.lastOfType("conversation.item.create") as Record<string, any>;
    expect(item.item.role).toBe("system");
    expect(JSON.stringify(item.item.content)).toContain("the CI run");
    expect(JSON.stringify(harness.fake.sent)).not.toContain("PNGDATA");

    askCto(harness, "what is this showing", { callId: "call_1" });
    await tick();
    expect(seen).toEqual(["PNGDATA"]);

    // One capture, one turn: it must not ride along on the next one too.
    askCto(harness, "and the one before it", { callId: "call_2" });
    await tick();
    expect(seen).toEqual(["PNGDATA", null]);
  });

  it("hands output audio straight to the renderer", async () => {
    const chunks: string[] = [];
    const harness = createService({ onOutputAudio: (b64) => chunks.push(b64) });
    await openCall(harness);
    harness.fake.receive({ type: "response.output_audio.delta", delta: "AAAB" });
    // The same event under the name the older surface still uses for it.
    harness.fake.receive({ type: "response.audio.delta", delta: "AAAC" });
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
    const harness = createService({ setCallConfirmMode: async (v: boolean) => { calls.push(v); } });

    await harness.service.start();
    // Read-only is on BEFORE the socket exists — no audio may be in flight
    // while the CTO can still write.
    expect(calls).toEqual([true]);

    harness.fake.open();
    harness.fake.receive({ type: "session.created", session: { id: "sess_1" } });
    await harness.service.end();
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
 * The second half of the bug this protocol swap fixed.
 *
 * A rejected upgrade never carries OpenAI's explanation — the handshake fails
 * before there is a session to explain anything. An upgrade that SUCCEEDS and
 * then fails does, as an `error` event, and that message is the truth.
 */
/**
 * The defect that made the CTO look like it was talking to itself.
 *
 * On the owner's call, six CTO turns ran in thirty-eight seconds from three
 * spoken sentences: "Haha.", "OK,OK,好好好." and "아니." were invented by the
 * transcriber out of a quiet room, and each one became a real turn that spoke a
 * real answer. Under the hybrid the model hears the audio itself and decides
 * what to answer, so what this gate now guards is the CALL RECORD and the
 * spoken yes/no parser — a caption is a claim that the user said something, and
 * a hallucinated "yes" must never release a blocked tool.
 */
describe("the transcript gate", () => {
  /** Every rejection the gate logged, in order. */
  function rejections(info: ReturnType<typeof vi.fn>) {
    return info.mock.calls
      .filter(([event]) => event === "cto_voice.transcript_rejected")
      .map(([, meta]) => meta as { reason: string; text: string; scope: string });
  }

  /**
   * A question ADE asked out loud, so the meter has something to judge.
   *
   * The gate is scoped to this path alone now: everywhere else a transcript is
   * captioned whatever the microphone thought, because rejecting it never
   * stopped the realtime model answering — it only deleted the user's words.
   */
  function askForApproval(harness: ReturnType<typeof createService>) {
    harness.service.raiseApproval({
      itemId: "item-1",
      toolName: "openPr",
      prompt: "Open a pull request for ade/sync-fix?",
    });
    // The question is spoken, and the answer arrives after it has been said —
    // otherwise every frame of the reply lands while a response is in flight
    // and the echo rule, not the energy rule, is what refuses it.
    harness.fake.receive({ type: "response.created", response: { id: "resp_ask" } });
    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_ask", status: "completed", output: [] },
    });
  }

  /**
   * A call whose log the test can read, and whose clock it can own.
   *
   * One factory rather than two: the only difference between "a gated call" and
   * "a gated call with a clock" was whether `now` was injected, and two of them
   * meant the frame helper existed on one and not the other.
   */
  function gatedCall() {
    let clock = 1_000_000;
    const info = vi.fn();
    const harness = createService({ logger: { info, warn: vi.fn() }, now: () => clock });
    return {
      harness,
      info,
      /** What the call wrote down as having been said. */
      captions: () => harness.latest().captions.map((caption) => caption.text),
      advance: (ms: number) => { clock += ms; },
      /** One frame, at the current instant, at the level given. */
      frame: (level: number) => harness.service.pushAudio(MIC_FRAME, level),
    };
  }

  it("throws away a transcript with no words in it", async () => {
    const { harness, info } = gatedCall();
    await openCall(harness);

    utter(harness, "   ");
    await tick();
    // Punctuation only is the other shape silence comes back as.
    utter(harness, " … ");
    await tick();

    expect(spoken(harness.fake)).toEqual([]);
    expect(harness.latest().captions).toEqual([]);
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["empty", "empty"]);
    expect(new Set(rejections(info).map((entry) => entry.scope))).toEqual(new Set(["caption"]));
  });

  /**
   * The failure this scoping exists for.
   *
   * On the call of 2026-09-16 three REAL sentences measured a peak of 0.005 and
   * were thrown away, so the user watched the CTO answer questions the HUD said
   * had never been asked. The model answers from the audio whatever the meter
   * thinks, so a rejected caption only ever deletes the user's own words.
   */
  it("writes down what the user said even when the meter heard nothing", async () => {
    const { harness, info, captions } = gatedCall();
    await openCall(harness);

    utter(harness, "Who are you?", { level: 0.005 });
    await tick();
    utter(harness, "Okay, what's going on?", { level: 0 });
    await tick();

    expect(captions()).toEqual(["Who are you?", "Okay, what's going on?"]);
    expect(rejections(info)).toEqual([]);
  });

  it("will not let a phantom yes approve anything", async () => {
    const { harness, info, captions } = gatedCall();
    await openCall(harness);
    askForApproval(harness);

    // The transcriber writes a word out of a quiet room while a tool is parked
    // inside `canUseTool`. It is written down — it is the only record of what
    // the transcriber claimed — and it decides nothing.
    utter(harness, "yes", { level: ROOM_NOISE_LEVEL });
    await tick();

    expect(captions()).toContain("yes");
    expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(rejections(info).map((entry) => ({ reason: entry.reason, scope: entry.scope })))
      .toEqual([{ reason: "no_speech_energy", scope: "confirmation" }]);
  });

  it("lets a yes the microphone heard release the question", async () => {
    const { harness } = gatedCall();
    await openCall(harness);
    askForApproval(harness);

    utter(harness, "yes");
    await tick();

    expect(harness.latest().pendingConfirmation).toBeNull();
  });

  it("writes down a transcript the microphone heard the user say", async () => {
    const { harness, captions } = gatedCall();
    await openCall(harness);

    utter(harness, "what merged yesterday");
    await tick();

    expect(captions()).toEqual(["what merged yesterday"]);
  });

  it("accepts a one-word answer, which is the shortest thing a call must hear", async () => {
    // The gate's length rule is allowed to reject a click. It is not allowed to
    // reject "yes", which is the whole spoken-confirmation system.
    const { harness, captions } = gatedCall();
    await openCall(harness);

    utter(harness, "yes", { frames: 4 });
    await tick();

    expect(captions()).toEqual(["yes"]);
  });

  it("refuses a decision to a click that carried a sentence", async () => {
    const { harness, info, captions } = gatedCall();
    await openCall(harness);
    askForApproval(harness);

    // One loud frame — 85 ms — is a door or a keyboard, not a spoken "go
    // ahead". It is captioned; it does not open the gate.
    utter(harness, "go ahead", { frames: 1 });
    await tick();

    expect(captions()).toContain("go ahead");
    expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["too_short"]);
  });

  it("ignores its own voice arriving back through the microphone", async () => {
    const { harness, info } = gatedCall();
    await openCall(harness);
    askForApproval(harness);

    // ADE is speaking, and every frame of the segment lands under that speech at
    // the level echo cancellation leaves behind.
    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    hearMic(harness, { level: ROOM_NOISE_LEVEL, frames: 12 });
    harness.fake.receive({ type: "input_audio_buffer.speech_stopped" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Yes, go ahead.",
    });
    await tick();

    expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["echo"]);
  });

  it("shuts the confirmation path on a runaway, and opens it again after quiet", async () => {
    const { harness, info, captions, advance } = gatedCall();
    await openCall(harness);

    // Five accepted transcripts inside the window — faster than a call can
    // physically have exchanges, so the source, not the user, is producing them.
    for (let i = 0; i < 5; i += 1) {
      advance(1_500);
      utter(harness, `question ${i}`);
      await tick();
    }
    expect(captions()).toHaveLength(5);
    expect(info.mock.calls.some(([event]) => event === "cto_voice.transcript_valve_tripped"))
      .toBe(true);

    // The valve shuts the DECISION, never the record: a transcript source
    // running away must not be able to answer a question ADE asked out loud,
    // and it is still allowed to fill the call record.
    askForApproval(harness);
    advance(1_500);
    utter(harness, "yes");
    await tick();
    expect(captions().at(-1)).toBe("yes");
    expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["runaway"]);

    // Quiet is what opens it: no transcript for the cooldown, and the user's
    // spoken answer counts again.
    advance(CTO_VOICE_TURN_BURST_COOLDOWN_MS + 1);
    utter(harness, "yes");
    await tick();
    expect(harness.latest().pendingConfirmation).toBeNull();
    expect(info.mock.calls.some(([event]) => event === "cto_voice.transcript_valve_cleared"))
      .toBe(true);
  });

  it("reopens the valve on quiet even when no question was ever asked", async () => {
    // The latch this fixes: the valve was only ever CLEARED inside the
    // confirmation branch, and the cooldown is measured from the last
    // transcript of any kind. So an ordinary talkative call shut it, kept it
    // shut by carrying on talking, and every spoken yes after that came back
    // "runaway" — with no question open at the moment quiet actually arrived.
    const { harness, info, advance } = gatedCall();
    await openCall(harness);

    for (let i = 0; i < 5; i += 1) {
      advance(1_500);
      utter(harness, `question ${i}`);
      await tick();
    }
    expect(info.mock.calls.some(([event]) => event === "cto_voice.transcript_valve_tripped"))
      .toBe(true);

    // Quiet, and then an ordinary sentence with nothing pending. That is the
    // transcript the valve has to be judged on.
    advance(CTO_VOICE_TURN_BURST_COOLDOWN_MS + 1);
    utter(harness, "still there?");
    await tick();
    expect(info.mock.calls.some(([event]) => event === "cto_voice.transcript_valve_cleared"))
      .toBe(true);

    // And now the conversation carries on at a normal pace: the yes lands a
    // second and a half later, well inside the cooldown, and is still honoured.
    askForApproval(harness);
    advance(1_500);
    utter(harness, "yes");
    await tick();
    expect(harness.latest().pendingConfirmation).toBeNull();
    expect(rejections(info).map((entry) => entry.reason)).toEqual([]);
  });

  it("does not let one segment's silence count against the next one's speech", async () => {
    const { harness, captions } = gatedCall();
    await openCall(harness);

    utter(harness, "…", { level: ROOM_NOISE_LEVEL });
    await tick();
    utter(harness, "what is left");
    await tick();

    expect(captions()).toEqual(["what is left"]);
  });

  /* ── The meter's memory ──────────────────────────────────────────────────
   *
   * The gate above was RUNNING on the build that let a phantom "好" through,
   * and these three tests are why it did not help. The meter was a set of
   * running totals cleared only by a judgement, so the first transcript of a
   * call was judged against every frame since the microphone opened — and
   * `voicedMs` was a SUM, which a quiet room reaches given enough seconds.
   * ──────────────────────────────────────────────────────────────────────── */

  it("does not add up transients scattered across a long quiet stretch", async () => {
    const call = gatedCall();
    await openCall(call.harness);
    askForApproval(call.harness);

    // Fifteen seconds of a room the renderer never stops metering: mostly
    // silence, with one transient — a key, a chair — about once a second. The
    // fifteen loud frames sum to 1.2 s of "voiced" audio, which is five times
    // the minimum, and under the old sum that alone let a hallucination
    // through. Not one of them is next to another.
    for (let second = 0; second < 15; second += 1) {
      for (let i = 0; i < 11; i += 1) {
        call.frame(ROOM_NOISE_LEVEL);
        call.advance(85);
      }
      call.frame(SPEAKING_LEVEL);
      call.advance(85);
    }
    call.harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "yes",
    });
    await tick();

    expect(call.harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(rejections(call.info).map((entry) => entry.reason)).toEqual(["too_short"]);
  });

  it("accepts energy that stays up for a word's length", async () => {
    const call = gatedCall();
    await openCall(call.harness);

    // Four frames in a row, ~340 ms: a word. The same four frames with silence
    // between them are the test above, and the only difference is that these
    // are contiguous.
    call.frame(ROOM_NOISE_LEVEL);
    call.advance(85);
    for (let i = 0; i < 4; i += 1) {
      call.frame(SPEAKING_LEVEL);
      call.advance(85);
    }
    call.frame(ROOM_NOISE_LEVEL);
    call.advance(85);
    call.harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "ship it",
    });
    await tick();

    expect(call.captions()).toEqual(["ship it"]);
  });

  it("forgets a loud moment that has fallen out of the window", async () => {
    const call = gatedCall();
    await openCall(call.harness);
    askForApproval(call.harness);

    // A real sentence, and then ten seconds of nothing. The sentence is over
    // and it does not get to vouch for whatever the transcriber writes next.
    for (let i = 0; i < 6; i += 1) {
      call.frame(SPEAKING_LEVEL);
      call.advance(85);
    }
    call.advance(10_000);
    call.frame(SPEAKING_LEVEL);
    call.advance(85);
    call.harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "yes",
    });
    await tick();

    expect(call.harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(rejections(call.info).map((entry) => entry.reason)).toEqual(["too_short"]);
  });

  /**
   * Only rejections were ever logged, so a gate that waved a phantom through
   * looked exactly like a gate with nothing to reject. The accepted line is what
   * makes the difference visible — with the measurements, and with the text's
   * length rather than the text, because an accepted transcript is something the
   * user actually said.
   */
  it("logs what it accepted, and how loud it was, without logging the words", async () => {
    const { harness, info, captions } = gatedCall();
    await openCall(harness);

    utter(harness, "what merged yesterday");
    await tick();

    expect(captions()).toEqual(["what merged yesterday"]);
    const accepted = info.mock.calls
      .filter(([event]) => event === "cto_voice.transcript_accepted")
      .map(([, meta]) => meta as Record<string, unknown>);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.peak).toBe(Number(SPEAKING_LEVEL.toFixed(3)));
    expect(accepted[0]!.voicedMs as number).toBeGreaterThanOrEqual(CTO_VOICE_MIN_SPEECH_MS);
    expect(accepted[0]!.frames).toBe(5);
    expect(accepted[0]!.framesWhileIdle).toBe(5);
    expect(accepted[0]!.textLength).toBe("what merged yesterday".length);
    expect(JSON.stringify(accepted[0])).not.toContain("what merged yesterday");
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

/** The length half of the gate, measured off the audio rather than a clock. */
describe("ctoVoiceFrameDurationMs", () => {
  it("reads a frame's length out of its bytes", () => {
    // 2048 samples of PCM16 at 24 kHz is the renderer's frame: ~85.3 ms.
    expect(ctoVoiceFrameDurationMs(Buffer.alloc(2048 * 2).toString("base64")))
      .toBeCloseTo(85.333, 2);
    expect(ctoVoiceFrameDurationMs(Buffer.alloc(24_000 * 2).toString("base64")))
      .toBeCloseTo(1_000, 3);
    expect(ctoVoiceFrameDurationMs("")).toBe(0);
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

describe("a session that answers with an error", () => {
  it("names an expired key, because 'rejected' sends the user to the wrong fix", async () => {
    const warn = vi.fn();
    const harness = createService({ logger: { info: () => {}, warn } });
    await openCall(harness);

    harness.fake.receive({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_api_key",
        message: "Your API key has expired. Create a new API key to continue.",
      },
    });
    await tick();

    expect(harness.service.getState().error).toBe(
      "Your OpenAI key has expired. Create a new key at platform.openai.com"
      + " and paste it under CTO settings, Voice.",
    );
    expect(harness.states.some((state) => state.phase === "failed")).toBe(true);
    // A refused key does not recover, so the call ends rather than sitting there.
    expect(harness.states.at(-1)?.phase).toBe("ended");
    expect(harness.service.getConnectionFailureKind()).toBe("rejected_key");
    // The raw error, with its code and type, is in the trace.
    expect(warn).toHaveBeenCalledWith("cto_voice.session_error", expect.objectContaining({
      code: "invalid_api_key",
      type: "invalid_request_error",
      message: "Your API key has expired. Create a new API key to continue.",
    }));
  });

  it("surfaces an error it cannot classify in OpenAI's own words", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown parameter: 'session.wobble'." },
    });

    // Verbatim, not "The voice connection failed." — a sentence someone wrote
    // to be read is better than a guess, whatever we do with it.
    expect(harness.service.getState().error).toBe("Unknown parameter: 'session.wobble'.");
    // Not fatal: the session is still there and the call keeps going.
    expect(harness.service.getState().phase).toBe("listening");
  });

  it("says nothing about a response it cancelled a beat too late", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({
      type: "error",
      error: { type: "invalid_request_error", message: "Cancellation failed: no active response found" },
    });
    expect(harness.service.getState().error).toBeNull();
    expect(harness.service.getState().phase).toBe("listening");
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

describe("describeCtoVoiceServerError", () => {
  const EXPIRED = "Your OpenAI key has expired. Create a new key at platform.openai.com"
    + " and paste it under CTO settings, Voice.";
  const REJECTED = "OpenAI rejected this key. Check it under CTO settings, Voice.";
  const NO_CREDIT = "Your OpenAI account has no credit for voice calls."
    + " Add billing at platform.openai.com.";

  it("names an expired key, which is a different fix from a wrong one", () => {
    expect(describeCtoVoiceServerError({
      message: "Your API key has expired. Create a new API key to continue.",
    })).toEqual({ message: EXPIRED, kind: "expired_key", fatal: true });
  });

  it("keeps the rejected-key sentence for a key OpenAI does not recognise", () => {
    for (const message of [
      "Incorrect API key provided: sk-abc***. You can find your API key at …",
      "Invalid API key",
    ]) {
      expect(describeCtoVoiceServerError({ message }))
        .toEqual({ message: REJECTED, kind: "rejected_key", fatal: true });
    }
    expect(describeCtoVoiceServerError({ code: "invalid_api_key", message: "" }).kind)
      .toBe("rejected_key");
  });

  it("sends an account with no credit to billing, not back to the key field", () => {
    expect(describeCtoVoiceServerError({
      code: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    })).toEqual({ message: NO_CREDIT, kind: "no_credit", fatal: true });
  });

  it("does not blame the key for a parameter it did not like", () => {
    // The trap in a bare /invalid/: this is about a field, not a credential,
    // and "check your key" would send the user to the one place nothing is wrong.
    const reason = describeCtoVoiceServerError({
      type: "invalid_request_error",
      message: "Invalid value: 'chirp' for session.audio.output.voice.",
    });
    expect(reason.kind).toBe("other");
    expect(reason.message).toBe("Invalid value: 'chirp' for session.audio.output.voice.");
    expect(reason.fatal).toBe(false);
  });

  it("passes an unrecognised message through, trimmed to one line", () => {
    expect(describeCtoVoiceServerError({
      message: "  The server had a problem.  \nStack: at foo (bar.js:1)\n",
    })).toEqual({ message: "The server had a problem.", kind: "other", fatal: false });
  });

  it("still says something when the error carried no message at all", () => {
    expect(describeCtoVoiceServerError()).toEqual({
      message: "The voice session reported an error.",
      kind: "other",
      fatal: false,
    });
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
    // The leak: `pendingOurResponse` is set on the send and cleared on
    // `response.created`, which never arrived for the line this call was in the
    // middle of. Carried into the next call it made the FIRST server response
    // look like one of ADE's own, so the first barge-in cancelled a response the
    // server was already truncating itself.
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
