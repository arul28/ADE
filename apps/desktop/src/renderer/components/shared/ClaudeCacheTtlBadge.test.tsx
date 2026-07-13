/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ClaudeCacheTtlBadge } from "./ClaudeCacheTtlBadge";
import { CLAUDE_CHAT_CACHE_TTL_MS } from "../../lib/claudeCacheTtl";

const T0 = Date.parse("2026-04-08T12:00:00.000Z");

/** idleSinceAt timestamp such that exactly `remainingMs` of cache TTL remain at T0. */
function idleWithRemaining(remainingMs: number): string {
  return new Date(T0 - (CLAUDE_CHAT_CACHE_TTL_MS - remainingMs)).toISOString();
}

describe("ClaudeCacheTtlBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("counts down with ceil-based one-second resolution, then stops its interval once expired while mounted", () => {
    const baseline = vi.getTimerCount();
    // 2500ms remaining distinguishes ceil (→ "0:03") from floor (→ "0:02").
    const { container } = render(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(2500)} />);

    // One interval is installed and the ceil-based countdown is visible.
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

  it("installs no interval when mounted already expired", () => {
    const baseline = vi.getTimerCount();
    const { container } = render(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(0)} />);
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("installs no interval when there is no idle timestamp", () => {
    const baseline = vi.getTimerCount();
    const { container } = render(<ClaudeCacheTtlBadge idleSinceAt={null} />);
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("clears the interval on unmount", () => {
    const baseline = vi.getTimerCount();
    const { unmount } = render(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(120_000)} />);
    expect(vi.getTimerCount()).toBe(baseline + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("restarts a single interval and does not leak the old one when idleSinceAt changes", () => {
    const baseline = vi.getTimerCount();
    const { rerender } = render(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(120_000)} />);
    expect(vi.getTimerCount()).toBe(baseline + 1);
    rerender(<ClaudeCacheTtlBadge idleSinceAt={idleWithRemaining(60_000)} />);
    expect(vi.getTimerCount()).toBe(baseline + 1);
  });

  it.each([1, 50, 500])(
    "returns every interval timer to zero after expiry for %i mounted badges",
    (count) => {
      const baseline = vi.getTimerCount();
      render(
        <>
          {Array.from({ length: count }, (_, i) => (
            <ClaudeCacheTtlBadge key={i} idleSinceAt={idleWithRemaining(2000)} />
          ))}
        </>,
      );
      // One interval per mounted, unexpired badge.
      expect(vi.getTimerCount()).toBe(baseline + count);

      // After expiry every badge self-clears; no wakeups remain.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(vi.getTimerCount()).toBe(baseline);
    },
  );
});
