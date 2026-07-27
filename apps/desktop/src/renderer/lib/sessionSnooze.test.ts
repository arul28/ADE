import { describe, expect, it } from "vitest";
import {
  nextSnoozeDeadlineMs,
  sessionWokeMarker,
  snoozeDeadlineIso,
  snoozeWakeLabel,
  wakeReasonLabel,
} from "./sessionSnooze";

/** Local-time anchor so the evening/morning presets are deterministic. */
function localMs(y: number, m: number, d: number, hh: number, mm = 0): number {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

describe("snoozeDeadlineIso", () => {
  it("adds exactly an hour for the 1-hour preset", () => {
    const now = localMs(2026, 7, 26, 9, 15);
    expect(Date.parse(snoozeDeadlineIso("hour", now))).toBe(now + 3_600_000);
  });

  it("targets 6pm today when the evening has not happened yet", () => {
    const now = localMs(2026, 7, 26, 9, 15);
    expect(Date.parse(snoozeDeadlineIso("evening", now))).toBe(localMs(2026, 7, 26, 18));
  });

  it("rolls to the next evening once 6pm has passed", () => {
    const now = localMs(2026, 7, 26, 20, 0);
    expect(Date.parse(snoozeDeadlineIso("evening", now))).toBe(localMs(2026, 7, 27, 18));
  });

  it("targets 9am the following day for the tomorrow preset, even late at night", () => {
    expect(Date.parse(snoozeDeadlineIso("tomorrow", localMs(2026, 7, 26, 23, 30))))
      .toBe(localMs(2026, 7, 27, 9));
    expect(Date.parse(snoozeDeadlineIso("tomorrow", localMs(2026, 7, 26, 1, 0))))
      .toBe(localMs(2026, 7, 27, 9));
  });

  it("parks 'until I'm asked' far enough out that only a hand-raise brings it back", () => {
    const now = localMs(2026, 7, 26, 9, 15);
    const until = Date.parse(snoozeDeadlineIso("asked", now));
    expect(until - now).toBeGreaterThan(365 * 24 * 3_600_000);
    expect(snoozeWakeLabel(new Date(until).toISOString(), now)).toBe("wakes when asked");
  });
});

describe("snoozeWakeLabel", () => {
  const now = localMs(2026, 7, 26, 9, 0);

  it("counts down in minutes under an hour", () => {
    expect(snoozeWakeLabel(new Date(now + 25 * 60_000).toISOString(), now)).toBe("wakes in 25m");
  });

  it("counts down in hours within the same day", () => {
    expect(snoozeWakeLabel(new Date(now + 3 * 3_600_000).toISOString(), now)).toBe("wakes in 3h");
  });

  it("says tomorrow for a next-day wake that is more than half a day out", () => {
    expect(snoozeWakeLabel(new Date(localMs(2026, 7, 27, 9)).toISOString(), now)).toBe("wakes tomorrow");
  });

  it("keeps an hour countdown for a next-day wake that is only hours away", () => {
    const lateNight = localMs(2026, 7, 26, 23, 0);
    expect(snoozeWakeLabel(new Date(localMs(2026, 7, 27, 2)).toISOString(), lateNight)).toBe("wakes in 3h");
  });

  it("returns null without a deadline and 'wakes now' once it has lapsed", () => {
    expect(snoozeWakeLabel(null, now)).toBeNull();
    expect(snoozeWakeLabel(new Date(now - 1).toISOString(), now)).toBe("wakes now");
  });
});

describe("wakeReasonLabel", () => {
  it("uses specific operational copy per reason", () => {
    expect(wakeReasonLabel("needs_you")).toBe("needs approval");
    expect(wakeReasonLabel("error")).toBe("errored");
    expect(wakeReasonLabel("turn_complete")).toBe("turn finished");
    expect(wakeReasonLabel("timer")).toBe("snooze ended");
    expect(wakeReasonLabel(null)).toBeNull();
  });
});

describe("sessionWokeMarker", () => {
  const now = localMs(2026, 7, 26, 9, 0);

  it("prefers the persisted woke reason", () => {
    expect(sessionWokeMarker({
      snoozedUntil: null,
      snoozedAt: null,
      wokeAt: new Date(now - 60_000).toISOString(),
      wokeReason: "needs_you",
    }, now)).toEqual({ reason: "needs_you", label: "needs approval" });
  });

  it("falls back to a derived timer wake when the snooze merely lapsed", () => {
    expect(sessionWokeMarker({
      snoozedUntil: new Date(now - 60_000).toISOString(),
      snoozedAt: new Date(now - 3_600_000).toISOString(),
      wokeAt: null,
      wokeReason: null,
    }, now)).toEqual({ reason: "timer", label: "snooze ended" });
  });

  it("shows nothing for a row that is still snoozed", () => {
    expect(sessionWokeMarker({
      snoozedUntil: new Date(now + 3_600_000).toISOString(),
      snoozedAt: new Date(now - 60_000).toISOString(),
      wokeAt: null,
      wokeReason: null,
    }, now)).toBeNull();
  });
});

describe("nextSnoozeDeadlineMs", () => {
  const now = localMs(2026, 7, 26, 9, 0);

  it("returns the soonest future deadline so callers arm exactly one timer", () => {
    expect(nextSnoozeDeadlineMs([
      { snoozedUntil: new Date(now + 7_200_000).toISOString() },
      { snoozedUntil: new Date(now + 600_000).toISOString() },
      { snoozedUntil: new Date(now - 600_000).toISOString() },
      { snoozedUntil: null },
    ], now)).toBe(now + 600_000);
  });

  it("returns null when nothing is currently snoozed", () => {
    expect(nextSnoozeDeadlineMs([{ snoozedUntil: null }], now)).toBeNull();
  });
});
