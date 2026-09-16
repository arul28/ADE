import { describe, expect, it, vi } from "vitest";
import {
  createCtoVoiceCallService,
  ctoVoiceFrameDurationMs,
  describeCtoVoiceServerError,
  describeCtoVoiceSocketFailure,
  forwardUnexpectedResponse,
  type CtoVoiceSocket,
} from "./ctoVoiceCallService";
import {
  CTO_VOICE_MIN_SPEECH_MS,
  CTO_VOICE_MODEL,
  CTO_VOICE_SAMPLE_RATE,
  CTO_VOICE_TRANSCRIBE_LANGUAGE,
  CTO_VOICE_TRANSCRIBE_MODEL,
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

/** Every response this call asked for, as the text it was told to read. */
function spoken(fake: ReturnType<typeof createFakeSocket>): string[] {
  return fake.sent
    .filter((message) => message.type === "response.create")
    .map((message) => String((message.response as { instructions?: unknown }).instructions ?? ""));
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
    } as never);
    await service.start();
    expect(urls).toEqual([`wss://api.openai.com/v1/realtime?model=${CTO_VOICE_MODEL}`]);
  });

  /**
   * The event that decides whether this is a CTO call or a chat with a
   * stranger. `create_response: false` is the whole architecture: the session
   * still segments, commits and transcribes the user's speech for us, and is
   * refused permission to answer any of it. If this ever goes green with
   * `create_response` missing, the voice model is answering from its own
   * knowledge and the CTO is no longer the brain.
   */
  it("configures the session so the voice model cannot answer for itself", async () => {
    const harness = createService({ voice: () => "cedar" } as never);
    await harness.service.start();
    harness.fake.open();

    const update = harness.fake.lastOfType("session.update") as Record<string, any>;
    expect(update).toBeTruthy();
    expect(update.session.type).toBe("realtime");
    expect(update.session.output_modalities).toEqual(["audio"]);
    expect(update.session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      create_response: false,
      interrupt_response: false,
    });
    // Without transcription there is no intent to hand the CTO at all, and
    // without a language the transcriber guesses per utterance — which is how a
    // phantom "好" reached the CTO and came back as a reply in Chinese.
    expect(update.session.audio.input.transcription).toEqual({
      model: CTO_VOICE_TRANSCRIBE_MODEL,
      language: CTO_VOICE_TRANSCRIBE_LANGUAGE,
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
   * The regression this replaced: a filler on the first line of every turn.
   * "Let me check that." went out before the backend was even called, which
   * meant the user heard it before "Hello" too — four words of nothing, every
   * single answer. A turn now says exactly one thing, and it is the answer.
   *
   * `backchannelsEnabled` is deliberately ON here: the setting no longer buys
   * the filler back.
   */
  it("says nothing at all while the backend is thinking", async () => {
    const order: string[] = [];
    let releaseBackend: () => void = () => {};
    const harness = createService({
      backchannelsEnabled: () => true,
      runBackendTurn: async () => {
        order.push("backend-started");
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "Three merged yesterday." };
      },
    });
    await openCall(harness);
    utter(harness, "what merged yesterday");
    await tick();

    expect(spoken(harness.fake)).toEqual([]);
    expect(order).toEqual(["backend-started"]);
    expect(harness.latest().phase).toBe("thinking");
    releaseBackend();
  });

  it("speaks the answer and nothing before it", async () => {
    const harness = createService({ backchannelsEnabled: () => false });
    await openCall(harness);
    utter(harness, "what merged yesterday");
    await tick();

    const said = spoken(harness.fake);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Three merged yesterday.");
  });

  /**
   * The Realtime API has no "say this" event. The CTO's sentence rides as the
   * `instructions` of one `response.create`, fenced and marked read-aloud, so
   * an answer that itself contains a question is READ rather than answered.
   */
  it("speaks the CTO's answer by asking for a response that reads it out", async () => {
    const harness = createService({
      backchannelsEnabled: () => false,
      runBackendTurn: async () => ({ spoken: "Shall I open the PR?" }),
    });
    await openCall(harness);
    utter(harness, "what next");
    await tick();

    const request = harness.fake.lastOfType("response.create") as Record<string, any>;
    expect(request.response.output_modalities).toEqual(["audio"]);
    expect(String(request.response.instructions)).toContain("word for word");
    expect(String(request.response.instructions)).toContain("Shall I open the PR?");
    expect(harness.latest().phase).toBe("speaking");
  });

  /**
   * The bug this shape exists for: a response created INSIDE the conversation is
   * generated with the user's audio in front of it, so the model answers the
   * user instead of reading what it was handed. Measured against the live API —
   * in-conversation, everything after the first exchange of a call was hijacked
   * ("I'm ChatGPT…"); out-of-band, 24 of 24 sentences were read word for word.
   * `create_response: false` does not cover this: it only stops responses the
   * model creates on its own.
   */
  it("asks for every response out-of-band so the model has nothing to answer", async () => {
    const harness = createService({
      backchannelsEnabled: () => false,
      runBackendTurn: async () => ({ spoken: "Three merged yesterday." }),
    });
    await openCall(harness);
    utter(harness, "how are the PRs");
    await tick();

    const requests = harness.fake.sent
      .filter((message) => message.type === "response.create")
      .map((message) => message.response as Record<string, unknown>);
    expect(requests.length).toBeGreaterThan(0);
    for (const response of requests) {
      expect(response.conversation).toBe("none");
      expect(response.input).toEqual([]);
    }
  });

  /**
   * One response at a time is an API rule, not a style choice: a second
   * `response.create` while one is generating is answered with an error instead
   * of with speech, so the answer would simply never be heard.
   */
  it("holds an answer until the response already in flight is over", async () => {
    const harness = createService();
    await openCall(harness);
    // A response the server has already named — the state a queued answer has
    // to survive. Asking for a second one here is answered with an error, not
    // with speech, so the answer would simply never be heard.
    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    utter(harness, "what merged yesterday");
    await tick();

    expect(spoken(harness.fake)).toEqual([]);

    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    expect(spoken(harness.fake)).toHaveLength(1);
    expect(spoken(harness.fake)[0]).toContain("Three merged yesterday.");
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
      // An interrupted turn deliberately answers with no sentence. A timing
      // line that only appears for the happy path cannot tell you which turns
      // were slow, so this one is written too.
      runBackendTurn: async () => ({ spoken: "" }),
    });
    await openCall(harness);
    utter(harness, "never mind");
    await tick();

    const timing = lines.filter((line) => line.event === "cto_voice.turn_timing");
    expect(timing).toHaveLength(1);
    expect(timing[0]!.meta.outcome).toBe("silent");
    expect(timing[0]!.meta.firstSpeakToFirstAudioMs).toBeNull();
  });

  it("asks the CTO exactly what the transcript said", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    utter(harness, "what is the status of the PRs");
    await tick();
    expect(seen).toEqual(["what is the status of the PRs"]);
  });

  it("builds the intent from transcription deltas when that is all that arrives", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    hearMic(harness);
    harness.fake.receive({ type: "conversation.item.input_audio_transcription.delta", delta: "what is the " });
    harness.fake.receive({ type: "conversation.item.input_audio_transcription.delta", delta: "status of the PRs" });
    // A completion with no transcript field: the deltas are the record.
    harness.fake.receive({ type: "conversation.item.input_audio_transcription.completed" });
    await tick();
    expect(seen).toEqual(["what is the status of the PRs"]);
  });

  it("never carries one utterance's words into the next one's question", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    utter(harness, "what merged yesterday");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    utter(harness, "and what is left");
    await tick();
    expect(seen).toEqual(["what merged yesterday", "and what is left"]);
  });

  it("asks an utterance exactly once, however many times it is delivered", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    utter(harness, "what merged yesterday");
    await tick();
    // The same completion again, without a new turn opening. Given its own
    // microphone energy, so the once-per-utterance guard is the only thing that
    // can turn it away.
    hearMic(harness);
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "what merged yesterday",
    });
    await tick();
    expect(seen).toEqual(["what merged yesterday"]);
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

  it("drops a superseded answer instead of speaking it over the next one", async () => {
    // The user asks, then interrupts and asks something else. The first turn is
    // still running; when it finishes, its answer is to a question the user has
    // moved on from. Reading the abort flag off the module binding asked the
    // WRONG controller — by then it named the superseding turn — so the stale
    // answer was spoken over the live one.
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

    utter(harness, "the first question");
    await tick();
    utter(harness, "no wait, the second question");
    await tick();

    // The first turn only finishes now, after it was superseded.
    release.forEach((fn) => fn());
    await tick();

    const said = spoken(harness.fake).join("\n");
    expect(said).toContain("FRESH ANSWER");
    expect(said).not.toContain("STALE ANSWER");
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

  it("does not start a second CTO turn while one is parked on a confirmation", async () => {
    // The turn that raised the question is still inside `canUseTool`. A reply
    // that decides nothing must not become a fresh question on the same
    // session, or two turns collide on one thread.
    const intents: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { intents.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    utter(harness, "open a pr for the sync lane");
    await tick();
    harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request?" });

    utter(harness, "what time is it");
    await tick();

    expect(intents).toEqual(["open a pr for the sync lane"]);
    expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
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
      // The real sequence: the turn is still running — parked inside
      // `canUseTool` — when the approval is raised, so it has not returned an
      // answer and the only thing ahead of the question is the filler.
      let releaseBackend: () => void = () => {};
      const harness = createCallWithApprovals({
        runBackendTurn: async () => {
          await new Promise<void>((resolve) => { releaseBackend = resolve; });
          return { spoken: "Opened it." };
        },
      });
      await openCall(harness);
      utter(harness, "open a pr for the sync lane");
      await tick();
      harness.fake.receive({ type: "response.done", response: { status: "completed" } });

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
      utter(harness, "open a pr for the sync lane");
      await tick();
      harness.fake.receive({ type: "response.done", response: { status: "completed" } });

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
   * Barge-in is two cancellations, not one. `response.cancel` stops the audio
   * the user is talking over; aborting the controller stops the CTO turn behind
   * it, whose answer would otherwise arrive seconds later and be read out over
   * the new question.
   */
  it("cancels the response and the turn when the user talks over the answer", async () => {
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
    utter(harness, "what merged yesterday");
    await tick();
    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });

    expect(harness.fake.typesSent()).toContain("response.cancel");
    expect(seenSignal.current?.aborted).toBe(true);
    expect(harness.latest().interrupted).toBe(true);
    expect(harness.latest().phase).toBe("listening");

    releaseBackend();
    await tick();
    expect(spoken(harness.fake).join("\n")).not.toContain("STALE ANSWER");
  });

  /**
   * A cancel has to name the response it is cancelling. Every response this
   * service asks for is out-of-band, and a bare `response.cancel` is understood
   * as "cancel the response in the DEFAULT conversation" — where ours never is.
   * Without the id the cancel lands on nothing and the CTO talks over the user.
   */
  it("cancels the response by id, because an out-of-band one has no other name", async () => {
    const harness = createService({ backchannelsEnabled: () => false });
    await openCall(harness);
    utter(harness, "what merged yesterday");
    await tick();
    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });

    const cancel = harness.fake.lastOfType("response.cancel") as Record<string, unknown>;
    expect(cancel).toBeTruthy();
    expect(cancel.response_id).toBe("resp_1");
  });

  /**
   * `response.create` and `response.created` are a round trip apart, and the
   * user can talk inside it. Dropping the cancel there loses the one thing a
   * call must always honour, so it waits for the name instead.
   */
  it("holds a barge-in that arrived before the response had a name, and sends it when it does", async () => {
    const harness = createService({ backchannelsEnabled: () => false });
    await openCall(harness);
    utter(harness, "what merged yesterday");
    await tick();

    // The answer has been asked for, and the server has not named it yet.
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
   * The realtime model is ears and a mouth: it cannot read an image. The only
   * place a captured window can actually be looked at is the backend that does
   * the thinking.
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

    utter(harness, "what is this showing");
    await tick();
    expect(seen).toEqual(["PNGDATA"]);

    // One capture, one turn: it must not ride along on the next one too.
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    utter(harness, "and the one before it");
    await tick();
    expect(seen).toEqual(["PNGDATA", null]);
  });

  it("hands output audio straight to the renderer", async () => {
    const chunks: string[] = [];
    const harness = createService({ onOutputAudio: (b64: string) => chunks.push(b64) } as never);
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
    const harness = createService({ setCallConfirmMode: async (v: boolean) => { calls.push(v); } } as never);

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
 * real answer. Every test here is one of those transcripts, or the real speech
 * that must still get through.
 */
describe("the transcript gate", () => {
  /** Every rejection the gate logged, in order. */
  function rejections(info: ReturnType<typeof vi.fn>) {
    return info.mock.calls
      .filter(([event]) => event === "cto_voice.transcript_rejected")
      .map(([, meta]) => meta as { reason: string; text: string });
  }

  function gatedCall() {
    const info = vi.fn();
    const intents: string[] = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: { info, warn: vi.fn() },
      runBackendTurn: async ({ intent }: { intent: string }) => {
        intents.push(intent);
        return { spoken: "ok" };
      },
    } as never);
    return { harness, info, intents };
  }

  it("throws away a transcript with no words in it", async () => {
    const { harness, info, intents } = gatedCall();
    await openCall(harness);

    utter(harness, "   ");
    await tick();
    // Punctuation only is the other shape silence comes back as.
    utter(harness, " … ");
    await tick();

    expect(intents).toEqual([]);
    expect(spoken(harness.fake)).toEqual([]);
    expect(harness.latest().captions).toEqual([]);
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["empty", "empty"]);
  });

  it("throws away words the transcriber invented out of a quiet room", async () => {
    const { harness, info, intents } = gatedCall();
    await openCall(harness);

    // The exact transcripts from the owner's call, over the microphone level a
    // quiet room actually produces.
    for (const phantom of ["Haha.", "OK,OK,好好好。", "아니."]) {
      utter(harness, phantom, { level: ROOM_NOISE_LEVEL });
      await tick();
    }

    expect(intents).toEqual([]);
    expect(spoken(harness.fake)).toEqual([]);
    expect(harness.latest().captions).toEqual([]);
    expect(rejections(info).map((entry) => entry.text))
      .toEqual(["Haha.", "OK,OK,好好好。", "아니."]);
    expect(new Set(rejections(info).map((entry) => entry.reason)))
      .toEqual(new Set(["no_speech_energy"]));
  });

  it("answers a transcript the microphone heard the user say", async () => {
    const { harness, intents } = gatedCall();
    await openCall(harness);

    utter(harness, "what merged yesterday");
    await tick();

    expect(intents).toEqual(["what merged yesterday"]);
    expect(harness.latest().captions.map((caption) => caption.text))
      .toEqual(["what merged yesterday"]);
  });

  it("accepts a one-word answer, which is the shortest thing a call must hear", async () => {
    // The gate's length rule is allowed to reject a click. It is not allowed to
    // reject "yes", which is the whole spoken-confirmation system.
    const { harness, intents } = gatedCall();
    await openCall(harness);

    utter(harness, "yes", { frames: 4 });
    await tick();

    expect(intents).toEqual(["yes"]);
  });

  it("rejects a click that carried a sentence", async () => {
    const { harness, info, intents } = gatedCall();
    await openCall(harness);

    // One loud frame — 85 ms — is a door or a keyboard, not a sentence.
    utter(harness, "ship it", { frames: 1 });
    await tick();

    expect(intents).toEqual([]);
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["too_short"]);
  });

  it("ignores its own voice arriving back through the microphone", async () => {
    const { harness, info, intents } = gatedCall();
    await openCall(harness);

    // ADE is speaking, and every frame of the segment lands under that speech at
    // the level echo cancellation leaves behind.
    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    hearMic(harness, { level: ROOM_NOISE_LEVEL, frames: 12 });
    harness.fake.receive({ type: "input_audio_buffer.speech_stopped" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Three merged yesterday.",
    });
    await tick();

    expect(intents).toEqual([]);
    expect(harness.latest().captions).toEqual([]);
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["echo"]);
  });

  it("shuts the gate on a runaway, and opens it again after quiet", async () => {
    let clock = 1_000_000;
    const info = vi.fn();
    const intents: string[] = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: { info, warn: vi.fn() },
      now: () => clock,
      runBackendTurn: async ({ intent }: { intent: string }) => {
        intents.push(intent);
        return { spoken: "ok" };
      },
    } as never);
    await openCall(harness);

    // Five turns inside the window — faster than the CTO can even finish
    // speaking one answer, so the source, not the user, is producing them.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_500;
      utter(harness, `question ${i}`);
      await tick();
      harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    }
    expect(intents).toHaveLength(5);
    expect(info.mock.calls.some(([event]) => event === "cto_voice.transcript_valve_tripped"))
      .toBe(true);

    // Real speech is now turned away too: a gate that only half closes does not
    // stop a runaway.
    clock += 1_500;
    utter(harness, "please stop");
    await tick();
    expect(intents).toHaveLength(5);
    expect(rejections(info).map((entry) => entry.reason)).toEqual(["runaway"]);

    // Quiet is what opens it: no transcript for the cooldown, and the user has
    // their call back.
    clock += CTO_VOICE_TURN_BURST_COOLDOWN_MS + 1;
    utter(harness, "are you there");
    await tick();
    expect(intents.at(-1)).toBe("are you there");
    expect(info.mock.calls.some(([event]) => event === "cto_voice.transcript_valve_cleared"))
      .toBe(true);
  });

  it("does not let one segment's silence count against the next one's speech", async () => {
    const { harness, intents } = gatedCall();
    await openCall(harness);

    utter(harness, "…", { level: ROOM_NOISE_LEVEL });
    await tick();
    utter(harness, "what is left");
    await tick();

    expect(intents).toEqual(["what is left"]);
  });

  /* ── The meter's memory ──────────────────────────────────────────────────
   *
   * The gate above was RUNNING on the build that let a phantom "好" through,
   * and these three tests are why it did not help. The meter was a set of
   * running totals cleared only by a judgement, so the first transcript of a
   * call was judged against every frame since the microphone opened — and
   * `voicedMs` was a SUM, which a quiet room reaches given enough seconds.
   * ──────────────────────────────────────────────────────────────────────── */

  /** A gate whose clock the test owns, so frames can be placed in time. */
  function timedCall() {
    let clock = 1_000_000;
    const info = vi.fn();
    const intents: string[] = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: { info, warn: vi.fn() },
      now: () => clock,
      runBackendTurn: async ({ intent }: { intent: string }) => {
        intents.push(intent);
        return { spoken: "ok" };
      },
    } as never);
    return {
      harness,
      info,
      intents,
      advance: (ms: number) => { clock += ms; },
      /** One frame, at the current instant, at the level given. */
      frame: (level: number) => harness.service.pushAudio(MIC_FRAME, level),
    };
  }

  it("does not add up transients scattered across a long quiet stretch", async () => {
    const call = timedCall();
    await openCall(call.harness);

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
      transcript: "好",
    });
    await tick();

    expect(call.intents).toEqual([]);
    expect(rejections(call.info).map((entry) => entry.reason)).toEqual(["too_short"]);
  });

  it("accepts energy that stays up for a word's length", async () => {
    const call = timedCall();
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

    expect(call.intents).toEqual(["ship it"]);
  });

  it("forgets a loud moment that has fallen out of the window", async () => {
    const call = timedCall();
    await openCall(call.harness);

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
      transcript: "아니.",
    });
    await tick();

    expect(call.intents).toEqual([]);
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
    const { harness, info, intents } = gatedCall();
    await openCall(harness);

    utter(harness, "what merged yesterday");
    await tick();

    expect(intents).toEqual(["what merged yesterday"]);
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
    } as never);
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

  it("does not count a transcript nobody said", async () => {
    const reports: Array<{ exchanges: number; live: boolean }> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: { info: vi.fn(), warn: vi.fn() },
      onExchange: (args: { exchanges: number; live: boolean }) => reports.push(args),
    } as never);
    await openCall(harness);

    utter(harness, "hey there");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    utter(harness, "OK,OK,好好好。", { level: ROOM_NOISE_LEVEL });
    await tick();

    expect(reports).toEqual([{ exchanges: 1, live: true }]);
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
    const harness = createService({ logger: { info: () => {}, warn } } as never);
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
