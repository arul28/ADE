import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type {
  AppControlElement,
  AppControlSession,
  AppControlSnapshot,
} from "../../../../shared/types";
import { inferAttachmentType } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import type { HostEngineAttachProps, HostEngineViewProps } from "./engineViewProps";

/**
 * The Electron Control picture, and only the picture.
 *
 * ## Why this file exists at all
 *
 * `ade-app-control`'s page draws the launch row, the CDP attach row, the status
 * pill, the window picker, the blockers card, the inspect list and the type
 * field. What it cannot draw is the screencast: thirty base64 PNGs a second
 * crossing the plugin bridge would be a structured clone per frame for an image
 * the guest would then decode again, and a transparent overlay in the guest
 * could not take the pointer events anyway, because the host paints a native
 * view over it.
 *
 * So the page reserves a rect and the host paints THIS into it. Registering the
 * whole compiled `ChatAppControlPanel` there instead — which is what the rail
 * did before — drew a second complete panel over the page and swallowed every
 * click the page's own chrome expected to get.
 *
 * ## What is here, and what deliberately is not
 *
 * Here: the live `<img>`, the frame pump that writes onto it, the click, the
 * wheel, the hover inspect, the element overlays, the blank-frame detector, and
 * the mode that decides which verb a click performs. Every one of those needs
 * the pixels or the pointer, and the page has neither.
 *
 * Not here: anything a reader could operate without the picture. The page owns
 * it, and a copy here would be a second control that disagreed with the first.
 *
 * ## Mode lives here, not in the page
 *
 * Control and Inspect select which host verb a click on the picture becomes, so
 * the toggle belongs to whoever owns the click. Drawing it in the page would
 * mean a state the page could set and the engine could not read — the two would
 * disagree on the very next click. The compiled panel drew it over the image
 * for the same reason, and this keeps that placement.
 */

type MessageTone = "info" | "error";
type Message = { tone: MessageTone; text: string };
type AppControlMode = "control" | "inspect";

type LiveFrameDims = {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  scaleX: number;
  scaleY: number;
};

type MappedPoint = {
  viewportX: number;
  viewportY: number;
  leftPct: number;
  topPct: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function elementLabel(element: AppControlElement): string {
  return element.label ?? element.value ?? element.testId ?? element.role ?? element.tagName ?? "element";
}

/**
 * Copied from `apps/desktop/src/renderer/components/chat/ChatAppControlPanel.tsx`
 * (`clampFrame`, `cropFrameDataUrl`, `imageLooksBlank`), which still owns the
 * originals because it is still mounted in the chat drawer. The two copies must
 * move together until that panel is retired.
 */
function clampFrame(frame: AppControlElement["pixelFrame"], width: number, height: number) {
  const x = Math.max(0, Math.min(width, Math.round(frame.x)));
  const y = Math.max(0, Math.min(height, Math.round(frame.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(frame.width))),
    height: Math.max(1, Math.min(height - y, Math.round(frame.height))),
  };
}

function cropFrameDataUrl(
  snapshot: AppControlSnapshot,
  pixelFrame: AppControlElement["pixelFrame"],
): Promise<string | null> {
  const screenshot = snapshot.screenshot;
  if (!screenshot) return Promise.resolve(null);
  const frame = clampFrame(pixelFrame, screenshot.width, screenshot.height);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = frame.width;
      canvas.height = frame.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(null);
    img.src = screenshot.dataUrl;
  });
}

/**
 * "The renderer attached but the window is closed" is indistinguishable from a
 * working app that happens to be showing black, unless you measure the pixels.
 * Mean brightness AND variance, because a dark theme is dark but not flat.
 */
function imageLooksBlank(image: HTMLImageElement): boolean {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width <= 0 || height <= 0) return true;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(48, width);
  canvas.height = Math.min(48, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixelCount = data.length / 4;
  let visiblePixels = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha <= 8) continue;
    visiblePixels += 1;
    const brightness = ((data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0)) / 3;
    sum += brightness;
    sumSquares += brightness * brightness;
  }
  if (visiblePixels / pixelCount < 0.05) return true;
  const mean = sum / visiblePixels;
  const variance = Math.max(0, sumSquares / visiblePixels - mean * mean);
  return mean < 8 && variance < 4;
}

export function AppControlEngineView({
  laneId: _laneId,
  projectRoot,
  runtimePin = null,
  sessionId: _sessionId,
  controlDisabledReason = null,
  onAddContext,
  onAddAttachment,
}: HostEngineViewProps & HostEngineAttachProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  // Read through a ref, not a dep: a local pin object is rebuilt on every
  // cross-machine merge, and this view is keyed on the pin at its mount site.
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  const [session, setSession] = useState<AppControlSession | null>(null);
  const [snapshot, setSnapshot] = useState<AppControlSnapshot | null>(null);
  const [mode, setMode] = useState<AppControlMode>("control");
  const [liveFrameActive, setLiveFrameActive] = useState(false);
  const [liveFrameInitialSrc, setLiveFrameInitialSrc] = useState<string | null>(null);
  const [hoverElement, setHoverElement] = useState<AppControlElement | null>(null);
  const [selectedElement, setSelectedElement] = useState<AppControlElement | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<{ x: number; y: number } | null>(null);
  const [controlPulse, setControlPulse] = useState<{ leftPct: number; topPct: number; nonce: number } | null>(null);
  const [screenshotBlank, setScreenshotBlank] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const liveFrameDimsRef = useRef<LiveFrameDims | null>(null);
  const liveFrameActiveRef = useRef(false);
  const liveFramePendingSrcRef = useRef<string | null>(null);
  const liveFrameRafRef = useRef<number | null>(null);
  const activeTargetIdRef = useRef<string | null>(null);
  const scrollPendingRef = useRef<{ x: number; y: number; deltaX: number; deltaY: number; coordinateSpace: "viewport" } | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const scrollEnabledRef = useRef(false);
  const hoverInspectSeqRef = useRef(0);
  const hoverInspectTimerRef = useRef<number | null>(null);
  const modeRef = useRef<AppControlMode>(mode);

  const controlsDisabled = Boolean(controlDisabledReason);
  const controlsDisabledMessage = controlDisabledReason
    ?? "This Electron Control session is read-only from the current lane.";
  const sessionConnected = session?.status === "connected";
  const hasActiveSession = Boolean(session) && !["exited", "stopped", "failed"].includes(session?.status ?? "");

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    scrollEnabledRef.current = liveFrameActive && mode === "control";
    liveFrameActiveRef.current = liveFrameActive;
  }, [liveFrameActive, mode]);

  useEffect(() => {
    activeTargetIdRef.current = session?.cdpTargetId ?? null;
  }, [session?.cdpTargetId]);

  useEffect(() => {
    if (mode !== "inspect") setHoverElement(null);
  }, [mode]);

  useEffect(() => {
    setScreenshotBlank(false);
  }, [snapshot?.screenshot?.dataUrl]);

  useEffect(() => {
    if (!controlPulse) return undefined;
    const timer = window.setTimeout(() => setControlPulse(null), 600);
    return () => window.clearTimeout(timer);
  }, [controlPulse]);

  const refreshSnapshot = useCallback(async () => {
    const next = await window.ade.appControl.getSnapshot({ projectRoot }, runtimePinRef.current);
    setSnapshot(next);
    setSelectedElement(next.hitElement);
    return next;
  }, [projectRoot]);

  /**
   * One subscription for both halves of the stream.
   *
   * Session events decide whether there is a picture to draw at all; frame
   * events are the picture. They arrive on the same channel and a second
   * subscription would double the frame traffic for no gain.
   */
  useEffect(() => {
    let cancelled = false;
    function resetSessionState(): void {
      setSnapshot(null);
      setSelectedElement(null);
      setSelectedPoint(null);
      setHoverElement(null);
      setLiveFrameActive(false);
      setLiveFrameInitialSrc(null);
      liveFrameActiveRef.current = false;
      liveFrameDimsRef.current = null;
      liveFramePendingSrcRef.current = null;
    }

    void window.ade.appControl.getStatus(runtimePinRef.current)
      .then((status) => {
        if (cancelled) return;
        setSession(status.activeSession ?? null);
        if (status.activeSession?.status === "connected") void refreshSnapshot().catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });

    const unsubscribe = window.ade.appControl.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        const previousTargetId = activeTargetIdRef.current;
        const nextTargetId = event.session?.cdpTargetId ?? null;
        activeTargetIdRef.current = nextTargetId;
        setSession(event.session ?? null);
        const nextStatus = event.session?.status ?? null;
        if (nextStatus === "connected") {
          // A new CDP target is a new picture. Dropping the old frame rather
          // than letting it sit is what stops the view claiming to mirror a
          // window that is no longer the one attached.
          if (previousTargetId !== nextTargetId) {
            resetSessionState();
            if (imageRef.current) imageRef.current.removeAttribute("src");
          }
          void refreshSnapshot().catch(() => {});
        } else if (nextStatus) {
          resetSessionState();
        }
        return;
      }
      if (event.type === "session-stopped") {
        setSession(null);
        resetSessionState();
        return;
      }
      if (event.type === "frame") {
        if (event.frame.cdpTargetId !== activeTargetIdRef.current) return;
        const src = `data:${event.frame.mimeType};base64,${event.frame.data}`;
        if (!liveFrameActiveRef.current) setLiveFrameInitialSrc(src);
        // Hot path at 30+ fps: stash the freshest frame and let ONE animation
        // frame write it onto the image, rather than a React render per frame.
        liveFramePendingSrcRef.current = src;
        if (event.frame.width > 0 && event.frame.height > 0) {
          liveFrameDimsRef.current = {
            width: event.frame.width,
            height: event.frame.height,
            viewportWidth: event.frame.viewportWidth && event.frame.viewportWidth > 0
              ? event.frame.viewportWidth
              : Math.round(event.frame.width / (event.frame.scale || 1)),
            viewportHeight: event.frame.viewportHeight && event.frame.viewportHeight > 0
              ? event.frame.viewportHeight
              : Math.round(event.frame.height / (event.frame.scale || 1)),
            scale: event.frame.scale || event.frame.scaleX || 1,
            scaleX: event.frame.scaleX || event.frame.scale || 1,
            scaleY: event.frame.scaleY || event.frame.scale || 1,
          };
        }
        if (liveFrameRafRef.current == null) {
          liveFrameRafRef.current = window.requestAnimationFrame(() => {
            liveFrameRafRef.current = null;
            const next = liveFramePendingSrcRef.current;
            liveFramePendingSrcRef.current = null;
            if (next && imageRef.current) imageRef.current.src = next;
          });
        }
        setLiveFrameActive((current) => {
          if (current) return current;
          liveFrameActiveRef.current = true;
          return true;
        });
      }
    }, runtimePinRef.current);

    return () => {
      cancelled = true;
      unsubscribe();
      if (liveFrameRafRef.current != null) {
        window.cancelAnimationFrame(liveFrameRafRef.current);
        liveFrameRafRef.current = null;
      }
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (hoverInspectTimerRef.current != null) {
        window.clearTimeout(hoverInspectTimerRef.current);
        hoverInspectTimerRef.current = null;
      }
      hoverInspectSeqRef.current += 1;
      scrollPendingRef.current = null;
    };
  }, [refreshSnapshot]);

  const displayedMetrics = useCallback((): LiveFrameDims | null => {
    if (liveFrameActive) {
      const live = liveFrameDimsRef.current;
      if (live && live.width > 0 && live.height > 0 && live.viewportWidth > 0 && live.viewportHeight > 0) {
        return live;
      }
    }
    const sw = snapshot?.screenshot?.width ?? 0;
    const sh = snapshot?.screenshot?.height ?? 0;
    if (sw <= 0 || sh <= 0) return null;
    const scaleX = snapshot?.screen.scaleX ?? snapshot?.screen.scale ?? 1;
    const scaleY = snapshot?.screen.scaleY ?? snapshot?.screen.scale ?? scaleX;
    return {
      width: sw,
      height: sh,
      viewportWidth: snapshot?.screen.viewportWidth && snapshot.screen.viewportWidth > 0
        ? snapshot.screen.viewportWidth
        : sw / scaleX,
      viewportHeight: snapshot?.screen.viewportHeight && snapshot.screen.viewportHeight > 0
        ? snapshot.screen.viewportHeight
        : sh / scaleY,
      scale: snapshot?.screen.scale ?? scaleX,
      scaleX,
      scaleY,
    };
  }, [liveFrameActive, snapshot]);

  const mapClientPoint = useCallback((
    clientX: number,
    clientY: number,
    image: HTMLImageElement | null = imageRef.current,
  ): MappedPoint | null => {
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    const metrics = displayedMetrics();
    if (!metrics || rect.width <= 0 || rect.height <= 0) return null;
    const xRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const yRatio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return {
      viewportX: Math.round(xRatio * metrics.viewportWidth),
      viewportY: Math.round(yRatio * metrics.viewportHeight),
      leftPct: xRatio * 100,
      topPct: yRatio * 100,
    };
  }, [displayedMetrics]);

  const overlayStyleForElement = useCallback((element: AppControlElement): CSSProperties | null => {
    const metrics = displayedMetrics();
    if (!metrics || metrics.viewportWidth <= 0 || metrics.viewportHeight <= 0) return null;
    return {
      left: `${(element.frame.x / metrics.viewportWidth) * 100}%`,
      top: `${(element.frame.y / metrics.viewportHeight) * 100}%`,
      width: `${(element.frame.width / metrics.viewportWidth) * 100}%`,
      height: `${(element.frame.height / metrics.viewportHeight) * 100}%`,
    };
  }, [displayedMetrics]);

  /**
   * Wheel has to be a NON-passive listener or `preventDefault` is ignored, and
   * React's synthetic `onWheel` is passive. Deltas are coalesced onto one
   * animation frame so a trackpad flick is one host call, not forty.
   */
  useEffect(() => {
    const img = imageRef.current;
    if (!img) return undefined;
    const handler = (event: WheelEvent) => {
      if (!scrollEnabledRef.current) return;
      const point = mapClientPoint(event.clientX, event.clientY, img);
      if (!point) return;
      const { deltaX, deltaY } = event;
      if (deltaX === 0 && deltaY === 0) return;
      event.preventDefault();
      const pending = scrollPendingRef.current;
      scrollPendingRef.current = {
        x: point.viewportX,
        y: point.viewportY,
        deltaX: (pending?.deltaX ?? 0) + deltaX,
        deltaY: (pending?.deltaY ?? 0) + deltaY,
        coordinateSpace: "viewport",
      };
      if (scrollRafRef.current == null) {
        scrollRafRef.current = window.requestAnimationFrame(() => {
          scrollRafRef.current = null;
          const next = scrollPendingRef.current;
          scrollPendingRef.current = null;
          if (!next || controlsDisabled) return;
          void window.ade.appControl.scroll(next, runtimePinRef.current).catch(() => {});
        });
      }
    };
    img.addEventListener("wheel", handler, { passive: false });
    return () => img.removeEventListener("wheel", handler);
  }, [controlsDisabled, liveFrameActive, mapClientPoint]);

  const attachSelection = useCallback(async (x: number, y: number) => {
    if (controlsDisabled) {
      setMessage({ tone: "error", text: controlsDisabledMessage });
      return;
    }
    if (screenshotBlank) {
      setMessage({
        tone: "error",
        text: "The renderer is attached but the picture is blank. Open the app window, then refresh the snapshot before attaching context.",
      });
      return;
    }
    if (!onAddContext) {
      setMessage({ tone: "error", text: "There is no chat beside this view to attach context to." });
      return;
    }
    try {
      const result = await window.ade.appControl.selectPoint({
        projectRoot,
        x,
        y,
        coordinateSpace: "viewport",
        includeScreenshot: false,
      }, runtimePinRef.current);
      const element = result.snapshot?.hitElement ?? null;
      let attachmentPath: string | null = null;
      let screenshotDataUrl = result.item.screenshotDataUrl ?? null;
      // The crop is taken from the frame this view already holds, which is why
      // it is taken here: the page has no pixels to cut from.
      if (snapshot && (onAddAttachment || screenshotDataUrl)) {
        const cropFrame = element?.pixelFrame ?? result.item.frame;
        if (cropFrame) {
          const crop = await cropFrameDataUrl(snapshot, cropFrame);
          if (crop) screenshotDataUrl = crop;
        }
      }
      if (screenshotDataUrl && onAddAttachment) {
        const { path } = await window.ade.agentChat.saveTempAttachment({
          data: stripDataUrlPrefix(screenshotDataUrl),
          filename: "app-control-selection.png",
        }, ...(runtimePinRef.current ? [runtimePinRef.current] as const : []));
        attachmentPath = path;
        onAddAttachment({ path, type: inferAttachmentType(path, "image/png") });
      }
      onAddContext({
        ...result.item,
        screenshotDataUrl,
        metadata: {
          ...result.item.metadata,
          ...(attachmentPath ? { attachmentPath } : {}),
        },
      });
      setSelectedPoint({ x, y });
      setSelectedElement(element);
      const attachedLabel = result.source === "coordinate-fallback"
        ? "coordinate"
        : element
          ? elementLabel(element)
          : String(result.source);
      setMessage({ tone: "info", text: `Inserted ${attachedLabel} context.` });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    }
  }, [
    controlsDisabled,
    controlsDisabledMessage,
    onAddAttachment,
    onAddContext,
    projectRoot,
    screenshotBlank,
    snapshot,
  ]);

  const inspectHoverAt = useCallback((point: MappedPoint) => {
    if (controlsDisabled || !sessionConnected || screenshotBlank) return;
    if (hoverInspectTimerRef.current != null) {
      window.clearTimeout(hoverInspectTimerRef.current);
      hoverInspectTimerRef.current = null;
    }
    // Debounced AND sequenced: the timer stops a request per mouse pixel, and
    // the sequence stops a slow answer painting an outline the pointer has
    // already left.
    const requestSeq = hoverInspectSeqRef.current + 1;
    hoverInspectSeqRef.current = requestSeq;
    hoverInspectTimerRef.current = window.setTimeout(() => {
      hoverInspectTimerRef.current = null;
      void window.ade.appControl.inspectPoint({
        projectRoot,
        x: point.viewportX,
        y: point.viewportY,
        coordinateSpace: "viewport",
        includeScreenshot: false,
      }, runtimePinRef.current)
        .then((result) => {
          if (hoverInspectSeqRef.current !== requestSeq || modeRef.current !== "inspect") return;
          setHoverElement(result.snapshot.hitElement);
        })
        .catch(() => {
          if (hoverInspectSeqRef.current === requestSeq) setHoverElement(null);
        });
    }, 60);
  }, [controlsDisabled, projectRoot, screenshotBlank, sessionConnected]);

  const handleImageClick = useCallback((event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const point = mapClientPoint(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    if (controlsDisabled) {
      setMessage({ tone: "error", text: controlsDisabledMessage });
      return;
    }
    if (!liveFrameActive && screenshotBlank) {
      setMessage({
        tone: "error",
        text: "The renderer is attached but the picture is blank. Open the app window, then refresh the snapshot.",
      });
      return;
    }
    if (modeRef.current === "inspect") {
      void attachSelection(point.viewportX, point.viewportY);
      return;
    }
    setControlPulse({ leftPct: point.leftPct, topPct: point.topPct, nonce: Date.now() });
    // Fire and forget on purpose. The screencast is live, so the picture
    // already answers; awaiting the CDP round trip would make every click feel
    // like it locked the view.
    window.ade.appControl
      .click({ x: point.viewportX, y: point.viewportY, coordinateSpace: "viewport" }, runtimePinRef.current)
      .catch((error: unknown) => {
        setMessage({ tone: "error", text: `Click failed: ${errorMessage(error)}` });
      });
    setMessage(null);
  }, [attachSelection, controlsDisabled, controlsDisabledMessage, liveFrameActive, mapClientPoint, screenshotBlank]);

  const screenshot = snapshot?.screenshot ?? null;
  const hasPicture = Boolean(screenshot) || liveFrameActive;
  const overlaysVisible = mode === "inspect" && hasPicture && !screenshotBlank;
  const imageSrc = liveFrameActive
    ? liveFrameInitialSrc ?? screenshot?.dataUrl
    : screenshot?.dataUrl;

  const emptyMessage = useMemo(() => {
    if (!hasActiveSession) return "No Electron app is attached. Launch or connect one from the panel around this view.";
    if (!sessionConnected) return "Waiting for the app to answer on its debugging port.";
    return "Connected. Waiting for the first frame.";
  }, [hasActiveSession, sessionConnected]);

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-black/20"
      data-testid="app-control-engine-view"
      data-engine-mode={mode}
    >
      <div
        className="absolute left-2 top-2 z-10 inline-flex items-center rounded-md border border-white/[0.08] bg-black/55 p-0.5 backdrop-blur"
        aria-label="Electron Control mode"
      >
        {(["control", "inspect"] as const).map((nextMode) => (
          <button
            key={nextMode}
            type="button"
            disabled={!hasActiveSession || controlsDisabled}
            onClick={() => setMode(nextMode)}
            className={cn(
              "h-6 rounded-[3px] px-2 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              mode === nextMode
                ? "bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg/90 shadow-sm"
                : "text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80",
            )}
          >
            {nextMode === "control" ? "Control" : "Inspect"}
          </button>
        ))}
      </div>

      {message ? (
        <div
          role={message.tone === "error" ? "alert" : "status"}
          className={cn(
            "absolute inset-x-2 bottom-2 z-10 rounded-md border px-2 py-1 text-[10px] leading-4 backdrop-blur",
            message.tone === "error"
              ? "border-rose-400/30 bg-rose-500/12 text-rose-100/90"
              : "border-white/[0.08] bg-black/60 text-fg/75",
          )}
        >
          {message.text}
        </div>
      ) : null}

      {hasPicture ? (
        <div className="relative flex h-full min-h-0 w-full items-center justify-center overflow-auto p-2">
          <div className="relative max-h-full">
            <img
              ref={imageRef}
              // Live frames are written onto this node by the animation frame
              // above; `src` here only covers the beat before the first one.
              src={imageSrc}
              alt="Electron app screencast"
              draggable={false}
              data-testid="app-control-engine-image"
              className={cn(
                "block max-h-full max-w-full rounded-sm border border-white/[0.06] object-contain",
                screenshotBlank
                  ? "cursor-not-allowed opacity-35"
                  : mode === "inspect" ? "cursor-crosshair" : "cursor-pointer",
              )}
              onLoad={(event) => {
                const blank = Boolean(snapshot?.elements.length) && imageLooksBlank(event.currentTarget);
                setScreenshotBlank(blank);
                if (blank) {
                  setHoverElement(null);
                  setSelectedElement(null);
                  setSelectedPoint(null);
                }
              }}
              onError={() => {
                liveFrameActiveRef.current = false;
                liveFramePendingSrcRef.current = null;
                setLiveFrameInitialSrc(null);
                setLiveFrameActive(false);
                setScreenshotBlank(false);
              }}
              onClick={handleImageClick}
              onMouseMove={(event) => {
                if (mode !== "inspect") return;
                const point = mapClientPoint(event.clientX, event.clientY, event.currentTarget);
                if (point) inspectHoverAt(point);
              }}
              onMouseLeave={() => {
                if (hoverInspectTimerRef.current != null) {
                  window.clearTimeout(hoverInspectTimerRef.current);
                  hoverInspectTimerRef.current = null;
                }
                hoverInspectSeqRef.current += 1;
                setHoverElement(null);
              }}
            />
            {screenshotBlank ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-sm border border-amber-300/18 bg-black/70 px-4 text-center backdrop-blur-sm">
                <div className="max-w-[360px] text-[11px] leading-5 text-amber-100/85">
                  Renderer attached, but the picture is blank. Open the app window or menu bar item, then refresh the snapshot.
                </div>
              </div>
            ) : null}
            {overlaysVisible && selectedElement ? (() => {
              const style = overlayStyleForElement(selectedElement);
              return style ? (
                <div
                  key={`selected-${selectedElement.id}`}
                  className="pointer-events-none absolute rounded-sm border-2 border-sky-300/85 bg-sky-300/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.18)]"
                  style={style}
                />
              ) : null;
            })() : null}
            {overlaysVisible && hoverElement && hoverElement.id !== selectedElement?.id ? (() => {
              const style = overlayStyleForElement(hoverElement);
              return style ? (
                <div
                  key={`hover-${hoverElement.id}`}
                  className="pointer-events-none absolute rounded-sm border border-sky-200/60 bg-sky-200/5"
                  style={style}
                />
              ) : null;
            })() : null}
            {overlaysVisible && selectedPoint && !selectedElement ? (() => {
              const metrics = displayedMetrics();
              return metrics ? (
                <div
                  className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-300/90 bg-sky-300/40"
                  style={{
                    left: `${(selectedPoint.x / metrics.viewportWidth) * 100}%`,
                    top: `${(selectedPoint.y / metrics.viewportHeight) * 100}%`,
                  }}
                />
              ) : null;
            })() : null}
            {mode === "control" && controlPulse && !screenshotBlank ? (
              <div
                key={`pulse-${controlPulse.nonce}`}
                className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-200/70 bg-sky-200/35 motion-safe:animate-ping"
                style={{ left: `${controlPulse.leftPct}%`, top: `${controlPulse.topPct}%` }}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-[11px] leading-5 text-muted-fg/70">
          {emptyMessage}
        </div>
      )}
    </div>
  );
}
