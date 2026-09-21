import { useCallback, useMemo, useState, type ReactNode } from "react";
import { IosSimH264Video, isWebCodecsAvailable } from "../chat/IosSimH264Video";
import { cn } from "../ui/cn";
import {
  AppleDevice3DView,
  type AppleDeviceFamily,
  type AppleDeviceOrientation,
} from "./AppleDevice3DView";
import {
  AppleDeviceFlatView,
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
   * Remounts the 3D view, which is what "Reset view" means: the orbit spring,
   * the camera and the loaded body all live inside it.
   */
  viewNonce: number;
  family: AppleDeviceFamily;
  deviceTypeName: string | null;
  realistic: boolean;
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
   * Drawn inside the screen box in flat mode — the live inspect overlay.
   *
   * A render prop rather than a node, because the overlay needs the presenter's
   * device→view mapping and only the presenter knows it. Null is passed
   * whenever the presenter cannot map (before the first frame; 3D mid-orbit),
   * which is exactly the contract `AppleInspectOverlay` already takes.
   */
  renderScreenOverlay?: (
    deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null,
  ) => ReactNode;
  /** Blockers, ribbons and the toolbar rail, drawn over the whole stage. */
  children?: ReactNode;
  className?: string;
};

/** Off-screen but still laid out, because a 0×0 canvas never receives a frame. */
const PARKED_CANVAS_STYLE = {
  position: "absolute" as const,
  left: -100_000,
  top: 0,
  width: 320,
  height: 640,
  opacity: 0,
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
  realistic,
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

  // WebGL is a hard precondition for the 3D presenter, and the column disables
  // its button when it is missing — but a stage asked for 3D anyway must still
  // show the device rather than nothing.
  const flat = mode === "flat";

  const videoStyle = useMemo(() => {
    if (!flat) return PARKED_CANVAS_STYLE;
    if (!geometry) return { ...PARKED_CANVAS_STYLE, opacity: 0 };
    return {
      position: "absolute" as const,
      left: geometry.left,
      top: geometry.top,
      width: geometry.width,
      height: geometry.height,
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
          interactive={interactive}
          onDeviceInput={onDeviceInput}
          onDeviceScroll={onDeviceScroll}
          onDeviceKey={onDeviceKey}
          onGeometryChange={setGeometry}
          screenOverlay={renderScreenOverlay?.(flatDeviceToView(geometry))}
        />
      ) : (
        <AppleDevice3DView
          key={`apple-3d:${viewNonce}`}
          screenCanvas={canvas}
          frameVersion={frameVersion}
          family={family}
          deviceTypeName={deviceTypeName}
          realistic={realistic}
          orientation={orientation}
          screenPixelSize={screenPixelSize ?? { width: 0, height: 0 }}
          interactive={interactive}
          onDeviceInput={onDeviceInput}
        />
      )}

      {children}
    </div>
  );
}

/**
 * The device→view mapping for the flat presenter, in the shape the inspect
 * overlay takes. Null in 3D, where the presenter cannot answer mid-orbit.
 */
export function flatDeviceToView(
  geometry: AppleDeviceGeometry | null,
): ((point: { x: number; y: number }) => { x: number; y: number }) | null {
  if (!geometry || geometry.scale <= 0) return null;
  return (point) => ({ x: point.x / geometry.scale, y: point.y / geometry.scale });
}

export { isWebCodecsAvailable };
