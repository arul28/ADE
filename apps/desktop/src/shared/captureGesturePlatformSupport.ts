/**
 * Per-platform availability of the global capture gesture.
 *
 * The gesture is "press both modifier keys anywhere on the OS, capture the
 * frontmost window, hand it to the CTO". Implementing it means a native helper
 * that watches the keyboard without the app being focused and grabs the pixels
 * of a window ADE does not own — two things with no cross-platform API, so each
 * platform gets its own helper binary:
 *
 * - macOS  → `native/ADECaptureHelper` (both Command keys; polls
 *   `NSEvent.modifierFlags`, which needs NO Accessibility grant, and shells out
 *   to `screencapture -l`, which needs Screen Recording).
 * - Windows → `native/ADECaptureHelperWin` (both Ctrl keys; `WH_KEYBOARD_LL`
 *   plus `PrintWindow`/BitBlt).
 * - Linux → nothing. X11 and Wayland need different grabs, Wayland refuses
 *   foreign-window pixel capture outright without a portal handshake, and ADE
 *   ships no Linux packaging target today. Rather than ship a switch that is
 *   present and permanently dead, the gesture is hidden there.
 *
 * This is deliberately NOT a `process.platform === "darwin"` check scattered
 * across main, preload and the renderer: there was no "macOS and Windows but
 * not Linux" predicate in the codebase before this, and three hand-rolled
 * copies of one would drift the moment a fourth target appears.
 */

/**
 * Why the gesture is unavailable, phrased for a person looking at the settings
 * card. Kept beside the gate (the `providerPlatformSupport.ts` rule) so a
 * caller that refuses the gesture never has to restate the reason and get it
 * subtly wrong.
 */
export const CAPTURE_GESTURE_UNSUPPORTED_BLOCKER =
  "Screen capture with a keyboard gesture needs a native helper, and ADE only ships one for macOS and Windows.";

/**
 * True on macOS and Windows, false everywhere else.
 *
 * `arch` is accepted and deliberately ignored: both helpers are built for
 * whatever the packaging target is (macOS ships a universal binary, the Windows
 * x64 build runs under emulation on Windows on ARM), so no arch is excluded
 * today. It stays in the signature because every caller already has to pass the
 * pair to `rendererRuntimeTarget()`-style gates, and an arch-specific exclusion
 * (a future arm64-only helper gap, say) must not change this function's shape
 * out from under them.
 */
export function isCaptureGestureSupported(platform: string, _arch?: string): boolean {
  return platform === "darwin" || platform === "win32";
}

/** The blocker sentence for this platform, or null when the gesture works. */
export function captureGestureUnavailableReason(
  platform: string,
  arch?: string,
): string | null {
  return isCaptureGestureSupported(platform, arch)
    ? null
    : CAPTURE_GESTURE_UNSUPPORTED_BLOCKER;
}

/**
 * How the chord is spelled on this platform. Both halves of the same physical
 * gesture — "both of the big modifier keys at once" — but a Mac keyboard has no
 * Ctrl pair worth reaching for and a PC keyboard has no Command key at all.
 */
export function captureGestureChordLabel(platform: string): string {
  if (platform === "darwin") return "both ⌘ keys";
  if (platform === "win32") return "both Ctrl keys";
  return "the capture gesture";
}
