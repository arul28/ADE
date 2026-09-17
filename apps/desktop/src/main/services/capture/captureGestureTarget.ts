/**
 * Where a capture lands.
 *
 * The focused ADE window when there is one, otherwise the window the user was
 * last in, otherwise any live window — and NEVER a newly opened one, because
 * the gesture must be able to fire while ADE is in the background without
 * conjuring a window the user did not ask for.
 *
 * The middle step is the one that matters in practice: the gesture's whole
 * point is firing over ANOTHER app's window, so the focused window is null
 * exactly when a capture happens, and "the first of all windows" is creation
 * order — an arbitrary project, usually not the one the user was last in.
 *
 * Pure and generic over the window type so the ORDER can be tested without an
 * Electron window; liveness filtering stays with the caller that can ask.
 */
export function pickCaptureGestureWindow<T extends { id: number }>(args: {
  /** Already filtered to windows that are not destroyed. */
  liveWindows: readonly T[];
  focused: T | null;
  lastFocusedId: number | null;
}): T | null {
  const lastFocused = args.lastFocusedId == null
    ? null
    : args.liveWindows.find((win) => win.id === args.lastFocusedId) ?? null;
  return args.focused ?? lastFocused ?? args.liveWindows[0] ?? null;
}
