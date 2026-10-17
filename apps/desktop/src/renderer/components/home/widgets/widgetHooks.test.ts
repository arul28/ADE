/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOfLocalWeek, useLocalDayStart } from "./widgetHooks";

describe("the home page's week and day", () => {
  it.each([
    ["Monday", new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 5)],
    ["Wednesday evening", new Date(2026, 9, 7, 21, 15), new Date(2026, 9, 5)],
    ["Sunday night (still last week)", new Date(2026, 9, 11, 23, 59), new Date(2026, 9, 5)],
    ["the next Monday", new Date(2026, 9, 12, 0, 1), new Date(2026, 9, 12)],
  ])("starts the week on Monday: %s", (_label, now, monday) => {
    expect(startOfLocalWeek(now).getTime()).toBe(monday.getTime());
  });

  describe("useLocalDayStart", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.setSystemTime(new Date(2026, 9, 11, 23, 50));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ["the window gains focus", () => window.dispatchEvent(new Event("focus"))],
      ["the window becomes visible", () => document.dispatchEvent(new Event("visibilitychange"))],
    ])("moves to the new day when %s after the computer slept through midnight", (_label, wake) => {
      const { result } = renderHook(() => useLocalDayStart());
      expect(result.current).toBe(new Date(2026, 9, 11).getTime());

      // Asleep across midnight: the clock moved, the midnight timer did not fire.
      vi.setSystemTime(new Date(2026, 9, 12, 8, 0));
      expect(result.current).toBe(new Date(2026, 9, 11).getTime());

      act(() => wake());
      expect(result.current).toBe(new Date(2026, 9, 12).getTime());
      // A new week started with it.
      expect(startOfLocalWeek(new Date(result.current)).getTime()).toBe(new Date(2026, 9, 12).getTime());
    });
  });
});
