import { describe, expect, it } from "vitest";
import {
  TERMINAL_SCROLL_AT_BOTTOM,
  clampTerminalScrollOffset,
  jumpTerminalToBottom,
  noteTerminalNewRows,
  readTerminalScroll,
  scrollTerminalBy,
  terminalPageStep,
  type TerminalScrollBySessionId,
} from "../components/TerminalScrollState";

describe("readTerminalScroll", () => {
  it("defaults to pinned-at-bottom for unknown / missing session", () => {
    const map: TerminalScrollBySessionId = {};
    expect(readTerminalScroll(map, "missing")).toEqual(TERMINAL_SCROLL_AT_BOTTOM);
    expect(readTerminalScroll(map, null)).toEqual(TERMINAL_SCROLL_AT_BOTTOM);
    expect(readTerminalScroll(map, undefined)).toEqual(TERMINAL_SCROLL_AT_BOTTOM);
  });

  it("returns the stored state when present", () => {
    const state = { scrollOffset: 7, pendingNewCount: 3 };
    expect(readTerminalScroll({ s1: state }, "s1")).toBe(state);
  });
});

describe("clampTerminalScrollOffset", () => {
  it("clamps to [0, maxScrollable]", () => {
    expect(clampTerminalScrollOffset(-5, 100)).toBe(0);
    expect(clampTerminalScrollOffset(50, 100)).toBe(50);
    expect(clampTerminalScrollOffset(500, 100)).toBe(100);
  });

  it("floors fractional offsets and tolerates non-finite input", () => {
    expect(clampTerminalScrollOffset(3.9, 100)).toBe(3);
    expect(clampTerminalScrollOffset(Number.NaN, 100)).toBe(0);
  });

  it("allows scrolling well past 500 rows (desync regression: cursor must keep advancing)", () => {
    // The old slice(-500) pinned the buffer; scrollback must reach the full
    // retained window (e.g. 2000 rows), not be capped near 500.
    expect(clampTerminalScrollOffset(1_900, 2_000)).toBe(1_900);
    expect(clampTerminalScrollOffset(2_000, 2_000)).toBe(2_000);
  });
});

describe("scrollTerminalBy", () => {
  const max = 100;

  it("scrolls up (positive delta) toward older output, clamped", () => {
    const a = scrollTerminalBy(TERMINAL_SCROLL_AT_BOTTOM, 10, max);
    expect(a.scrollOffset).toBe(10);
    const b = scrollTerminalBy(a, 200, max);
    expect(b.scrollOffset).toBe(100);
  });

  it("scrolls down (negative delta) toward newest, clearing pending at the bottom", () => {
    const up = { scrollOffset: 20, pendingNewCount: 5 };
    const mid = scrollTerminalBy(up, -5, max);
    expect(mid).toEqual({ scrollOffset: 15, pendingNewCount: 5 });
    const bottom = scrollTerminalBy(mid, -100, max);
    expect(bottom).toEqual({ scrollOffset: 0, pendingNewCount: 0 });
  });

  it("returns the same reference when already pinned at the bottom and going further down", () => {
    expect(scrollTerminalBy(TERMINAL_SCROLL_AT_BOTTOM, -10, max)).toBe(TERMINAL_SCROLL_AT_BOTTOM);
  });
});

describe("jumpTerminalToBottom", () => {
  it("resets offset and pending counter", () => {
    expect(jumpTerminalToBottom({ scrollOffset: 40, pendingNewCount: 9 })).toEqual(
      TERMINAL_SCROLL_AT_BOTTOM,
    );
  });

  it("is a no-op (same ref) when already at the bottom", () => {
    expect(jumpTerminalToBottom(TERMINAL_SCROLL_AT_BOTTOM)).toBe(TERMINAL_SCROLL_AT_BOTTOM);
  });
});

describe("noteTerminalNewRows", () => {
  it("accumulates the counter AND advances scrollOffset to anchor content while scrolled up", () => {
    // viewportY grows by 3, so scrollOffset must grow by 3 to keep
    // viewportY - scrollOffset constant (content stays pinned, no drift).
    const scrolled = { scrollOffset: 12, pendingNewCount: 2 };
    expect(noteTerminalNewRows(scrolled, 3)).toEqual({ scrollOffset: 15, pendingNewCount: 5 });
  });

  it("clamps the advanced scrollOffset to maxScrollable", () => {
    expect(
      noteTerminalNewRows({ scrollOffset: 98, pendingNewCount: 0 }, 5, 100),
    ).toEqual({ scrollOffset: 100, pendingNewCount: 5 });
  });

  it("does not count new output while pinned to the bottom (no chip)", () => {
    expect(noteTerminalNewRows(TERMINAL_SCROLL_AT_BOTTOM, 10)).toBe(TERMINAL_SCROLL_AT_BOTTOM);
  });

  it("ignores zero / negative arrivals", () => {
    const scrolled = { scrollOffset: 4, pendingNewCount: 1 };
    expect(noteTerminalNewRows(scrolled, 0)).toBe(scrolled);
    expect(noteTerminalNewRows(scrolled, -3)).toBe(scrolled);
  });
});

describe("terminalPageStep", () => {
  it("pages by half the visible window, at least one row", () => {
    expect(terminalPageStep(20)).toBe(10);
    expect(terminalPageStep(1)).toBe(1);
    expect(terminalPageStep(0)).toBe(1);
  });
});
