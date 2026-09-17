import { describe, expect, it } from "vitest";

import {
  CTO_VOICE_TURN_BURST_COOLDOWN_MS,
  CTO_VOICE_TURN_BURST_LIMIT,
  CTO_VOICE_TURN_BURST_WINDOW_MS,
} from "../../../shared/types/ctoVoice";
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
});
