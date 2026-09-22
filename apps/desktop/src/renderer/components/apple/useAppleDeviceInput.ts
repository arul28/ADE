// Ported from t3code apps/web/src/components/device/DeviceStreamView.tsx and
// useDeviceControls.ts (MIT, T3 Tools Inc.) — the pointer-capture gesture shape
// and the normalise-against-the-drawn-frame rule.
import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AppleDeviceInput } from "./AppleDeviceFlatView";

/**
 * One pointer gesture on the device, turned into ONE call.
 *
 * Round 2 sent `tap` on pointer-up and threw `begin` and `move` away. Three
 * things followed from that, all of them in the 2026-09-21 live test:
 *
 * 1. **A drag did nothing.** Scrolling a list, swiping a row, dragging a
 *    slider: all of them arrived as a single tap at the point the finger
 *    happened to lift.
 * 2. **A burst of taps was a burst of runtime actions.** Every one is an
 *    `ade/actions/call` with the default 25s timeout, and the device's control
 *    queue runs them one at a time — so a slow or wedged runtime turned a few
 *    impatient taps into the storm of identical timeouts in the desktop log.
 * 3. There was no way to tell a tap from the end of a drag, so the service
 *    could not have done better with what it was given.
 *
 * The gesture is recognised here, where the pointer stream already is, and
 * leaves as exactly one action: `tap` for a press that did not travel,
 * `drag` for one that did (the service replays it as begin → moves → end on
 * the helper, with the real duration, which is what makes iOS read it as a
 * drag rather than a flick). A wheel is a drag too — iOS has no scroll event.
 */

/** Travel, in device points, under which a gesture is a tap and not a drag. */
export const APPLE_TAP_SLOP_POINTS = 10;

/** A wheel notch is ~120; this is how far the finger travels per unit. */
const WHEEL_TO_POINTS = 1;

/** Below this a drag is a flick; iOS ignores flicks on most scrollers. */
const MIN_DRAG_MS = 60;
const MAX_DRAG_MS = 2_000;

export type AppleDeviceInputSender = {
  /** Wire to `AppleDeviceStage`'s `onDeviceInput`. */
  send: (input: AppleDeviceInput) => void;
  /** Wire to `AppleDeviceStage`'s `onDeviceScroll`. */
  scroll: (delta: { x: number; y: number; deltaX: number; deltaY: number }) => void;
  /** Wire to the focused frame's `onKeyDown`. Returns true when it was sent. */
  key: (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => boolean;
};

export type UseAppleDeviceInputArgs = {
  deviceUdid: string | null;
  laneId: string | null;
  chatSessionId: string | null;
  /** False drops every event: not live, watching someone else, inspect on. */
  enabled: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onError?: (error: unknown) => void;
};

type ActiveGesture = {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  travel: number;
  startedAt: number;
};

/** The text a key event puts on the device, or null when it puts none. */
export function appleKeyText(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Enter") return "\n";
  // A single printable character. Every named key ("Shift", "ArrowUp",
  // "Backspace") is longer than one char, which is exactly the filter the
  // helper's `type` command needs: it types text and cannot press keys.
  if (event.key.length === 1) return event.key;
  return null;
}

export function useAppleDeviceInput({
  deviceUdid,
  laneId,
  chatSessionId,
  enabled,
  runtimePinRef,
  onError,
}: UseAppleDeviceInputArgs): AppleDeviceInputSender {
  const gestureRef = useRef<ActiveGesture | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const fail = useCallback((error: unknown) => {
    onErrorRef.current?.(error);
  }, []);

  const scope = useMemo(
    () => ({ laneId, chatSessionId }),
    [chatSessionId, laneId],
  );

  const send = useCallback((input: AppleDeviceInput) => {
    if (!enabled || !deviceUdid) {
      gestureRef.current = null;
      return;
    }
    const x = Math.round(input.x);
    const y = Math.round(input.y);
    if (input.phase === "begin") {
      gestureRef.current = {
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        travel: 0,
        startedAt: Date.now(),
      };
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) return;
    gesture.travel = Math.max(
      gesture.travel,
      Math.hypot(x - gesture.startX, y - gesture.startY),
    );
    gesture.lastX = x;
    gesture.lastY = y;
    if (input.phase === "move") return;

    gestureRef.current = null;
    const pin = runtimePinRef.current;
    if (gesture.travel <= APPLE_TAP_SLOP_POINTS) {
      void window.ade.iosSimulator
        .tap({ deviceUdid, x, y, ...scope }, pin)
        .catch(fail);
      return;
    }
    const durationMs = Math.min(
      MAX_DRAG_MS,
      Math.max(MIN_DRAG_MS, Date.now() - gesture.startedAt),
    );
    void window.ade.iosSimulator
      .drag(
        {
          deviceUdid,
          startX: gesture.startX,
          startY: gesture.startY,
          endX: x,
          endY: y,
          durationMs,
          ...scope,
        },
        pin,
      )
      .catch(fail);
  }, [deviceUdid, enabled, fail, runtimePinRef, scope]);

  const scroll = useCallback((delta: { x: number; y: number; deltaX: number; deltaY: number }) => {
    if (!enabled || !deviceUdid) return;
    if (!Number.isFinite(delta.deltaX) || !Number.isFinite(delta.deltaY)) return;
    if (delta.deltaX === 0 && delta.deltaY === 0) return;
    // The finger moves opposite to the content, exactly as the helper's own
    // wheel path documents: scrolling the content down is a swipe up.
    const endX = delta.x - (delta.deltaX * WHEEL_TO_POINTS);
    const endY = delta.y - (delta.deltaY * WHEEL_TO_POINTS);
    void window.ade.iosSimulator
      .drag(
        {
          deviceUdid,
          startX: Math.round(delta.x),
          startY: Math.round(delta.y),
          endX: Math.round(endX),
          endY: Math.round(endY),
          durationMs: 120,
          ...scope,
        },
        runtimePinRef.current,
      )
      .catch(fail);
  }, [deviceUdid, enabled, fail, runtimePinRef, scope]);

  const key = useCallback((event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  }): boolean => {
    if (!enabled || !deviceUdid) return false;
    const text = appleKeyText(event);
    if (text == null) return false;
    void window.ade.iosSimulator
      .typeText({ deviceUdid, text, ...scope }, runtimePinRef.current)
      .catch(fail);
    return true;
  }, [deviceUdid, enabled, fail, runtimePinRef, scope]);

  return { send, scroll, key };
}
