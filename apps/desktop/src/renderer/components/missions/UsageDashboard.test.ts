/**
 * Tests for UsageDashboard helper functions.
 *
 * The UsageDashboard component contains module-private utility functions
 * (formatDuration, formatBudgetMs, budgetPercent). We re-derive them
 * here to test the logic, plus test the dependent exports from missionHelpers
 * (formatResetCountdown, usagePercentColor).
 */
import { describe, expect, it } from "vitest";
import { formatResetCountdown, usagePercentColor } from "./missionHelpers";

// ── Re-derive module-private helpers for unit testing ──

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatBudgetMs(ms: number | null | undefined): string {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return "n/a";
  const minutes = Math.max(1, Math.round(Number(ms) / 60_000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function budgetPercent(used: number, limit: number | null | undefined): number | null {
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  const raw = (used / Number(limit)) * 100;
  return Math.max(0, Math.min(100, raw));
}

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(2500)).toBe("2.5s");
  });

  it("formats minutes", () => {
    expect(formatDuration(150_000)).toBe("2.5m");
  });

  it("formats hours", () => {
    expect(formatDuration(5_400_000)).toBe("1.5h");
  });
});

describe("formatBudgetMs", () => {
  it("returns n/a for null", () => {
    expect(formatBudgetMs(null)).toBe("n/a");
  });

  it("returns n/a for undefined", () => {
    expect(formatBudgetMs(undefined)).toBe("n/a");
  });

  it("returns n/a for zero", () => {
    expect(formatBudgetMs(0)).toBe("n/a");
  });

  it("returns n/a for negative", () => {
    expect(formatBudgetMs(-1000)).toBe("n/a");
  });

  it("formats short durations as minutes", () => {
    expect(formatBudgetMs(5 * 60_000)).toBe("5m");
    expect(formatBudgetMs(30 * 60_000)).toBe("30m");
  });

  it("formats longer durations as hours and minutes", () => {
    expect(formatBudgetMs(90 * 60_000)).toBe("1h 30m");
    expect(formatBudgetMs(120 * 60_000)).toBe("2h");
  });

  it("clamps to minimum 1m for very small positive values", () => {
    expect(formatBudgetMs(1000)).toBe("1m");
  });
});

describe("budgetPercent", () => {
  it("returns null for null limit", () => {
    expect(budgetPercent(50, null)).toBeNull();
  });

  it("returns null for undefined limit", () => {
    expect(budgetPercent(50, undefined)).toBeNull();
  });

  it("returns null for zero limit", () => {
    expect(budgetPercent(50, 0)).toBeNull();
  });

  it("returns correct percentage", () => {
    expect(budgetPercent(50, 100)).toBe(50);
    expect(budgetPercent(75, 100)).toBe(75);
  });

  it("clamps to 100", () => {
    expect(budgetPercent(150, 100)).toBe(100);
  });

  it("clamps to 0 for negative used", () => {
    expect(budgetPercent(-10, 100)).toBe(0);
  });
});

// ── Exported helpers from missionHelpers used by UsageDashboard ──

describe("formatResetCountdown", () => {
  it("returns 'resets now' for zero", () => {
    expect(formatResetCountdown(0)).toBe("resets now");
  });

  it("returns 'resets now' for negative", () => {
    expect(formatResetCountdown(-1000)).toBe("resets now");
  });

  it("formats minutes", () => {
    expect(formatResetCountdown(30 * 60_000)).toBe("resets in 30m");
  });

  it("formats hours and minutes", () => {
    expect(formatResetCountdown(90 * 60_000)).toBe("resets in 1h 30m");
  });

  it("formats exact hours", () => {
    expect(formatResetCountdown(2 * 3_600_000)).toBe("resets in 2h 0m");
  });
});

describe("usagePercentColor", () => {
  it("returns green for low usage", () => {
    expect(usagePercentColor(0)).toBe("#22C55E");
    expect(usagePercentColor(30)).toBe("#22C55E");
    expect(usagePercentColor(59)).toBe("#22C55E");
  });

  it("returns amber for medium usage", () => {
    expect(usagePercentColor(60)).toBe("#F59E0B");
    expect(usagePercentColor(70)).toBe("#F59E0B");
    expect(usagePercentColor(80)).toBe("#F59E0B");
  });

  it("returns red for high usage", () => {
    expect(usagePercentColor(81)).toBe("#EF4444");
    expect(usagePercentColor(100)).toBe("#EF4444");
  });
});
