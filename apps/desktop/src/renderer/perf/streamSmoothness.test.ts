import { describe, expect, it } from "vitest";
import { StreamSmoothnessAccumulator } from "./streamSmoothness";

/**
 * Pure window math only — the rAF loop and DOM reads are deliberately not
 * exercised here (timing-based rAF assertions are brittle and prove nothing
 * about the aggregation this file owns).
 */
describe("StreamSmoothnessAccumulator", () => {
  it("counts advancing frames and the gaps between them", () => {
    const acc = new StreamSmoothnessAccumulator(100);

    expect(acc.addFrame(0, 0)).toBeNull(); // baseline
    expect(acc.addFrame(10, 0)).toBeNull();
    expect(acc.addFrame(20, 5)).toBeNull(); // advance, first — no gap yet
    expect(acc.addFrame(30, 5)).toBeNull();
    expect(acc.addFrame(40, 10)).toBeNull(); // advance, gap 20
    const window = acc.addFrame(100, 10); // closes the window

    expect(window).toEqual({
      framesTotal: 6,
      framesAdvanced: 2,
      advancedRatio: 0.33,
      gapP50: 20,
      gapP95: 20,
      gapMax: 20,
      // Intervals 10,10,10,10,60 → median 10. Window ran 0→100.
      frameIntervalP50: 10,
      durationMs: 100,
      charsAdvanced: 10,
    });
  });

  it("reports the median rAF interval so consumers can infer the refresh rate", () => {
    const acc = new StreamSmoothnessAccumulator(100);

    // A 240 Hz display: ~4.17ms between frames.
    for (let i = 0; i <= 23; i += 1) acc.addFrame(i * 4.17, i);
    const window = acc.addFrame(100, 24);

    expect(window?.frameIntervalP50).toBeCloseTo(4.17, 1);
    expect(1000 / (window?.frameIntervalP50 ?? 1)).toBeCloseTo(240, 0);
  });

  it("attributes a frame interval straddling a window boundary to the later window", () => {
    const acc = new StreamSmoothnessAccumulator(100);

    acc.addFrame(0, 0);
    const first = acc.addFrame(100, 1); // intervals: [100]
    expect(first?.frameIntervalP50).toBe(100);

    acc.addFrame(110, 2); // interval 10 — starts in window 1, lands in window 2
    const second = acc.addFrame(200, 3); // interval 90
    expect(second?.frameIntervalP50).toBe(10);
    expect(second?.durationMs).toBe(100);
  });

  it("counts a gap that spans a window boundary once, in the window where it ends", () => {
    const acc = new StreamSmoothnessAccumulator(100);

    acc.addFrame(0, 0);
    acc.addFrame(10, 5); // advance
    const first = acc.addFrame(100, 5); // no advance; closes window 1
    expect(first).toMatchObject({ framesTotal: 3, framesAdvanced: 1, gapMax: 0 });

    acc.addFrame(110, 10); // advance — the 100ms gap started in window 1
    const second = acc.addFrame(200, 10);

    expect(second).toMatchObject({
      framesTotal: 2,
      framesAdvanced: 1,
      gapP50: 100,
      gapMax: 100,
      charsAdvanced: 5,
    });
  });

  it("rebaselines when the summed length shrinks (rows unmounted) instead of going negative", () => {
    const acc = new StreamSmoothnessAccumulator(100);

    acc.addFrame(0, 100);
    acc.addFrame(10, 40); // virtualization dropped rows — not an advance
    acc.addFrame(20, 50); // +10 against the new baseline
    const window = acc.flush(30);

    expect(window).toMatchObject({
      framesTotal: 3,
      framesAdvanced: 1,
      charsAdvanced: 10,
    });
  });

  it("sums text across all assistant nodes so a message handover is not a reset", () => {
    const acc = new StreamSmoothnessAccumulator(1000);

    // One node growing, then a second node appears at length 1 while the first
    // stays put: the total still advances.
    acc.addFrame(0, 500);
    acc.addFrame(16, 520);
    acc.addFrame(32, 521);
    const window = acc.flush(48);

    expect(window).toMatchObject({ framesAdvanced: 2, charsAdvanced: 21 });
  });

  it("flushes nothing when no frames were seen", () => {
    expect(new StreamSmoothnessAccumulator(100).flush(10)).toBeNull();
  });

  it("reports a zero ratio for a fully stalled window", () => {
    const acc = new StreamSmoothnessAccumulator(100);
    acc.addFrame(0, 42);
    acc.addFrame(50, 42);
    const window = acc.addFrame(100, 42);

    expect(window).toEqual({
      framesTotal: 3,
      framesAdvanced: 0,
      advancedRatio: 0,
      gapP50: 0,
      gapP95: 0,
      gapMax: 0,
      frameIntervalP50: 50,
      durationMs: 100,
      charsAdvanced: 0,
    });
  });
});
