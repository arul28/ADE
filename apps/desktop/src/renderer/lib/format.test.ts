import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { relativeTimeCompact } from "./format";

describe("relativeTimeCompact", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for null/undefined input", () => {
    expect(relativeTimeCompact(null)).toBe("");
    expect(relativeTimeCompact(undefined)).toBe("");
  });

  it("returns empty string for invalid ISO string", () => {
    expect(relativeTimeCompact("not-a-date")).toBe("");
  });

  it('returns "now" for timestamps less than 1 minute ago', () => {
    expect(relativeTimeCompact("2026-04-09T12:00:00.000Z")).toBe("now");
    expect(relativeTimeCompact("2026-04-09T11:59:30.000Z")).toBe("now");
  });

  it("returns minutes for timestamps 1–59 minutes ago", () => {
    expect(relativeTimeCompact("2026-04-09T11:59:00.000Z")).toBe("1m");
    expect(relativeTimeCompact("2026-04-09T11:30:00.000Z")).toBe("30m");
    expect(relativeTimeCompact("2026-04-09T11:01:00.000Z")).toBe("59m");
  });

  it("returns hours for timestamps 1–23 hours ago", () => {
    expect(relativeTimeCompact("2026-04-09T11:00:00.000Z")).toBe("1h");
    expect(relativeTimeCompact("2026-04-09T00:00:00.000Z")).toBe("12h");
    expect(relativeTimeCompact("2026-04-08T13:00:00.000Z")).toBe("23h");
  });

  it("returns days for timestamps 24+ hours ago", () => {
    expect(relativeTimeCompact("2026-04-08T12:00:00.000Z")).toBe("1d");
    expect(relativeTimeCompact("2026-04-02T12:00:00.000Z")).toBe("7d");
  });

  it("treats future timestamps as 'now' (delta clamped to 0)", () => {
    expect(relativeTimeCompact("2026-04-09T13:00:00.000Z")).toBe("now");
  });
});
