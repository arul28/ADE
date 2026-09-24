import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopStreamStatus } from "../../../shared/types/macDesktop";
import type { H264VideoStatus } from "./H264VideoCanvas";
import { setMacDesktopFrame } from "./macDesktopFrameStore";
import {
  MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY,
  acquireMacDesktopLiveViewLease,
  startMacDesktopLiveStream,
} from "./macDesktopLiveViewLease";

/**
 * The lane display's live view: one H.264 reader, one address, one budget.
 *
 * The transport is the simulator's `idb-h264` path, and deliberately so — the
 * Mac encodes with VideoToolbox and writes Annex-B access units to a
 * token-guarded loopback endpoint, this side decodes with WebCodecs. That is
 * the only shape that crosses a machine boundary, which is the whole point: a
 * Windows desktop viewing a Mac-hosted lane runs this exact code path.
 *
 * Three things that look like details and are not:
 *
 * - **The URL carries the token, and only `startStream` returns it.** A status
 *   read is redacted (it sits on the agent action allowlist), so a reconnect
 *   asks `startStream` again rather than replaying a remembered address: the
 *   host's `startStream` is idempotent while a lane is running and hands back
 *   the transport it is already serving, so this is a read, not a restart —
 *   and it is the only way to notice that the run it belonged to has ended.
 *   Reconnect is the one exception: it asks `fresh`, and the host restarts a
 *   run that has sent nothing for seconds.
 * - **A remote lane's address is loopback on the OTHER Mac.** It is resolved
 *   through `resolveStreamUrl`, which builds the SSH forward, and re-resolved
 *   on reconnect because a runtime reconnect closes that forward while the
 *   encoder keeps running.
 * - **The retry budget is small and slow.** The other reason to be in the error
 *   state is that the encoder died, and hammering that costs a process per try.
 *
 * Frame rate is entirely the host's business: the service drops to
 * `MAC_DESKTOP_IDLE_FPS` when nothing is happening and back up on activity, and
 * there is nothing for a decoder to do about it but decode what arrives.
 */

export const RETRY_MS = 4_000;
export const RETRY_MAX_ATTEMPTS = 5;
/** How long a reader with an address may wait for its first drawn frame. */
export const FIRST_FRAME_TIMEOUT_MS = 5_000;
/**
 * How long after its capture ends a viewer that still wants frames asks
 * again, times the try number. The same numbers as the Apple tool's viewer.
 */
export const RECOVER_DELAY_MS = 750;
/**
 * Automatic re-dials in a row before the viewer waits for a human. Reset by
 * the first drawn frame, so a stream that recovers can recover again.
 */
export const RECOVER_MAX_TRIES = 3;

/**
 * Whether the reader should try again, given what the last attempt did.
 *
 * Pure because it is the one rule worth stating on its own: only the error
 * state retries, only a lane retries, and the budget is spent for good until
 * something resets it — a fresh `restart()`, or an attempt that succeeded.
 */
export function shouldRetryLiveView(args: {
  status: MacDesktopLiveView["status"];
  laneId: string | null;
  failures: number;
}): boolean {
  if (args.status !== "error" || !args.laneId) return false;
  return args.failures < RETRY_MAX_ATTEMPTS;
}

/**
 * How often the last frame is copied into the shared store.
 *
 * Not per decoded frame: at 30fps a `toDataURL` per frame would cost more than
 * the decode. One a second is what the mini view and the Lanes hover peek
 * actually need — they are showing "what does that lane look like", not video.
 */
// Four a second, not one: the floating preview is a picture of this snapshot
// and one frame a second read as a broken stream.
const FRAME_SNAPSHOT_MS = 250;

export type MacDesktopLiveView = {
  /** The address this desktop can open, or null while it is being built. */
  url: string | null;
  /** Bumping this reconnects the reader. */
  reconnectNonce: number;
  status: "idle" | "starting" | "playing" | "error";
  error: string | null;
  /** The stream's own idea of itself, redacted. Null until the first start. */
  streamStatus: MacDesktopStreamStatus | null;
  /** Pixel size of the decoded picture, once a frame has arrived. */
  dimensions: { width: number; height: number } | null;
  onStatus: (status: H264VideoStatus, error: string | null) => void;
  onDimensions: (size: { width: number; height: number }) => void;
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
  /** Tear the stream down and build it again, budget included. */
  restart: () => void;
};

export function useMacDesktopLiveView(args: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** The pane is on screen and the display exists. Nothing starts otherwise. */
  enabled: boolean;
  chatSessionId?: string | null;
  /**
   * Who this surface is, for the per-lane decoder election. The pane (and full
   * screen) outranks the corner card, so reopening the pane takes the decoder
   * back instead of leaving a passive pane. Defaults to the pane.
   */
  priority?: number;
}): MacDesktopLiveView {
  const { laneId, runtimePin, enabled } = args;
  const chatSessionId = args.chatSessionId ?? null;
  const priority = args.priority ?? MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY;

  const [url, setUrl] = useState<string | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [status, setStatus] = useState<MacDesktopLiveView["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<MacDesktopStreamStatus | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [resolveFailures, setResolveFailures] = useState(0);
  const [restartNonce, setRestartNonce] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  /**
   * Whether this surface holds the lane's one decoder.
   *
   * A passive holder — the corner card while the pane is open — keeps the
   * stream alive without reading it, and goes active when the decoder owner
   * releases. The lease owns start/stop; this hook only decodes when it wins
   * the election.
   */
  const [ownsDecoder, setOwnsDecoder] = useState(false);

  const pinKey = runtimePin?.key ?? null;
  useEffect(() => {
    if (!enabled || !laneId) {
      setOwnsDecoder(false);
      return undefined;
    }
    // The chat rides the lease so its release drops this chat, and only this
    // chat, from the service's viewer list.
    const lease = acquireMacDesktopLiveViewLease({
      laneId,
      priority,
      chatSessionId,
      runtimePin: pinRef.current,
      onDecoderOwnershipChange: setOwnsDecoder,
    });
    setOwnsDecoder(lease.ownsDecoder());
    return () => {
      setOwnsDecoder(false);
      lease.release();
    };
  }, [chatSessionId, enabled, laneId, pinKey, priority]);

  const wanted = ownsDecoder && enabled && Boolean(laneId);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const urlRef = useRef(url);
  urlRef.current = url;

  /*
   * A viewer that still wants frames never waits for a remount.
   *
   * The capture can end under it: another desktop's explicit stop, the
   * encoder dying, the last reader timing out on the host. Before, the viewer
   * kept a dead address and sat on "Connecting" until the pane was reopened.
   * Now it asks `startStream` again by itself, a few times with a growing
   * pause, and the host either hands back the running capture or opens one.
   */
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoverTriesRef = useRef(0);
  /**
   * The next start is a Reconnect: the host restarts a run that has sent
   * nothing instead of handing the same dead run back. Set by `restart()` and
   * by an address that drew nothing; a capture that merely ended is asked for
   * again, not restarted.
   */
  const freshNextRef = useRef(false);
  const scheduleRecover = useCallback((options?: { fresh?: boolean }) => {
    if (recoverTimerRef.current != null) return;
    if (recoverTriesRef.current >= RECOVER_MAX_TRIES) return;
    recoverTriesRef.current += 1;
    recoverTimerRef.current = setTimeout(() => {
      recoverTimerRef.current = null;
      if (!wantedRef.current) return;
      if (options?.fresh) freshNextRef.current = true;
      setRestartNonce((nonce) => nonce + 1);
    }, RECOVER_DELAY_MS * recoverTriesRef.current);
  }, []);
  useEffect(() => () => {
    if (recoverTimerRef.current != null) clearTimeout(recoverTimerRef.current);
  }, []);
  // A new lane is a new story: its failures start from zero.
  useEffect(() => {
    recoverTriesRef.current = 0;
  }, [laneId]);

  // The host says this lane's capture ended, or failed, while we read it.
  useEffect(() => {
    const api = window.ade?.macDesktop;
    if (!wanted || !laneId || !api?.onEvent) return undefined;
    return api.onEvent((event) => {
      if (event.type !== "stream-stopped" && event.type !== "stream-error") return;
      if (event.status.laneId !== laneId) return;
      scheduleRecover();
    }, pinRef.current);
  }, [laneId, pinKey, scheduleRecover, wanted]);

  // An address that never draws a frame is as dead as one that ended.
  useEffect(() => {
    if (!wanted || !url || status !== "starting") return undefined;
    const timer = setTimeout(() => scheduleRecover({ fresh: true }), FIRST_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [scheduleRecover, status, url, wanted]);

  const onCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
  }, []);

  const onDimensions = useCallback((size: { width: number; height: number }) => {
    setDimensions((current) => (
      current && current.width === size.width && current.height === size.height ? current : size
    ));
  }, []);

  const onStatus = useCallback((next: H264VideoStatus, nextError: string | null) => {
    if (next === "stopped") {
      // With no address the reader has nothing to stop: it says "stopped"
      // just for mounting, and taken as news it would overwrite a start's
      // error with "starting", which no retry watches.
      if (!urlRef.current) return;
      // The body ended under a viewer that still wants it: the capture went
      // away. Ask for it again rather than keep a dead address.
      if (wantedRef.current) scheduleRecover();
    }
    if (next === "playing") recoverTriesRef.current = 0;
    setStatus(next === "playing" ? "playing" : next === "error" ? "error" : "starting");
    setError(nextError);
  }, [scheduleRecover]);

  const restart = useCallback(() => {
    setResolveFailures(0);
    recoverTriesRef.current = 0;
    freshNextRef.current = true;
    setRestartNonce((nonce) => nonce + 1);
  }, []);

  /* ── Start and stop ──────────────────────────────────────────────────── */

  useEffect(() => {
    if (!ownsDecoder || !enabled || !laneId) {
      setUrl(null);
      setStatus("idle");
      return undefined;
    }
    let cancelled = false;
    setResolveFailures(0);
    setStatus("starting");
    setError(null);

    const fresh = freshNextRef.current;
    freshNextRef.current = false;
    const run = async () => {
      // Through the lease module, so a start another holder of this chat
      // already has in flight is joined rather than repeated.
      const started = await startMacDesktopLiveStream({
        laneId,
        chatSessionId,
        runtimePin: pinRef.current,
        fresh,
      });
      if (cancelled) return;
      setStreamStatus(started);
      const hostUrl = started.transport?.url ?? null;
      if (!hostUrl) throw new Error(started.lastError ?? "The lane's display returned no stream address.");
      const resolved = await window.ade.macDesktop.resolveStreamUrl(hostUrl, pinRef.current);
      if (cancelled) return;
      if (!resolved.url) throw new Error(resolved.error ?? "The live view returned no address.");
      setUrl(resolved.url);
    };

    void run().catch((caught: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    });

    return () => {
      cancelled = true;
      setUrl(null);
      // No `stopStream` here: the stream is stopped by the lease when the last
      // holder releases, not by the first surface that happens to unmount. A
      // pane→corner-card hand-off must not kill the encoder under the card.
    };
  }, [chatSessionId, enabled, laneId, ownsDecoder, restartNonce]);

  /* ── Reconnect ───────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!laneId) return;
    if (!shouldRetryLiveView({ status, laneId, failures: resolveFailures })) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        // `startStream` again rather than a remembered address: the token is
        // only ever handed out by this call, and a stream that was restarted
        // on the host — or taken over by a second viewer — has a different one.
        // The host returns the running transport untouched when there is one.
        const started = await startMacDesktopLiveStream({
          laneId,
          chatSessionId,
          runtimePin: pinRef.current,
        });
        if (cancelled) return;
        setStreamStatus(started);
        const hostUrl = started.transport?.url ?? null;
        if (!hostUrl) throw new Error(started.lastError ?? "The lane's display returned no stream address.");
        const resolved = await window.ade.macDesktop.resolveStreamUrl(hostUrl, pinRef.current);
        if (cancelled) return;
        if (!resolved.url) throw new Error(resolved.error ?? "The live view returned no address.");
        setResolveFailures(0);
        setUrl(resolved.url);
        setStatus("starting");
        setError(null);
        setReconnectNonce((nonce) => nonce + 1);
      })().catch(() => {
        if (!cancelled) setResolveFailures((failures) => failures + 1);
      });
    }, RETRY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chatSessionId, laneId, resolveFailures, status]);

  /* ── The shared last frame ───────────────────────────────────────────── */

  useEffect(() => {
    if (status !== "playing" || !laneId) return;
    const snapshot = () => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return;
      let dataUrl: string;
      try {
        // JPEG, not PNG: the readers show it at thumbnail size and a PNG of a
        // 2560x1440 desktop is megabytes held in a module-level map.
        dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      } catch {
        // A tainted canvas cannot be read. Nothing to recover — the live view
        // itself is unaffected, only the peek.
        return;
      }
      setMacDesktopFrame({
        laneId,
        dataUrl,
        width: canvas.width,
        height: canvas.height,
        at: Date.now(),
        caption: null,
      });
    };
    // `dimensions` is in the dependency list for the blank-mini-view case: the
    // decoder reports a size as it draws the first frame, and before that the
    // canvas is 0x0 and `snapshot` has nothing to read. Without it, a pane
    // opened and closed inside the first second never wrote a frame and the
    // mini view stayed empty.
    snapshot();
    const timer = setInterval(snapshot, FRAME_SNAPSHOT_MS);
    return () => clearInterval(timer);
  }, [dimensions, laneId, status]);

  return {
    url,
    reconnectNonce,
    status,
    error,
    streamStatus,
    dimensions,
    onStatus,
    onDimensions,
    onCanvas,
    restart,
  };
}
