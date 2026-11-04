import { describe, expect, it } from "vitest";

import { createH264FrameGate } from "./h264FrameGate";

describe("createH264FrameGate", () => {
  it("holds P-frames until the keyframe after a sequence gap", () => {
    const gate = createH264FrameGate();
    // A subscriber's first frame is a keyframe by contract; a P-frame that
    // arrives first has nothing to reference.
    expect(gate.shouldDeliver(false, 0)).toBe(false);
    expect(gate.shouldDeliver(true, 1)).toBe(true);
    expect(gate.shouldDeliver(false, 2)).toBe(true);
    expect(gate.shouldDeliver(false, 3)).toBe(true);

    // Backpressure skipped 4 and 5: nothing may be decoded until the host's
    // next keyframe, even though P-frames keep arriving.
    expect(gate.shouldDeliver(false, 6)).toBe(false);
    expect(gate.shouldDeliver(false, 7)).toBe(false);
    expect(gate.shouldDeliver(true, 8)).toBe(true);
    expect(gate.shouldDeliver(false, 9)).toBe(true);
  });

  it("waits for a keyframe after a decoder error with no gap in the sequence", () => {
    const gate = createH264FrameGate();
    expect(gate.shouldDeliver(true, 0)).toBe(true);
    expect(gate.shouldDeliver(false, 1)).toBe(true);

    gate.requireKeyframe();
    expect(gate.awaitingKeyframe).toBe(true);
    expect(gate.shouldDeliver(false, 2)).toBe(false);
    expect(gate.shouldDeliver(true, 3)).toBe(true);
    expect(gate.shouldDeliver(false, 4)).toBe(true);
  });

  it("starts over after reset, and does not treat a retry as a gap", () => {
    const gate = createH264FrameGate();
    expect(gate.shouldDeliver(true, 40)).toBe(true);
    expect(gate.shouldDeliver(false, 41)).toBe(true);

    gate.reset();
    expect(gate.lastSeq).toBeNull();
    expect(gate.awaitingKeyframe).toBe(true);
    // The first record of a resubscribed stream may carry a lower seq: without
    // a last seq there is nothing to compare, so the keyframe is what resumes.
    expect(gate.shouldDeliver(false, 0)).toBe(false);
    expect(gate.shouldDeliver(true, 1)).toBe(true);
  });
});
