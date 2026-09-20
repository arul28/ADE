import { describe, expect, it, vi } from "vitest";

import { CTO_VOICE_MIN_SPEECH_MS, CTO_VOICE_TURN_BURST_COOLDOWN_MS } from "../../../shared/types/ctoVoice";
import {
  MIC_FRAME,
  ROOM_NOISE_LEVEL,
  SPEAKING_LEVEL,
  createService,
  hearMic,
  openCall,
  spoken,
  tick,
  utter,
} from "./ctoVoiceCallHarness";

/**
 * What ADE's own microphone heard, and what that says about a transcript.
 *
 * Driven through a real call rather than against the meter alone, because the
 * rule the gate exists for is a rule about ONE decision: a transcript may be
 * captioned and counted whatever the meter thought, and may only answer a
 * question ADE asked out loud when the meter agrees somebody spoke.
 */

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
