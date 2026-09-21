import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { IosSimulatorStreamStatus, OpenProjectBinding } from "../../../shared/types";
import type { IosSimH264Status } from "../chat/IosSimH264Video";
import {
  acquireAppleStreamLease,
  appleStreamLeaseKey,
  releaseAppleStreamLease,
} from "./appleStreamLease";

/**
 * The Apple column's live view, and the successor to `useIosSimLiveView`.
 *
 * Everything the old hook owned for the renderer's own Simulator.app window
 * capture — the desktop-capture constraints, the bezel calibration, the window
 * hold, the three-state cancellation token that kept a superseded start from
 * stopping its successor's stream — is gone with the backend it served. There is one engine now: the vendored Swift helper encodes H.264 on
 * the machine that owns the device and serves it over loopback, so this hook is
 * an address, a token, two watchdogs and a reconnect.
 *
 * The two watchdogs are not the same check:
 *
 * - **First frame** (5s). The stream said it started and the reader connected,
 *   but no access unit has ever been decoded. The old window path had one of
 *   these and the H.264 path did not, so a helper that accepted the connection
 *   and then produced nothing left the column saying "Starting" forever.
 * - **Frame time** (3s). Frames were arriving and stopped. This is the classic
 *   stall, and it must not fire before the first frame or a slow boot reads as
 *   a dead stream.
 */

/** Nothing for this long after frames were flowing is a stall. */
export const APPLE_FRAME_STALL_MS = 3_000;
/** Connected, but the first access unit never arrived. */
export const APPLE_FIRST_FRAME_TIMEOUT_MS = 5_000;
/** How often the live chip re-reads fps and bitrate. */
const STREAM_METRICS_POLL_MS = 3_000;

export type AppleStreamState =
  | "idle"
  | "starting"
  | "live"
  | "stalled"
  | "paused"
  | "error";

export type AppleStreamChip = {
  label: string;
  detail: string;
  tone: "active" | "starting" | "error";
};

export type UseAppleDeviceStreamArgs = {
  /** The device to stream. Null stops everything. */
  deviceUdid: string | null;
  laneId: string | null;
  chatSessionId: string | null;
  /**
   * False stops the stream without treating it as a failure — the column is not
   * visible, or there is no booted device behind it yet. The spec's
   * "Paused — not visible" state is this flag going false with a device still
   * present.
   */
  enabled: boolean;
  /** True when the column is mounted but its surface is not visible. */
  hidden: boolean;
  /** The machine that owns the device, for the chip. Null when it is this one. */
  machineName: string | null;
  /** Encoder cap, from `apple.remoteBitrateKbpsCap`. Only sent for a remote viewer. */
  bitrateKbpsCap: number | null;
  /**
   * The machine every `iosSimulator.*` call drives. A ref, never a dep: the pin
   * object is rebuilt on each cross-machine merge and depending on its identity
   * would restart the stream on that timer.
   */
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** Where a stream failure surfaces. Must be stable. */
  onError: (message: string | null) => void;
};

export type AppleDeviceStream = {
  state: AppleStreamState;
  /** Localised read address, or null before one exists. */
  url: string | null;
  /** The bearer token the reader must send as a header. */
  token: string | null;
  /** Bump to force the reader to redial. */
  reconnectNonce: number;
  /** Decoded frame size, in PIXELS. */
  width: number | null;
  height: number | null;
  /**
   * Screen size in POINTS, which is the unit `tap`, `drag` and the inspect
   * overlay all speak. Null until the stream says.
   *
   * Passing this to the presenter is what makes a pointer position land where
   * the user pointed: a view laid out in decoded pixels maps a click to a
   * pixel coordinate, and sending that to `tap` on a 3× phone aims at three
   * times the intended point — off the bottom of the screen for anything below
   * a third of the way down. That was round 2's "input does nothing".
   */
  devicePointSize: { width: number; height: number } | null;
  error: string | null;
  chip: AppleStreamChip | null;
  /** Increments once per decoded frame; the 3D presenter re-uploads on change. */
  frameVersion: number;
  streamStatus: IosSimulatorStreamStatus | null;
  /** Wire to `IosSimH264Video`'s `onStatus`. */
  handleReaderStatus: (status: IosSimH264Status, error: string | null) => void;
  /** Wire to `IosSimH264Video`'s `onDimensions`. */
  handleDimensions: (size: { width: number; height: number }) => void;
  /** Wire to `IosSimH264Video`'s `onFrame`. The watchdogs live on this call. */
  noteFrame: () => void;
  /** New stream, new address, new token. The Reconnect action on every viewer. */
  reconnect: () => void;
  /** Applies one `stream-*` event from the service. */
  applyStreamEvent: (status: IosSimulatorStreamStatus) => void;
};

function formatBitrate(kbps: number | null | undefined): string | null {
  if (typeof kbps !== "number" || !Number.isFinite(kbps) || kbps <= 0) return null;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${Math.round(kbps)} kb/s`;
}

export function useAppleDeviceStream({
  deviceUdid,
  laneId,
  chatSessionId,
  enabled,
  hidden,
  machineName,
  bitrateKbpsCap,
  runtimePinRef,
  onError,
}: UseAppleDeviceStreamArgs): AppleDeviceStream {
  const [state, setState] = useState<AppleStreamState>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  const [pointSize, setPointSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [frameVersion, setFrameVersion] = useState(0);
  const [streamStatus, setStreamStatus] = useState<IosSimulatorStreamStatus | null>(null);
  /**
   * When the last frame landed, and whether any ever did.
   *
   * Refs rather than state: they are written once per decoded frame, and a
   * `setState` at 60Hz would re-render the whole column for a number only the
   * watchdog reads.
   */
  const lastFrameAtRef = useRef(0);
  const sawFrameRef = useRef(false);
  const connectedAtRef = useRef(0);
  /**
   * The lease this viewer holds, or null when it holds none.
   *
   * This replaces a plain "I started it" boolean. The boolean was right while
   * a device had one viewer and wrong the moment it had two: the column and
   * the corner card both own a hook, `stopStream` is lane-scoped, and whichever
   * one unmounted first stopped the other's frames.
   */
  const leaseKeyRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const forwardError = useCallback((message: string | null) => {
    setError(message);
    onErrorRef.current(message);
  }, []);

  /**
   * Hand this viewer's lease back, and stop the stream only if it was the last.
   *
   * Takes the lane and chat ids as arguments rather than closing over them so
   * the unmount path — which runs after the props are gone — stops the stream
   * it actually started rather than whatever the last render happened to name.
   */
  const releaseLease = useCallback((scope: { laneId: string | null; chatSessionId: string | null }) => {
    const key = leaseKeyRef.current;
    if (!key) return;
    leaseKeyRef.current = null;
    if (!releaseAppleStreamLease(key).last) return;
    void window.ade.iosSimulator
      .stopStream(runtimePinRef.current, { laneId: scope.laneId, chatSessionId: scope.chatSessionId })
      .catch(() => {});
  }, [runtimePinRef]);

  const reconnect = useCallback(() => {
    sawFrameRef.current = false;
    lastFrameAtRef.current = 0;
    connectedAtRef.current = 0;
    setError(null);
    setReconnectNonce((nonce) => nonce + 1);
  }, []);

  const wanted = Boolean(deviceUdid) && enabled && !hidden;

  // Start and stop. Keyed on primitives so a status refresh never tears the
  // stream down, while a real device change or a visibility change does.
  useEffect(() => {
    if (!deviceUdid) {
      setState("idle");
      setUrl(null);
      setToken(null);
      return;
    }
    if (!wanted) {
      // Not a failure: the viewer stopped asking. The spec's rule is that a
      // hidden viewer stops its stream and says so, rather than stalling — and
      // "its" is load-bearing: a hidden corner card gives up ITS lease, and the
      // column beside it keeps the frames it is still holding a lease for.
      setState(hidden ? "paused" : "idle");
      setUrl(null);
      setToken(null);
      releaseLease({ laneId, chatSessionId });
      return;
    }

    const leaseKey = appleStreamLeaseKey({
      pinKey: runtimePinRef.current?.key,
      laneId,
      deviceUdid,
    });
    // A device swap inside one mounted viewer: the old capture's lease is this
    // viewer's to give back, or the count never reaches zero and the helper
    // keeps encoding a device nobody is watching.
    if (leaseKeyRef.current && leaseKeyRef.current !== leaseKey) {
      releaseLease({ laneId, chatSessionId });
    }
    if (!leaseKeyRef.current) {
      acquireAppleStreamLease(leaseKey);
      leaseKeyRef.current = leaseKey;
    }

    let cancelled = false;
    sawFrameRef.current = false;
    lastFrameAtRef.current = 0;
    connectedAtRef.current = Date.now();
    setState("starting");
    setError(null);

    const run = async () => {
      const status = await window.ade.iosSimulator.startStream(
        {
          deviceUdid,
          laneId,
          chatSessionId,
          fps: 30,
          // Only a remote viewer is capped. A viewer on the machine that owns
          // the device pays nothing for the bits, so capping it would be a
          // quality loss with no saving behind it.
          bitrateKbps: machineName ? bitrateKbpsCap : null,
        },
        runtimePinRef.current,
      );
      if (cancelled) {
        releaseLease({ laneId, chatSessionId });
        return;
      }
      setStreamStatus(status);
      const hostUrl = status.transport?.url ?? status.streamUrl;
      // The token never rides the URL: the helper strips the query string
      // before it matches the path and authorises on the header alone.
      const streamToken = status.transport?.token ?? null;
      const resolved = await window.ade.iosSimulator.resolveStreamUrl(hostUrl, runtimePinRef.current);
      if (cancelled) return;
      if (!resolved.url) {
        throw new Error(resolved.error ?? "The live view returned no address.");
      }
      setUrl(resolved.url);
      setToken(streamToken);
      setSize({
        width: status.transport?.width ?? null,
        height: status.transport?.height ?? null,
      });
      const pointWidth = status.transport?.pointWidth ?? null;
      const pointHeight = status.transport?.pointHeight ?? null;
      setPointSize(
        pointWidth && pointHeight && pointWidth > 0 && pointHeight > 0
          ? { width: pointWidth, height: pointHeight }
          : null,
      );
    };

    void run().catch((caught: unknown) => {
      // A start that never produced a stream owes no stop, but it does owe the
      // lease back — otherwise a failed viewer pins the count above zero and
      // the last real viewer's stop never fires.
      releaseLease({ laneId, chatSessionId });
      if (cancelled) return;
      setState("error");
      forwardError(caught instanceof Error ? caught.message : String(caught));
    });

    return () => {
      cancelled = true;
    };
  }, [
    bitrateKbpsCap,
    chatSessionId,
    deviceUdid,
    forwardError,
    hidden,
    laneId,
    machineName,
    reconnectNonce,
    releaseLease,
    runtimePinRef,
    wanted,
  ]);

  /**
   * Unmount hands this viewer's lease back.
   *
   * The scope is read from refs because the cleanup runs with whatever the
   * closure captured, and a stop aimed at a stale lane is a stop that misses.
   */
  const scopeRef = useRef({ laneId, chatSessionId });
  scopeRef.current = { laneId, chatSessionId };
  useEffect(() => () => {
    releaseLease(scopeRef.current);
  }, [releaseLease]);

  const noteFrame = useCallback(() => {
    lastFrameAtRef.current = Date.now();
    sawFrameRef.current = true;
    setFrameVersion((version) => version + 1);
    setState((current) => (current === "live" ? current : "live"));
  }, []);

  const handleReaderStatus = useCallback((next: IosSimH264Status, nextError: string | null) => {
    if (next === "error") {
      setState("error");
      forwardError(nextError);
      return;
    }
    if (next === "connecting") {
      connectedAtRef.current = Date.now();
      setState((current) => (current === "paused" ? current : "starting"));
      return;
    }
    if (next === "stopped") {
      setState((current) => (current === "paused" ? current : "idle"));
      return;
    }
    // `playing` means the decoder accepted a chunk, not that a frame was drawn.
    // `noteFrame` is what promotes the column to `live`.
  }, [forwardError]);

  const handleDimensions = useCallback((next: { width: number; height: number }) => {
    setSize((current) => (
      current.width === next.width && current.height === next.height ? current : next
    ));
  }, []);

  const applyStreamEvent = useCallback((next: IosSimulatorStreamStatus) => {
    setStreamStatus(next);
  }, []);

  // One timer for both watchdogs. It runs only while a stream is wanted, so a
  // paused or absent device costs nothing.
  useEffect(() => {
    if (!wanted) return;
    if (state !== "starting" && state !== "live") return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (!sawFrameRef.current) {
        const connectedAt = connectedAtRef.current;
        if (connectedAt > 0 && now - connectedAt > APPLE_FIRST_FRAME_TIMEOUT_MS) {
          setState("stalled");
        }
        return;
      }
      if (now - lastFrameAtRef.current > APPLE_FRAME_STALL_MS) setState("stalled");
    }, 500);
    return () => window.clearInterval(timer);
  }, [state, wanted]);

  // Only the host-encoded backend counts its own frames, so a slow poll is the
  // only thing that keeps fps and bitrate honest on the chip.
  useEffect(() => {
    if (!wanted || state === "idle") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void window.ade.iosSimulator
        .getStreamStatus(runtimePinRef.current, { laneId, chatSessionId })
        .then((next) => {
          if (!cancelled) setStreamStatus(next);
        })
        .catch(() => {});
    }, STREAM_METRICS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [chatSessionId, laneId, runtimePinRef, state, wanted]);

  const chip = useMemo<AppleStreamChip | null>(() => {
    if (state === "idle") return null;
    const fps = typeof streamStatus?.fps === "number" && streamStatus.fps > 0
      ? `${Math.round(streamStatus.fps)}fps`
      : null;
    const bitrate = formatBitrate(streamStatus?.bitrateKbps);
    const where = machineName ? `Encoded on ${machineName}.` : "Encoded on this Mac.";
    const metrics = [fps, bitrate].filter((part): part is string => Boolean(part)).join(" · ");
    switch (state) {
      case "starting":
        return { label: "Starting", detail: where, tone: "starting" };
      case "paused":
        return { label: "Paused", detail: "Not visible.", tone: "starting" };
      case "stalled":
        return {
          label: "Stalled",
          detail: metrics ? `${where} ${metrics}` : where,
          tone: "error",
        };
      case "error":
        return { label: "Error", detail: error ?? where, tone: "error" };
      case "live":
      default:
        return {
          label: "Live",
          detail: metrics ? `${where} ${metrics}` : where,
          tone: "active",
        };
    }
  }, [error, machineName, state, streamStatus?.bitrateKbps, streamStatus?.fps]);

  return {
    state,
    url,
    token,
    reconnectNonce,
    width: size.width,
    height: size.height,
    devicePointSize: pointSize,
    error,
    chip,
    frameVersion,
    streamStatus,
    handleReaderStatus,
    handleDimensions,
    noteFrame,
    reconnect,
    applyStreamEvent,
  };
}
