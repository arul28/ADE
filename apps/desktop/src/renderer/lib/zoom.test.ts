import { describe, it, expect } from "vitest";
import {
  zoomFactorForDisplay,
  shellHeaderInsetPx,
  SHELL_HEADER_TRAFFIC_LIGHT_DIP,
  DEFAULT_ZOOM,
  MIN_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
} from "./zoom";

describe("zoomFactorForDisplay", () => {
  it("maps the displayed percentage to its effective render factor (+10% offset)", () => {
    expect(zoomFactorForDisplay(100)).toBeCloseTo(1.1, 5);
    expect(zoomFactorForDisplay(70)).toBeCloseTo(0.8, 5);
    expect(zoomFactorForDisplay(150)).toBeCloseTo(1.6, 5);
  });
});

describe("shellHeaderInsetPx", () => {
  it("preserves the legacy 80px reservation at the default zoom", () => {
    // 88 DIP / factor 1.1 === 80 CSS px — no visual change at 100%.
    expect(shellHeaderInsetPx(DEFAULT_ZOOM)).toBe(80);
  });

  it("grows the CSS reservation as the page zooms out", () => {
    // The native traffic lights don't scale, so zooming out must reserve more
    // CSS px to keep them clear of the logo.
    expect(shellHeaderInsetPx(MIN_ZOOM_LEVEL)).toBeGreaterThan(
      shellHeaderInsetPx(DEFAULT_ZOOM),
    );
    expect(shellHeaderInsetPx(70)).toBe(110); // 88 / 0.8
  });

  it("shrinks the CSS reservation as the page zooms in", () => {
    expect(shellHeaderInsetPx(MAX_ZOOM_LEVEL)).toBeLessThan(
      shellHeaderInsetPx(DEFAULT_ZOOM),
    );
    expect(shellHeaderInsetPx(150)).toBe(55); // 88 / 1.6
  });

  it("keeps the on-screen clearance physically constant across all zoom levels", () => {
    // inset(css) * factor should equal the fixed DIP clearance (± rounding).
    for (let pct = MIN_ZOOM_LEVEL; pct <= MAX_ZOOM_LEVEL; pct += 10) {
      const physical = shellHeaderInsetPx(pct) * zoomFactorForDisplay(pct);
      expect(physical).toBeGreaterThanOrEqual(SHELL_HEADER_TRAFFIC_LIGHT_DIP - 1);
      expect(physical).toBeLessThanOrEqual(SHELL_HEADER_TRAFFIC_LIGHT_DIP + 1);
    }
  });

  it("falls back to the base clearance for non-finite input", () => {
    expect(shellHeaderInsetPx(Number.NaN)).toBe(SHELL_HEADER_TRAFFIC_LIGHT_DIP);
  });
});
