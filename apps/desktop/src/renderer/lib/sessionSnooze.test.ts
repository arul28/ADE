import { describe, expect, it } from "vitest";
import {
  nextSnoozeDeadlineMs,
  resolveSnoozePresets,
  sessionWokeMarker,
  snoozeDeadlineIso,
  snoozeWakeDescription,
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

  it("targets the coming Monday 9am for the next-week preset", () => {
    // Wednesday 2026-04-08 → Monday 2026-04-13.
    expect(Date.parse(snoozeDeadlineIso("next-week", localMs(2026, 4, 8, 10))))
      .toBe(localMs(2026, 4, 13, 9));
  });

  it("puts next week a FULL week out when today is already Monday", () => {
    // Monday 2026-04-06 must not resolve to "in a few hours" the same morning.
    expect(Date.parse(snoozeDeadlineIso("next-week", localMs(2026, 4, 6, 10))))
      .toBe(localMs(2026, 4, 13, 9));
    // Sunday is the other edge of the modulo: next Monday is tomorrow.
    expect(Date.parse(snoozeDeadlineIso("next-week", localMs(2026, 4, 12, 10))))
      .toBe(localMs(2026, 4, 13, 9));
  });
});

/** Hours local time skips between two instants — 1 across a spring-forward, 0 in UTC. */
function dstShiftHours(fromMs: number, toMs: number): number {
  return (new Date(fromMs).getTimezoneOffset() - new Date(toMs).getTimezoneOffset()) / 60;
}

/**
 * Regression guard for the classic snooze bug: advancing a deadline by
 * `24 * 60 * 60 * 1000` instead of by a calendar day. A spring-forward day is
 * 23 hours, so a fixed offset taken at 23:30 the night before skips clean over
 * the next day and lands on the one after.
 *
 * These run against the MACHINE'S zone. Repointing `process.env.TZ` inside a
 * vitest worker does not move V8's cached zone, so pinning one here would look
 * rigorous while asserting nothing. The consequence is honest instead: in a
 * DST zone (every dev box in a populated timezone) the assertions below fail on
 * the naive implementation; on a UTC CI box there is no transition to trip over
 * and they reduce to the ordinary calendar case. Both are stated explicitly so
 * the elapsed-time expectations stay exact rather than being loosened.
 */
describe("snoozeDeadlineIso across a DST transition", () => {
  // 2026-03-08 is the US spring-forward (02:00 EST → 03:00 EDT).
  it("lands tomorrow 9am on the spring-forward day itself, from 23:30 the night before", () => {
    const springForwardEve = localMs(2026, 3, 7, 23, 30);
    const until = new Date(snoozeDeadlineIso("tomorrow", springForwardEve));
    expect(until.getDate()).toBe(8);
    expect(until.getHours()).toBe(9);
    // 9.5 wall-clock hours, minus whatever the zone skipped. A `+24h` deadline
    // could not produce this figure at all — it would be past the 9th.
    const lost = dstShiftHours(springForwardEve, until.getTime());
    expect(until.getTime() - springForwardEve).toBe((9.5 - lost) * 3_600_000);
  });

  it("lands the correct morning after the fall-back day's extra hour", () => {
    // 2026-11-01 02:00 EDT → 01:00 EST: a 25-hour day.
    const fallBackEve = localMs(2026, 10, 31, 23, 30);
    const until = new Date(snoozeDeadlineIso("tomorrow", fallBackEve));
    expect(until.getDate()).toBe(1);
    expect(until.getMonth()).toBe(10);
    expect(until.getHours()).toBe(9);
  });

  it("keeps next week on a Monday when a transition falls inside the window", () => {
    // Tuesday 2026-03-03 → Monday 2026-03-09, the day after spring forward.
    const until = new Date(snoozeDeadlineIso("next-week", localMs(2026, 3, 3, 10)));
    expect(until.getDay()).toBe(1);
    expect(until.getDate()).toBe(9);
    expect(until.getHours()).toBe(9);
  });

  it("puts tomorrow on the next calendar day from 23:30 on every day of a year", () => {
    // Sweeps whichever transitions the running zone actually has, in both
    // directions, from the hour of day where a fixed 24h offset does the most
    // damage. Cheap, and it needs no knowledge of the zone's rules.
    for (let dayIndex = 0; dayIndex < 365; dayIndex += 1) {
      const at2330 = new Date(2026, 0, 1 + dayIndex, 23, 30, 0, 0).getTime();
      const expected = new Date(2026, 0, 2 + dayIndex, 9, 0, 0, 0).getTime();
      expect(Date.parse(snoozeDeadlineIso("tomorrow", at2330))).toBe(expected);
    }
  });
});

describe("resolveSnoozePresets", () => {
  it("offers every preset in the morning, open-ended last", () => {
    const presets = resolveSnoozePresets(localMs(2026, 4, 8, 10));
    expect(presets.map((preset) => preset.key)).toEqual([
      "hour",
      "evening",
      "tomorrow",
      "next-week",
      "asked",
    ]);
  });

  it("drops 'This evening' once 6pm is within an hour or already past", () => {
    // 17:30 — the evening deadline would duplicate "In 1 hour".
    expect(resolveSnoozePresets(localMs(2026, 4, 8, 17, 30)).map((preset) => preset.key))
      .toEqual(["hour", "tomorrow", "next-week", "asked"]);
    // 21:00 — "This evening" would silently resolve to TOMORROW evening.
    expect(resolveSnoozePresets(localMs(2026, 4, 8, 21)).map((preset) => preset.key))
      .toEqual(["hour", "tomorrow", "next-week", "asked"]);
    // 16:59 is still more than an hour out, so the row survives.
    expect(resolveSnoozePresets(localMs(2026, 4, 8, 16, 59)).map((preset) => preset.key))
      .toContain("evening");
  });

  it("keeps the open-ended preset at every hour of the day", () => {
    // The `asked` row has no clock semantics, so nothing may ever suppress it —
    // it is the only preset backed by the session's own wake signals.
    for (let hour = 0; hour < 24; hour += 1) {
      const presets = resolveSnoozePresets(localMs(2026, 4, 8, hour));
      expect(presets[presets.length - 1]!.key).toBe("asked");
      expect(presets.find((preset) => preset.key === "asked")!.whenLabel).toBe("on a hand-raise");
    }
  });

  it("gives every row a time column that complements rather than repeats its label", () => {
    const presets = resolveSnoozePresets(localMs(2026, 4, 8, 10));
    for (const preset of presets) {
      // Day words live in the label column; the time column carries the clock
      // (plus a weekday for next week, which names a different day). "In 1
      // hour" is a duration, not a clock time, so only clock times are barred.
      expect(preset.label.toLowerCase()).not.toMatch(/\d\s*(am|pm)|\d:\d/);
      expect(preset.whenLabel.toLowerCase()).not.toContain("tomorrow");
    }
    expect(presets.find((preset) => preset.key === "tomorrow")!.whenLabel).toMatch(/9/);
    expect(presets.find((preset) => preset.key === "next-week")!.whenLabel).toMatch(/Mon/);
  });

  it("hands each row the deadline it will actually write", () => {
    const now = localMs(2026, 4, 8, 10);
    for (const preset of resolveSnoozePresets(now)) {
      expect(preset.untilIso).toBe(snoozeDeadlineIso(preset.key, now));
      expect(Date.parse(preset.untilIso)).toBeGreaterThan(now);
    }
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

describe("snoozeWakeDescription", () => {
  // Wednesday 2026-04-08 10:00 local.
  const now = localMs(2026, 4, 8, 10);

  it("gives a bare time for a wake later today", () => {
    const description = snoozeWakeDescription(new Date(localMs(2026, 4, 8, 18)).toISOString(), now);
    expect(description).toMatch(/\d/);
    expect(description).not.toContain("tomorrow");
    expect(description).not.toMatch(/Wed|,/);
  });

  it("names tomorrow explicitly", () => {
    expect(snoozeWakeDescription(new Date(localMs(2026, 4, 9, 9)).toISOString(), now))
      .toMatch(/^tomorrow /);
  });

  it("uses a weekday inside the coming week", () => {
    expect(snoozeWakeDescription(new Date(localMs(2026, 4, 13, 9)).toISOString(), now))
      .toMatch(/^Mon /);
  });

  it("switches to a date past a week, where a weekday would be ambiguous", () => {
    const description = snoozeWakeDescription(
      new Date(localMs(2026, 4, 20, 9)).toISOString(),
      now,
    );
    expect(description).not.toMatch(/^tomorrow |^Mon /);
    // The date branch is the only one that carries a comma ("Apr 20, 9:00 AM"),
    // which keeps the assertion off the locale's month spelling.
    expect(description).toMatch(/20/);
    expect(description).toContain(",");
  });

  it("reads the ~100-year 'until asked' deadline as a condition, not a date", () => {
    expect(snoozeWakeDescription(snoozeDeadlineIso("asked", now), now)).toBe("when you're asked");
  });

  it("returns null without a deadline and 'now' once it has lapsed", () => {
    expect(snoozeWakeDescription(null, now)).toBeNull();
    expect(snoozeWakeDescription("not-a-date", now)).toBeNull();
    expect(snoozeWakeDescription(new Date(now - 1).toISOString(), now)).toBe("now");
  });

  it("counts calendar days, not 24h blocks, across a spring-forward", () => {
    // Sat 2026-03-07 10:00 → Mon 2026-03-09 09:00 is two calendar days but, in
    // a zone observing the 2026-03-08 spring-forward, only 46 hours of real
    // time. Dividing the remaining milliseconds by 24h floors that to 1 and
    // mislabels Monday as "tomorrow"; `calendarDayDelta` does not.
    const beforeTransition = localMs(2026, 3, 7, 10);
    expect(snoozeWakeDescription(new Date(localMs(2026, 3, 9, 9)).toISOString(), beforeTransition))
      .toMatch(/^Mon /);
    // …and the genuine next day still reads as tomorrow.
    expect(snoozeWakeDescription(new Date(localMs(2026, 3, 8, 9)).toISOString(), beforeTransition))
      .toMatch(/^tomorrow /);
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
