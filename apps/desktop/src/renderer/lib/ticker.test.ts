/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useTicker } from "./ticker";

const T0 = Date.parse("2026-04-08T12:00:00.000Z");

/**
 * The ticker exists so that many rows showing a live value cost one timer
 * instead of one each. These cases pin that contract, and the one property the
 * shared reading it replaced could not hold: a component that joins a channel
 * already running must not be handed the last published reading.
 */
describe("useTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("runs one timer for any number of subscribers on the same period", () => {
    const baseline = vi.getTimerCount();
    const first = renderHook(() => useTicker(1_000));
    const second = renderHook(() => useTicker(1_000));
    const third = renderHook(() => useTicker(1_000));
    expect(vi.getTimerCount()).toBe(baseline + 1);

    first.unmount();
    second.unmount();
    third.unmount();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("keeps the timer while any subscriber remains, and clears it with the last", () => {
    const baseline = vi.getTimerCount();
    const first = renderHook(() => useTicker(1_000));
    const second = renderHook(() => useTicker(1_000));

    first.unmount();
    expect(vi.getTimerCount()).toBe(baseline + 1);

    second.unmount();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("advances the reading once per period while enabled", () => {
    const { result } = renderHook(() => useTicker(1_000));
    expect(result.current).toBe(T0);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(T0 + 1_000);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(T0 + 3_000);
  });

  it("starts no timer while disabled", () => {
    const baseline = vi.getTimerCount();
    renderHook(() => useTicker(1_000, false));
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("gives a subscriber joining a running channel the current reading, not the last tick", () => {
    const first = renderHook(() => useTicker(30_000));
    expect(first.result.current).toBe(T0);

    // The thirty-second channel has not ticked yet. A component mounting now
    // must read the current time: the reading published when the channel
    // started is twenty seconds old, and anything derived from it (a "waiting
    // 5m" label is minute-granular and rounds up) would be wrong until the
    // next tick.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    const second = renderHook(() => useTicker(30_000));
    expect(second.result.current).toBe(T0 + 20_000);
  });

  it("keeps different periods on separate timers", () => {
    const baseline = vi.getTimerCount();
    renderHook(() => useTicker(1_000));
    renderHook(() => useTicker(30_000));
    expect(vi.getTimerCount()).toBe(baseline + 2);
  });
});
