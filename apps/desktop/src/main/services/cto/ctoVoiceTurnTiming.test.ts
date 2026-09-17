import { describe, expect, it } from "vitest";

import { askCto, createService, hearMic, openCall, tick, utter } from "./ctoVoiceCallHarness";
import { createTurnTimingRecorder } from "./ctoVoiceTurnTiming";

/**
 * How long one voice turn took, leg by leg.
 *
 * The record is only worth having if it appears for the turns that went WRONG
 * as well as the ones that went right, so each case here is about which record
 * gets written and when: a turn nobody heard, a turn the user talked over, and
 * a turn that was replaced before it answered.
 */

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
