import { describe, expect, it } from "vitest";

import { pickCaptureGestureWindow } from "./captureGestureTarget";

/**
 * The routing order is the whole contract, and it is an order rather than a
 * rule: focused, then the window the user was last in, then any live window,
 * and NEVER a new one. Each step exists because the step after it was wrong in
 * practice, so each one is pinned here separately.
 */
describe("pickCaptureGestureWindow", () => {
  const windows = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("prefers the focused window", () => {
    expect(
      pickCaptureGestureWindow({ liveWindows: windows, focused: windows[2], lastFocusedId: 1 }),
    ).toBe(windows[2]);
  });

  /**
   * The case that matters: the gesture fires over ANOTHER app's window, so
   * nothing of ADE's is focused. Falling straight to the first window would
   * pick creation order — an arbitrary project, usually not the one the user
   * was last in.
   */
  it("falls back to the window the user was last in, not the oldest one", () => {
    expect(
      pickCaptureGestureWindow({ liveWindows: windows, focused: null, lastFocusedId: 3 }),
    ).toBe(windows[2]);
  });

  /**
   * A focused window that is mid-teardown is not a target, and main.ts says so
   * by passing `focused: null` — which must fall THROUGH to the remembered
   * window rather than skipping to the oldest one. Same input shape as "no
   * focused window at all", deliberately: the caller owns liveness (only
   * Electron can answer it) and this function owns the order.
   */
  it("falls through to the last-focused window when the focused one is being torn down", () => {
    const live = [{ id: 1 }, { id: 2 }];
    expect(
      pickCaptureGestureWindow({ liveWindows: live, focused: null, lastFocusedId: 2 }),
    ).toBe(live[1]);
  });

  /** ...and the remembered window is only usable while it is still live. */
  it("ignores a remembered window that is no longer in the live set", () => {
    expect(
      pickCaptureGestureWindow({ liveWindows: windows, focused: null, lastFocusedId: 99 }),
    ).toBe(windows[0]);
    expect(
      pickCaptureGestureWindow({ liveWindows: windows, focused: null, lastFocusedId: null }),
    ).toBe(windows[0]);
  });

  /** Never a new window: with nothing live there is nowhere to deliver. */
  it("answers null rather than conjuring a window", () => {
    expect(
      pickCaptureGestureWindow({ liveWindows: [], focused: null, lastFocusedId: 3 }),
    ).toBeNull();
  });
});
