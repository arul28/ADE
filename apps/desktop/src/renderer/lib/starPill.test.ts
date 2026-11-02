import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAR_PILL_PREFS,
  STAR_PILL_CHECK_INTERVAL_MS,
  isStarCheckDue,
  isStarPillVisible,
  mergeStarPillPrefs,
  normalizeStarPillPrefs,
  starPillCountsMessages,
  type StarPillPrefs,
} from "./starPill";

const prefs = (over: Partial<StarPillPrefs> = {}): StarPillPrefs => ({
  ...DEFAULT_STAR_PILL_PREFS,
  ...over,
});

describe("isStarPillVisible", () => {
  it("needs a sent message, and never returns once the repo is starred", () => {
    expect(isStarPillVisible(prefs())).toBe(false);
    expect(isStarPillVisible(prefs({ messagesSent: 1 }))).toBe(true);
    expect(isStarPillVisible(prefs({ messagesSent: 1, starred: true }))).toBe(false);
  });

  it("returns once, exactly when the snooze count is reached, and the second dismissal is final", () => {
    const snoozed = prefs({ messagesSent: 20, dismissCount: 1, snoozedUntilMessageCount: 21 });
    expect(isStarPillVisible(snoozed)).toBe(false);
    expect(starPillCountsMessages(snoozed)).toBe(true);
    const back = { ...snoozed, messagesSent: 21 };
    expect(isStarPillVisible(back)).toBe(true);
    expect(starPillCountsMessages(back)).toBe(false);
    expect(isStarPillVisible({ ...back, dismissCount: 2 })).toBe(false);
  });
});

describe("mergeStarPillPrefs", () => {
  it("keeps both machines' progress instead of letting the newer copy win", () => {
    // A machine that only bumped its counter must not erase the star or the
    // dismissal another machine recorded.
    const local = prefs({ starred: true, messagesSent: 3, lastCheckedAt: 500 });
    const merged = mergeStarPillPrefs(local, {
      messagesSent: 40,
      dismissCount: 1,
      shownReported: 2,
      snoozedUntilMessageCount: 60,
      starred: false,
      lastCheckedAt: 100,
    });
    expect(merged).toEqual({
      messagesSent: 40,
      dismissCount: 1,
      shownReported: 2,
      snoozedUntilMessageCount: 60,
      starred: true,
      lastCheckedAt: 500,
    });
  });

  it("reads an older machine's chat-count snooze as one dismissal, not a fresh prompt", () => {
    const local = prefs({ messagesSent: 1 });
    const merged = mergeStarPillPrefs(local, { hasSentMessage: true, threadsCreated: 4, snoozedUntilThreadCount: 20 });
    expect(merged.dismissCount).toBe(1);
    expect(isStarPillVisible(merged)).toBe(false);
  });

  it("treats a missing or malformed remote copy as no progress", () => {
    const local = prefs({ messagesSent: 1, dismissCount: 1, snoozedUntilMessageCount: 21 });
    expect(mergeStarPillPrefs(local, null)).toEqual(local);
    expect(mergeStarPillPrefs(local, "nonsense")).toEqual(local);
    expect(normalizeStarPillPrefs({ messagesSent: -5, starred: "yes" }))
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
