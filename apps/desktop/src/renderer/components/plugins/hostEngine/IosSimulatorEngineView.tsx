import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

import type {
  IosScreenSnapshot,
  IosSimulatorStatus,
  IosSimulatorWindowSource,
  OpenProjectBinding,
} from "../../../../shared/types";
import { listWindowSourcesForSession } from "../../chat/iosSimContracts";
import { cn } from "../../ui/cn";
import type { HostEngineViewProps } from "./engineViewProps";

/**
 * The simulator mirror, and nothing else.
 *
 * A plugin page draws the device picker, the launch form, the status, the
 * inspect list and the preview lab; it reserves a rect and asks the host to
 * paint the picture into it. This is that picture: the live `<video>` of the
 * Simulator window, plus the taps, drags and keystrokes that land on it. Every
 * piece of chrome the compiled `ChatIosSimulatorPanel` also draws is absent on
 * purpose — registering the whole panel as the engine painted a second panel
 * over the page and swallowed its input, which is the bug this replaces.
 *
 * It picks no device either. The page picks; this mirrors whatever
 * `getStatus` reports as active, and follows `onEvent` when that changes.
 */

/* ---------------------------------------------------------------------------
 * Copied from `../../chat/ChatIosSimulatorPanel.tsx`.
 *
 * These helpers are module-private there, so they cannot be imported. This is a
 * COPY and not a move: the compiled panel still owns the originals and still
 * runs them, so the window geometry now has two spellings. Change one and the
 * two surfaces disagree about where a tap lands — the heuristic's margins, the
 * luminance search and the object-contain maths must move together until the
 * compiled panel is retired and this becomes the only copy.
 * ------------------------------------------------------------------------- */

type RenderedMediaBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

type WindowScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: "matched" | "heuristic";
};

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

function measureObjectContain(
  element: HTMLElement,
  intrinsicWidth: number,
  intrinsicHeight: number,
): RenderedMediaBounds | null {
  const rect = element.getBoundingClientRect();
  if (intrinsicWidth <= 0 || intrinsicHeight <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / intrinsicWidth, rect.height / intrinsicHeight);
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;
  const parentRect = element.parentElement?.getBoundingClientRect() ?? rect;
  return {
    left: rect.left + ((rect.width - width) / 2) - parentRect.left,
    top: rect.top + ((rect.height - height) / 2) - parentRect.top,
    width,
    height,
    scaleX: width / intrinsicWidth,
    scaleY: height / intrinsicHeight,
  };
}

function pointerToMediaPoint(
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>,
  element: HTMLElement,
  intrinsicWidth: number,
  intrinsicHeight: number,
): { x: number; y: number; bounds: RenderedMediaBounds } | null {
  const bounds = measureObjectContain(element, intrinsicWidth, intrinsicHeight);
  if (!bounds) return null;
  const parentRect = element.parentElement?.getBoundingClientRect() ?? element.getBoundingClientRect();
  const localX = event.clientX - parentRect.left - bounds.left;
  const localY = event.clientY - parentRect.top - bounds.top;
  if (localX < 0 || localY < 0 || localX > bounds.width || localY > bounds.height) return null;
  return {
    x: localX / bounds.scaleX,
    y: localY / bounds.scaleY,
    bounds,
  };
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load iOS snapshot for window calibration."));
    image.src = src;
  });
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

/* --------------------------- end of the copy ----------------------------- */

type DragStart = {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
};

type LiveVisual = {
  kind: "window";
  status: "starting" | "reconnecting" | "active" | "error";
  sourceId: string | null;
  sourceName: string | null;
  width: number | null;
  height: number | null;
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

/** Travel below this is a tap; anything more is a drag. In CSS pixels. */
const TAP_TRAVEL_LIMIT_PX = 8;

export function IosSimulatorEngineView({
  laneId,
  projectRoot,
  runtimePin,
  controlDisabledReason = null,
}: HostEngineViewProps) {
  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [snapshot, setSnapshot] = useState<IosScreenSnapshot | null>(null);
  const [liveVisual, setLiveVisual] = useState<LiveVisual | null>(null);
  const [windowScreenRect, setWindowScreenRect] = useState<WindowScreenRect | null>(null);
  const [videoSizeNonce, setVideoSizeNonce] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const windowScreenRectRef = useRef<WindowScreenRect | null>(null);
  const liveFrameCountRef = useRef(0);
  const liveFrameWindowStartRef = useRef(0);
  const lastWindowFrameAtRef = useRef(0);
  const liveActiveSinceRef = useRef(0);
  const windowCaptureRecoveryTimerRef = useRef<number | null>(null);
  const windowCaptureRecoveryAttemptedAtRef = useRef(0);
  const dragStartRef = useRef<DragStart | null>(null);
  const snapshotSequenceRef = useRef(0);
  // Two obligations to the host, tracked apart. One ref carrying both meant the
  // give-up path — which returns the parking hold but deliberately keeps the
  // stream flagged so unmount still reaches `stopStream` — left a later release
  // site free to return the same hold twice. The host counts holders across
  // every surface in this window, so a double release decrements a holder this
  // view does not own.
  const streamStartedByPanelRef = useRef(false);
  // A token for the hold rather than a boolean: a start that was cancelled has
  // to hand back the holder *it* took and must never hand back a newer one that
  // the restart replacing it has since taken.
  const parkingHoldRef = useRef<symbol | null>(null);
  /**
   * The one cancellation fact for window-capture starts. Three states:
   *
   * - `null` — no start is wanted. The page took the engine down, the session
   *   went away, or this unmounted. A start that reads this on entry does not
   *   begin, and a start already in flight learns two things at once: it has
   *   been cancelled, and nobody has taken over the host stream it brought up,
   *   so stopping that stream is its own job.
   * - an arm symbol — a caller wants a start and is about to make one. A start
   *   in flight reading this has been superseded, and must *not* stop the host
   *   stream: its replacement stops the old stream itself, and a stop issued
   *   from here could land on top of the new one.
   * - a start symbol — the start that currently owns the live view.
   *
   * Arm symbols are unique per run, and every caller passes the value it armed
   * or read before its own prelude. That is what stops a cancelled prelude from
   * waking up, reading a *later* run's token, and claiming after its successor.
   */
  const captureStartRef = useRef<symbol | null>(null);

  /**
   * Which tree every scoped iOS Simulator call means.
   *
   * An explicit `projectRoot` beats `laneId` service-side, so sending both is
   * not belt-and-braces — it silently discards the lane, and the call lands in
   * the primary checkout while this view reports success. When a lane is
   * scoped, name only the lane: the service resolves its worktree and fails
   * loudly if it cannot.
   */
  const rootScope = useMemo(
    (): { laneId: string } | { projectRoot: string | null } => (laneId ? { laneId } : { projectRoot }),
    [laneId, projectRoot],
  );
  // Stringified because the pin is a fresh object on most renders, and every
  // effect below that talks to the host wants "the machine changed", not "the
  // parent re-rendered".
  const runtimePinKey = useMemo(() => JSON.stringify(runtimePin ?? null), [runtimePin]);

  const controlsDisabled = Boolean(controlDisabledReason);
  const controlsDisabledMessage = controlDisabledReason ?? "Read-only from this lane.";

  const activeDevice = status?.activeDevice ?? null;
  const activeSession = status?.activeSession ?? null;
  const activeDeviceUdid = activeDevice?.udid ?? null;
  const activeDeviceName = activeDevice?.name ?? null;
  const activeSessionId = activeSession?.id ?? null;
  const activeSessionDeviceUdid = activeSession?.deviceUdid ?? null;
  const statusSupported = status?.supported ?? null;

  const liveVisualKind = liveVisual?.kind ?? null;
  const liveWindowSourceId = liveVisual?.kind === "window" ? liveVisual.sourceId : null;
  const liveWindowWidth = liveVisual?.width ?? null;
  const liveWindowHeight = liveVisual?.height ?? null;
  const liveWidth = liveVisual?.width ?? videoRef.current?.videoWidth ?? null;
  const liveHeight = liveVisual?.height ?? videoRef.current?.videoHeight ?? null;
  const mediaWidth = liveWidth ?? snapshot?.screenshot.width ?? snapshot?.screen.width ?? 0;
  const mediaHeight = liveHeight ?? snapshot?.screenshot.height ?? snapshot?.screen.height ?? 0;

  /**
   * Returns the parking hold, once.
   *
   * Called with no argument the release is unconditional, but only ever when a
   * hold this view still owns is on record: a release for a hold it already
   * gave back decrements *another* surface's holder in this same window.
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
    if (preserveVisual) {
      setLiveVisual((current) => current ? { ...current, status: "reconnecting", error: null } : current);
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
   * runs for up to one host budget (~12s). The page moving the engine off
   * screen, the session going away, or this unmounting while it says "Starting
   * the live view" therefore lands React's cleanups *before* this resumes —
   * they see no stream and no hold, and then this took both for a live view
   * nobody is watching, permanently pinning the parking follow so every later
   * ADE window move re-parks (and reopens) Simulator.app with no view on
   * screen. Anything taken past that point is given back here instead,
   * including the host stream when nothing replaced it.
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
      // live view and returned, or this unmounted — so the host stream this
      // start brought up is nobody else's to stop, and leaving it running would
      // report a live capture (and a relaunched Simulator.app) to every other
      // surface and to the CLI. A successor start owns the token instead: it
      // stops the old stream itself, and a stop issued from here could land on
      // top of the replacement.
      if (captureStartRef.current === null && streamStartedByPanelRef.current) {
        streamStartedByPanelRef.current = false;
        await window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
      }
    };

    try {
      await window.ade.iosSimulator.startStream({ deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 }, runtimePinRef.current);
      streamStartedByPanelRef.current = true;
      if (superseded()) {
        await abandonStart();
        return;
      }
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
      // re-attaches inside its 12s budget, so the transient a renderer-side
      // retry loop existed for — "the Simulator window is sometimes a beat
      // behind the app" — is handled before this call ever returns.
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
        // hold is recorded only then. Believing otherwise would make every
        // later release decrement a holder this view never took, which is
        // another surface's. A `false` is not retried: it means another ADE
        // window owns the parking claim, which stays true for the life of that
        // claim, so this view simply captures without a hold. It records
        // nothing and therefore releases nothing.
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
      // A superseded start's failure is not this view's failure: the caller's
      // catch would paint an error over a live view that has since moved on, and
      // hand back a parking hold that now belongs to the start which replaced
      // this one. Giving back only what this start took is `abandonStart`'s job.
      if (!superseded()) throw error;
      await abandonStart();
    }
  }, [releaseParkingHold]);

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
   * A callback ref, not an effect keyed on the visual: the <video> is one branch
   * of a conditional, so a degradation sentence taking its place and going away
   * again remounts the element without changing the visual. An effect would not
   * re-run and the new element would have no `srcObject`; attaching on mount
   * cannot miss it.
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

  const refreshStatus = useCallback(async () => {
    const next = await window.ade.iosSimulator.getStatus(runtimePinRef.current);
    setStatus(next);
  }, []);

  useEffect(() => {
    void refreshStatus().catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshStatus, runtimePinKey]);

  // The page owns the device picker, so every change of what is active reaches
  // this view as a host event rather than as a prop.
  useEffect(() => {
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        void refreshStatus().catch(() => {});
        return;
      }
      if (event.type === "session-released") {
        setSnapshot(null);
        void refreshStatus().catch(() => {});
        return;
      }
      if (event.type === "stream-error") {
        const errorMessage = event.status.lastError ?? null;
        setLiveVisual((current) => current ? { ...current, status: "error", error: errorMessage ?? current.error } : current);
      }
    }, runtimePinRef.current);
    return () => {
      unsubscribe();
    };
  }, [refreshStatus, runtimePinKey]);

  /**
   * The snapshot is never drawn here. It is read for three numbers — the
   * screenshot's pixel width and height, and the screen's control scale —
   * without which a pointer on the video maps to nothing.
   */
  const refreshSnapshot = useCallback(async () => {
    const deviceUdid = activeDeviceUdid ?? undefined;
    const sequence = snapshotSequenceRef.current + 1;
    snapshotSequenceRef.current = sequence;
    try {
      const next = await window.ade.iosSimulator.getScreenSnapshot({ deviceUdid, ...rootScope }, runtimePinRef.current);
      if (sequence !== snapshotSequenceRef.current) return;
      setSnapshot(next);
    } catch {
      // A snapshot that will not come back costs input, not the picture, and
      // the page is the surface that reports simulator errors.
    }
  }, [activeDeviceUdid, rootScope]);

  useEffect(() => {
    if (!activeDeviceUdid || !activeSessionId) {
      setSnapshot(null);
      return;
    }
    void refreshSnapshot();
  }, [activeDeviceUdid, activeSessionId, refreshSnapshot]);

  const scheduleWindowCaptureRecovery = useCallback((reason: string) => {
    if (!activeDevice || !activeSession || activeSession.deviceUdid !== activeDevice.udid || liveVisualKind !== "window") {
      return;
    }
    if (windowCaptureRecoveryTimerRef.current != null) return;
    const now = Date.now();
    if (now - windowCaptureRecoveryAttemptedAtRef.current < 2_500) return;
    windowCaptureRecoveryAttemptedAtRef.current = now;
    setMessage(`${reason} Restoring the live view...`);
    windowCaptureRecoveryTimerRef.current = window.setTimeout(() => {
      windowCaptureRecoveryTimerRef.current = null;
      // Read the token before the prelude below: if anything replaces or
      // cancels this run while it stops the old stream, the start declines.
      const armedForRecovery = captureStartRef.current;
      void (async () => {
        try {
          stopRendererLiveVisual();
          await window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
          await startWindowCaptureVisual(activeDevice, armedForRecovery);
          void refreshSnapshot();
        } catch (windowError) {
          // Same dead end as the effect's give-up path: nothing retries a
          // recovery that failed, the deps did not change so the effect will
          // not re-run, and the hold this start took would otherwise keep the
          // host re-parking Simulator.app while the view says it failed.
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
        }
      })().catch(() => {});
    }, 250);
  }, [
    activeDevice,
    activeSession,
    liveVisualKind,
    refreshSnapshot,
    releaseParkingHold,
    startWindowCaptureVisual,
    stopRendererLiveVisual,
  ]);

  const armWindowCaptureRecoveryAfterInput = useCallback(() => {
    if (liveVisualKind !== "window") return;
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
  }, [liveVisualKind, scheduleWindowCaptureRecovery]);

  useEffect(() => {
    // Keyed on primitives, not object identity, so a plain status refresh no
    // longer tears the stream down — while a real device switch still does,
    // which is what re-picks the capture source instead of parking on the old
    // simulator window.
    if (
      statusSupported === null
      || !statusSupported
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
        // this view holds two and its single release on unmount never reaches
        // zero.
        await releaseParkingHold();
        streamStartedByPanelRef.current = false;
        await startWindowCaptureVisual(device, myArm);
      } catch (streamError) {
        // No cancellation check here: a start that was superseded or torn down
        // returns quietly and cleans up after itself, so reaching this catch
        // means this run's own start failed while it still owned the live view.
        //
        // Giving up here is terminal: nothing retries a stream that never
        // produced a frame. The first discovery sweep took a parking hold, so
        // without this release the host keeps re-parking Simulator.app on every
        // ADE window move while the view says the picture failed.
        // `streamStartedByPanelRef` deliberately stays set — the stream itself
        // did start, so unmount still has to reach `stopStream` — but the hold
        // is given back here and only here, so no later release site returns it
        // a second time.
        void releaseParkingHold();
        const streamMessage = streamError instanceof Error ? streamError.message : String(streamError);
        setLiveVisual({
          kind: "window",
          status: "error",
          sourceId: null,
          sourceName: null,
          width: null,
          height: null,
          error: `Could not start the live view. ${streamMessage}`,
        });
      }
    })();
    return () => {
      // Runs before every successor shape: the run that restarts the stream, the
      // early return above that stops it and starts nothing, and unmount. The
      // successor that does start again re-arms above; the ones that do not
      // leave this `null`, which is what tells a start still in flight that the
      // host stream it brought up is its own to stop.
      captureStartRef.current = null;
      stopRendererLiveVisual();
    };
  }, [
    activeDeviceName,
    activeDeviceUdid,
    activeSessionDeviceUdid,
    activeSessionId,
    releaseParkingHold,
    startWindowCaptureVisual,
    statusSupported,
    stopRendererLiveVisual,
  ]);

  // The renderer-side teardown above never reaches the host, so a view taken off
  // screen would leave the capture helper running. Stop it once, on real unmount
  // only — and drop the window-parking follow with it, or every later ADE window
  // move keeps nudging (and reopening) Simulator.app for a view that is gone.
  //
  // `releaseParkingHold` is a stable callback, so this stays a mount/unmount
  // effect despite the dependency.
  useEffect(() => () => {
    // Read by a start that is still in flight: the cleanups cannot clean up what
    // it has not taken yet, so it has to finish the job itself.
    captureStartRef.current = null;
    if (streamStartedByPanelRef.current) {
      streamStartedByPanelRef.current = false;
      void window.ade.iosSimulator.stopStream(runtimePinRef.current).catch(() => {});
    }
    void releaseParkingHold();
  }, [releaseParkingHold]);

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

  useEffect(() => {
    if (liveVisualKind !== "window" || !snapshot) return;
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
    snapshot,
    videoSizeNonce,
  ]);

  const mapLivePointToSimulatorPixel = useCallback((point: { x: number; y: number }): { x: number; y: number } | null => {
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

  const liveSimulatorPointFromPointer = useCallback((event: PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const media = videoRef.current;
    if (!media || !mediaWidth || !mediaHeight) return null;
    const point = pointerToMediaPoint(event, media, mediaWidth, mediaHeight);
    if (!point) return null;
    return mapLivePointToSimulatorPixel(point);
  }, [mapLivePointToSimulatorPixel, mediaHeight, mediaWidth]);

  const handleSnapshotInteractPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (controlsDisabled) {
      setMessage(controlsDisabledMessage);
      return;
    }
    const point = liveSimulatorPointFromPointer(event);
    if (!point) return;
    dragStartRef.current = {
      x: point.x,
      y: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [controlsDisabled, controlsDisabledMessage, liveSimulatorPointFromPointer]);

  const handleSnapshotInteractPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    if (controlsDisabled) {
      setMessage(controlsDisabledMessage);
      return;
    }
    const point = liveSimulatorPointFromPointer(event);
    if (!point) return;
    const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
    void (async () => {
      try {
        // The picture is in screenshot pixels; the control verbs are in points.
        const controlScale = snapshot?.screen.scale && Number.isFinite(snapshot.screen.scale) && snapshot.screen.scale > 0
          ? snapshot.screen.scale
          : 1;
        armWindowCaptureRecoveryAfterInput();
        if (moved < TAP_TRAVEL_LIMIT_PX) {
          await window.ade.iosSimulator.tap({ deviceUdid: activeDeviceUdid, x: point.x / controlScale, y: point.y / controlScale }, runtimePinRef.current);
        } else {
          await window.ade.iosSimulator.drag({
            deviceUdid: activeDeviceUdid,
            startX: start.x / controlScale,
            startY: start.y / controlScale,
            endX: point.x / controlScale,
            endY: point.y / controlScale,
          }, runtimePinRef.current);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [activeDeviceUdid, armWindowCaptureRecoveryAfterInput, controlsDisabled, controlsDisabledMessage, liveSimulatorPointFromPointer, snapshot?.screen.scale]);

  const handleVideoKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // A chord is a host or app shortcut, not text for the device.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (controlsDisabled) {
      setMessage(controlsDisabledMessage);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      armWindowCaptureRecoveryAfterInput();
      void window.ade.iosSimulator.typeText({ deviceUdid: activeDeviceUdid, text: "\n" }, runtimePinRef.current).catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      armWindowCaptureRecoveryAfterInput();
      void window.ade.iosSimulator.typeText({ deviceUdid: activeDeviceUdid, text: event.key }, runtimePinRef.current).catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
    }
  }, [activeDeviceUdid, armWindowCaptureRecoveryAfterInput, controlsDisabled, controlsDisabledMessage]);

  /**
   * One plain sentence in place of the picture, never a blank box and never a
   * thrown error. The host's own wording wins wherever it gave one: it knows
   * which permission is off, which is the only actionable half of the news.
   */
  let fallbackSentence: string | null = null;
  if (liveVisual?.status === "error") {
    fallbackSentence = liveVisual.error ?? "The live view stopped.";
  } else if (status === null) {
    fallbackSentence = "Looking for the simulator...";
  } else if (statusSupported === false) {
    fallbackSentence = "This computer cannot run the iOS Simulator.";
  } else if (!activeDevice) {
    fallbackSentence = "No simulator is running.";
  } else if (!activeSession || activeSessionDeviceUdid !== activeDeviceUdid) {
    fallbackSentence = `Nothing is running on ${activeDevice.name} yet.`;
  } else if (!liveWindowSourceId) {
    fallbackSentence = "Starting the live view...";
  }

  const notice = message ?? (controlDisabledReason || null);

  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-black/40">
      {fallbackSentence ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center font-sans text-[12px] leading-5 text-muted-fg/60">
          {fallbackSentence}
        </div>
      ) : (
        <div
          className={cn(
            "relative h-full w-full outline-none",
            controlsDisabled ? "cursor-default" : "cursor-pointer",
          )}
          data-testid="ios-simulator-engine-surface"
          tabIndex={controlsDisabled ? -1 : 0}
          onKeyDown={handleVideoKeyDown}
          onPointerDown={handleSnapshotInteractPointerDown}
          onPointerUp={handleSnapshotInteractPointerUp}
        >
          <video
            ref={setVideoNode}
            className="h-full w-full object-contain"
            muted
            playsInline
          />
        </div>
      )}
      {notice ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/65 px-2.5 py-1 font-sans text-[11px] leading-4 text-fg/80 backdrop-blur">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

export default IosSimulatorEngineView;
