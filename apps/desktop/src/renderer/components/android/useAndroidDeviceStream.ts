import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { H264StreamStatus } from "../device/h264StreamPlayer";
import { useAppStore } from "../../state/appStore";
import {
  acquireAndroidStreamLease,
  androidStreamLeaseCount,
  androidStreamLeaseKey,
  releaseAndroidStreamLease,
} from "./androidStreamLease";
import type { AndroidStreamState } from "./androidDeviceState";

/**
 * The Android pane's live view: an address, a token, a first-frame watchdog
 * and a reconnect, the same shape as `useAppleDeviceStream` (which also
 * watches for a stall; Android does not, see the watchdog below).
 *
 * Android differs in two ways that make it smaller:
 *
 * - The brain's stream is keyed by lane, not by device, so the lease and the
 *   stop are per lane.
 * - The pane is flat only (P0), so nothing re-uploads a texture per frame and
 *   this hook does not re-render per frame: frames are counted in refs, and the
 *   state changes only when it actually changes.
 */

/** Connected, but the first access unit never arrived. */
export const ANDROID_FIRST_FRAME_TIMEOUT_MS = 6_000;
/** How often the status strip re-reads fps, only while the picture is on screen. */
const STREAM_METRICS_POLL_MS = 3_000;
const STREAM_RECOVER_DELAY_MS = 750;
const STREAM_RECOVER_MAX_TRIES = 3;
/** How long the last viewer's stop waits for another viewer (a remount) to arrive. */
export const ANDROID_STREAM_STOP_GRACE_MS = 1_000;

export type UseAndroidDeviceStreamArgs = {
  laneId: string | null;
  /** The lane's AVD while it is booted; null stops everything. */
  avdName: string | null;
  /** False stops the stream without calling it a failure (the pane is off screen). */
  enabled: boolean;
  hidden: boolean;
  /** A ref, never a dep: the pin object is rebuilt on cross-machine merges. */
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** Stable. */
  onError: (message: string | null) => void;
};

export type AndroidDeviceStream = {
  state: AndroidStreamState;
  url: string | null;
  token: string | null;
  reconnectNonce: number;
  /** Decoded frame size in pixels. */
  width: number | null;
  height: number | null;
  /** Frames per second from the brain, while live. */
  fps: number | null;
  gaveUp: boolean;
  handleReaderStatus: (status: H264StreamStatus, error: string | null) => void;
  handleDimensions: (size: { width: number; height: number }) => void;
  noteFrame: () => void;
  reconnect: () => void;
};

export function useAndroidDeviceStream({
  laneId,
  avdName,
  enabled,
  hidden,
  runtimePinRef,
  onError,
}: UseAndroidDeviceStreamArgs): AndroidDeviceStream {
  const [state, setStateRaw] = useState<AndroidStreamState>("idle");
  const stateRef = useRef<AndroidStreamState>("idle");
  const setState = useCallback((next: AndroidStreamState) => {
    if (stateRef.current === next) return;
    stateRef.current = next;
    setStateRaw(next);
  }, []);
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number | null; height: number | null }>({ width: null, height: null });
  const [fps, setFps] = useState<number | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);

  const sawFrameRef = useRef(false);
  const connectedAtRef = useRef(0);
  const leaseKeyRef = useRef<string | null>(null);
  const leaseEpochRef = useRef<number | null>(null);
  const leasePinRef = useRef<OpenProjectBinding | null>(null);
  const leaseLaneRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /** Give the lease back; stop the lane's stream only when this was the last viewer. */
  const releaseLease = useCallback((immediate = false) => {
    const key = leaseKeyRef.current;
    const lane = leaseLaneRef.current;
    if (!key || !lane) return;
    const epoch = leaseEpochRef.current ?? undefined;
    const pin = leasePinRef.current;
    leaseKeyRef.current = null;
    leaseEpochRef.current = null;
    leasePinRef.current = null;
    leaseLaneRef.current = null;
    if (!releaseAndroidStreamLease(key, epoch).last) return;
    const stop = () => {
      void window.ade?.androidEmulator?.stopStream({ laneId: lane }, pin).catch(() => {});
    };
    if (immediate) {
      stop();
      return;
    }
    window.setTimeout(() => {
      // A remount took the lane's stream up again in the meantime: theirs now.
      if (androidStreamLeaseCount(key) > 0) return;
      stop();
    }, ANDROID_STREAM_STOP_GRACE_MS);
  }, []);

  const reconnect = useCallback(() => {
    sawFrameRef.current = false;
    connectedAtRef.current = 0;
    setReconnectNonce((nonce) => nonce + 1);
  }, []);

  const wanted = Boolean(laneId && avdName) && enabled && !hidden;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const urlRef = useRef<string | null>(null);
  urlRef.current = url;

  const recoverTimerRef = useRef<number | null>(null);
  const recoverTriesRef = useRef(0);
  const scheduleRecover = useCallback(() => {
    if (recoverTimerRef.current != null) return;
    if (recoverTriesRef.current >= STREAM_RECOVER_MAX_TRIES) {
      setGaveUp(true);
      if (stateRef.current !== "error" && stateRef.current !== "paused") setState("stalled");
      return;
    }
    recoverTriesRef.current += 1;
    const delay = STREAM_RECOVER_DELAY_MS * recoverTriesRef.current;
    recoverTimerRef.current = window.setTimeout(() => {
      recoverTimerRef.current = null;
      if (wantedRef.current) reconnect();
    }, delay);
  }, [reconnect, setState]);
  useEffect(() => () => {
    if (recoverTimerRef.current != null) window.clearTimeout(recoverTimerRef.current);
  }, []);
  // A new device starts its failures from zero.
  useEffect(() => {
    recoverTriesRef.current = 0;
    setGaveUp(false);
  }, [avdName]);

  // The brain says the lane's stream stopped while we still want it. The brain
  // restarts a crashed scrcpy server by itself (3 a minute); this covers the
  // stop it does not retry.
  useEffect(() => {
    const api = window.ade?.androidEmulator;
    if (!wanted || !laneId || !api?.onEvent) return undefined;
    return api.onEvent((event) => {
      if (event.type !== "android.stream.state" || event.laneId !== laneId || event.running) return;
      scheduleRecover();
    }, runtimePinRef.current);
  }, [laneId, runtimePinRef, scheduleRecover, wanted]);

  // Start and stop, keyed on primitives so a status refresh never redials.
  useEffect(() => {
    const api = window.ade?.androidEmulator;
    if (!wanted || !laneId || !api) {
      setState(hidden && avdName ? "paused" : "idle");
      setUrl(null);
      setToken(null);
      setFps(null);
      releaseLease();
      return;
    }
    const pin = runtimePinRef.current;
    const bound = useAppStore.getState().projectBinding;
    const leaseKey = androidStreamLeaseKey({ pin, bound, laneId });
    if (leaseKeyRef.current && leaseKeyRef.current !== leaseKey) releaseLease();
    if (!leaseKeyRef.current) {
      const { epoch } = acquireAndroidStreamLease(leaseKey);
      leaseKeyRef.current = leaseKey;
      leaseEpochRef.current = epoch;
      leasePinRef.current = pin;
      leaseLaneRef.current = laneId;
    }

    let cancelled = false;
    sawFrameRef.current = false;
    connectedAtRef.current = Date.now();
    setState("starting");

    const run = async () => {
      // `startStream` joins a running stream; it mints the viewer's token.
      const status = await api.startStream({ laneId }, runtimePinRef.current);
      if (cancelled) return;
      if (!status.running || !status.transport) {
        throw new Error("The emulator's stream did not start.");
      }
      // A loopback address on another machine becomes one this window can open.
      const resolved = await api.resolveStreamUrl(status.transport.url, runtimePinRef.current);
      if (cancelled) return;
      if (!resolved.url) throw new Error(resolved.error ?? "The live view returned no address.");
      setUrl(resolved.url);
      setToken(status.transport.token);
      setSize({ width: status.transport.width || null, height: status.transport.height || null });
      setFps(status.fps);
    };

    void run().catch((caught: unknown) => {
      if (cancelled) return;
      releaseLease();
      setState("error");
      onErrorRef.current(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {
      cancelled = true;
    };
  }, [avdName, hidden, laneId, reconnectNonce, releaseLease, runtimePinRef, setState, wanted]);

  useEffect(() => () => releaseLease(), [releaseLease]);

  // A reload tears the page down before the grace timer fires: stop now.
  useEffect(() => {
    const onPageHide = () => releaseLease(true);
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [releaseLease]);

  const noteFrame = useCallback(() => {
    if (!sawFrameRef.current) {
      sawFrameRef.current = true;
      recoverTriesRef.current = 0;
      setGaveUp(false);
    }
    setState("live");
  }, [setState]);

  const handleReaderStatus = useCallback((next: H264StreamStatus, nextError: string | null) => {
    if (next === "error") {
      setState("error");
      onErrorRef.current(nextError);
      return;
    }
    if (next === "connecting") {
      connectedAtRef.current = Date.now();
      if (stateRef.current !== "paused") setState("starting");
      return;
    }
    if (next === "stopped") {
      // The reader says "stopped" just for mounting with no address.
      if (!urlRef.current) return;
      if (stateRef.current !== "paused") setState("idle");
      if (wantedRef.current) scheduleRecover();
    }
  }, [scheduleRecover, setState]);

  const handleDimensions = useCallback((next: { width: number; height: number }) => {
    setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
  }, []);

  // The first-frame watchdog, only while a stream is wanted.
  useEffect(() => {
    if (!wanted || (state !== "starting" && state !== "live")) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      // After the first frame, silence is not a stall: a still screen may send
      // nothing. A lost stream ends the reader or arrives as
      // `android.stream.state`, and both recover above.
      if (sawFrameRef.current) return;
      const connectedAt = connectedAtRef.current;
      if (connectedAt > 0 && now - connectedAt > ANDROID_FIRST_FRAME_TIMEOUT_MS) {
        setState("stalled");
        scheduleRecover();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [scheduleRecover, setState, state, wanted]);

  // fps for the status strip: a slow read while the picture is live and on screen.
  useEffect(() => {
    const api = window.ade?.androidEmulator;
    if (!wanted || state !== "live" || !laneId || !api) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.getStreamStatus({ laneId }, runtimePinRef.current)
        .then((next) => {
          if (!cancelled) setFps((current) => (current === next.fps ? current : next.fps));
        })
        .catch(() => {});
    }, STREAM_METRICS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [laneId, runtimePinRef, state, wanted]);

  return {
    state,
    url,
    token,
    reconnectNonce,
    width: size.width,
    height: size.height,
    fps,
    gaveUp,
    handleReaderStatus,
    handleDimensions,
    noteFrame,
    reconnect,
  };
}
