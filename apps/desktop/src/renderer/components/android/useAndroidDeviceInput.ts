import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidHardwareKey, AndroidTouchEvent } from "../../../shared/types/androidEmulator";
import type { DeviceInput } from "../device/DeviceFlatView";
import { androidKeyText } from "./androidDeviceState";

/**
 * Pointer, wheel and keys on the Android picture, as scrcpy control events.
 *
 * Unlike the Apple path, which turns a whole gesture into one `tap` or `drag`
 * action, Android takes the touch itself: down, moves, up, in device pixels,
 * and the brain injects them as they come. So the gesture is the device's to
 * recognise, and this hook only keeps the stream cheap and in order:
 *
 * - Down and up are never dropped. Moves between two sends collapse into the
 *   latest one, and moves leave at most once per animation frame.
 * - One `sendTouch` is in flight at a time, so a slow machine gets fewer,
 *   newer moves instead of a queue of old ones, and nothing arrives out of order.
 * - Typed characters are joined per frame into one `sendText`.
 * - A wheel is a finger drag: down at the pointer, moves against the scroll,
 *   and up once the wheel has been still for a moment.
 */

/** A wheel notch is ~120 px; this is how far the finger travels per unit, in device pixels. */
const WHEEL_TO_DEVICE_PX = 2;
/** The wheel has been still this long: lift the finger. */
const WHEEL_END_MS = 140;
/** The wheel uses its own pointer id so it cannot end a mouse drag. */
const WHEEL_POINTER_ID = 1;

export type AndroidDeviceInputSender = {
  /** Wire to the flat view's `onDeviceInput` (its points are device pixels here). */
  send: (input: DeviceInput) => void;
  scroll: (delta: { x: number; y: number; deltaX: number; deltaY: number }) => void;
  /** Wire to the focused screen's `onDeviceKey`. True when the key was used. */
  key: (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => boolean;
  /** A rail key: Back, Home, Recents, Power, volume. */
  pressKey: (key: AndroidHardwareKey) => void;
};

export function useAndroidDeviceInput({
  laneId,
  enabled,
  runtimePinRef,
  onError,
}: {
  laneId: string | null;
  /** False drops every event: the picture is not live. */
  enabled: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onError: (error: unknown) => void;
}): AndroidDeviceInputSender {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const laneRef = useRef(laneId);
  laneRef.current = laneId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const pendingRef = useRef<AndroidTouchEvent[]>([]);
  const inFlightRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const textRef = useRef("");
  const textFrameRef = useRef<number | null>(null);
  const wheelRef = useRef<{ x: number; y: number; timer: number } | null>(null);

  const flush = useCallback(() => {
    frameRef.current = null;
    const lane = laneRef.current;
    const api = window.ade?.androidEmulator;
    if (inFlightRef.current || pendingRef.current.length === 0 || !lane || !api) return;
    const events = pendingRef.current;
    pendingRef.current = [];
    inFlightRef.current = true;
    void api.sendTouch({ laneId: lane, events }, runtimePinRef.current)
      .catch((error: unknown) => onErrorRef.current(error))
      .finally(() => {
        inFlightRef.current = false;
        if (pendingRef.current.length === 0) return;
        // A down or up that queued behind the last send goes now. A window
        // that is not painting (hidden, or driven by App Control) runs no
        // animation frames, and an up that waits for one leaves the finger down.
        if (pendingRef.current.some((pending) => pending.action !== "move")) {
          if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
          flush();
          return;
        }
        if (frameRef.current == null) frameRef.current = window.requestAnimationFrame(flush);
      });
  }, [runtimePinRef]);

  const queue = useCallback((event: AndroidTouchEvent) => {
    const pending = pendingRef.current;
    const last = pending[pending.length - 1];
    if (event.action === "move" && last?.action === "move" && last.pointerId === event.pointerId) {
      pending[pending.length - 1] = event;
    } else {
      pending.push(event);
    }
    if (event.action === "move") {
      if (frameRef.current == null) frameRef.current = window.requestAnimationFrame(flush);
      return;
    }
    // Down and up go now: a tap must not wait a frame.
    if (frameRef.current != null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    flush();
  }, [flush]);

  const send = useCallback((input: DeviceInput) => {
    if (!enabledRef.current) return;
    const action = input.phase === "begin" ? "down" : input.phase === "end" ? "up" : "move";
    queue({ action, x: Math.round(input.x), y: Math.round(input.y), pointerId: 0 });
  }, [queue]);

  const scroll = useCallback((delta: { x: number; y: number; deltaX: number; deltaY: number }) => {
    if (!enabledRef.current) return;
    if (!Number.isFinite(delta.deltaX) || !Number.isFinite(delta.deltaY)) return;
    if (delta.deltaX === 0 && delta.deltaY === 0) return;
    let wheel = wheelRef.current;
    if (!wheel) {
      wheel = { x: delta.x, y: delta.y, timer: 0 };
      wheelRef.current = wheel;
      queue({ action: "down", x: Math.round(wheel.x), y: Math.round(wheel.y), pointerId: WHEEL_POINTER_ID });
    } else {
      window.clearTimeout(wheel.timer);
    }
    // The finger moves against the content: scrolling down is a swipe up.
    wheel.x -= delta.deltaX * WHEEL_TO_DEVICE_PX;
    wheel.y -= delta.deltaY * WHEEL_TO_DEVICE_PX;
    queue({ action: "move", x: Math.round(wheel.x), y: Math.round(wheel.y), pointerId: WHEEL_POINTER_ID });
    const current = wheel;
    current.timer = window.setTimeout(() => {
      if (wheelRef.current !== current) return;
      wheelRef.current = null;
      queue({ action: "up", x: Math.round(current.x), y: Math.round(current.y), pointerId: WHEEL_POINTER_ID });
    }, WHEEL_END_MS);
  }, [queue]);

  const pressKey = useCallback((key: AndroidHardwareKey) => {
    const lane = laneRef.current;
    const api = window.ade?.androidEmulator;
    if (!enabledRef.current || !lane || !api) return;
    void api.sendKey({ laneId: lane, key }, runtimePinRef.current)
      .catch((error: unknown) => onErrorRef.current(error));
  }, [runtimePinRef]);

  const flushText = useCallback(() => {
    textFrameRef.current = null;
    const text = textRef.current;
    textRef.current = "";
    const lane = laneRef.current;
    const api = window.ade?.androidEmulator;
    if (!text || !lane || !api) return;
    void api.sendText({ laneId: lane, text }, runtimePinRef.current)
      .catch((error: unknown) => onErrorRef.current(error));
  }, [runtimePinRef]);

  const key = useCallback((event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean => {
    if (!enabledRef.current) return false;
    // Esc is Back, the key every Android emulator front end maps it to.
    if (event.key === "Escape") {
      pressKey("back");
      return true;
    }
    const text = androidKeyText(event);
    if (text == null) return false;
    textRef.current += text;
    if (textFrameRef.current == null) textFrameRef.current = window.requestAnimationFrame(flushText);
    return true;
  }, [flushText, pressKey]);

  // A device that stops drawing mid-gesture gets nothing more; pending frames go.
  useEffect(() => {
    if (enabled) return;
    pendingRef.current = [];
    textRef.current = "";
  }, [enabled]);

  useEffect(() => () => {
    if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
    if (textFrameRef.current != null) window.cancelAnimationFrame(textFrameRef.current);
    if (wheelRef.current) window.clearTimeout(wheelRef.current.timer);
  }, []);

  return { send, scroll, key, pressKey };
}
