// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHELL_HEADER_INSET_END_BASE_PX,
  WINDOWS_CAPTION_FALLBACK_PX,
  WINDOWS_CAPTION_GUTTER_PX,
  createTitleBarOverlaySync,
  windowsCaptionInsetPx,
} from "./windowControlsOverlay";

const FALLBACK = WINDOWS_CAPTION_FALLBACK_PX + WINDOWS_CAPTION_GUTTER_PX;

function overlay(rect: { x: number; width: number }, visible = true) {
  return {
    visible,
    getTitlebarAreaRect: () => ({ x: rect.x, y: 0, width: rect.width, height: 32 }),
  };
}

describe("windowsCaptionInsetPx", () => {
  it("reserves whatever the caption buttons occupy at the trailing edge", () => {
    expect(windowsCaptionInsetPx({
      overlay: overlay({ x: 0, width: 1000 }),
      viewportWidth: 1146,
    })).toBe(146 + WINDOWS_CAPTION_GUTTER_PX);
  });

  it("reclaims the space when the overlay is hidden", () => {
    expect(windowsCaptionInsetPx({
      overlay: overlay({ x: 0, width: 1000 }, false),
      viewportWidth: 1000,
    })).toBe(SHELL_HEADER_INSET_END_BASE_PX);
  });

  it("asks again rather than dropping the reservation mid-resize", () => {
    expect(windowsCaptionInsetPx({
      overlay: overlay({ x: 0, width: 1200 }),
      viewportWidth: 1000,
    })).toBeNull();
  });

  it("falls back where the overlay API is absent", () => {
    expect(windowsCaptionInsetPx({ overlay: null, viewportWidth: 1000 })).toBe(FALLBACK);
  });
});

describe("createTitleBarOverlaySync", () => {
  const originalPlatform = navigator.platform;
  let setTitleBarOverlay: ReturnType<typeof vi.fn>;
  let syncWindowsTitleBarOverlay: ReturnType<typeof createTitleBarOverlaySync>;

  const setPlatform = (value: string) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value });
  };

  beforeEach(() => {
    setTitleBarOverlay = vi.fn().mockResolvedValue({ applied: true });
    (window as unknown as { ade: unknown }).ade = { zoom: { setTitleBarOverlay } };
    // A syncer per test, so nothing has to undo the previous test's values.
    syncWindowsTitleBarOverlay = createTitleBarOverlaySync();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("does nothing on macOS, where the OS owns the traffic lights", () => {
    setPlatform("MacIntel");
    syncWindowsTitleBarOverlay({ theme: "light", displayZoom: 70 });
    expect(setTitleBarOverlay).not.toHaveBeenCalled();
  });

  /**
   * The two inputs arrive from unrelated call sites — the zoom hook and the
   * `data-theme` effect — so each push has to carry the other's last value or
   * one of them would be reset to a default it never had.
   */
  it("carries the last known theme and zoom on every push", () => {
    setPlatform("Win32");
    syncWindowsTitleBarOverlay({ displayZoom: 70 });
    // 70% display is a 0.8 render factor (the +10% offset).
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
      theme: "dark",
      zoomFactor: 0.8,
    });

    syncWindowsTitleBarOverlay({ theme: "light" });
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
      theme: "light",
      zoomFactor: 0.8,
    });

    syncWindowsTitleBarOverlay({ displayZoom: 150 });
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
      theme: "light",
      zoomFactor: 1.6,
    });
  });

  it("no-ops when the bridge is missing rather than throwing into the caller", () => {
    setPlatform("Win32");
    delete (window as unknown as { ade?: unknown }).ade;
    expect(() => syncWindowsTitleBarOverlay({ displayZoom: 100 })).not.toThrow();
  });
});
