/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ClaudeCacheTtlBadge } from "./ClaudeCacheTtlBadge";

const T0 = Date.parse("2026-04-08T12:00:00.000Z");
const FIVE_MINUTES = 5 * 60_000;
const MIN = 60_000;

/** A turn end such that a 5-minute cache has exactly `remainingMs` left at T0. */
function idleWithRemaining(remainingMs: number): string {
  return new Date(T0 - (FIVE_MINUTES - remainingMs)).toISOString();
}
const minutesAgo = (minutes: number) => new Date(T0 - minutes * MIN).toISOString();

describe("ClaudeCacheTtlBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("counts a 5-minute cache down with ceil-based one-second resolution, then stops its timer once expired while mounted", () => {
    const baseline = vi.getTimerCount();
    // 2500ms remaining distinguishes ceil (→ "0:03") from floor (→ "0:02").
    const { container } = render(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(2500)} cache={{ ttl: "5m" }} />);

    expect(vi.getTimerCount()).toBe(baseline + 1);
    expect(container.textContent).toContain("0:03");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 1500ms remaining → ceil → "0:02" (floor would be "0:01").
    expect(container.textContent).toContain("0:02");
    expect(vi.getTimerCount()).toBe(baseline + 1);

    // Cross zero: the badge publishes the final (null) state and clears its timer.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(baseline);

    // No callbacks remain: further clock advances do nothing while still mounted.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.getTimerCount()).toBe(baseline);
    expect(container.textContent).toBe("");
  });

  it("keeps a 1-hour cache hidden on one sleeping timer, shows its last ten minutes, and ends before the hour", () => {
    const baseline = vi.getTimerCount();
    const { container } = render(<ClaudeCacheTtlBadge idleSinceAt={minutesAgo(44)} cache={{ ttl: "1h" }} />);

    // Nothing to read for most of the hour, and nothing ticking either.
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(baseline + 1);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(baseline + 1);

    // Minute 45: the countdown appears with ten minutes on it.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toContain("10:00");
    act(() => {
      vi.advanceTimersByTime(4 * MIN);
    });
    expect(container.textContent).toContain("6:00");

    // Minute 55: over, and no wakeups remain.
    act(() => {
      vi.advanceTimersByTime(6 * MIN);
    });
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("counts from the start of the last request when the chat knows it", () => {
    // The turn ended a minute ago, but its last request started four minutes ago.
    const { container } = render(
      <ClaudeCacheTtlBadge idleSinceAt={minutesAgo(1)} cache={{ ttl: "5m", since: minutesAgo(4) }} />,
    );
    expect(container.textContent).toContain("1:00");
  });

  it.each([
    ["the countdown is already over", idleWithRemaining(0), { ttl: "5m" as const }],
    ["there is no idle timestamp", null, { ttl: "5m" as const }],
    ["the chat's cache is unknown", idleWithRemaining(120_000), null],
  ])("shows nothing and installs no timer when %s", (_name, idleSinceAt, cache) => {
    const baseline = vi.getTimerCount();
    const { container } = render(<ClaudeCacheTtlBadge idleSinceAt={idleSinceAt} cache={cache} />);
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("clears its timer on unmount, for a showing and for a still-hidden badge", () => {
    const baseline = vi.getTimerCount();
    const showing = render(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(120_000)} cache={{ ttl: "5m" }} />);
    const hidden = render(<ClaudeCacheTtlBadge idleSinceAt={minutesAgo(5)} cache={{ ttl: "1h" }} />);
    expect(vi.getTimerCount()).toBe(baseline + 2);
    showing.unmount();
    hidden.unmount();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("restarts a single timer and does not leak the old one when the turn end changes", () => {
    const baseline = vi.getTimerCount();
    const { rerender } = render(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(120_000)} cache={{ ttl: "5m" }} />);
    expect(vi.getTimerCount()).toBe(baseline + 1);
    rerender(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(60_000)} cache={{ ttl: "5m" }} />);
    expect(vi.getTimerCount()).toBe(baseline + 1);
  });

  it.each([1, 50, 500])(
    "returns every timer to zero after expiry for %i mounted badges",
    (count) => {
      const baseline = vi.getTimerCount();
      render(
        <>
          {Array.from({ length: count }, (_, i) => (
            <ClaudeCacheTtlBadge key={i} idleSinceAt={idleWithRemaining(2000)} cache={{ ttl: "5m" }} />
          ))}
        </>,
      );
      // Every mounted, unexpired badge shares one one-second timer.
      expect(vi.getTimerCount()).toBe(baseline + 1);

      // After expiry every badge self-clears; no wakeups remain.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(vi.getTimerCount()).toBe(baseline);
    },
  );
});
