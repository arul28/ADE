import { describe, expect, it } from "vitest";

import {
  CTO_VOICE_TURN_BURST_COOLDOWN_MS,
  CTO_VOICE_TURN_BURST_LIMIT,
  CTO_VOICE_TURN_BURST_WINDOW_MS,
} from "../../../shared/types/ctoVoice";
import { createService, openCall, utter } from "./ctoVoiceCallHarness";
import { createTranscriptBurstValve } from "./ctoVoiceTurnBurst";

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
