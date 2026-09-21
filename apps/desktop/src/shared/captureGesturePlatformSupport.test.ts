import { describe, expect, it } from "vitest";
import {
  CAPTURE_GESTURE_UNSUPPORTED_BLOCKER,
  captureGestureChordLabel,
  captureGestureUnavailableReason,
  isCaptureGestureSupported,
} from "./captureGesturePlatformSupport";

describe("capture gesture platform support", () => {
  it("supports macOS and Windows on every arch ADE ships", () => {
    for (const arch of ["arm64", "x64"]) {
      expect(isCaptureGestureSupported("darwin", arch)).toBe(true);
      // Windows on ARM included: the x64 helper runs under emulation, so
      // hiding the gesture there would remove a working feature.
      expect(isCaptureGestureSupported("win32", arch)).toBe(true);
    }
  });

  it("refuses Linux and anything unrecognised", () => {
    expect(isCaptureGestureSupported("linux", "x64")).toBe(false);
    expect(isCaptureGestureSupported("", "")).toBe(false);
    expect(isCaptureGestureSupported("freebsd")).toBe(false);
  });

  it("carries the blocker sentence with the gate, not at the call site", () => {
    expect(captureGestureUnavailableReason("darwin", "arm64")).toBeNull();
    expect(captureGestureUnavailableReason("linux", "x64"))
      .toBe(CAPTURE_GESTURE_UNSUPPORTED_BLOCKER);
  });

  it("spells the chord the way each platform's keyboard does", () => {
    expect(captureGestureChordLabel("darwin")).toBe("both ⌘ keys");
    expect(captureGestureChordLabel("win32")).toBe("both Ctrl keys");
    // Never a Command key on a machine that has none.
    expect(captureGestureChordLabel("linux")).not.toContain("⌘");
  });
});
