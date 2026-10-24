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
import { appleDuoPanelOrientation } from "../../../shared/appleOrientation";

/** How long ADE's own fold may sweep before the simulator's reports count again. */
const FOLD_HOLD_MS = 8_000;
/** A hinge drag sends its latest angle once the drag pauses, not every frame. */
const ANGLE_DEBOUNCE_MS = 250;
/** When the first read does not know how the phone is held, read once more after this. */
const POSTURE_REREAD_MS = 1_500;
/** A reported hinge this close to the drawn one is the same fold, not a move. */
const HINGE_MATCH_DEGREES = 2;

/** The Duo's inner panel is the one showing (false for every rigid device). */
export function appleDuoInnerPanelLive(posture: AppleDevicePosture | null | undefined): boolean {
  return Boolean(posture?.supported && posture.activeScreenId === APPLE_DUO_INNER_SCREEN_ID);
}

/**
 * How a stage should draw the stream for a device held at `orientation`, given
 * the Duo's live panel. A Duo says how its live panel's picture sits on the
 * framebuffer, for either panel and whatever the app on it decided; that is
 * drawn as reported; without the report, the inner panel is drawn a quarter
 * turn on (`appleDuoPanelOrientation`).
 */
export function appleDuoDisplayOrientation(
  orientation: AppleDeviceOrientation,
  posture: AppleDevicePosture | null | undefined,
): AppleDeviceOrientation {
  if (posture?.supported && posture.displayOrientation) return posture.displayOrientation;
  return appleDuoPanelOrientation(orientation, appleDuoInnerPanelLive(posture));
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
    let retry: ReturnType<typeof setTimeout> | null = null;
    const read = (again: boolean) => {
      void window.ade.iosSimulator
        .getPosture({ ...scopeRef.current, deviceUdid }, runtimePinRef.current)
        .then((next) => {
          if (cancelled) return;
          setPosture(next);
          if (next.angle !== null) onAngleRef.current?.(next.angle);
          // A capture that just started has not heard how the phone is held
          // yet; it does within a moment, and a still phone sends no event.
          if (again && next.supported && next.orientation === null) retry = setTimeout(() => read(false), POSTURE_REREAD_MS);
        })
        // The view draws without a posture; the events fill it in once they come.
        .catch((cause: unknown) => {
          logRendererDebugEvent("apple.posture_read_failed", { error: cause instanceof Error ? cause.message : String(cause) });
        });
    };
    read(true);
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      if (event.type !== "apple.device.posture" || event.udid !== deviceUdid) return;
      setPosture(event.posture);
      const angle = event.posture.angle;
      if (angle === null) return;
      const fold = foldTargetRef.current;
      if (fold) {
        if (Date.now() < fold.until && Math.abs(angle - fold.angle) > HINGE_MATCH_DEGREES) return;
        foldTargetRef.current = null;
      }
      onAngleRef.current?.(angle);
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      unsubscribe?.();
    };
  }, [enabled, deviceUdid, pinKey, runtimePinRef]);

  /** Fold the real simulator to a preset or an angle; its own posture settles the view. */
  const sendPosture = useCallback((target: { pose?: AppleDevicePose; angle?: number }) => {
    const angle = target.pose ? APPLE_DEVICE_POSE_TARGETS[target.pose].angle : target.angle;
    if (typeof angle === "number") foldTargetRef.current = { angle, until: Date.now() + FOLD_HOLD_MS };
    void window.ade.iosSimulator
      .setPosture({ ...scopeRef.current, ...target }, runtimePinRef.current)
      // The answer can come while the hinge still sweeps: the slider stays
      // where it was let go, and the fold hold above settles the rest.
      .then((result) => setPosture(result.posture))
      .catch((cause: unknown) => {
        onErrorRef.current?.(cause);
        // A fold that failed leaves the phone where it was: the drawn hinge
        // and the slider go back to the device's angle, not the one asked for.
        foldTargetRef.current = null;
        void window.ade.iosSimulator
          .getPosture({ ...scopeRef.current }, runtimePinRef.current)
          .then((posture) => {
            setPosture(posture);
            if (posture.supported && posture.angle !== null) onAngleRef.current?.(posture.angle);
          })
          .catch(() => undefined);
      });
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

  /** A posture read elsewhere (a rotate's answer), shown until the next event. */
  const showPosture = useCallback((next: AppleDevicePosture) => setPosture(next), []);

  return { posture, sendPosture, sendAngleSoon, showPosture };
}
