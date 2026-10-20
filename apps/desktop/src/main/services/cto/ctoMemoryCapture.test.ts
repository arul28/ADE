import { describe, expect, it } from "vitest";

import { parseContinuityCapture } from "./ctoMemoryCapture";

describe("parseContinuityCapture", () => {
  it("does not replace a summary when none is labeled and keeps known fact kinds", () => {
    const capture = parseContinuityCapture([
      "I cannot provide a summary for this conversation.",
      "DURABLE:",
      "- decision: Keep retries idempotent across the API boundary.",
      "- convention: Use sentence case in user-facing copy.",
    ].join("\n"));

    expect(capture.summary).toBeNull();
    expect(capture.facts).toEqual([
      { kind: "decision", text: "Keep retries idempotent across the API boundary." },
      { kind: "convention", text: "Use sentence case in user-facing copy." },
    ]);
    expect(capture.facts).toHaveLength(2);
  });
});
