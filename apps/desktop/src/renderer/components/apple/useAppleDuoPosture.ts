import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { logRendererDebugEvent } from "../../lib/debugLog";
import {
  APPLE_DEVICE_POSE_TARGETS,
  APPLE_DUO_INNER_SCREEN_ID,
  type AppleDeviceOrientation,
  type AppleDevicePose,
  type AppleDevicePosture,
  type OpenProjectBinding,
} from "../../../shared/types";

/** How long ADE's own fold may sweep before the simulator's reports count again. */
const FOLD_HOLD_MS = 4_000;
/** A hinge drag sends its latest angle once the drag pauses, not every frame. */
const ANGLE_DEBOUNCE_MS = 250;

/**
 * The inner panel's picture, a quarter turn on from the device's orientation:
 * the panel is mounted that way, so its raw framebuffer is portrait while its
 * picture is landscape. The stage already turns a raw frame for a sideways
 * device, so the inner panel is drawn one quarter turn further on (and taps
 * are inverted by the same turn).
 */
const APPLE_DUO_INNER_ORIENTATION: Record<AppleDeviceOrientation, AppleDeviceOrientation> = {
  portrait: "landscape-left",
  "landscape-left": "portrait-upside-down",
  "portrait-upside-down": "landscape-right",
  "landscape-right": "portrait",
};

/** The Duo's inner panel is the one showing (false for every rigid device). */
export function appleDuoInnerPanelLive(posture: AppleDevicePosture | null | undefined): boolean {
  return Boolean(posture?.supported && posture.activeScreenId === APPLE_DUO_INNER_SCREEN_ID);
}

/** How a stage should draw the stream for a device held at `orientation`, given the Duo's live panel. */
export function appleDuoDisplayOrientation(
  orientation: AppleDeviceOrientation,
  posture: AppleDevicePosture | null | undefined,
): AppleDeviceOrientation {
  return appleDuoInnerPanelLive(posture) ? APPLE_DUO_INNER_ORIENTATION[orientation] : orientation;
}

/**
 * What a foldable simulator reports about itself (its hinge and the panel
 * that is on), and the one way to fold it.
 *
 * Read once when enabled, then kept current by `apple.device.posture` events
 * from the device's own machine (the pin). A device without a hinge answers
 * `supported: false` and nothing else happens.
 *
 * `onAngle` hears the simulator's angle so the caller's drawn hinge follows a
 * fold made elsewhere (the CLI, another window). While ADE's own fold sweeps
 * to its target in 10° steps those reports are held back: drawing each step
 * pulled the hinge back toward where it came from.
 */
export function useAppleDuoPosture({
  enabled,
  deviceUdid,
  laneId,
  chatSessionId,
  runtimePinRef,
  pinKey,
  onAngle,
  onError,
}: {
  enabled: boolean;
  deviceUdid: string | null;
  laneId: string | null;
  chatSessionId: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** `pin?.key`: re-read when the target machine changes, not when the pin object is rebuilt. */
  pinKey: string | null;
  onAngle?: (angle: number) => void;
  onError?: (error: unknown) => void;
}) {
  const [posture, setPosture] = useState<AppleDevicePosture | null>(null);
  const foldTargetRef = useRef<{ angle: number; until: number } | null>(null);
  const onAngleRef = useRef(onAngle);
  onAngleRef.current = onAngle;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const scopeRef = useRef({ laneId, chatSessionId });
  scopeRef.current = { laneId, chatSessionId };

  useEffect(() => {
    if (!enabled || !deviceUdid) {
      setPosture(null);
      return;
    }
    let cancelled = false;
    void window.ade.iosSimulator
      .getPosture({ ...scopeRef.current, deviceUdid }, runtimePinRef.current)
      .then((next) => {
        if (cancelled) return;
        setPosture(next);
        if (next.angle !== null) onAngleRef.current?.(next.angle);
      })
      // The view draws without a posture; the events fill it in once they come.
      .catch((cause: unknown) => {
        logRendererDebugEvent("apple.posture_read_failed", { error: cause instanceof Error ? cause.message : String(cause) });
      });
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      if (event.type !== "apple.device.posture" || event.udid !== deviceUdid) return;
      setPosture(event.posture);
      const angle = event.posture.angle;
      if (angle === null) return;
      const fold = foldTargetRef.current;
      if (fold) {
        if (Date.now() < fold.until && Math.abs(angle - fold.angle) > 2) return;
        foldTargetRef.current = null;
      }
      onAngleRef.current?.(angle);
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled, deviceUdid, pinKey, runtimePinRef]);

  /** Fold the real simulator to a preset or an angle; its own posture settles the view. */
  const sendPosture = useCallback((target: { pose?: AppleDevicePose; angle?: number }) => {
    const angle = target.pose ? APPLE_DEVICE_POSE_TARGETS[target.pose].angle : target.angle;
    if (typeof angle === "number") foldTargetRef.current = { angle, until: Date.now() + FOLD_HOLD_MS };
    void window.ade.iosSimulator
      .setPosture({ ...scopeRef.current, ...target }, runtimePinRef.current)
      .then((result) => setPosture(result.posture))
      .catch((cause: unknown) => onErrorRef.current?.(cause));
  }, [runtimePinRef]);

  const angleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendAngleSoon = useCallback((angle: number) => {
    if (angleTimerRef.current) clearTimeout(angleTimerRef.current);
    angleTimerRef.current = setTimeout(() => {
      angleTimerRef.current = null;
      sendPosture({ angle: Math.round(angle) });
    }, ANGLE_DEBOUNCE_MS);
  }, [sendPosture]);
  useEffect(() => () => {
    if (angleTimerRef.current) clearTimeout(angleTimerRef.current);
  }, []);

  return { posture, sendPosture, sendAngleSoon };
}
