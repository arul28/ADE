import { describe, expect, it } from "vitest";
import { createFailureLogDeduper } from "./failureLogDeduper";

describe("createFailureLogDeduper", () => {
  it("logs a burst once and emits at most one summary per minute", () => {
    const lines: string[] = [];
    let now = 0;
    const deduper = createFailureLogDeduper({
      log: (line) => lines.push(line),
      now: () => now,
    });
    for (let index = 0; index < 10; index += 1) deduper.note("disk", "failed");
    expect(lines).toEqual(["failed"]);

    now = 60_000;
    deduper.note("disk", "failed");
    deduper.note("disk", "failed");
    expect(lines).toEqual(["failed", "ADE brain sync host still failing (11 occurrences): failed"]);

    now = 119_999;
    deduper.note("disk", "failed");
    expect(lines).toHaveLength(2);
  });

  it("carries each note's meta to the log callback, on both branches", () => {
    const calls: Array<{ line: string; meta: Record<string, unknown> | undefined }> = [];
    let now = 0;
    const deduper = createFailureLogDeduper({
      log: (line, meta) => calls.push({ line, meta }),
      now: () => now,
    });

    deduper.note("disk", "failed", { attempt: 1 });
    expect(calls[0]?.meta).toEqual({ attempt: 1 });

    // The summary carries the LATEST attempt, not the first one's.
    deduper.note("disk", "failed", { attempt: 2 });
    now = 60_000;
    deduper.note("disk", "failed", { attempt: 3 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.meta).toEqual({ attempt: 3 });
  });
});
