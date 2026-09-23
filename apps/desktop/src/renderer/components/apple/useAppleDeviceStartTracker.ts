import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { APPLE_START_GIVE_UP_CODE } from "./appleErrors";

/**
 * How often a loading card that has not moved re-reads the truth.
 *
 * The card used to wait on exactly one thing — the `deviceStart` promise, or
 * the stream hook — and when that answer never came it sat on "Booting
 * device" until the pane was remounted, over a device that was already
 * streaming. A re-read every few seconds is what makes that impossible.
 */
export const APPLE_LOADING_RECHECK_MS = 8_000;
/**
 * Past this a start has failed whatever its promise says: `bootstatus` gives
 * up at 90s and the helper's capture at 30s. The card turns into the "taking
 * too long" sentence with Start, instead of spinning.
 */
export const APPLE_START_GIVE_UP_MS = 150_000;

/** True while the start it was handed for is still the current one. */
export type AppleStartTicket = () => boolean;

export type AppleDeviceStartTracker = {
  /** The start in flight: a udid, `"create"`, or null. */
  pending: string | null;
  /** A new start; the ticket stays true until another start or a settle. */
  begin: (key: string) => AppleStartTicket;
  /** The start is over (it finished, streamed, or was given up). */
  settle: (ticket?: AppleStartTicket) => void;
  /** A ticket for the start in flight right now, or null. */
  inFlight: () => AppleStartTicket | null;
  /** The device the service last called off, until something says it is on. */
  offUdid: string | null;
  markOff: (udid: string) => void;
  clearOff: (udid: string) => void;
};

/**
 * The Apple pane's start lifecycle: which start is in flight, and which device
 * the service last called off.
 */
export function useAppleDeviceStartTracker({
  deviceUdid,
  statusSaysBooted,
}: {
  deviceUdid: string | null;
  /** A status read says this lane's device is Booted. */
  statusSaysBooted: boolean;
}): AppleDeviceStartTracker {
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = pending;
  /** Which start is current, so an older one settling late changes nothing. */
  const tokenRef = useRef(0);
  /**
   * A device the service just told us is off (`APPLE_DEVICE_OFF`).
   *
   * Wins over every "booted" reading until something says it is on again: a
   * start, a boot event, or a fresh `simctl` read. Without it a status read
   * that still said Booted would ask for the stream again and again.
   */
  const [offUdid, setOffUdid] = useState<string | null>(null);

  const begin = useCallback((key: string): AppleStartTicket => {
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    setOffUdid(null);
    setPending(key);
    return () => tokenRef.current === token;
  }, []);

  const settle = useCallback((ticket?: AppleStartTicket) => {
    if (ticket && !ticket()) return;
    tokenRef.current += 1;
    setPending(null);
  }, []);

  const inFlight = useCallback((): AppleStartTicket | null => {
    if (!pendingRef.current) return null;
    const token = tokenRef.current;
    return () => tokenRef.current === token;
  }, []);

  const markOff = useCallback((udid: string) => setOffUdid(udid), []);
  const clearOff = useCallback((udid: string) => {
    setOffUdid((current) => (current === udid ? null : current));
  }, []);

  // A status read of this device as Booted is fresh `simctl` truth too.
  useEffect(() => {
    if (offUdid && statusSaysBooted && deviceUdid === offUdid) setOffUdid(null);
  }, [deviceUdid, offUdid, statusSaysBooted]);

  return { pending, begin, settle, inFlight, offUdid, markOff, clearOff };
}

/**
 * A loading card that cannot hang.
 *
 * While the card is up, re-read the truth every few seconds: the device list
 * and status (which land an off device on the Off card and a running one on
 * the stream), and for a start in flight, whether the lane is already
 * streaming — in which case the start is done, whatever its promise is doing.
 * A start still going past `APPLE_START_GIVE_UP_MS` is given up. A hidden pane
 * re-reads nothing: its stream is paused on purpose.
 */
export function useAppleLoadingWatchdog(
  tracker: Pick<AppleDeviceStartTracker, "inFlight" | "settle">,
  {
    loading,
    hidden,
    laneId,
    chatSessionId,
    runtimePinRef,
    refreshList,
    reconnectStream,
    onGiveUp,
  }: {
    loading: boolean;
    hidden: boolean;
    laneId: string | null;
    chatSessionId: string | null;
    runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
    refreshList: () => void;
    reconnectStream: () => void;
    onGiveUp: (error: Error) => void;
  },
): void {
  const { inFlight, settle } = tracker;
  const reconnectRef = useRef(reconnectStream);
  reconnectRef.current = reconnectStream;
  const onGiveUpRef = useRef(onGiveUp);
  onGiveUpRef.current = onGiveUp;
  useEffect(() => {
    if (!loading || hidden) return undefined;
    const since = Date.now();
    const timer = window.setInterval(() => {
      refreshList();
      const ticket = inFlight();
      if (!ticket) {
        // "Connecting video" with no start in flight: the device is up and
        // only this viewer's stream is missing. Ask for it again — the
        // service joins a capture another viewer is running, or opens one.
        reconnectRef.current();
        return;
      }
      if (Date.now() - since >= APPLE_START_GIVE_UP_MS) {
        settle(ticket);
        onGiveUpRef.current(new Error(
          `${APPLE_START_GIVE_UP_CODE}: the simulator did not become ready within ${Math.round(APPLE_START_GIVE_UP_MS / 1000)}s.`,
        ));
        return;
      }
      void window.ade.iosSimulator.getStreamStatus(runtimePinRef.current, { laneId, chatSessionId })
        .then((next) => {
          if (next?.running) settle(ticket);
        })
        .catch(() => undefined);
    }, APPLE_LOADING_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [chatSessionId, hidden, inFlight, laneId, loading, refreshList, runtimePinRef, settle]);
}
