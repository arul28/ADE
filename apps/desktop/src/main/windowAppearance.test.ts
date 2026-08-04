import { describe, expect, it } from "vitest";
import {
  ADE_WINDOWS_APP_USER_MODEL_ID,
  windowChromeOptions,
  windowsTitleBarOverlay,
  windowsTitleBarOverlayHeight,
} from "./windowAppearance";

describe("windowAppearance", () => {
  it("keeps inset traffic lights on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 },
    });
  });

  it("uses a Windows title-bar overlay with native caption controls", () => {
    expect(windowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#0F0D14",
        symbolColor: "#F8F8F2",
        height: 32,
      },
    });
    expect(ADE_WINDOWS_APP_USER_MODEL_ID).toBe("com.ade.desktop");
  });

  it("uses the native title bar on other platforms", () => {
    expect(windowChromeOptions("linux")).toEqual({
      titleBarStyle: "default",
    });
  });
});

describe("windowsTitleBarOverlayHeight", () => {
  /**
   * The caption strip is declared in DIP and the header it covers is declared
   * in CSS px, so only the zoom factor reconciles them. A fixed 32 left the
   * strip overhanging ~6 DIP into the tab strip at 70% zoom, where clicks went
   * to the OS instead of to ADE.
   */
  it("tracks the header height through the zoom factor", () => {
    expect(windowsTitleBarOverlayHeight(1)).toBe(32);
    expect(windowsTitleBarOverlayHeight(0.8)).toBe(26);
    expect(windowsTitleBarOverlayHeight(1.1)).toBe(35);
    expect(windowsTitleBarOverlayHeight(1.6)).toBe(51);
  });

  it("falls back to the unzoomed height rather than emitting one Electron rejects", () => {
    expect(windowsTitleBarOverlayHeight(0)).toBe(32);
    expect(windowsTitleBarOverlayHeight(-1)).toBe(32);
    expect(windowsTitleBarOverlayHeight(Number.NaN)).toBe(32);
  });
});

describe("windowsTitleBarOverlay", () => {
  it("defaults to the dark palette at 1:1, matching window creation", () => {
    expect(windowsTitleBarOverlay()).toEqual({
      color: "#0F0D14",
      symbolColor: "#F8F8F2",
      height: 32,
    });
  });

  /**
   * The overlay is opaque and does not inherit `data-theme`, so the light theme
   * used to get a near-black rectangle in the corner of a cream header.
   */
  it("repaints for the light theme", () => {
    expect(windowsTitleBarOverlay({ theme: "light", zoomFactor: 1 })).toEqual({
      color: "#FEFEFE",
      symbolColor: "#1A1A1E",
      height: 32,
    });
  });

  it("combines theme and zoom", () => {
    expect(windowsTitleBarOverlay({ theme: "light", zoomFactor: 0.8 })).toEqual({
      color: "#FEFEFE",
      symbolColor: "#1A1A1E",
      height: 26,
    });
  });
});
