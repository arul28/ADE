import { describe, expect, it } from "vitest";
import { recordWriterGone } from "./processStartTime";

const runs = () => true;

describe("recordWriterGone", () => {
  it("never reads a live writer as gone, and reads a reused process id as gone", () => {
    const now = Date.now();
    const longAgo = now - 10 * 365 * 24 * 60 * 60_000;

    // The process that wrote the record still has the id.
    expect(recordWriterGone(process.pid, now, runs)).toBe(false);
    expect(recordWriterGone(process.ppid, now, runs)).toBe(false);
    // A record time that cannot be read proves nothing against a running id.
    expect(recordWriterGone(process.pid, Number.NaN, runs)).toBe(false);
    expect(recordWriterGone(process.ppid, Number.NaN, runs)).toBe(false);

    // The id does not run at all.
    expect(recordWriterGone(process.ppid, now, () => false)).toBe(true);
    // The record is older than the process that has the id now: after a
    // restart of the computer, another process (or this one) got the id.
    expect(recordWriterGone(process.ppid, longAgo, runs)).toBe(true);
    expect(recordWriterGone(process.pid, longAgo, runs)).toBe(true);
  });
});
