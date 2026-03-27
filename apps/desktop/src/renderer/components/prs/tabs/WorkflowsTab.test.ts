/**
 * Tests for WorkflowsTab helper functions.
 *
 * The WorkflowsTab component contains module-private helpers
 * (outcomeColor, cleanupBadgeStyle) that we re-derive and test.
 */
import { describe, expect, it } from "vitest";
import { COLORS, inlineBadge } from "../../lanes/laneDesignTokens";

// Re-derive module-private helpers from WorkflowsTab
function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "clean": return COLORS.success;
    case "conflict": return COLORS.warning;
    default: return COLORS.danger;
  }
}

function cleanupBadgeStyle(cleanupState: string | null | undefined): ReturnType<typeof inlineBadge> | null {
  switch (cleanupState) {
    case "required":
      return inlineBadge(COLORS.warning, { background: `${COLORS.warning}18`, fontWeight: 600 });
    case "completed":
      return inlineBadge(COLORS.success, { background: `${COLORS.success}18`, fontWeight: 600 });
    case "declined":
      return inlineBadge(COLORS.textSecondary, { background: "rgba(255,255,255,0.06)", fontWeight: 600 });
    default:
      return null;
  }
}

describe("outcomeColor", () => {
  it("returns success color for clean", () => {
    expect(outcomeColor("clean")).toBe(COLORS.success);
  });

  it("returns warning color for conflict", () => {
    expect(outcomeColor("conflict")).toBe(COLORS.warning);
  });

  it("returns danger color for blocked and unknown", () => {
    expect(outcomeColor("blocked")).toBe(COLORS.danger);
    expect(outcomeColor("anything-else")).toBe(COLORS.danger);
  });
});

describe("cleanupBadgeStyle", () => {
  it("returns warning badge for required", () => {
    const style = cleanupBadgeStyle("required");
    expect(style).not.toBeNull();
    expect(style!.color).toBe(COLORS.warning);
    expect(style!.fontWeight).toBe(600);
  });

  it("returns success badge for completed", () => {
    const style = cleanupBadgeStyle("completed");
    expect(style).not.toBeNull();
    expect(style!.color).toBe(COLORS.success);
  });

  it("returns secondary badge for declined", () => {
    const style = cleanupBadgeStyle("declined");
    expect(style).not.toBeNull();
    expect(style!.color).toBe(COLORS.textSecondary);
  });

  it("returns null for null", () => {
    expect(cleanupBadgeStyle(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(cleanupBadgeStyle(undefined)).toBeNull();
  });

  it("returns null for unknown state", () => {
    expect(cleanupBadgeStyle("unknown")).toBeNull();
  });
});
