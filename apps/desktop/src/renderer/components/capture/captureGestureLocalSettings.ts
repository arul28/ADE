/**
 * Where the capture gesture's on/off switch lives.
 *
 * localStorage on this machine, exactly like `activityNotchLocalSettings` —
 * and for the same reason: what a native helper does on THIS computer is not a
 * preference that should travel to another machine through the account. A
 * second Mac has its own Screen Recording grant and its own opinion about
 * whether a global key gesture is welcome.
 *
 * Default ON. The gesture costs nothing until it fires, and a feature nobody
 * discovers is a feature nobody has.
 */

const CAPTURE_GESTURE_ENABLED_KEY = "ade:capture-gesture:enabled";
const CAPTURE_GESTURE_CHANGED_EVENT = "ade:capture-gesture-settings-changed";

/**
 * A property read is not a capability check on the hosted web adapter: its
 * fallback proxy fabricates callable namespaces for missing properties, so
 * `window.ade.captureGesture` is truthy there even though no helper exists.
 * The `in` probe reaches the real exposed surface instead.
 */
export function captureGestureBridgeAvailable(): boolean {
  return typeof window !== "undefined"
    && window.ade != null
    && "captureGesture" in window.ade;
}

export function readCaptureGestureEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(CAPTURE_GESTURE_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeCaptureGestureEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CAPTURE_GESTURE_ENABLED_KEY, String(enabled));
  } catch {
    // A restricted renderer still applies the change for this process through
    // the `updateSettings` call the caller makes alongside this write.
  }
  window.dispatchEvent(new CustomEvent<boolean>(CAPTURE_GESTURE_CHANGED_EVENT, {
    detail: enabled,
  }));
}

/** Keeps two open settings surfaces in agreement without a round trip. */
export function onCaptureGestureEnabledChanged(
  callback: (enabled: boolean) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    callback(event.detail === true);
  };
  window.addEventListener(CAPTURE_GESTURE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(CAPTURE_GESTURE_CHANGED_EVENT, listener);
}
