import { describe, expect, it } from "vitest";

import { createOutputAudioQueue } from "./ctoVoiceOutputAudio";

describe("createOutputAudioQueue", () => {
  it("hands the owner everything it queued, in order, once", () => {
    const queue = createOutputAudioQueue(10);
    queue.push("a");
    queue.push("b");

    expect(queue.drain()).toEqual({ chunks: ["a", "b"], dropped: 0 });
    // A second poll a beat later must not replay the audio just played.
    expect(queue.drain()).toEqual({ chunks: [], dropped: 0 });
  });

  /**
   * An owner that stops polling — a frozen window, a renderer being replaced —
   * must cost a bounded amount of memory. What the bound threw away is counted,
   * because the renderer shows it rather than nobody seeing it.
   */
  it("drops the oldest audio past the limit and counts what it dropped", () => {
    const queue = createOutputAudioQueue(3);
    for (const chunk of ["a", "b", "c", "d", "e"]) queue.push(chunk);

    expect(queue.size()).toBe(3);
    expect(queue.drain()).toEqual({ chunks: ["c", "d", "e"], dropped: 2 });
  });

  /**
   * The two ways to empty this queue mean opposite things, which is the whole
   * reason it is a module: a barge-in CANCELS audio the user chose not to hear,
   * so it must not be reported as audio they lost.
   */
  it("clears a barge-in without calling it dropped, and keeps an older tally", () => {
    const queue = createOutputAudioQueue(2);
    for (const chunk of ["a", "b", "c"]) queue.push(chunk);
    expect(queue.size()).toBe(2);

    queue.clear();

    expect(queue.drain()).toEqual({ chunks: [], dropped: 1 });
  });

  it("forgets the last call entirely on reset, cancelled and dropped alike", () => {
    const queue = createOutputAudioQueue(1);
    queue.push("a");
    queue.push("b");

    queue.reset();

    expect(queue.drain()).toEqual({ chunks: [], dropped: 0 });
  });
});
