import { useCallback, useMemo, useState, type ReactNode } from "react";
import { IosSimH264Video, isWebCodecsAvailable } from "../chat/IosSimH264Video";
import { cn } from "../ui/cn";
import {
  AppleDevice3DView,
  type AppleDevice3DFailure,
  type AppleDeviceFamily,
  type AppleDeviceOrientation,
} from "./AppleDevice3DView";
import {
  AppleDeviceFlatView,
  appleScreenMediaRect,
  type AppleDeviceGeometry,
  type AppleDeviceInput,
} from "./AppleDeviceFlatView";

/**
 * The stage: black, the decoder, and whichever presenter is showing it.
 *
 * The decoder is mounted ONCE, in one stable DOM position, for the life of the
 * stream. Flat mode moves its box to the `object-contain` rect the flat view
 * measured; 3D mode parks it off-screen and hands the same canvas to the Three
 * view as a texture source. Re-parenting it on a mode switch would remount the
 * reader, drop the connection, and black-frame the device — the one failure the
 * spec names as a bug rather than a trade-off.
 */

export type AppleStageMode = "flat" | "3d";

export type AppleDeviceStageProps = {
  /** Localised read address. Null when there is no stream to read. */
  streamUrl: string | null;
  /** Bearer token for the reader's `Authorization` header. */
  streamToken: string | null;
  reconnectNonce: number;
  mode: AppleStageMode;
  /**
   * "Reset view". Handed to the 3D view as a value it acts on, NOT as a React
   * key: remounting meant a new `WebGLRenderer`, and a browser only lends out
   * so many GPU contexts before it starts taking the oldest one back.
   */
  viewNonce: number;
  family: AppleDeviceFamily;
  deviceTypeName: string | null;
  orientation: AppleDeviceOrientation;
  /** Device size in POINTS. Null falls back to the decoded pixel size. */
  devicePointSize: { width: number; height: number } | null;
  /** False while watching someone else's device, or while inspect owns the pointer. */
  interactive: boolean;
  onDeviceInput: (input: AppleDeviceInput) => void;
  onDeviceScroll?: (delta: { x: number; y: number; deltaX: number; deltaY: number }) => void;
  /** A key pressed while the flat screen holds focus. True = forwarded. */
  onDeviceKey?: (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => boolean;
  onReaderStatus: (status: "connecting" | "playing" | "error" | "stopped", error: string | null) => void;
  onDimensions: (size: { width: number; height: number }) => void;
  onFrame: () => void;
  /** Increments per drawn frame; the 3D view re-uploads its texture on change. */
  frameVersion: number;
  /**
   * The 3D presenter cannot show this device (no WebGL, or the bundled body
   * would not load). Round 4 §A1: there is no procedural slab to fall back
   * to, so the HOST falls back to the flat view and says so once.
   */
  onThreeUnavailable?: ((reason: AppleDevice3DFailure) => void) | undefined;
  /**
   * Drawn inside the screen box in flat mode — the live inspect overlay.
   *
   * A render prop rather than a node, because the overlay needs the presenter's
   * device→view mapping and only the presenter knows it. Null is passed
   * whenever the presenter cannot map — before the first frame in flat, before
   * the body has loaded in 3D — which is exactly the contract
   * `AppleInspectOverlay` already takes. In 3D the mapping is the live camera
   * projection, so the frames follow the device as it turns.
   */
  renderScreenOverlay?: (
    deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null,
  ) => ReactNode;
  /** Blockers, ribbons and the toolbar rail, drawn over the whole stage. */
  children?: ReactNode;
  className?: string;
};

/**
 * Where the decoder lives while the 3D view is the one showing it.
 *
 * ON SCREEN, tiny, and all but invisible — not parked off-screen at
 * `opacity: 0`, which is what round 3 did. A canvas the compositor has decided
 * is not visible still answers `getImageData` (that readback is a CPU path)
 * but hands WebGL a BLACK surface when it is used as a texture, so the 3D
 * device rendered a perfect body with a dead screen that came alive for a
 * moment whenever you touched it. Two pixels of real, composited canvas is
 * enough to keep the source alive; the texture is read from the canvas's own
 * backing store, which stays the full decoded frame whatever its CSS box says.
 */
const PARKED_CANVAS_STYLE = {
  position: "absolute" as const,
  left: 0,
  top: 0,
  width: 2,
  height: 2,
  opacity: 0.002,
  overflow: "hidden" as const,
  pointerEvents: "none" as const,
};

export function AppleDeviceStage({
  streamUrl,
  streamToken,
  reconnectNonce,
  mode,
  viewNonce,
  family,
  deviceTypeName,
  orientation,
  devicePointSize,
  interactive,
  onDeviceInput,
  onDeviceScroll,
  onDeviceKey,
  onReaderStatus,
  onDimensions,
  onFrame,
  frameVersion,
  onThreeUnavailable,
  renderScreenOverlay,
  children,
  className,
}: AppleDeviceStageProps) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [screenPixelSize, setScreenPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [geometry, setGeometry] = useState<AppleDeviceGeometry | null>(null);

  const handleDimensions = useCallback((size: { width: number; height: number }) => {
    setScreenPixelSize((current) => (
      current && current.width === size.width && current.height === size.height ? current : size
    ));
    onDimensions(size);
  }, [onDimensions]);

  // WebGL is a hard precondition for the 3D presenter. There is no procedural
  // stand-in any more (§A1): a 3D view that cannot draw the real body reports
  // it through `onThreeUnavailable`, and the host moves the stage to flat.
  const flat = mode === "flat";

  /**
   * Where the decoder's canvas sits in flat mode.
   *
   * §V1: the frame is the device's RAW framebuffer, which stays portrait
   * however the device is held, so a landscape device is drawn by giving this
   * holder the TRANSPOSED size and turning it about the screen box's centre.
   * The canvas inside is `h-full w-full` of this holder and needs no rotation
   * of its own, which is what keeps the picture unsquashed and uncropped.
   */
  const videoStyle = useMemo(() => {
    if (!flat) return PARKED_CANVAS_STYLE;
    if (!geometry) return { ...PARKED_CANVAS_STYLE, opacity: 0 };
    const rect = appleScreenMediaRect(geometry, geometry.rotation);
    return {
      position: "absolute" as const,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      ...(rect.transform ? { transform: rect.transform } : {}),
      borderRadius: 10,
      overflow: "hidden" as const,
    };
  }, [flat, geometry]);

  return (
    <div
      data-apple-stage=""
      data-apple-stage-mode={mode}
      className={cn("relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black", className)}
    >
      <div style={videoStyle} data-apple-stage-screen="">
        {streamUrl ? (
          <IosSimH264Video
            url={streamUrl}
            token={streamToken}
            reconnectNonce={reconnectNonce}
            onStatus={onReaderStatus}
            onDimensions={handleDimensions}
            onFrame={onFrame}
            onCanvas={setCanvas}
            className={flat ? "ring-1 ring-inset ring-white/[0.06]" : undefined}
          />
        ) : null}
      </div>

      {flat ? (
        <AppleDeviceFlatView
          screenPixelSize={screenPixelSize}
          devicePointSize={devicePointSize}
          orientation={orientation}
          interactive={interactive}
          onDeviceInput={onDeviceInput}
          onDeviceScroll={onDeviceScroll}
          onDeviceKey={onDeviceKey}
          onGeometryChange={setGeometry}
          screenOverlay={renderScreenOverlay?.(flatDeviceToView(geometry))}
        />
      ) : (
        <AppleDevice3DView
          screenCanvas={canvas}
          resetNonce={viewNonce}
          frameVersion={frameVersion}
          family={family}
          deviceTypeName={deviceTypeName}
          orientation={orientation}
          screenPixelSize={screenPixelSize ?? { width: 0, height: 0 }}
          devicePointSize={devicePointSize}
          interactive={interactive}
          onDeviceInput={onDeviceInput}
          onDeviceScroll={onDeviceScroll}
          onDeviceKey={onDeviceKey}
          onUnavailable={onThreeUnavailable}
          renderScreenOverlay={renderScreenOverlay}
        />
      )}

      {children}
    </div>
  );
}

/**
 * The device→view mapping for the flat presenter, in the shape the inspect
 * overlay takes. Null in 3D, where the presenter cannot answer mid-orbit.
 *
 * The points it takes are ORIENTED points — the accessibility tree describes
 * the app's own interface, which turns with the device — and `geometry` is the
 * drawn box, which turns with it too (§V1). So a rotated device needs no extra
 * term here: both sides rotated together, and the one scale still holds.
 */
export function flatDeviceToView(
  geometry: AppleDeviceGeometry | null,
): ((point: { x: number; y: number }) => { x: number; y: number }) | null {
  if (!geometry || geometry.scale <= 0) return null;
  return (point) => ({ x: point.x / geometry.scale, y: point.y / geometry.scale });
}

export { isWebCodecsAvailable };
