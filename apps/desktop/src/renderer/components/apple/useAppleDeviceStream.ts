import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { IosSimulatorStreamStatus, OpenProjectBinding } from "../../../shared/types";
import type { H264StreamStatus } from "../device/h264StreamPlayer";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import { useAppStore } from "../../state/appStore";
import { useGracefulStreamLease } from "../device/useGracefulStreamLease";
import { useStreamRecovery } from "../device/useStreamRecovery";
import {
  acquireAppleStreamLease,
  appleStreamLaneLeaseCount,
  appleStreamLeaseKey,
  releaseAppleStreamLease,
  type AppleStreamLeaseKey,
} from "./appleStreamLease";

/** Each decoded frame, outside React. `subscribe` returns its unsubscribe. */
export type AppleFrameFeed = { subscribe: (listener: () => void) => () => void };

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

/**
 * The lease this viewer holds.
 *
 * This replaces a plain "I started it" boolean. The boolean was right while a
 * device had one viewer and wrong the moment it had two: the column and the
 * corner card both own a hook, `stopStream` is lane-scoped, and whichever one
 * unmounted first stopped the other's frames.
 */
type AppleHeldLease = {
  key: AppleStreamLeaseKey;
  /**
   * Which RUN of that stream this viewer's lease belongs to.
   *
   * Carried back to `releaseAppleStreamLease`, so an unmount that lands after
   * another viewer has already started a NEW stream on the same key cannot
   * stop it. The pane and the floating player hand the device to each other,
   * and the one going away always releases after the one arriving has started.
   */
  epoch: number;
  /** Cleanup targets the runtime that acquired the lease, even if props move on. */
  pin: OpenProjectBinding | null;
};

/** The lane and chat a stop names. */
type AppleStopScope = { laneId: string | null; chatSessionId: string | null };

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
  /** True once any frame has been decoded. Set once, not per frame. */
  hasFrame: boolean;
  /**
   * Tells listeners about each decoded frame without a React render. A state
   * bumped per frame re-rendered the whole pane (rail, menus, toolbar) at the
   * stream's frame rate; the 3D presenter is the only thing that needs every
   * frame, and it only marks its texture dirty.
   */
  frames: AppleFrameFeed;
  streamStatus: IosSimulatorStreamStatus | null;
  /** Wire to `H264StreamView`'s `onStatus`. */
  handleReaderStatus: (status: H264StreamStatus, error: string | null) => void;
  /** Wire to `H264StreamView`'s `onDimensions`. */
  handleDimensions: (size: { width: number; height: number }) => void;
  /** Wire to `H264StreamView`'s `onFrame`. The watchdogs live on this call. */
  noteFrame: () => void;
  /** New stream, new address, new token. The Reconnect action on every viewer. */
  reconnect: () => void;
  /** Applies one `stream-*` event from the service. */
  applyStreamEvent: (status: IosSimulatorStreamStatus) => void;
  /**
   * The automatic reconnects ran out with no frame in between. Until then an
   * `idle` or `stalled` state is a hiccup the hook is already recovering from.
   */
  gaveUp: boolean;
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
  const [hasFrame, setHasFrame] = useState(false);
  const frameListenersRef = useRef(new Set<() => void>());
  const frames = useMemo<AppleFrameFeed>(() => ({
    subscribe(listener) {
      frameListenersRef.current.add(listener);
      return () => { frameListenersRef.current.delete(listener); };
    },
  }), []);
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
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const forwardError = useCallback((message: string | null) => {
    setError(message);
    onErrorRef.current(message);
  }, []);

  /**
   * Hand this viewer's lease back, and stop the stream only if it was the last.
   *
   * The lane and chat ids are arguments rather than a closure, so the unmount
   * path — which runs after the props are gone — stops the stream it actually
   * started rather than whatever the last render happened to name.
   */
  const scopeRef = useRef<AppleStopScope>({ laneId, chatSessionId });
  scopeRef.current = { laneId, chatSessionId };
  const { leaseRef, releaseLease } = useGracefulStreamLease<AppleHeldLease, AppleStopScope>({
    release: (lease) => releaseAppleStreamLease(lease.key, lease.epoch),
    // Somebody took the lane's stream up in the meantime, on this device or
    // another one (a swap): theirs now. The stop is lane-scoped, so it would
    // kill a new device's capture too.
    heldAgain: (lease) => appleStreamLaneLeaseCount(lease.key) > 0,
    stop: (lease, scope) => {
      void window.ade.iosSimulator
        .stopStream(lease.pin, { laneId: scope.laneId, chatSessionId: scope.chatSessionId })
        .catch(() => {});
    },
    scopeRef,
  });

  const reconnect = useCallback(() => {
    sawFrameRef.current = false;
    lastFrameAtRef.current = 0;
    connectedAtRef.current = 0;
    setError(null);
    setReconnectNonce((nonce) => nonce + 1);
  }, []);

  const wanted = Boolean(deviceUdid) && enabled && !hidden;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const deviceUdidRef = useRef(deviceUdid);
  deviceUdidRef.current = deviceUdid;
  const urlRef = useRef<string | null>(null);
  urlRef.current = url;

  // Before, a viewer whose capture ended kept a dead address — a frozen
  // picture, or "Connecting video" for ever — and only switching tabs asked
  // the service again. Now it asks again by itself.
  const { gaveUp, scheduleRecover, noteRecovered } = useStreamRecovery({
    wantedRef,
    reconnect,
    // Out of tries: say so. Left `idle` with its old address, the column
    // would call the frozen picture live and offer no Reconnect.
    onGiveUp: () => setState((current) => (current === "error" || current === "paused" ? current : "stalled")),
    resetKey: deviceUdid,
  });

  // The service says this device's capture ended while we still want it.
  useEffect(() => {
    const api = window.ade?.iosSimulator;
    if (!wanted || !deviceUdid || !api?.onEvent) return undefined;
    return api.onEvent((event) => {
      if (event.type !== "stream-stopped" && event.type !== "stream-error") return;
      if (event.status?.deviceUdid !== deviceUdidRef.current) return;
      scheduleRecover();
    }, runtimePinRef.current);
  }, [deviceUdid, runtimePinRef, scheduleRecover, wanted]);

  // Start and stop. Keyed on primitives so a status refresh never tears the
  // stream down, while a real device change or a visibility change does.
  useEffect(() => {
    if (!deviceUdid) {
      setState("idle");
      setUrl(null);
      setToken(null);
      // A device that went away still owes its lease back. This effect run is
      // the terminal owner of whatever an earlier run acquired; the superseded
      // run no longer releases on cancellation (see `run` below).
      releaseLease({ laneId, chatSessionId });
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

    const pin = runtimePinRef.current;
    const bound = useAppStore.getState().projectBinding;
    const pinKey = workRuntimeScopeKey(pin, bound);
    const leaseKey = appleStreamLeaseKey({ pin, bound, laneId, deviceUdid });
    // A device swap inside one mounted viewer: the old capture's lease is this
    // viewer's to give back, or the count never reaches zero and the helper
    // keeps encoding a device nobody is watching.
    if (leaseRef.current && leaseRef.current.key.id !== leaseKey.id) {
      releaseLease({ laneId, chatSessionId });
    }
    if (!leaseRef.current) {
      // The descriptor is what makes the lease answerable from outside: the
      // mini-player handover reads it to learn, synchronously, that this lane
      // has frames and which device they are of (round 4 §B4).
      const { epoch } = acquireAppleStreamLease(leaseKey, { laneId, deviceUdid, pinKey });
      leaseRef.current = { key: leaseKey, epoch, pin: pin ?? bound };
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
        // A superseded run does not own the lease. The effect that replaced it
        // either reused it (same device) or released it and took a fresh one
        // (device swap), so releasing here would decrement a lease a live
        // viewer still holds — and drop the count to zero under the run that
        // just started the stream, stopping the capture the viewer is watching.
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
      if (cancelled) return;
      // A terminal failure of the run this effect owns: nothing else will
      // release the lease, so the viewer does not pin the count above zero and
      // the last real viewer's stop never fires.
      releaseLease({ laneId, chatSessionId });
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
    leaseRef,
    reconnectNonce,
    releaseLease,
    runtimePinRef,
    wanted,
  ]);

  const noteFrame = useCallback(() => {
    lastFrameAtRef.current = Date.now();
    sawFrameRef.current = true;
    noteRecovered();
    setHasFrame(true);
    for (const listener of frameListenersRef.current) listener();
    setState((current) => (current === "live" ? current : "live"));
  }, [noteRecovered]);

  const handleReaderStatus = useCallback((next: H264StreamStatus, nextError: string | null) => {
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
      // With no address the reader has nothing to stop: it says "stopped"
      // just for mounting. Taken as news, it turned a start still in flight
      // into `idle`, which no watchdog watches — "Connecting video" for ever.
      if (!urlRef.current) return;
      setState((current) => (current === "paused" ? current : "idle"));
      // The body ended under a viewer that still wants it: the capture went
      // away. Ask for it again rather than keep a dead address.
      if (wantedRef.current) scheduleRecover();
      return;
    }
    // `playing` is reported once per stream; `noteFrame`, called per drawn
    // frame, is what promotes the column to `live` and feeds the watchdogs.
  }, [forwardError, scheduleRecover]);

  const handleDimensions = useCallback((next: { width: number; height: number }) => {
    setSize((current) => (
      current.width === next.width && current.height === next.height ? current : next
    ));
  }, []);

  const applyStreamEvent = useCallback((next: IosSimulatorStreamStatus) => {
    setStreamStatus(next);
  }, []);

  /*
   * A foldable streams whichever panel is on, and each panel has its own size:
   * folding the iPhone Duo swaps the inner display (669×951 pt) for the cover
   * (466×678 pt) on the SAME stream. The service republishes the transport's
   * sizes when that happens; follow them, or taps and the box keep the old
   * panel's shape.
   */
  const transportPointWidth = streamStatus?.transport?.pointWidth ?? null;
  const transportPointHeight = streamStatus?.transport?.pointHeight ?? null;
  useEffect(() => {
    if (!transportPointWidth || !transportPointHeight || transportPointWidth <= 0 || transportPointHeight <= 0) return;
    setPointSize((current) => (
      current && current.width === transportPointWidth && current.height === transportPointHeight
        ? current
        : { width: transportPointWidth, height: transportPointHeight }
    ));
  }, [transportPointHeight, transportPointWidth]);

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
          // Nothing ever drew: re-read the stream rather than wait on it.
          scheduleRecover();
        }
        return;
      }
      if (now - lastFrameAtRef.current > APPLE_FRAME_STALL_MS) setState("stalled");
    }, 500);
    return () => window.clearInterval(timer);
  }, [scheduleRecover, state, wanted]);

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
    hasFrame,
    frames,
    streamStatus,
    handleReaderStatus,
    handleDimensions,
    noteFrame,
    reconnect,
    applyStreamEvent,
    gaveUp,
  };
}
