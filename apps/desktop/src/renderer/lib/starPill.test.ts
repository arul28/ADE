import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAR_PILL_PREFS,
  STAR_PILL_CHECK_INTERVAL_MS,
  isStarCheckDue,
  isStarPillVisible,
  mergeStarPillPrefs,
  normalizeStarPillPrefs,
  type StarPillPrefs,
} from "./starPill";

const prefs = (over: Partial<StarPillPrefs> = {}): StarPillPrefs => ({
  ...DEFAULT_STAR_PILL_PREFS,
  ...over,
});

describe("isStarPillVisible", () => {
  it("needs a sent message, and never returns once the repo is starred", () => {
    expect(isStarPillVisible(prefs())).toBe(false);
    expect(isStarPillVisible(prefs({ hasSentMessage: true }))).toBe(true);
    expect(isStarPillVisible(prefs({ hasSentMessage: true, starred: true }))).toBe(false);
  });

  it("returns exactly when the snooze count is reached", () => {
    const snoozed = prefs({ hasSentMessage: true, threadsCreated: 19, snoozedUntilThreadCount: 20 });
    expect(isStarPillVisible(snoozed)).toBe(false);
    expect(isStarPillVisible({ ...snoozed, threadsCreated: 20 })).toBe(true);
    expect(isStarPillVisible({ ...snoozed, threadsCreated: 21 })).toBe(true);
  });
});

describe("mergeStarPillPrefs", () => {
  it("keeps both machines' progress instead of letting the newer copy win", () => {
    // A machine that only bumped its counter must not erase the star or the
    // snooze another machine recorded.
    const local = prefs({ starred: true, threadsCreated: 3, lastCheckedAt: 500 });
    const merged = mergeStarPillPrefs(local, {
      hasSentMessage: true,
      threadsCreated: 40,
      snoozedUntilThreadCount: 60,
      starred: false,
      lastCheckedAt: 100,
    });
    expect(merged).toEqual({
      hasSentMessage: true,
      threadsCreated: 40,
      snoozedUntilThreadCount: 60,
      starred: true,
      lastCheckedAt: 500,
    });
  });

  it("treats a missing or malformed remote copy as no progress", () => {
    const local = prefs({ hasSentMessage: true, snoozedUntilThreadCount: 20 });
    expect(mergeStarPillPrefs(local, null)).toEqual(local);
    expect(mergeStarPillPrefs(local, "nonsense")).toEqual(local);
    expect(normalizeStarPillPrefs({ threadsCreated: -5, starred: "yes" }))
      .toEqual({ ...DEFAULT_STAR_PILL_PREFS });
  });
});

describe("isStarCheckDue", () => {
  it("is due before the first check, at the interval, and never parks on a future stamp", () => {
    expect(isStarCheckDue(prefs(), 1_000)).toBe(true);
    const checked = prefs({ lastCheckedAt: 1_000 });
    expect(isStarCheckDue(checked, 1_000 + STAR_PILL_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(isStarCheckDue(checked, 1_000 + STAR_PILL_CHECK_INTERVAL_MS)).toBe(true);
    // Another machine's skewed clock must not hide the pill for hours.
    expect(isStarCheckDue(prefs({ lastCheckedAt: 2_000_000 }), 1_000)).toBe(true);
  });
});
