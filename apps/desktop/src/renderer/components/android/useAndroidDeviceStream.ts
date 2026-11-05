import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { H264StreamStatus } from "../device/h264StreamPlayer";
import { useAppStore } from "../../state/appStore";
import { useGracefulStreamLease } from "../device/useGracefulStreamLease";
import { useStreamRecovery } from "../device/useStreamRecovery";
import { androidStreamLeaseKey, androidStreamLeases } from "./androidStreamLease";
import type { AndroidStreamState } from "./androidDeviceState";

/**
 * The Android pane's live view: an address, a token, a first-frame watchdog,
 * a stall check and a reconnect, the same shape as `useAppleDeviceStream`.
 * The stall check differs from Apple's, see `reconnecting` below.
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
const ANDROID_FIRST_FRAME_TIMEOUT_MS = 6_000;
/** How often the status strip re-reads fps, only while the picture is on screen. */
const STREAM_METRICS_POLL_MS = 3_000;
/** No frame for this long, with a sign the link is at fault, reads as "Reconnecting". */
const ANDROID_FRAME_STALL_MS = 3_000;

/** The lease this viewer holds: the lane's stream on one machine, and the run it joined. */
type AndroidHeldLease = {
  key: string;
  epoch: number;
  pin: OpenProjectBinding | null;
  laneId: string;
};

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
  /**
   * Live, but frames stopped reaching this window while the link looks at
   * fault. Flips only on transitions, never per frame.
   */
  reconnecting: boolean;
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
  const [reconnecting, setReconnectingRaw] = useState(false);
  const reconnectingRef = useRef(false);
  const setReconnecting = useCallback((next: boolean) => {
    if (reconnectingRef.current === next) return;
    reconnectingRef.current = next;
    setReconnectingRaw(next);
  }, []);

  const sawFrameRef = useRef(false);
  const lastFrameAtRef = useRef(0);
  /** When the fps read now in flight was sent; 0 when none is. */
  const statusReadSinceRef = useRef(0);
  /** The last fps read failed: the brain could not be reached. */
  const statusReadFailedRef = useRef(false);
  const connectedAtRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // The stop names the lane the lease was taken for, so it needs no scope.
  const { leaseRef, releaseLease } = useGracefulStreamLease<AndroidHeldLease, void>({
    release: (lease) => androidStreamLeases.release(lease.key, lease.epoch),
    // A remount took the lane's stream up again in the meantime: theirs now.
    heldAgain: (lease) => androidStreamLeases.count(lease.key) > 0,
    stop: (lease) => {
      void window.ade?.androidEmulator?.stopStream({ laneId: lease.laneId }, lease.pin).catch(() => {});
    },
  });

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

  const { gaveUp, scheduleRecover, noteRecovered } = useStreamRecovery({
    wantedRef,
    reconnect,
    onGiveUp: () => {
      if (stateRef.current !== "error" && stateRef.current !== "paused") setState("stalled");
    },
    resetKey: avdName,
  });

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
    if (leaseRef.current && leaseRef.current.key !== leaseKey) releaseLease();
    if (!leaseRef.current) {
      const { epoch } = androidStreamLeases.acquire(leaseKey, () => null);
      leaseRef.current = { key: leaseKey, epoch, pin, laneId };
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
  }, [avdName, hidden, laneId, leaseRef, reconnectNonce, releaseLease, runtimePinRef, setState, wanted]);

  // Called per drawn frame: refs only, and a state write only on a transition.
  const noteFrame = useCallback(() => {
    lastFrameAtRef.current = Date.now();
    if (!sawFrameRef.current) {
      sawFrameRef.current = true;
      noteRecovered();
    }
    setReconnecting(false);
    setState("live");
  }, [noteRecovered, setReconnecting, setState]);

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
      // After the first frame, silence alone is not a stall: a still screen
      // may send nothing. A lost stream ends the reader or arrives as
      // `android.stream.state`, and both recover above; a link that stalls
      // under an open stream is `reconnecting`, below.
      if (sawFrameRef.current) return;
      const connectedAt = connectedAtRef.current;
      if (connectedAt > 0 && now - connectedAt > ANDROID_FIRST_FRAME_TIMEOUT_MS) {
        setState("stalled");
        scheduleRecover();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [scheduleRecover, setState, state, wanted]);

  /*
   * "Reconnecting": live, but the picture froze because the link did.
   *
   * Silence alone cannot say that. scrcpy encodes from a virtual display, and
   * whether a still screen keeps producing frames is up to the device's
   * encoder, so "no frame for 3 s" may just be a still screen. So silence
   * counts only with a second sign that the link, not the screen, went quiet:
   *
   * - the brain reports frames (fps > 0 over its last 2 s) that never got
   *   here, which is the stream breaking between the brain and this window;
   * - the brain itself cannot be reached: the fps read failed, or has hung
   *   past the stall time, which is what a relay stall looks like (remote
   *   calls wait ~25 s, then fail).
   *
   * The first frame that arrives clears it in `noteFrame`. So does a read that
   * answers with fps 0: the link is back and the brain has nothing to send,
   * so the silence is a still screen again.
   *
   * `hostFps` is a fresh read's fps; null when there is none to go on.
   */
  const checkStall = useCallback((hostFps: number | null) => {
    if (stateRef.current !== "live" || !sawFrameRef.current) return;
    if (reconnectingRef.current) {
      if (hostFps === 0) setReconnecting(false);
      return;
    }
    const now = Date.now();
    if (now - lastFrameAtRef.current < ANDROID_FRAME_STALL_MS) return;
    const readSince = statusReadSinceRef.current;
    const linkSilent = statusReadFailedRef.current
      || (readSince > 0 && now - readSince >= ANDROID_FRAME_STALL_MS);
    if (linkSilent || (hostFps != null && hostFps > 0)) setReconnecting(true);
  }, [setReconnecting]);

  // fps for the status strip: a slow read while the picture is live and on
  // screen. It doubles as the link check above, so one read at a time: a
  // stalled link gets one hung read, not a pile of them.
  useEffect(() => {
    const api = window.ade?.androidEmulator;
    if (!wanted || state !== "live" || !laneId || !api) {
      setReconnecting(false);
      statusReadFailedRef.current = false;
      return undefined;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (statusReadSinceRef.current > 0) {
        checkStall(null);
        return;
      }
      statusReadSinceRef.current = Date.now();
      void api.getStreamStatus({ laneId }, runtimePinRef.current)
        .then((next) => {
          if (cancelled) return;
          statusReadSinceRef.current = 0;
          statusReadFailedRef.current = false;
          setFps((current) => (current === next.fps ? current : next.fps));
          checkStall(next.fps);
        })
        .catch(() => {
          if (cancelled) return;
          statusReadSinceRef.current = 0;
          statusReadFailedRef.current = true;
          checkStall(null);
        });
    }, STREAM_METRICS_POLL_MS);
    // A hung read is noticed between polls too, so the line turns within ~1 s
    // of the stall time rather than at the next 3 s poll.
    const stallTimer = window.setInterval(() => checkStall(null), 1_000);
    return () => {
      cancelled = true;
      statusReadSinceRef.current = 0;
      window.clearInterval(timer);
      window.clearInterval(stallTimer);
    };
  }, [checkStall, laneId, runtimePinRef, setReconnecting, state, wanted]);

  return {
    state,
    url,
    token,
    reconnectNonce,
    width: size.width,
    height: size.height,
    fps,
    reconnecting,
    gaveUp,
    handleReaderStatus,
    handleDimensions,
    noteFrame,
    reconnect,
  };
}
