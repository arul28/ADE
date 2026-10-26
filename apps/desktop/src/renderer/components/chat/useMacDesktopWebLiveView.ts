import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { isWebCodecsAvailable, type H264StreamStatus } from "./h264StreamPlayer";
import { macDesktopWebApi } from "./macDesktopWebStream";
import { useMacDesktopStreamSubscription } from "./useMacDesktopStreamSubscription";
import {
  RECOVER_DELAY_MS,
  RECOVER_MAX_TRIES,
  RECOVER_SLOW_MS,
  useMacDesktopFrameSnapshots,
  type MacDesktopLiveView,
} from "./useMacDesktopLiveView";

/**
 * How long a web subscription may wait for its first drawn frame.
 *
 * Longer than the desktop's loopback reader: the records cross the relay, and
 * the host only starts a viewer on a keyframe.
 */
export const WEB_FIRST_FRAME_TIMEOUT_MS = 10_000;

/**
 * The lane display's live view on the hosted web client.
 *
 * The same `MacDesktopLiveView` the desktop hook returns, so the full pane
 * renders one way on both surfaces. What differs is only the transport: the
 * desktop reads a token-guarded loopback URL (or its SSH forward), which a
 * browser has no way to reach; here the host pushes the H.264 records over the
 * sync socket (`macDesktop.streamSubscribe`) and the decoder reads them as a
 * push source.
 *
 * A subscription belongs to one socket and one visible tab. A hidden tab drops
 * it (nobody is looking, and the host would keep encoding for it), and a
 * socket that closes takes it along, so both re-subscribe when they come back.
 * A stream that ends or never draws is asked for again a few times, then once
 * every `RECOVER_SLOW_MS`, the same budget the desktop viewer keeps.
 */
export function useMacDesktopWebLiveView(args: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** The pane is on screen and the display exists. Nothing subscribes otherwise. */
  enabled: boolean;
}): MacDesktopLiveView {
  const { laneId, runtimePin } = args;
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const api = macDesktopWebApi();
  // The host half and the browser half, both: without WebCodecs there is
  // nothing to decode with, and the full pane is not offered (workToolPanels).
  const supported = Boolean(
    api?.streamSubscribe
    && api.onStreamRecord
    && api.supportsLiveStream?.(pinRef.current ?? undefined) === true,
  ) && isWebCodecsAvailable();
  const enabled = args.enabled && supported && Boolean(laneId);

  const [nonce, setNonce] = useState(0);
  const { pageVisible, connected, source } = useMacDesktopStreamSubscription({
    api,
    laneId,
    runtimePin,
    enabled,
    nonce,
  });
  const [status, setStatus] = useState<MacDesktopLiveView["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const wanted = enabled && pageVisible && connected;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  /* ── Re-dials ─────────────────────────────────────────────────────────── */

  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoverTriesRef = useRef(0);
  const clearRecover = useCallback(() => {
    if (recoverTimerRef.current != null) clearTimeout(recoverTimerRef.current);
    recoverTimerRef.current = null;
  }, []);
  useEffect(() => clearRecover, [clearRecover]);

  const scheduleRecover = useCallback(() => {
    if (recoverTimerRef.current != null) return;
    if (recoverTriesRef.current >= RECOVER_MAX_TRIES) {
      if (wantedRef.current) setGaveUp(true);
      return;
    }
    recoverTriesRef.current += 1;
    recoverTimerRef.current = setTimeout(() => {
      recoverTimerRef.current = null;
      if (wantedRef.current) setNonce((value) => value + 1);
    }, RECOVER_DELAY_MS * recoverTriesRef.current);
  }, []);

  // A new lane, or a viewer that stopped wanting the lane, starts fresh.
  useEffect(() => {
    clearRecover();
    recoverTriesRef.current = 0;
    setGaveUp(false);
    setDimensions(null);
  }, [clearRecover, laneId, enabled]);

  // Spent re-dials still ask now and then, so a host whose capture came back
  // is not left on "no picture" until somebody presses Reconnect.
  useEffect(() => {
    if (!gaveUp || !wanted) return undefined;
    const timer = setInterval(() => setNonce((value) => value + 1), RECOVER_SLOW_MS);
    return () => clearInterval(timer);
  }, [gaveUp, wanted]);

  /* ── The subscription ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (!source) {
      setStatus("idle");
      setError(null);
      return;
    }
    setStatus("starting");
    setError(null);
  }, [source]);

  // A subscription that never draws is as dead as one that ended.
  useEffect(() => {
    if (!source || status !== "starting") return undefined;
    const timer = setTimeout(scheduleRecover, WEB_FIRST_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [scheduleRecover, source, status]);

  const onStatus = useCallback((next: H264StreamStatus, nextError: string | null) => {
    if (next === "playing") {
      recoverTriesRef.current = 0;
      clearRecover();
      setGaveUp(false);
    } else if ((next === "stopped" || next === "error") && wantedRef.current) {
      scheduleRecover();
    }
    setStatus(next === "playing" ? "playing" : next === "error" ? "error" : "starting");
    setError(nextError);
  }, [clearRecover, scheduleRecover]);

  const onDimensions = useCallback((size: { width: number; height: number }) => {
    setDimensions((current) => (
      current && current.width === size.width && current.height === size.height ? current : size
    ));
  }, []);

  const onCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
  }, []);

  /** A person's Reconnect: a fresh subscription and a fresh budget. */
  const restart = useCallback(() => {
    clearRecover();
    recoverTriesRef.current = 0;
    setGaveUp(false);
    setNonce((value) => value + 1);
  }, [clearRecover]);

  useMacDesktopFrameSnapshots({ laneId, status, dimensions, canvasRef });

  return {
    url: null,
    source,
    reconnectNonce: 0,
    status,
    error,
    streamStatus: null,
    dimensions,
    onStatus,
    onDimensions,
    onCanvas,
    gaveUp,
    restart,
  };
}
