import { describe, expect, it } from "vitest";
import type { SimRecording } from "../../../main/services/ios/recording/simRecordingService";
import {
  canDeleteRecording,
  describeRecording,
  formatRecordingBytes,
  formatRecordingElapsed,
  isRecordingActive,
  recordingElapsedMs,
  sortRecordings,
  summarizeRecordings,
} from "./appleRecording";

function recording(overrides: Partial<SimRecording> = {}): SimRecording {
  return {
    id: "rec-1",
    laneId: "lane-1",
    udid: "UDID-1",
    chatSessionId: null,
    path: "/tmp/rec-1.mp4",
    startedAt: "2026-09-21T10:00:00.000Z",
    endedAt: "2026-09-21T10:00:42.000Z",
    durationMs: 42_000,
    bytes: 1024 * 1024,
    mode: "manual",
    proof: false,
    label: null,
    overlays: true,
    ...overrides,
  };
}

describe("formatRecordingElapsed", () => {
  it("pads to mm:ss and grows an hours field", () => {
    expect(formatRecordingElapsed(0)).toBe("00:00");
    expect(formatRecordingElapsed(42_000)).toBe("00:42");
    expect(formatRecordingElapsed(84_000)).toBe("01:24");
    expect(formatRecordingElapsed(3_723_000)).toBe("1:02:03");
  });

  it("never renders a negative clock", () => {
    expect(formatRecordingElapsed(-5_000)).toBe("00:00");
  });
});

describe("recordingElapsedMs", () => {
  it("uses the recorded duration once a recording has ended", () => {
    expect(recordingElapsedMs(recording(), Date.parse("2026-09-21T12:00:00.000Z"))).toBe(42_000);
  });

  it("measures an in-flight recording against the caller's clock", () => {
    // `now` is passed in rather than read here so one tick in the column drives
    // every row, instead of each row holding a clock of its own.
    const live = recording({ endedAt: null, durationMs: null });
    expect(recordingElapsedMs(live, Date.parse("2026-09-21T10:00:10.000Z"))).toBe(10_000);
  });

  it("answers zero for an unparseable start rather than NaN", () => {
    const broken = recording({ endedAt: null, durationMs: null, startedAt: "not a date" });
    expect(recordingElapsedMs(broken, Date.now())).toBe(0);
  });
});

describe("summarizeRecordings and deletion", () => {
  it("counts bytes and pins", () => {
    const summary = summarizeRecordings([
      recording({ id: "a", bytes: 1_000 }),
      recording({ id: "b", bytes: 2_000, proof: true }),
      recording({ id: "c", bytes: null }),
    ]);
    expect(summary).toEqual({ count: 3, totalBytes: 3_000, pinnedCount: 1 });
  });

  it("refuses to offer delete on a proof-pinned recording", () => {
    expect(canDeleteRecording(recording({ proof: true }))).toBe(false);
    expect(canDeleteRecording(recording())).toBe(true);
  });
});

describe("sortRecordings", () => {
  it("puts the in-flight recording first, then newest", () => {
    const rows = sortRecordings([
      recording({ id: "old", startedAt: "2026-09-21T09:00:00.000Z" }),
      recording({ id: "live", endedAt: null, durationMs: null, startedAt: "2026-09-21T08:00:00.000Z" }),
      recording({ id: "new", startedAt: "2026-09-21T11:00:00.000Z" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["live", "new", "old"]);
  });
});

describe("describeRecording", () => {
  it("names the owner and the mode", () => {
    expect(describeRecording(recording({ chatSessionId: "chat-1", mode: "auto" }))).toBe("agent · auto");
    expect(describeRecording(recording({ mode: "manual" }))).toBe("manual");
    expect(describeRecording(recording({ proof: true }))).toBe("manual · pinned");
  });
});

describe("formatRecordingBytes", () => {
  it("scales and never prints a bare zero for an unknown size", () => {
    expect(formatRecordingBytes(null)).toBe("—");
    expect(formatRecordingBytes(0)).toBe("—");
    expect(formatRecordingBytes(512)).toBe("512 B");
    expect(formatRecordingBytes(1024 * 1024 * 3)).toBe("3 MB");
  });
});

describe("isRecordingActive", () => {
  it("is exactly the absence of an end stamp", () => {
    expect(isRecordingActive(recording({ endedAt: null }))).toBe(true);
    expect(isRecordingActive(recording())).toBe(false);
  });
});
