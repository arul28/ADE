import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { H264StreamView } from "../device/H264StreamView";
import { h264SourceForUrl } from "../device/h264StreamPlayer";
import { cn } from "../ui/cn";
import {
  DeviceFlatView,
  flatDeviceToView,
  type DeviceGeometry,
  type DeviceInput,
} from "../device/DeviceFlatView";
import {
  Device3DView,
  type Device3DFailure,
  type DeviceFrameFeed,
  type DeviceRenderer,
} from "../device/Device3DView";
import type { DeviceOrientation } from "../device/deviceScene";
import { androidBodySource, type AndroidBodySpec } from "./androidDeviceBody";
import type { AndroidBootScreen } from "./useAndroidBootScreen";

/**
 * The Android stage: black, the decoder, and whichever presenter shows it:
 * the shared flat view (`device/DeviceFlatView`) or the shared 3D view
 * (`device/Device3DView`) with an Android body.
 *
 * Both presenters take the device's size in device PIXELS, so the input they
 * report is already what `sendTouch` takes. The video arrives the right way
 * up (scrcpy turns it with the display): the flat view draws it unturned, and
 * the 3D body turns a quarter to the left for a landscape picture, smoothly.
 *
 * The decoder is mounted once for the life of the stream, as on the Apple
 * stage: 3D mode parks its canvas (on screen, two pixels, all but invisible,
 * see `PARKED_CANVAS_STYLE` in `AppleDeviceStage.tsx`) and hands the same
 * canvas to the 3D view as a texture. While the emulator boots, the 3D view
 * shows the boot screen's canvas on the same body instead (boot on the model).
 */

export type AndroidStageMode = "flat" | "3d";

const HIDDEN_CANVAS_STYLE = {
  position: "absolute" as const,
  left: 0,
  top: 0,
  width: 2,
  height: 2,
  opacity: 0,
  overflow: "hidden" as const,
  pointerEvents: "none" as const,
};

/** 3D mode: on screen and composited, or WebGL samples a black surface. */
const PARKED_CANVAS_STYLE = { ...HIDDEN_CANVAS_STYLE, opacity: 0.002 };

/** The scrcpy stream's "no stream" answer, which a viewer treats as the stream ending. */
const ANDROID_STREAM_GONE_CODE = "ANDROID_NOT_RUNNING";

/** An Android picture that is wider than tall: the device turned a quarter to the left. */
export function androidStageOrientation(size: { width: number; height: number } | null): DeviceOrientation {
  return size && size.width > size.height ? "landscape-right" : "portrait";
}

export function AndroidDeviceStage({
  streamUrl,
  streamToken,
  reconnectNonce,
  devicePixelSize,
  interactive,
  mode = "flat",
  bodySpec = null,
  screenAspect = 0,
  boot = null,
  viewNonce = 0,
  rendererRef,
  onThreeUnavailable,
  onThreeReady,
  onDeviceInput,
  onDeviceScroll,
  onDeviceKey,
  onReaderStatus,
  onDimensions,
  onFrame,
  railInset = 0,
  renderScreenOverlay,
  children,
  className,
}: {
  streamUrl: string | null;
  streamToken: string | null;
  reconnectNonce: number;
  /** The device in device pixels, in the orientation the video shows. */
  devicePixelSize: { width: number; height: number } | null;
  interactive: boolean;
  mode?: AndroidStageMode;
  /** The body the 3D view draws (catalog entry or profile, and the colour). */
  bodySpec?: AndroidBodySpec | null;
  /** The screen's short side over its long side, from the AVD's profile. */
  screenAspect?: number;
  /** Set while the emulator boots: the 3D screen shows this instead of the video. */
  boot?: AndroidBootScreen | null;
  /** "Reset view", handled in place by the 3D view. */
  viewNonce?: number;
  rendererRef?: { current: DeviceRenderer | null } | undefined;
  onThreeUnavailable?: (reason: Device3DFailure) => void;
  onThreeReady?: () => void;
  onDeviceInput: (input: DeviceInput) => void;
  onDeviceScroll?: (delta: { x: number; y: number; deltaX: number; deltaY: number }) => void;
  onDeviceKey?: (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => boolean;
  onReaderStatus: (status: "connecting" | "playing" | "error" | "stopped", error: string | null) => void;
  onDimensions: (size: { width: number; height: number }) => void;
  onFrame: () => void;
  /** The rail's width while it shows; the screen stays clear of it. */
  railInset?: number;
  /**
   * Inspect's overlay, drawn over the screen. A render prop, because it needs
   * the presenter's device-pixel-to-view mapping (flat or the 3D camera).
   */
  renderScreenOverlay?: (
    deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null,
  ) => ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const [screenPixelSize, setScreenPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [geometry, setGeometry] = useState<DeviceGeometry | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const threeD = mode === "3d" && bodySpec !== null;

  const handleDimensions = useCallback((size: { width: number; height: number }) => {
    setScreenPixelSize((current) => (current && current.width === size.width && current.height === size.height ? current : size));
    onDimensions(size);
  }, [onDimensions]);

  // Each drawn frame, for the 3D view's texture upload.
  const frameListeners = useRef(new Set<() => void>());
  const frames = useMemo<DeviceFrameFeed>(() => ({
    subscribe(listener) {
      frameListeners.current.add(listener);
      return () => { frameListeners.current.delete(listener); };
    },
  }), []);
  const handleFrame = useCallback(() => {
    onFrame();
    for (const listener of frameListeners.current) listener();
  }, [onFrame]);

  const videoStyle = useMemo(() => {
    if (threeD) return PARKED_CANVAS_STYLE;
    if (!geometry) return HIDDEN_CANVAS_STYLE;
    return {
      position: "absolute" as const,
      left: geometry.left,
      top: geometry.top,
      width: geometry.width,
      height: geometry.height,
      borderRadius: 10,
      overflow: "hidden" as const,
    };
  }, [geometry, threeD]);

  const source = useMemo(() => (streamUrl ? h264SourceForUrl(streamUrl, streamToken) : null), [streamToken, streamUrl]);

  // The body's aspect: the profile's, so a boot and a rotate keep one body.
  const aspect = screenAspect > 0
    ? screenAspect
    : screenPixelSize
      ? Math.min(screenPixelSize.width, screenPixelSize.height) / Math.max(screenPixelSize.width, screenPixelSize.height)
      : boot
        ? boot.size.width / boot.size.height
        : 9 / 20;
  const bodySource = useMemo(
    () => (bodySpec ? androidBodySource(bodySpec, aspect) : null),
    [aspect, bodySpec],
  );

  const showingBoot = Boolean(boot?.canvas);
  const orientation = showingBoot ? "portrait" : androidStageOrientation(screenPixelSize);

  return (
    <div
      data-android-stage=""
      data-android-stage-mode={threeD ? "3d" : "flat"}
      // Esc is the device's Back while it takes input, so the Work tools pane
      // must not also take it as "back to the tool list".
      data-ade-escape-scope={interactive ? "android-device" : undefined}
      className={cn("relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black", className)}
    >
      <div style={videoStyle} data-android-stage-screen="">
        {source ? (
          <H264StreamView
            source={source}
            streamName="emulator video stream"
            streamGoneCode={ANDROID_STREAM_GONE_CODE}
            reconnectNonce={reconnectNonce}
            onStatus={onReaderStatus}
            onDimensions={handleDimensions}
            onFrame={handleFrame}
            onCanvas={setCanvas}
            className={threeD ? undefined : "ring-1 ring-inset ring-fg/[0.06]"}
          />
        ) : null}
      </div>
      {threeD && bodySource ? (
        <Device3DView
          screenCanvas={showingBoot ? boot!.canvas : canvas}
          frames={showingBoot ? boot!.frames : frames}
          bodySource={bodySource}
          ariaLabel="Android emulator screen"
          orientation={orientation}
          screenPixelSize={showingBoot ? boot!.size : screenPixelSize ?? { width: 0, height: 0 }}
          devicePointSize={showingBoot ? null : devicePixelSize}
          interactive={interactive && !showingBoot}
          animateRotation
          rendererRef={rendererRef}
          resetNonce={viewNonce}
          onDeviceInput={onDeviceInput}
          onDeviceScroll={onDeviceScroll}
          onDeviceKey={onDeviceKey}
          onReady={onThreeReady}
          onUnavailable={onThreeUnavailable}
          railInset={railInset}
          renderScreenOverlay={showingBoot ? undefined : renderScreenOverlay}
        />
      ) : (
        <DeviceFlatView
          screenPixelSize={screenPixelSize}
          devicePointSize={devicePixelSize}
          orientation="portrait"
          ariaLabel="Android emulator screen"
          interactive={interactive}
          onDeviceInput={onDeviceInput}
          onDeviceScroll={onDeviceScroll}
          onDeviceKey={onDeviceKey}
          railInset={railInset}
          onGeometryChange={setGeometry}
          screenOverlay={renderScreenOverlay?.(flatDeviceToView(geometry))}
        />
      )}
      {children}
    </div>
  );
}
