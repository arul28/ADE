import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CTO_VOICE_WORKING_NUDGE_AFTER_MS,
  CTO_VOICE_WORKING_NUDGE_EVERY_MS,
  CTO_VOICE_WORKING_NUDGE_MAX,
} from "../../../shared/types/ctoVoice";
import { createWorkingNudger } from "./ctoVoiceWorkingNudge";

/**
 * The clock on its own, with nothing around it.
 *
 * The call suite drives these sentences through a real call and a fake socket,
 * which is what proves they reach the wire. What it cannot show cheaply is the
 * arithmetic: the wait is measured from the last thing the user could HEAR, it
 * defers rather than gives up, and it is capped per request.
 */

function createNudger(overrides: Partial<Parameters<typeof createWorkingNudger>[0]> = {}) {
  const notes: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let responses = 0;
  const nudger = createWorkingNudger({
    // The same clock the timers run on: `vi.useFakeTimers` mocks `Date.now`, so
    // a hand-rolled counter beside it would drift the moment a timer re-arms
    // itself from inside an advance.
    now: () => Date.now(),
    log: (_event, meta) => logs.push(meta ?? {}),
    enabled: () => true,
    canSpeakNow: () => true,
    think: (note) => { notes.push(note); },
    requestModelResponse: () => { responses += 1; },
    ...overrides,
  });
  return {
    nudger,
    notes,
    logs,
    responses: () => responses,
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}

describe("createWorkingNudger", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("says nothing until the request has been silent for the first wait", async () => {
    const harness = createNudger();
    harness.nudger.start();

    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS - 1);
    expect(harness.notes).toEqual([]);

    await harness.advance(1);
    expect(harness.notes).toHaveLength(1);
    expect(harness.notes[0]).toContain("about 7 seconds so far");
    expect(harness.notes[0]).toContain("do not invent results");
    expect(harness.responses()).toBe(1);
  });

  /**
   * The wait is measured from the last moment the user had something to LISTEN
   * to, not from when the request started. An acknowledgement still playing is
   * company already; a sentence on top of it is the call talking over itself.
   */
  it("waits behind audio the user can still hear", async () => {
    const harness = createNudger();
    harness.nudger.start();
    // Two seconds of acknowledgement, handed over at the start of the request.
    harness.nudger.noteAudioDeadline(Date.now() + 2_000);

    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS);
    expect(harness.notes).toEqual([]);

    await harness.advance(2_000);
    expect(harness.notes).toHaveLength(1);
  });

  /**
   * Deferred, not dropped. The request is still running, so the sentence is
   * still owed — it just waits out one more gap rather than talking over a
   * question ADE asked or a user mid-sentence.
   */
  it("defers while something else has the floor, and says it once the floor is free", async () => {
    let floor = false;
    const harness = createNudger({ canSpeakNow: () => floor });
    harness.nudger.start();

    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS);
    expect(harness.notes).toEqual([]);

    floor = true;
    await harness.advance(CTO_VOICE_WORKING_NUDGE_EVERY_MS);
    expect(harness.notes).toHaveLength(1);
  });

  it("uses the longer gap for every sentence after the first", async () => {
    const harness = createNudger();
    harness.nudger.start();

    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS);
    expect(harness.notes).toHaveLength(1);

    await harness.advance(CTO_VOICE_WORKING_NUDGE_EVERY_MS - 1);
    expect(harness.notes).toHaveLength(1);

    await harness.advance(1);
    expect(harness.notes).toHaveLength(2);
    expect(harness.notes[1]).toContain("about 19 seconds so far");
  });

  it("stops at the cap rather than filling the rest of the wait", async () => {
    const harness = createNudger();
    harness.nudger.start();

    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS);
    await harness.advance(CTO_VOICE_WORKING_NUDGE_EVERY_MS * 10);

    expect(harness.notes).toHaveLength(CTO_VOICE_WORKING_NUDGE_MAX);
    expect(harness.logs.map((line) => line.nudge)).toEqual([1, 2, 3]);
  });

  it("says nothing at all when the user asked it to work silently", async () => {
    const harness = createNudger({ enabled: () => false });
    harness.nudger.start();

    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS * 5);
    expect(harness.notes).toEqual([]);
    expect(harness.responses()).toBe(0);
  });

  it("goes quiet the moment the request it was covering for ends", async () => {
    const harness = createNudger();
    harness.nudger.start();

    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS);
    expect(harness.notes).toHaveLength(1);

    harness.nudger.stop();
    await harness.advance(CTO_VOICE_WORKING_NUDGE_EVERY_MS * 5);
    expect(harness.notes).toHaveLength(1);
  });

  /**
   * Per request, not per call: a call with four slow requests in it is four
   * separate silences, and a counter that survived one of them would leave the
   * user listening to nothing for the rest of the call.
   */
  it("starts the count again for the next request", async () => {
    const harness = createNudger();
    harness.nudger.start();
    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS);
    await harness.advance(CTO_VOICE_WORKING_NUDGE_EVERY_MS * 10);
    expect(harness.notes).toHaveLength(CTO_VOICE_WORKING_NUDGE_MAX);
    harness.nudger.stop();

    harness.nudger.start();
    await harness.advance(CTO_VOICE_WORKING_NUDGE_AFTER_MS);
    expect(harness.notes).toHaveLength(CTO_VOICE_WORKING_NUDGE_MAX + 1);
    // The elapsed seconds are this request's, not the call's.
    expect(harness.notes[CTO_VOICE_WORKING_NUDGE_MAX]).toContain("about 7 seconds so far");
  });
});
