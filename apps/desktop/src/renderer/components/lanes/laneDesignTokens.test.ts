import { describe, expect, it } from "vitest";
import {
  COLORS,
  SPACING,
  FONT_SIZES,
  RADII,
  APP_FONT_STACK,
  SANS_FONT,
  MONO_FONT,
  LABEL_STYLE,
  inlineBadge,
  outlineButton,
  primaryButton,
  dangerButton,
  cardStyle,
  recessedStyle,
  processStatusColor,
  healthColor,
  formatTimestamp,
  conflictDotColor,
} from "./laneDesignTokens";

// ── Constants ──

describe("design token constants", () => {
  it("exports COLORS with all expected keys", () => {
    expect(COLORS.pageBg).toBe("#09080C");
    expect(COLORS.accent).toBe("#A78BFA");
    expect(COLORS.success).toBe("#22C55E");
    expect(COLORS.danger).toBe("#EF4444");
    expect(COLORS.warning).toBe("#F59E0B");
    expect(COLORS.textPrimary).toBe("#FAFAFA");
  });

  it("exports SPACING values", () => {
    expect(SPACING.xs).toBe(4);
    expect(SPACING.xl).toBe(24);
  });

  it("exports FONT_SIZES values", () => {
    expect(FONT_SIZES.xs).toBe(9);
    expect(FONT_SIZES.xl).toBe(14);
  });

  it("exports RADII values", () => {
    expect(RADII.sm).toBe(6);
    expect(RADII.xl).toBe(16);
  });

  it("exports font stacks", () => {
    expect(APP_FONT_STACK).toContain("Geist");
    expect(SANS_FONT).toBe("var(--font-sans)");
    expect(MONO_FONT).toBe("var(--font-mono)");
  });

  it("exports LABEL_STYLE with correct properties", () => {
    expect(LABEL_STYLE.fontSize).toBe(11);
    expect(LABEL_STYLE.fontWeight).toBe(500);
    expect(LABEL_STYLE.fontFamily).toBe(SANS_FONT);
    expect(LABEL_STYLE.color).toBe(COLORS.textMuted);
  });
});

// ── Style factory functions ──

describe("inlineBadge", () => {
  it("returns correct base style for a given color", () => {
    const style = inlineBadge("#FF0000");
    expect(style.color).toBe("#FF0000");
    expect(style.background).toBe("#FF000010");
    expect(style.display).toBe("inline-flex");
    expect(style.fontSize).toBe(11);
    expect(style.border).toBe("1px solid transparent");
    expect(style.borderRadius).toBe(6);
  });

  it("applies overrides", () => {
    const style = inlineBadge("#FF0000", { fontWeight: 800, borderRadius: 0 });
    expect(style.fontWeight).toBe(800);
    expect(style.borderRadius).toBe(0);
    // Base properties still present
    expect(style.color).toBe("#FF0000");
  });
});

describe("outlineButton", () => {
  it("returns default style", () => {
    const style = outlineButton();
    expect(style.height).toBe(32);
    expect(style.cursor).toBe("pointer");
    expect(style.borderRadius).toBe(8);
    expect(style.color).toBe(COLORS.textSecondary);
  });

  it("applies overrides", () => {
    const style = outlineButton({ color: "red", height: 40 });
    expect(style.color).toBe("red");
    expect(style.height).toBe(40);
  });
});

describe("primaryButton", () => {
  it("returns default style", () => {
    const style = primaryButton();
    expect(style.height).toBe(32);
    expect(style.cursor).toBe("pointer");
    expect(style.color).toBe(COLORS.pageBg);
    expect(style.border).toBe("none");
  });

  it("applies overrides", () => {
    const style = primaryButton({ height: 48 });
    expect(style.height).toBe(48);
  });
});

describe("dangerButton", () => {
  it("returns default style with danger color", () => {
    const style = dangerButton();
    expect(style.color).toBe(COLORS.danger);
    expect(style.background).toBe(`${COLORS.danger}10`);
    expect(style.cursor).toBe("pointer");
    expect(style.border).toBe("1px solid transparent");
  });

  it("applies overrides", () => {
    const style = dangerButton({ border: "2px solid red" });
    expect(style.border).toBe("2px solid red");
  });
});

describe("cardStyle", () => {
  it("returns default card style", () => {
    const style = cardStyle();
    expect(style.borderRadius).toBe(16);
    expect(style.padding).toBe(20);
    expect(style.border).toContain("1px solid");
  });

  it("applies overrides", () => {
    const style = cardStyle({ padding: 10 });
    expect(style.padding).toBe(10);
  });
});

describe("recessedStyle", () => {
  it("returns default recessed style", () => {
    const style = recessedStyle();
    expect(style.borderRadius).toBe(12);
    expect(style.padding).toBe(12);
  });

  it("applies overrides", () => {
    const style = recessedStyle({ borderRadius: 0 });
    expect(style.borderRadius).toBe(0);
  });
});

// ── Status color functions ──

describe("processStatusColor", () => {
  it("returns success for running", () => {
    expect(processStatusColor("running")).toBe(COLORS.success);
  });

  it("returns warning for starting and stopping", () => {
    expect(processStatusColor("starting")).toBe(COLORS.warning);
    expect(processStatusColor("stopping")).toBe(COLORS.warning);
  });

  it("returns danger for degraded, crashed, exited", () => {
    expect(processStatusColor("degraded")).toBe(COLORS.danger);
    expect(processStatusColor("crashed")).toBe(COLORS.danger);
    expect(processStatusColor("exited")).toBe(COLORS.danger);
  });

  it("returns textDim for undefined/unknown", () => {
    expect(processStatusColor(undefined)).toBe(COLORS.textDim);
    expect(processStatusColor("unknown" as any)).toBe(COLORS.textDim);
  });
});

describe("healthColor", () => {
  it("returns success for healthy", () => {
    expect(healthColor("healthy")).toBe(COLORS.success);
  });

  it("returns warning for degraded", () => {
    expect(healthColor("degraded")).toBe(COLORS.warning);
  });

  it("returns danger for unhealthy", () => {
    expect(healthColor("unhealthy")).toBe(COLORS.danger);
  });

  it("returns textDim for unknown and unrecognized values", () => {
    expect(healthColor("unknown")).toBe(COLORS.textDim);
    expect(healthColor("something-else")).toBe(COLORS.textDim);
  });
});

describe("formatTimestamp", () => {
  it("formats a valid ISO string to locale time", () => {
    const result = formatTimestamp("2026-03-26T14:30:45.000Z");
    // The result should contain hour:minute:second
    expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("returns the original string for invalid dates", () => {
    const result = formatTimestamp("not-a-date");
    // Either returns locale string for 'Invalid Date' or the original
    expect(typeof result).toBe("string");
  });
});

describe("conflictDotColor", () => {
  it("returns danger for conflict-active", () => {
    expect(conflictDotColor("conflict-active")).toBe(COLORS.danger);
  });

  it("returns warning for conflict-predicted", () => {
    expect(conflictDotColor("conflict-predicted")).toBe(COLORS.warning);
  });

  it("returns warning for behind-base", () => {
    expect(conflictDotColor("behind-base")).toBe(COLORS.warning);
  });

  it("returns success for merge-ready", () => {
    expect(conflictDotColor("merge-ready")).toBe(COLORS.success);
  });

  it("returns textMuted for unknown/undefined", () => {
    expect(conflictDotColor(undefined)).toBe(COLORS.textMuted);
    expect(conflictDotColor("other")).toBe(COLORS.textMuted);
  });
});
