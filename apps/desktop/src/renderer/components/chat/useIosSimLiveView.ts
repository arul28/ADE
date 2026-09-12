import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type {
  IosScreenSnapshot,
  IosSimulatorDevice,
  IosSimulatorPrivacyPane,
  IosSimulatorStreamStatus,
  IosSimulatorWindowState,
  IosSimulatorWindowSource,
  OpenProjectBinding,
} from "../../../shared/types";
import type { IosSimH264Status } from "./IosSimH264Video";
import {
  resolveIosSimBlocker,
  type IosSimBlocker,
  type IosSimBlockerAction,
} from "./IosSimVideoOverlay";
import {
  listWindowSourcesForSession,
  openIosSimSettingsPane,
  revealSimulator,
} from "./iosSimContracts";

/** Where the device screen sits inside a captured Simulator window, in video pixels. */
type WindowScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: "matched" | "heuristic";
};

/** What the drawer is currently showing, and which backend is producing it. */
export type LiveVisual =
  | {
    kind: "window";
    status: "starting" | "reconnecting" | "active" | "error";
    sourceId: string | null;
    sourceName: string | null;
    width: number | null;
    height: number | null;
    error: string | null;
  }
  /**
   * The host-encoded live view.
   *
   * The frames are the device screen, not the Simulator window, so there is no
   * capture source, no parking, and no bezel to find. `forwarded` records that
   * the URL crossed an SSH port forward, which is what lets the chip name the
   * machine the simulator really runs on.
   */
  | {
    kind: "h264";
    status: "starting" | "active" | "error";
    url: string | null;
    width: number | null;
    height: number | null;
    forwarded: boolean;
    machineName: string | null;
    error: string | null;
  };

type VideoFrameMetadata = {
  presentationTime?: number;
  expectedDisplayTime?: number;
  width?: number;
  height?: number;
};

type VideoFrameRequestElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** How long to wait before rebuilding a dropped host-encoded read address. */
const H264_RETRY_MS = 4_000;
/**
 * Consecutive failed re-resolves before the retry gives up.
 *
 * A forward that is still being rebuilt answers with no address for a few
 * seconds, which is worth waiting out. A runtime that refuses the forward
 * answers the same way forever, and at that point the overlay's Restart is the
 * honest next step.
 */
const H264_RETRY_MAX_ATTEMPTS = 5;
/** How often the Live chip re-reads the host encoder's own frame counters. */
const STREAM_METRICS_POLL_MS = 3_000;

/** Stream reports active but no new frame landed inside this window. */
const FRAME_STALL_MS = 3_000;
/** Window-state poll cadence: fast while the state is moving, slow once settled. */
const WINDOW_POLL_FAST_MS = 2_000;
const WINDOW_POLL_SLOW_MS = 10_000;
const WINDOW_POLL_STABLE_THRESHOLD = 3;

function pickSimulatorWindowSource(
  sources: IosSimulatorWindowSource[],
  device: { name: string } | null,
): IosSimulatorWindowSource | null {
  if (!sources.length) return null;
  const deviceName = device?.name.toLowerCase() ?? "";
  return [...sources]
    .filter((source) => !/developer tools|devtools|ade/i.test(source.name))
    .map((source) => {
      const name = source.name.toLowerCase();
      let score = 0;
      if (deviceName && name.includes(deviceName)) score += 80;
      if (name.includes("simulator")) score += 50;
      if (/\biphone\b|\bipad\b|\bios\b/.test(name)) score += 30;
      if (name.includes("apple tv") || name.includes("watch")) score -= 20;
      return { source, score };
    })
    .filter(({ source, score }) => {
      const name = source.name.toLowerCase();
      if (deviceName) return name.includes(deviceName) || name.includes("simulator");
      return score >= 50;
    })
    .sort((a, b) => b.score - a.score || a.source.name.localeCompare(b.source.name))[0]?.source ?? null;
}

function buildDesktopCaptureConstraints(sourceId: string, maxFrameRate: number): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        minFrameRate: Math.min(30, maxFrameRate),
        maxFrameRate,
      },
      optional: [{ cursor: "never" }],
    },
  } as unknown as MediaStreamConstraints;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load iOS snapshot for window calibration."));
    image.src = src;
  });
}

function heuristicWindowScreenRect(
  videoWidth: number,
  videoHeight: number,
  screenWidth: number | null | undefined,
  screenHeight: number | null | undefined,
): WindowScreenRect | null {
  if (videoWidth <= 0 || videoHeight <= 0 || !screenWidth || !screenHeight) return null;
  const aspect = screenWidth / screenHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const widthLimited = videoWidth * 0.91;
  const heightLimited = videoHeight * 0.9 * aspect;
  const width = Math.min(widthLimited, heightLimited);
  const height = width / aspect;
  const residualX = Math.max(0, videoWidth - width);
  const residualY = Math.max(0, videoHeight - height);
  return {
    x: residualX / 2,
    y: Math.min(residualY, Math.max(videoHeight * 0.065, residualY * 0.82)),
    width,
    height,
    confidence: 0.45,
    source: "heuristic",
  };
}

function luminanceAt(data: Uint8ClampedArray, index: number): number {
  return (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
}

async function calibrateWindowScreenRect(
  video: HTMLVideoElement,
  snapshot: IosScreenSnapshot,
): Promise<WindowScreenRect | null> {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const screenWidth = snapshot.screenshot.width;
  const screenHeight = snapshot.screenshot.height;
  const fallback = heuristicWindowScreenRect(videoWidth, videoHeight, screenWidth, screenHeight);
  if (!fallback || !snapshot.screenshot.dataUrl || video.readyState < video.HAVE_CURRENT_DATA) return fallback;

  try {
    const image = await loadImage(snapshot.screenshot.dataUrl);
    const aspect = screenWidth && screenHeight ? screenWidth / screenHeight : image.naturalWidth / image.naturalHeight;
    const sampleWidth = 28;
    const sampleHeight = Math.max(40, Math.round(sampleWidth / aspect));

    const referenceCanvas = document.createElement("canvas");
    referenceCanvas.width = sampleWidth;
    referenceCanvas.height = sampleHeight;
    const referenceCtx = referenceCanvas.getContext("2d", { willReadFrequently: true });
    if (!referenceCtx) return fallback;
    referenceCtx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    const reference = referenceCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;

    const videoCanvas = document.createElement("canvas");
    videoCanvas.width = videoWidth;
    videoCanvas.height = videoHeight;
    const videoCtx = videoCanvas.getContext("2d");
    if (!videoCtx) return fallback;
    videoCtx.drawImage(video, 0, 0, videoWidth, videoHeight);

    const candidateCanvas = document.createElement("canvas");
    candidateCanvas.width = sampleWidth;
    candidateCanvas.height = sampleHeight;
    const candidateCtx = candidateCanvas.getContext("2d", { willReadFrequently: true });
    if (!candidateCtx) return fallback;

    let bestRect: WindowScreenRect = fallback;
    let bestScore = Number.POSITIVE_INFINITY;
    const heightScales = [0.96, 0.98, 1, 1.02, 1.04];
    const xOffsets = [-0.04, -0.025, -0.01, 0, 0.01, 0.025, 0.04];
    const yOffsets = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06];

    for (const heightScale of heightScales) {
      const height = fallback.height * heightScale;
      const width = height * aspect;
      if (width <= 0 || height <= 0 || width > videoWidth || height > videoHeight) continue;
      const baseX = fallback.x + ((fallback.width - width) / 2);
      const baseY = fallback.y + ((fallback.height - height) / 2);
      for (const xOffset of xOffsets) {
        for (const yOffset of yOffsets) {
          const x = Math.max(0, Math.min(videoWidth - width, baseX + (videoWidth * xOffset)));
          const y = Math.max(0, Math.min(videoHeight - height, baseY + (videoHeight * yOffset)));
          candidateCtx.clearRect(0, 0, sampleWidth, sampleHeight);
          candidateCtx.drawImage(videoCanvas, x, y, width, height, 0, 0, sampleWidth, sampleHeight);
          const candidate = candidateCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
          let score = 0;
          for (let index = 0; index < reference.length; index += 4) {
            score += Math.abs(luminanceAt(reference, index) - luminanceAt(candidate, index));
          }
          score /= reference.length / 4;
          if (score < bestScore) {
            bestScore = score;
            bestRect = {
              x,
              y,
              width,
              height,
              confidence: Math.max(0, Math.min(1, 1 - (score / 255))),
              source: "matched",
            };
          }
        }
      }
    }
    return bestRect.confidence > 0.55 ? bestRect : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Records which live view an installation actually watches a simulator through.
 *
 * `tool_ios` already says the pane was opened. It cannot tell an install that
 * drives a simulator on this Mac from one driving a Mac across the room, and
 * that difference is the whole reason the host-encoded backend exists.
 *
 * Coarse and closed: the backend id and nothing else. No device, lane, machine
 * name, address, codec, resolution, fps, or duration — a backend id says how
 * the pixels arrived, and any of those would say what was being worked on. A
 * per-backend 24-hour deduplication key holds this to at most TWO accepted
 * events per installation per UTC day, well inside the existing
 * `ade_feature_used` 140-per-day / 30-per-minute limits. No ceiling was raised,
 * and the dashboard spec is untouched: no card asks this yet.
 */
function captureIosLiveViewBackend(backend: "window" | "host_encoded"): void {
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: {
      feature: "work",
      action: "ios_live_view",
      outcome: `backend_${backend}`,
      source: "renderer_route",
    },
    dedupeKey: `work_ios_live_view:${backend}`,
    minimumIntervalMs: 24 * 60 * 60_000,
  }).catch(() => undefined);
}

export type UseIosSimLiveViewArgs = {
  /**
   * Which surface the drawer is on. Per-render, and load-bearing: every effect
   * below stops the live view the moment this leaves `"interact"`.
   */
  mode: "interact" | "inspect" | "preview";
  /**
   * The device the recovery restart and the manual Restart act on. Per-render
   * object identity (it is the panel's own `useMemo`), which is why only the
   * two callbacks that need the whole device list it — the effects below key on
   * the primitives instead.
   */
  activeDevice: IosSimulatorDevice | null;
  /** `activeDevice.udid`, as a primitive: the main effect keys on this. */
  activeDeviceUdid: string | null;
  /** `activeDevice.name`, as a primitive, for the same reason. */
  activeDeviceName: string | null;
  /**
   * The device the app-or-device session names. A live view is only started
   * when it is the same device the drawer is pointed at.
   */
  activeSessionDeviceUdid: string | null;
  /**
   * The identity the live-view effect restarts on. A device session has no
   * session id of its own, so the panel synthesises one from its device.
   */
  activeSessionId: string | null;
  /** `status.supported`, or null before the first status read. Per-render. */
  statusSupported: boolean | null;
  /** Whether a booted device stands behind the drawer at all. Per-render. */
  hasActiveSession: boolean;
  /**
   * The last screen snapshot. Per-render, and the pointer mapping's only source
   * for the device's own pixel size.
   */
  snapshot: IosScreenSnapshot | null;
  /**
   * Whether this chat is pinned to another machine. Per-render primitive, and
   * the single question that decides which backend runs: a remote chat has no
   * Simulator window on this computer to capture.
   */
  chatIsRemote: boolean;
  /** The machine that owns the simulator, for the chip and the error state. */
  chatMachineName: string | null;
  /**
   * Re-reads the screen snapshot. Per-render identity (a `useCallback` in the
   * panel), and listed in the dependency arrays that already listed it there,
   * so it behaves exactly as it did in the component.
   */
  refreshSnapshot: (options?: { silent?: boolean; priority?: boolean }) => Promise<void>;
  /**
   * The machine every `iosSimulator.*` call below drives. Read through a ref,
   * never a dep: a local pin object is rebuilt on each cross-machine merge, and
   * depending on its identity would restart the live stream on that timer.
   *
   * The moved effects and callbacks below list it because `exhaustive-deps`
   * demands a ref it did not see declared here. A ref object never changes
   * identity, so the arrays behave exactly as they did in the component — the
   * unmount teardown below is still a mount/unmount effect.
   */
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /**
   * The panel's launch, for the overlay's Relaunch action.
   *
   * A ref rather than the function: `launch` is declared after this hook runs
   * (it needs values this hook has no business knowing), so the blocker handler
   * cannot close over it. The panel already keeps this ref current with a sync
   * effect and already calls through it elsewhere.
   */
  launchRef: MutableRefObject<(() => Promise<void>) | null>;
  /**
   * The inspect snapshot's `<img>`.
   *
   * A live-view hook wants it for one reason: it is the last fallback for "how
   * big is the media on screen". With no live visual and no video element, the
   * still image is the only node that knows the intrinsic size, and the pointer
   * mapping is measured against whatever that size is.
   */
  imageRef: MutableRefObject<HTMLImageElement | null>;
  /**
   * Where a live-view failure surfaces. Must be stable: several callbacks below
   * list it, so a fresh identity each render would re-arm them.
   */
  onError: (message: string | null) => void;
};

/** Everything the drawer still reads about the live view. */
export type IosSimLiveView = {
  liveVisual: LiveVisual | null;
  liveVisualKind: LiveVisual["kind"] | null;
  liveWidth: number | null;
  liveHeight: number | null;
  liveChip: { label: string; detail: string; tone: "active" | "starting" | "error" } | null;
  liveBlocker: IosSimBlocker | null;
  handleBlockerAction: (action: IosSimBlockerAction) => void;
  h264ReconnectNonce: number;
  h264Canvas: HTMLCanvasElement | null;
  setH264Canvas: (canvas: HTMLCanvasElement | null) => void;
  handleH264Status: (next: IosSimH264Status, nextError: string | null) => void;
  handleH264Dimensions: (size: { width: number; height: number }) => void;
  setVideoNode: (video: HTMLVideoElement | null) => void;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  mapLivePointToSimulatorPixel: (point: { x: number; y: number }) => { x: number; y: number } | null;
  armWindowCaptureRecoveryAfterInput: () => void;
  syncExistingStreamStatus: (nextStreamStatus: IosSimulatorStreamStatus | null) => void;
  handleStreamEvent: (
    type: "stream-started" | "stream-status" | "stream-stopped" | "stream-error",
    status: IosSimulatorStreamStatus,
  ) => string | null;
};

/**
 * Owns both live-view backends: the renderer's own window capture, and the
 * host-encoded H.264 stream a chat pinned to another machine gets instead.
 *
 * Everything that makes a live view hard lives here and nowhere else — the
 * capture-cancellation token, the single parking hold owed to the host, the
 * teardown ordering that stops a superseded start from stopping its
 * successor's stream, the retry that rebuilds a dropped port forward, and the
 * bezel calibration the pointer mapping is measured against. Those rules only
 * hold if they are read together, and in a 4,000-line drawer that also owns the
 * launch, the inspector and Preview Lab they were not: the ordering hazards
 * this file's comments describe were each found after they had already shipped
 * as a bug.
 *
 * The drawer keeps what the live view is *for* — the pointer handlers, the
 * capture crops, the media measurement — because those are shared with Inspect
 * and Preview Lab, which have no live view at all.
 */
export function useIosSimLiveView({
  mode,
  activeDevice,
  activeDeviceUdid,
  activeDeviceName,
  activeSessionDeviceUdid,
  activeSessionId,
  statusSupported,
  hasActiveSession,
  snapshot,
  chatIsRemote,
  chatMachineName,
  refreshSnapshot,
  runtimePinRef,
  launchRef,
  imageRef,
  onError,
}: UseIosSimLiveViewArgs): IosSimLiveView {
  const [liveVisual, setLiveVisual] = useState<LiveVisual | null>(null);
  const [h264ReconnectNonce, setH264ReconnectNonce] = useState(0);
  /**
   * Consecutive re-resolves that came back with no address.
   *
   * The retry effect below writes no other state when a re-resolve fails, so
   * without a counter in its dependency array it never ran a second time and one
   * transient refusal killed the live view for good. The count also bounds the
   * retry, which is what keeps a permanently refused forward from spinning.
   */
  const [h264ResolveFailures, setH264ResolveFailures] = useState(0);
  const [h264Canvas, setH264Canvas] = useState<HTMLCanvasElement | null>(null);
  /**
   * The address on the machine that owns the simulator.
   *
   * A status read cannot supply it — the URL carries the stream token and is
   * redacted there — so the value from `startStream` is kept here for the one
   * caller that needs it: the retry that rebuilds a dropped port forward.
   */
  const h264HostUrlRef = useRef<string | null>(null);
  const [windowScreenRect, setWindowScreenRect] = useState<WindowScreenRect | null>(null);
  const [simulatorWindowState, setSimulatorWindowState] = useState<IosSimulatorWindowState | null>(null);
  const [streamStatus, setStreamStatus] = useState<IosSimulatorStreamStatus | null>(null);
  const [frameStalled, setFrameStalled] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [windowPollNonce, setWindowPollNonce] = useState(0);
  const [videoSizeNonce, setVideoSizeNonce] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const windowScreenRectRef = useRef<WindowScreenRect | null>(null);
  const liveFrameCountRef = useRef(0);
  const liveFrameWindowStartRef = useRef(0);
  const windowCaptureRecoveryTimerRef = useRef<number | null>(null);
  const windowCaptureRecoveryAttemptedAtRef = useRef(0);
  const lastWindowFrameAtRef = useRef(0);
  const liveActiveSinceRef = useRef(0);
  // Two obligations to the host, tracked apart. One ref carrying both meant the
  // give-up path — which returns the parking hold but deliberately keeps the
  // stream flagged so unmount still reaches `stopStream` — left a later release
  // site free to return the same hold twice. With a second drawer open in this
  // window that second release decrements a holder this panel does not own,
  // tearing down the other drawer's follow.
  const streamStartedByPanelRef = useRef(false);
  // A token for the hold rather than a boolean: a start that was cancelled has
  // to hand back the holder *it* took and must never hand back a newer one that
  // the restart replacing it has since taken.
  const parkingHoldRef = useRef<symbol | null>(null);
  /**
   * The one cancellation fact for window-capture starts. Three states:
   *
   * - `null` — no start is wanted. The drawer left Interact, lost its session,
   *   or unmounted. A start that reads this on entry does not begin, and a start
   *   already in flight learns two things at once: it has been cancelled, and
   *   nobody has taken over the host stream it brought up, so stopping that
   *   stream is its own job.
   * - an arm symbol — a caller wants a start and is about to make one. A start
   *   in flight reading this has been superseded, and must *not* stop the host
   *   stream: its replacement stops the old stream itself, and a stop issued
   *   from here could land on top of the new one.
   * - a start symbol — the start that currently owns the live view.
   *
   * Arm symbols are unique per run, and every caller passes the value it armed
   * or read before its own prelude. That is what stops a cancelled prelude from
   * waking up, reading a *later* run's token, and claiming after its successor.
   *
   * This replaced three per-call-site cancellation predicates, two of which only
   * asked whether the panel had unmounted. A start superseded by a mode switch
   * or a released session therefore kept running: it took a fresh parking hold,
   * opened a getUserMedia stream nothing would tear down, and — because the host
   * relaunches Simulator.app to capture it — left a live stream on record for a
   * session that was already gone.
   */
  const captureStartRef = useRef<symbol | null>(null);

  const liveWidth = liveVisual?.width ?? videoRef.current?.videoWidth ?? imageRef.current?.naturalWidth ?? null;
  const liveHeight = liveVisual?.height ?? videoRef.current?.videoHeight ?? imageRef.current?.naturalHeight ?? null;
  const liveVisualKind = liveVisual?.kind ?? null;
  const liveWindowSourceId = liveVisual?.kind === "window" ? liveVisual.sourceId : null;
  const liveWindowHeight = liveVisual?.kind === "window" ? liveVisual.height : null;
  const liveWindowWidth = liveVisual?.kind === "window" ? liveVisual.width : null;

  const syncExistingStreamStatus = useCallback((nextStreamStatus: IosSimulatorStreamStatus | null) => {
    if (!nextStreamStatus) return;
    setStreamStatus(nextStreamStatus);
  }, []);

  /**
   * Applies one `stream-*` event and answers with what it said, so the panel
   * keeps its own footer message while the two live-view writes stay here.
   *
   * Empty dependency array, deliberately. The panel's event subscription lists
   * this, and that subscription is torn down and rebuilt on every identity
   * change — a churning identity would drop events for the length of a render.
   */
  const handleStreamEvent = useCallback((
    type: "stream-started" | "stream-status" | "stream-stopped" | "stream-error",
    status: IosSimulatorStreamStatus,
  ): string | null => {
    setStreamStatus(status);
    if (type !== "stream-error") return null;
    const errorMessage = status.lastError ?? null;
    setLiveVisual((current) => current ? { ...current, status: "error", error: errorMessage ?? current.error } : current);
    return errorMessage;
  }, []);

  /**
   * Hands the host parking holder this panel took back, at most once.
   *
   * Every teardown path goes through here so the rule lives in one place: only
   * a hold this panel still owns is returned, because a release for a hold it
   * already gave back decrements *another* drawer's holder in this same window
   * — a chat pane and the Work sidebar's iOS tab can both be open at once.
   *
   * `hold` narrows that to one specific holder, for callers that took their own
   * and may be racing a newer start: passing the token makes the release a
   * no-op once something else has replaced the hold on record.
   *
   * Never rejects: every caller is a teardown path.
   */
  const releaseParkingHold = useCallback(async (hold?: symbol): Promise<void> => {
    const held = parkingHoldRef.current;
    if (!held || (hold !== undefined && hold !== held)) return;
    parkingHoldRef.current = null;
    try {
      await window.ade.iosSimulator.releaseWindowParking();
    } catch {
      /* teardown is best-effort; the preload swallows its own failures too */
    }
  }, []);

  const stopRendererLiveVisual = useCallback((options: { preserveVisual?: boolean } = {}) => {
    const preserveVisual = options.preserveVisual === true;
    if (windowCaptureRecoveryTimerRef.current != null) {
      window.clearTimeout(windowCaptureRecoveryTimerRef.current);
      windowCaptureRecoveryTimerRef.current = null;
    }
    const video = videoRef.current as VideoFrameRequestElement | null;
    if (video && videoFrameCallbackRef.current != null && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
    }
    videoFrameCallbackRef.current = null;
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
    liveStreamRef.current = null;
    if (video) video.srcObject = null;
    liveFrameCountRef.current = 0;
    liveFrameWindowStartRef.current = 0;
    lastWindowFrameAtRef.current = 0;
    liveActiveSinceRef.current = 0;
    setFrameStalled(false);
    if (preserveVisual) {
      // Only the window backend reconnects: this teardown drops a MediaStream,
      // and the host-encoded backend has none. Its own reader owns its retry.
      setLiveVisual((current) => (
        current?.kind === "window" ? { ...current, status: "reconnecting", error: null } : current
      ));
      return;
    }
    windowScreenRectRef.current = null;
    setWindowScreenRect(null);
    setLiveVisual(null);
  }, []);

  const trackWindowVideoFrames = useCallback((video: HTMLVideoElement) => {
    const frameVideo = video as VideoFrameRequestElement;
    if (!frameVideo.requestVideoFrameCallback) return;
    liveFrameCountRef.current = 0;
    liveFrameWindowStartRef.current = performance.now();
    const onFrame = (now: number, metadata: VideoFrameMetadata) => {
      lastWindowFrameAtRef.current = Date.now();
      liveFrameCountRef.current += 1;
      const elapsedMs = Math.max(1, now - liveFrameWindowStartRef.current);
      if (elapsedMs >= 1_000) {
        liveFrameCountRef.current = 0;
        liveFrameWindowStartRef.current = now;
      }
      if (metadata.width || metadata.height) {
        setLiveVisual((current) => current?.kind === "window"
          ? {
              ...current,
              status: "active",
              width: metadata.width ?? current.width,
              height: metadata.height ?? current.height,
            }
          : current);
      }
      videoFrameCallbackRef.current = frameVideo.requestVideoFrameCallback?.(onFrame) ?? null;
    };
    videoFrameCallbackRef.current = frameVideo.requestVideoFrameCallback(onFrame);
  }, []);

  /**
   * `captureStartRef` is checked on entry and after every await in here, and
   * both awaits are long: `startStream` is a daemon round-trip, and discovery
   * runs for up to one host budget (~12s). Leaving Interact, losing the
   * session, or closing the drawer
   * while it says "Starting the live view" therefore lands React's cleanups
   * *before* this resumes — they see no stream and no hold, and then this took
   * both for a live view nobody is watching, permanently pinning the parking
   * follow so every later ADE window move re-parked (and reopened)
   * Simulator.app with no drawer open. Anything taken past that point is given
   * back here instead, including the host stream when nothing replaced it.
   *
   * The entry check is what covers the callers that `await stopStream()` right
   * before calling in: the drawer can already be gone by the time this body
   * runs, and starting anyway spawns Simulator.app for a panel that no longer
   * exists.
   */
  const startWindowCaptureVisual = useCallback(async (
    device: { udid: string; name: string },
    expected: symbol | null,
  ) => {
    // `expected` is the token the caller armed, or read, before its own
    // prelude. Comparing against it — rather than merely against null — is what
    // stops a cancelled prelude from waking up, reading a token the NEXT run
    // armed, and claiming after its own successor.
    if (expected === null || captureStartRef.current !== expected) return;
    const myStart = Symbol("ios-simulator-capture-start");
    captureStartRef.current = myStart;
    const superseded = (): boolean => captureStartRef.current !== myStart;
    let holdTakenByThisStart: symbol | null = null;
    const abandonStart = async (): Promise<void> => {
      if (holdTakenByThisStart) await releaseParkingHold(holdTakenByThisStart);
      // `null` means nothing took this start's place — the effect stopped the
      // live view and returned, or the panel unmounted — so the host stream this
      // start brought up is nobody else's to stop, and leaving it running would
      // report a live capture (and a relaunched Simulator.app) to every other
      // drawer and to the CLI. A successor start owns the token instead: it
      // stops the old stream itself, and a stop issued from here could land on
      // top of the replacement.
      if (captureStartRef.current === null && streamStartedByPanelRef.current) {
        streamStartedByPanelRef.current = false;
        await window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
      }
    };

    try {
      const status = await window.ade.iosSimulator.startStream({ deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 }, runtimePinRef.current);
      streamStartedByPanelRef.current = true;
      if (superseded()) {
        await abandonStart();
        return;
      }
      setStreamStatus(status);
      setLiveVisual({
        kind: "window",
        status: "starting",
        sourceId: null,
        sourceName: null,
        width: null,
        height: null,
        error: null,
      });
      // One sweep, and one only. The host's own discovery already settles and
      // re-attaches inside its 12s budget
      // (`SIMULATOR_SOURCE_DISCOVERY_BUDGET_MS`, sized above the ~10.5s of
      // AppleScript ceilings a cold Simulator costs), so the transient a
      // renderer-side retry loop existed for — "the Simulator window is
      // sometimes a beat behind the app" — is handled before this call ever
      // returns. Retrying on top of that only ever added spinner.
      //
      // Worst case is therefore one host budget: ~12s to a source or to a
      // terminal message.
      const result = await listWindowSourcesForSession({ deviceUdid: device.udid, deviceName: device.name });
      // Take the parking hold here, and not where the stream starts. Discovery
      // is what arms the host's claim, and a holder only counts against a claim
      // that already exists — while `startStream` itself is answered by the
      // brain daemon whenever a project is bound (which window capture
      // requires), so it never reaches the Electron-main code that owns parking
      // at all. Held even when discovery comes back empty, so the give-up path
      // below has something to give back.
      if (!parkingHoldRef.current) {
        // The host answers with whether it actually counted the holder — a
        // window that lost the claim race is silently not counted — and the
        // panel records the hold only then. Believing otherwise would make
        // every later release decrement a holder this panel never took, which
        // is another drawer's. A `false` is not retried: it means another ADE
        // window owns the parking claim, which stays true for the life of that
        // claim, so this drawer simply captures without a hold until the claim
        // is gone. It records nothing and therefore releases nothing.
        const held = await window.ade.iosSimulator.retainWindowParking();
        if (held) {
          holdTakenByThisStart = Symbol("ios-simulator-parking-hold");
          parkingHoldRef.current = holdTakenByThisStart;
        }
      }
      if (superseded()) {
        await abandonStart();
        return;
      }
      // The session passed above only tells the host whether to park and settle
      // at all. Choosing among the windows it found is this call, right here,
      // so a device switch re-picks instead of parking on the previous window.
      const source = pickSimulatorWindowSource(result.sources, device);
      if (result.windowState) setSimulatorWindowState(result.windowState);
      if (!source) {
        // The host answers with a `message` only when it has reached a verdict —
        // a permission blocker, no session, its own budget exhausted — and that
        // verdict is the specific, actionable one, so it is passed through
        // verbatim. Without one, discovery simply found no window: say that,
        // rather than claiming a timeout that did not happen.
        throw new Error(result.message ?? `ADE could not find the ${device.name} window. Make sure the simulator is running and its window is open, then try again.`);
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("ADE cannot show the simulator in this window.");
      const stream = await navigator.mediaDevices.getUserMedia(buildDesktopCaptureConstraints(source.id, 60));
      if (superseded()) {
        // `stopRendererLiveVisual` only ever stops the tracks it can see, and it
        // ran before this stream existed.
        stream.getTracks().forEach((track) => track.stop());
        await abandonStart();
        return;
      }
      liveStreamRef.current = stream;
      liveActiveSinceRef.current = Date.now();
      setFrameStalled(false);
      setLiveVisual({
        kind: "window",
        status: "active",
        sourceId: source.id,
        sourceName: source.name,
        width: null,
        height: null,
        error: null,
      });
    } catch (error) {
      // A superseded start's failure is not this drawer's failure: the caller's
      // catch would paint an error over a live view that has since moved on, and
      // hand back a parking hold that now belongs to the start which replaced
      // this one. Giving back only what this start took is `abandonStart`'s job.
      if (!superseded()) throw error;
      await abandonStart();
    }
  }, [releaseParkingHold, runtimePinRef]);

  const handleH264Status = useCallback((next: IosSimH264Status, nextError: string | null) => {
    setLiveVisual((current) => {
      if (current?.kind !== "h264") return current;
      const status = next === "playing"
        ? "active" as const
        : next === "connecting" ? "starting" as const : "error" as const;
      const error = next === "playing" || next === "connecting"
        ? null
        : nextError ?? "The live view stopped.";
      // Returning a new object for an unchanged status re-renders the whole
      // drawer. The player reports only on a real transition, and this is the
      // second guard: the two together keep a 30 fps stream at zero renders.
      if (current.status === status && current.error === error) return current;
      return { ...current, status, error };
    });
  }, []);

  const handleH264Dimensions = useCallback((size: { width: number; height: number }) => {
    setLiveVisual((current) => {
      if (current?.kind !== "h264") return current;
      if (current.width === size.width && current.height === size.height) return current;
      return { ...current, width: size.width, height: size.height };
    });
  }, []);

  /**
   * Starts the host-encoded live view.
   *
   * This is the only live view a chat pinned to another machine can have: the
   * window backend captures a Simulator window that exists on the Mac, not
   * here. It takes no parking hold, because there is no window on this computer
   * to park.
   */
  const startH264Visual = useCallback(async (
    device: { udid: string; name: string },
    arm: symbol,
  ): Promise<void> => {
    // Forget the previous stream's address before asking for a new one. A start
    // that fails leaves the error state that arms the retry, and the retry
    // would otherwise rebuild a forward to the old device with a token that
    // this stream's rotation has already invalidated — forever.
    h264HostUrlRef.current = null;
    // A fresh stream gets a fresh retry budget, so a device switch or a manual
    // Restart is not refused because the previous address had exhausted one.
    setH264ResolveFailures(0);
    setLiveVisual({
      kind: "h264",
      status: "starting",
      url: null,
      width: null,
      height: null,
      forwarded: false,
      machineName: chatIsRemote ? chatMachineName : null,
      error: null,
    });
    const status = await window.ade.iosSimulator.startStream({
      deviceUdid: device.udid,
      backend: "idb-h264",
      fps: 30,
    }, runtimePinRef.current);
    if (captureStartRef.current !== arm) {
      await window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
      return;
    }
    streamStartedByPanelRef.current = true;
    // Kept on this side, because a status read redacts it: the URL carries the
    // stream token, and only the call that creates the stream hands it out.
    const hostUrl = status.transport?.url ?? status.streamUrl;
    h264HostUrlRef.current = hostUrl;
    const resolved = await window.ade.iosSimulator.resolveStreamUrl(hostUrl, runtimePinRef.current);
    if (captureStartRef.current !== arm) return;
    if (!resolved.url) {
      throw new Error(resolved.error ?? "The live view returned no address.");
    }
    setLiveVisual({
      kind: "h264",
      status: "starting",
      url: resolved.url,
      width: status.transport?.width ?? null,
      height: status.transport?.height ?? null,
      forwarded: resolved.forwarded,
      machineName: chatIsRemote ? chatMachineName : null,
      error: null,
    });
  }, [chatIsRemote, chatMachineName, runtimePinRef]);


  /**
   * `liveStreamRef` is only ever populated by window capture, so its presence is
   * the whole precondition. Stable identity matters: React re-runs a callback
   * ref whose identity changed, and a churning ref would detach a playing video.
   */
  const attachLiveStream = useCallback((video: HTMLVideoElement | null) => {
    const stream = liveStreamRef.current;
    if (!video || !stream || video.srcObject === stream) return;
    video.srcObject = stream;
    void video.play().then(() => {
      liveActiveSinceRef.current = Date.now();
      setLiveVisual((current) => current?.kind === "window"
        ? {
            ...current,
            status: "active",
            width: video.videoWidth || current.width,
            height: video.videoHeight || current.height,
          }
        : current);
      trackWindowVideoFrames(video);
    }).catch((error) => {
      setLiveVisual((current) => current?.kind === "window"
        ? { ...current, status: "error", error: error instanceof Error ? error.message : String(error) }
        : current);
    });
  }, [trackWindowVideoFrames]);

  /**
   * A callback ref, not an effect keyed on the visual: the <video> is a sibling
   * branch of the launch stepper, so toggling the stepper remounts the element
   * without changing the visual. An effect would not re-run and the new element
   * would have no `srcObject`; attaching on mount cannot miss it.
   */
  const setVideoNode = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    attachLiveStream(video);
  }, [attachLiveStream]);

  // The element can outlive a stream swap (a device switch re-picks the capture
  // source), which the callback ref alone would not see.
  useEffect(() => {
    attachLiveStream(videoRef.current);
  }, [attachLiveStream, liveVisualKind, liveWindowSourceId]);

  useEffect(() => {
    windowScreenRectRef.current = windowScreenRect;
  }, [windowScreenRect]);

  const scheduleWindowCaptureRecovery = useCallback((reason: string) => {
    // Keyed on the session's device rather than on an app session, so the
    // restart still fires for a device session — which owns a live view of its
    // own and would otherwise stay frozen on the first dropped frame.
    if (
      mode !== "interact"
      || !activeDevice
      || activeSessionDeviceUdid !== activeDevice.udid
      || liveVisualKind !== "window"
    ) {
      return;
    }
    if (windowCaptureRecoveryTimerRef.current != null) return;
    const now = Date.now();
    if (now - windowCaptureRecoveryAttemptedAtRef.current < 2_500) return;
    windowCaptureRecoveryAttemptedAtRef.current = now;
    onError(`${reason} Restoring the live view...`);
    windowCaptureRecoveryTimerRef.current = window.setTimeout(() => {
      windowCaptureRecoveryTimerRef.current = null;
      // Read the token before the prelude below: if anything replaces or
      // cancels this run while it stops the old stream, the start declines.
      const armedForRecovery = captureStartRef.current;
      void (async () => {
        try {
          stopRendererLiveVisual();
          await window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
          // A recovery restart outlives the drawer just as easily as the first
          // start does, and it takes the same parking hold. It answers to the
          // same cancellation token, so a drawer that closed or switched out of
          // Interact during the stop above stops this run before it starts
          // anything.
          await startWindowCaptureVisual(activeDevice, armedForRecovery);
          void refreshSnapshot({ silent: true, priority: true });
        } catch (windowError) {
          // Same dead end as the effect's give-up path: nothing retries a
          // recovery that failed, the deps did not change so the effect will not
          // re-run, and the hold this start took would otherwise keep the host
          // re-parking Simulator.app while the drawer says the live view failed.
          void releaseParkingHold();
          const windowMessage = windowError instanceof Error ? windowError.message : String(windowError);
          setLiveVisual({
            kind: "window",
            status: "error",
            sourceId: null,
            sourceName: null,
            width: null,
            height: null,
            error: `Could not restore the live view. ${windowMessage}`,
          });
          onError(`Could not restore the live view. ${windowMessage}`);
        }
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setLiveVisual({
          kind: "window",
          status: "error",
          sourceId: null,
          sourceName: null,
          width: null,
          height: null,
          error: `Live view failed. ${message}`,
        });
        onError(`Live view failed. ${message}`);
      });
    }, 250);
  }, [
    activeDevice,
    activeSessionDeviceUdid,
    liveVisualKind,
    mode,
    onError,
    refreshSnapshot,
    releaseParkingHold,
    runtimePinRef,
    startWindowCaptureVisual,
    stopRendererLiveVisual,
  ]);

  const armWindowCaptureRecoveryAfterInput = useCallback(() => {
    if (mode !== "interact" || liveVisualKind !== "window") return;
    const previousFrameAt = lastWindowFrameAtRef.current;
    if (windowCaptureRecoveryTimerRef.current != null) {
      window.clearTimeout(windowCaptureRecoveryTimerRef.current);
      windowCaptureRecoveryTimerRef.current = null;
    }
    windowCaptureRecoveryTimerRef.current = window.setTimeout(() => {
      windowCaptureRecoveryTimerRef.current = null;
      if (lastWindowFrameAtRef.current <= previousFrameAt) {
        scheduleWindowCaptureRecovery("The simulator view did not update after input.");
      }
    }, 1_500);
  }, [liveVisualKind, mode, scheduleWindowCaptureRecovery]);

  /**
   * What the live view is and where it comes from.
   *
   * The host-encoded backend names the machine, because a remote live view is
   * visually identical to a local one. The window backend names nothing extra:
   * the simulator is on this computer, which the user already knows.
   */
  const liveChip = useMemo((): { label: string; detail: string; tone: "active" | "starting" | "error" } | null => {
    if (mode !== "interact" || !liveVisual) return null;
    const tone = liveVisual.status === "active"
      ? "active" as const
      : liveVisual.status === "error" ? "error" as const : "starting" as const;
    if (liveVisual.kind === "window") {
      return {
        label: "Live",
        detail: "The live view captures the Simulator window on this computer.",
        tone,
      };
    }
    const host = liveVisual.machineName ?? "this computer";
    const codec = streamStatus?.transport?.codec ?? null;
    const fps = streamStatus?.fps ?? null;
    const bitrate = streamStatus?.bitrateKbps ?? null;
    const size = liveVisual.width && liveVisual.height ? `${liveVisual.width}x${liveVisual.height}` : null;
    return {
      label: `Live ${host}`,
      detail: [
        `Encoded on ${host} and read over ${liveVisual.forwarded ? "an SSH port forward" : "loopback"}.`,
        codec ? `Codec ${codec}.` : null,
        size ? `Frame ${size}.` : null,
        fps != null ? `${fps} fps.` : null,
        bitrate != null ? `${bitrate} kbit/s.` : null,
      ].filter(Boolean).join(" "),
      tone,
    };
  }, [liveVisual, mode, streamStatus?.bitrateKbps, streamStatus?.fps, streamStatus?.transport?.codec]);

  /**
   * Rebuilds the read address after the live view drops.
   *
   * A remote stream is read through an SSH port forward, and a reconnect of the
   * runtime closes that forward: the encoder is still running, but the local
   * port it was reached on is gone. Re-resolving the host URL rebuilds the
   * forward, and the nonce is what makes the reader open the new one. The
   * retry is slow on purpose, because the other reason to be here is that the
   * encoder itself died, and hammering that costs a process each time.
   */
  useEffect(() => {
    if (liveVisual?.kind !== "h264" || liveVisual.status !== "error") return;
    const hostUrl = h264HostUrlRef.current;
    if (!hostUrl) return;
    if (h264ResolveFailures >= H264_RETRY_MAX_ATTEMPTS) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.ade.iosSimulator.resolveStreamUrl(hostUrl, runtimePinRef.current)
        .then((resolved) => {
          if (cancelled) return;
          // Counting the failure is the only state this branch writes, and it is
          // what re-arms the effect. Returning quietly left the live view dead
          // until something unrelated moved.
          if (!resolved.url) {
            setH264ResolveFailures((failures) => failures + 1);
            return;
          }
          setH264ResolveFailures(0);
          setLiveVisual((current) => (
            current?.kind === "h264"
              ? { ...current, url: resolved.url, forwarded: resolved.forwarded, status: "starting", error: null }
              : current
          ));
          setH264ReconnectNonce((nonce) => nonce + 1);
        })
        .catch(() => {
          if (!cancelled) setH264ResolveFailures((failures) => failures + 1);
        });
    }, H264_RETRY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [h264ResolveFailures, liveVisual?.kind, liveVisual?.status, runtimePinRef]);

  // The host-encoded backend is the only one that counts its own frames, so it
  // is the only one whose numbers change without an event. A slow poll keeps
  // the Live chip honest without another subscription.
  useEffect(() => {
    if (liveVisualKind !== "h264") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void window.ade.iosSimulator.getStreamStatus(runtimePinRef.current)
        .then((next) => {
          if (!cancelled) setStreamStatus(next);
        })
        .catch(() => {});
    }, STREAM_METRICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveVisualKind, runtimePinRef]);

  useEffect(() => {
    // Keyed on primitives, not object identity, so a plain status refresh no
    // longer tears the stream down — while a real device switch still does,
    // which is what re-picks the capture source instead of parking on the old
    // simulator window.
    // One guard, because the two that stood here had the same body:
    // `statusSupported !== true` covers both "not read yet" and "not
    // supported". Everything that is not a live view this panel can drive
    // tears the stream down the same way. It stays an early return so the
    // device id is narrowed for the code below.
    if (
      mode !== "interact"
      || statusSupported !== true
      || !activeDeviceUdid
      || !activeSessionId
      || activeSessionDeviceUdid !== activeDeviceUdid
    ) {
      stopRendererLiveVisual();
      void window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
      void releaseParkingHold();
      streamStartedByPanelRef.current = false;
      return;
    }
    // A remote chat has no Simulator window on this computer to capture, so the
    // live view is encoded on the machine that owns the simulator instead. The
    // local path keeps window capture: it hands the compositor's own frames to
    // a video element, which no encode can beat.
    const useHostEncoder = chatIsRemote;
    // Arm before the prelude below, not after it, so a start still in flight
    // from a previous run reads a non-null token and knows its replacement
    // stops the stream. The armed value is unique per run: a cancelled prelude
    // that wakes up later compares against the value IT armed, so it declines
    // instead of claiming on top of the run that replaced it.
    const myArm = Symbol("ios-simulator-capture-arm");
    captureStartRef.current = myArm;
    const device = { udid: activeDeviceUdid, name: activeDeviceName ?? "" };
    void (async () => {
      try {
        stopRendererLiveVisual();
        await window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
        // Starting the live view takes one parking hold on the host, so a
        // restart (a device switch) must drop the previous one first. Otherwise
        // this panel holds two and its single release on unmount never reaches
        // zero.
        await releaseParkingHold();
        streamStartedByPanelRef.current = false;
        captureIosLiveViewBackend(useHostEncoder ? "host_encoded" : "window");
        if (useHostEncoder) await startH264Visual(device, myArm);
        else await startWindowCaptureVisual(device, myArm);
      } catch (streamError) {
        // No cancellation check here: a start that was superseded or torn down
        // returns quietly and cleans up after itself, so reaching this catch
        // means this run's own start failed while it still owned the live view.
        //
        // Giving up here is terminal: nothing retries a stream that never
        // produced a frame. The panel took a parking hold on its first
        // discovery sweep, so without this release the host keeps re-parking
        // Simulator.app on every ADE window move while the drawer says the live
        // view failed. `streamStartedByPanelRef` deliberately stays set — the
        // stream itself did start, so unmount still has to reach `stopStream` —
        // but the hold is given back here and only here, so no later release
        // site returns it a second time. A failure before the first sweep took
        // no hold, so it releases nothing.
        void releaseParkingHold();
        const message = streamError instanceof Error ? streamError.message : String(streamError);
        setLiveVisual(useHostEncoder
          ? {
            kind: "h264",
            status: "error",
            url: null,
            width: null,
            height: null,
            forwarded: false,
            machineName: chatIsRemote ? chatMachineName : null,
            error: `Could not start the live view. ${message}`,
          }
          : {
            kind: "window",
            status: "error",
            sourceId: null,
            sourceName: null,
            width: null,
            height: null,
            error: `Could not start the live view. ${message}`,
          });
      }
    })();
    return () => {
      // Runs before every successor shape: the run that restarts the stream, the
      // two early returns above that stop it and start nothing, and unmount. The
      // successor that does start again re-arms above; the ones that do not
      // leave this `null`, which is what tells a start still in flight that the
      // host stream it brought up is its own to stop.
      captureStartRef.current = null;
      h264HostUrlRef.current = null;
      stopRendererLiveVisual();
    };
  }, [
    activeDeviceName,
    activeDeviceUdid,
    activeSessionDeviceUdid,
    activeSessionId,
    chatIsRemote,
    chatMachineName,
    mode,
    releaseParkingHold,
    runtimePinRef,
    startH264Visual,
    startWindowCaptureVisual,
    statusSupported,
    stopRendererLiveVisual,
  ]);

  // The renderer-side teardown above never reached the host, so a closed drawer
  // left the capture helper running. Stop it once, on real unmount only — and
  // drop the window-parking follow with it, or every later ADE window move keeps
  // nudging (and reopening) Simulator.app for a drawer that no longer exists.
  //
  // `releaseParkingHold` is a stable callback and `runtimePinRef` a ref object,
  // so this stays a mount/unmount effect despite the dependencies.
  useEffect(() => () => {
    // Read by a start that is still in flight: the cleanups cannot clean up what
    // it has not taken yet, so it has to finish the job itself. The live-view
    // effect's own cleanup clears this too, but only when its last committed run
    // was the one that starts a stream — a drawer sitting in Inspect registered
    // no cleanup at all.
    captureStartRef.current = null;
    if (streamStartedByPanelRef.current) {
      streamStartedByPanelRef.current = false;
      void window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
    }
    void releaseParkingHold();
  }, [releaseParkingHold, runtimePinRef]);

  useEffect(() => {
    if (mode !== "interact" || liveVisualKind !== "window" || !activeSessionId) {
      setSimulatorWindowState(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    let stableCount = 0;
    let lastSignature: string | null = null;
    const poll = async () => {
      let signature = "error";
      try {
        const next = await window.ade.iosSimulator.getSimulatorWindowState();
        if (cancelled) return;
        setSimulatorWindowState(next);
        signature = `${next.issue ?? "ok"}:${next.capturable}:${next.visible}:${next.windowCount}`;
      } catch {
        if (cancelled) return;
        setSimulatorWindowState(null);
      }
      // Back off once the window state stops moving; any change resets it.
      stableCount = signature === lastSignature ? stableCount + 1 : 0;
      lastSignature = signature;
      const delay = stableCount >= WINDOW_POLL_STABLE_THRESHOLD ? WINDOW_POLL_SLOW_MS : WINDOW_POLL_FAST_MS;
      timer = window.setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activeSessionId, liveVisualKind, mode, windowPollNonce]);

  // A refused Reveal is explained by the next window state (usually
  // automation-denied, which carries its own Open Settings action).
  useEffect(() => {
    setRevealError(null);
  }, [simulatorWindowState?.issue]);

  // A window-capture stream reports "active" the moment video.play() resolves,
  // even when every frame is black. Watch actual frame delivery instead.
  useEffect(() => {
    if (mode !== "interact" || liveVisual?.status !== "active") {
      setFrameStalled(false);
      return;
    }
    const video = videoRef.current as VideoFrameRequestElement | null;
    if (typeof video?.requestVideoFrameCallback !== "function") {
      setFrameStalled(false);
      return;
    }
    const timer = window.setInterval(() => {
      const last = lastWindowFrameAtRef.current || liveActiveSinceRef.current;
      if (!last) return;
      setFrameStalled(Date.now() - last > FRAME_STALL_MS);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [liveVisual?.status, mode]);

  // Tap mapping is calibrated against the captured window; a resize invalidates
  // it, so recalibrate rather than drift.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame != null) window.clearTimeout(frame);
      frame = window.setTimeout(() => setVideoSizeNonce((current) => current + 1), 250);
    });
    observer.observe(video);
    return () => {
      if (frame != null) window.clearTimeout(frame);
      observer.disconnect();
    };
  }, [liveVisualKind, liveWindowSourceId]);

  // Both live backends need one snapshot, for one number: `screen.scale`. A tap
  // is sent in device points and every live view measures in pixels, so without
  // it every tap on a 3x device lands at a third of the intended position. The
  // guard therefore asks for a booted device and not for a launch: a device
  // session carries a live view and no app session, and asking for a launch left
  // "Open <device> without an app" unscaled on the canvas backend and silently
  // dropping every tap on the window one.
  useEffect(() => {
    if (mode !== "interact" || !liveVisualKind || !hasActiveSession || snapshot) return;
    void refreshSnapshot({ silent: true, priority: true });
  }, [hasActiveSession, liveVisualKind, mode, refreshSnapshot, snapshot]);

  useEffect(() => {
    if (mode !== "interact" || liveVisualKind !== "window" || !snapshot) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const fallback = heuristicWindowScreenRect(
      video.videoWidth,
      video.videoHeight,
      snapshot.screenshot.width,
      snapshot.screenshot.height,
    );
    if (fallback) {
      windowScreenRectRef.current = fallback;
      setWindowScreenRect(fallback);
    }
    let cancelled = false;
    void calibrateWindowScreenRect(video, snapshot).then((rect) => {
      if (cancelled || !rect) return;
      windowScreenRectRef.current = rect;
      setWindowScreenRect(rect);
    });
    return () => {
      cancelled = true;
    };
  }, [
    liveVisualKind,
    liveWindowHeight,
    liveWindowWidth,
    mode,
    snapshot,
    snapshot?.capturedAt,
    snapshot?.screenshot.dataUrl,
    snapshot?.screenshot.height,
    snapshot?.screenshot.width,
    videoSizeNonce,
  ]);

  const mapLivePointToSimulatorPixel = useCallback((point: { x: number; y: number }): { x: number; y: number } | null => {
    if (liveVisualKind === "h264") {
      // The host-encoded frames ARE the device screen, so there is no bezel to
      // find and no window chrome to subtract. Only the encoder's own size has
      // to be reconciled with the screenshot's: an encoder rounds the width to
      // an even number of chroma samples, so 1179 points at 3x arrives as 1178.
      if (!snapshot?.screenshot.width || !snapshot.screenshot.height) return point;
      if (!liveWidth || !liveHeight) return point;
      return {
        x: (point.x / liveWidth) * snapshot.screenshot.width,
        y: (point.y / liveHeight) * snapshot.screenshot.height,
      };
    }
    if (liveVisualKind !== "window") return point;
    if (!snapshot || !snapshot.screenshot.width || !snapshot.screenshot.height) return null;
    const rect = windowScreenRectRef.current
      ?? heuristicWindowScreenRect(
        liveWidth ?? 0,
        liveHeight ?? 0,
        snapshot.screenshot.width,
        snapshot.screenshot.height,
      );
    if (!rect) return null;
    if (
      point.x < rect.x
      || point.y < rect.y
      || point.x > rect.x + rect.width
      || point.y > rect.y + rect.height
    ) {
      return null;
    }
    return {
      x: ((point.x - rect.x) / rect.width) * snapshot.screenshot.width,
      y: ((point.y - rect.y) / rect.height) * snapshot.screenshot.height,
    };
  }, [liveHeight, liveVisualKind, liveWidth, snapshot]);

  const liveBlocker = useMemo(() => (
    mode === "interact" && liveVisual
      ? resolveIosSimBlocker({
          // The window state describes Simulator.app on THIS computer. The
          // host-encoded backend does not use it, and on a remote runtime it
          // describes the wrong machine, so it is withheld rather than turned
          // into a blocker about a window nobody is watching.
          windowState: liveVisual.kind === "window" ? simulatorWindowState : null,
          liveStatus: liveVisual.status,
          liveError: liveVisual.error,
          frameStalled,
          degradationReason: streamStatus?.degradationReason ?? streamStatus?.fallbackReason ?? null,
          revealError,
        })
      : null
  ), [frameStalled, liveVisual, mode, revealError, simulatorWindowState, streamStatus?.degradationReason, streamStatus?.fallbackReason]);

  const restartLiveView = useCallback(async () => {
    const device = activeDevice;
    if (!device) return;
    // Same as the recovery path: the token is read before the prelude, so a
    // drawer that moves on during the stop below cancels this restart.
    const armedForRestart = captureStartRef.current;
    // A cleared token means the drawer left Interact or lost its device.
    // Stopping the visual first would replace a live error with an empty frame.
    if (armedForRestart == null) return;
    // Both backends arm the same token, so it cannot say which one is running.
    // Ask the same question the live-view effect asked: a remote chat has no
    // Simulator window on this computer, so window capture would grab nothing —
    // or, worse, the local machine's own simulator.
    const useHostEncoder = chatIsRemote;
    try {
      stopRendererLiveVisual();
      await window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
      if (useHostEncoder) await startH264Visual({ udid: device.udid, name: device.name }, armedForRestart);
      else await startWindowCaptureVisual({ udid: device.udid, name: device.name }, armedForRestart);
      void refreshSnapshot({ silent: true, priority: true });
    } catch (error) {
      // The same terminal give-up as the effect's catch: nothing retries a
      // manual restart that failed, and the hold this start took has to go back
      // or the host keeps re-parking Simulator.app behind a failed live view.
      void releaseParkingHold();
      const detail = error instanceof Error ? error.message : String(error);
      setLiveVisual(useHostEncoder
        ? {
          kind: "h264",
          status: "error",
          url: null,
          width: null,
          height: null,
          forwarded: false,
          machineName: chatMachineName,
          error: detail,
        }
        : {
          kind: "window",
          status: "error",
          sourceId: null,
          sourceName: null,
          width: null,
          height: null,
          error: detail,
        });
    }
  }, [
    activeDevice,
    chatIsRemote,
    chatMachineName,
    refreshSnapshot,
    releaseParkingHold,
    runtimePinRef,
    startH264Visual,
    startWindowCaptureVisual,
    stopRendererLiveVisual,
  ]);

  const handleBlockerAction = useCallback((action: IosSimBlockerAction) => {
    // A remote-bound project refuses this call outright. Swallowing that left
    // the button looking like it worked and the pane never opening, so say so
    // the same way a refused Reveal does.
    const openSettingsPane = (pane: IosSimulatorPrivacyPane) => {
      void openIosSimSettingsPane(pane).catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error));
      });
    };
    if (action === "open-screen-recording") {
      openSettingsPane("screen-recording");
      return;
    }
    if (action === "open-automation") {
      openSettingsPane("automation");
      return;
    }
    if (action === "relaunch") {
      void launchRef.current?.();
      return;
    }
    if (action === "reveal") {
      void (async () => {
        const result = await revealSimulator().catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
        if (!result.ok) {
          // Never report a refused reveal as done. Say why on the overlay, and
          // re-read the window state so the real blocker — usually a denied
          // Automation grant — replaces this card with its own Open Settings.
          setRevealError(result.message ?? "Could not reveal Simulator.");
          setWindowPollNonce((current) => current + 1);
          return;
        }
        setRevealError(null);
        await restartLiveView();
      })();
      return;
    }
    void restartLiveView();
  }, [launchRef, onError, restartLiveView]);
  return {
    liveVisual,
    liveVisualKind,
    liveWidth,
    liveHeight,
    liveChip,
    liveBlocker,
    handleBlockerAction,
    h264ReconnectNonce,
    h264Canvas,
    setH264Canvas,
    handleH264Status,
    handleH264Dimensions,
    setVideoNode,
    videoRef,
    mapLivePointToSimulatorPixel,
    armWindowCaptureRecoveryAfterInput,
    syncExistingStreamStatus,
    handleStreamEvent,
  };
}
