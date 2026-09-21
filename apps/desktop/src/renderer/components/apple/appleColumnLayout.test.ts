import { describe, expect, it } from "vitest";
import type { AppleLaneDevice } from "../../../shared/types";
import {
  appleColumnWidthPx,
  clampAppleColumnWidthPct,
  DEFAULT_APPLE_COLUMN_WIDTH_PCT,
  MAX_APPLE_COLUMN_WIDTH_PCT,
  MIN_APPLE_COLUMN_PANE_PX,
  MIN_APPLE_COLUMN_WIDTH_PCT,
  nextAppleColumnWidthPctForKey,
  selectAppleColumnVisible,
} from "./appleColumnLayout";

function device(overrides: Partial<AppleLaneDevice> = {}): AppleLaneDevice {
  return {
    laneId: "lane-1",
    udid: "UDID-1",
    name: "iPhone 17 — lane-1",
    origin: "clone",
    family: "iphone",
    runtime: "iOS 26.0",
    createdAt: new Date().toISOString(),
    templateUdid: "TEMPLATE-1",
    ...overrides,
  };
}

describe("clampAppleColumnWidthPct", () => {
  it("applies the taste clamp when no container is known", () => {
    expect(clampAppleColumnWidthPct(2)).toBe(MIN_APPLE_COLUMN_WIDTH_PCT);
    expect(clampAppleColumnWidthPct(95)).toBe(MAX_APPLE_COLUMN_WIDTH_PCT);
    expect(clampAppleColumnWidthPct(30)).toBe(30);
  });

  it("falls back to the default for a non-finite request", () => {
    expect(clampAppleColumnWidthPct(Number.NaN)).toBe(DEFAULT_APPLE_COLUMN_WIDTH_PCT);
    expect(clampAppleColumnWidthPct(36, Number.NaN)).toBe(36);
    expect(clampAppleColumnWidthPct(36, 0)).toBe(36);
  });

  it("never lets the column fall under the 200px spec floor", () => {
    const container = 1400;
    const clamped = clampAppleColumnWidthPct(MIN_APPLE_COLUMN_WIDTH_PCT, container);
    expect(appleColumnWidthPx(clamped, container)).toBeGreaterThanOrEqual(MIN_APPLE_COLUMN_PANE_PX - 0.01);
  });

  it("keeps a usable chat column, and shrinks its own ceiling by what the tools pane takes", () => {
    const container = 1200;
    const withoutTools = clampAppleColumnWidthPct(MAX_APPLE_COLUMN_WIDTH_PCT, container, 0);
    const withTools = clampAppleColumnWidthPct(MAX_APPLE_COLUMN_WIDTH_PCT, container, 30);
    expect(withTools).toBeLessThan(withoutTools);
    // The chat column still clears its floor once the tools pane is counted.
    const chatPx = appleColumnWidthPx(100 - withTools - 30, container);
    expect(chatPx).toBeGreaterThan(0);
  });

  it("lets the device floor win in a window too narrow for both floors", () => {
    const container = 420;
    const clamped = clampAppleColumnWidthPct(MIN_APPLE_COLUMN_WIDTH_PCT, container);
    expect(appleColumnWidthPx(clamped, container)).toBeGreaterThanOrEqual(MIN_APPLE_COLUMN_PANE_PX - 0.01);
  });
});

describe("nextAppleColumnWidthPctForKey", () => {
  const container = 1400;

  it("moves the separator, so ArrowLeft grows the column on the right", () => {
    expect(nextAppleColumnWidthPctForKey("ArrowLeft", 30, container)).toBe(32);
    expect(nextAppleColumnWidthPctForKey("ArrowRight", 30, container)).toBe(28);
  });

  it("snaps to the legal ends with Home and End", () => {
    expect(nextAppleColumnWidthPctForKey("Home", 40, container)).toBe(MIN_APPLE_COLUMN_WIDTH_PCT);
    expect(nextAppleColumnWidthPctForKey("End", 40, container)).toBe(MAX_APPLE_COLUMN_WIDTH_PCT);
  });

  it("ignores keys that are not the separator's", () => {
    expect(nextAppleColumnWidthPctForKey("Enter", 30, container)).toBeNull();
    expect(nextAppleColumnWidthPctForKey("ArrowUp", 30, container)).toBeNull();
  });
});

describe("selectAppleColumnVisible", () => {
  it("is hidden with no device", () => {
    expect(selectAppleColumnVisible({ device: null, closedUdid: null })).toBe(false);
  });

  it("is shown as soon as the lane has a device", () => {
    expect(selectAppleColumnVisible({ device: device(), closedUdid: null })).toBe(true);
  });

  it("stays hidden for the device the user closed it for", () => {
    expect(selectAppleColumnVisible({ device: device(), closedUdid: "UDID-1" })).toBe(false);
  });

  it("comes back for a different device — a stale dismissal cannot hide the next one", () => {
    expect(selectAppleColumnVisible({ device: device({ udid: "UDID-2" }), closedUdid: "UDID-1" })).toBe(true);
  });
});
