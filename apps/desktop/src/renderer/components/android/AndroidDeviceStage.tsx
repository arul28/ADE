import { useCallback, useMemo, useState, type ReactNode } from "react";
import { H264StreamView } from "../chat/H264StreamView";
import { h264SourceForUrl } from "../chat/h264StreamPlayer";
import { cn } from "../ui/cn";
import {
  AppleDeviceFlatView,
  type AppleDeviceGeometry,
  type AppleDeviceInput,
} from "../apple/AppleDeviceFlatView";

/**
 * The Android stage: black, the decoder, and the Apple flat view over it.
 *
 * The flat view is generic: it letterboxes a box of the device's size and maps
 * a pointer to that box's units. Android hands it the device's size in device
 * PIXELS, so the input it reports is already what `sendTouch` takes. The video
 * arrives the right way up (scrcpy turns it with the display), so the flat
 * view is always told "portrait" and draws it unturned.
 *
 * Flat only in P0. The 3D presenter joins here when the Android bodies land.
 */

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

/** The scrcpy stream's "no stream" answer, which a viewer treats as the stream ending. */
const ANDROID_STREAM_GONE_CODE = "ANDROID_NOT_RUNNING";

export function AndroidDeviceStage({
  streamUrl,
  streamToken,
  reconnectNonce,
  devicePixelSize,
  interactive,
  onDeviceInput,
  onDeviceScroll,
  onDeviceKey,
  onReaderStatus,
  onDimensions,
  onFrame,
  children,
  className,
}: {
  streamUrl: string | null;
  streamToken: string | null;
  reconnectNonce: number;
  /** The device in device pixels, in the orientation the video shows. */
  devicePixelSize: { width: number; height: number } | null;
  interactive: boolean;
  onDeviceInput: (input: AppleDeviceInput) => void;
  onDeviceScroll?: (delta: { x: number; y: number; deltaX: number; deltaY: number }) => void;
  onDeviceKey?: (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => boolean;
  onReaderStatus: (status: "connecting" | "playing" | "error" | "stopped", error: string | null) => void;
  onDimensions: (size: { width: number; height: number }) => void;
  onFrame: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const [screenPixelSize, setScreenPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [geometry, setGeometry] = useState<AppleDeviceGeometry | null>(null);

  const handleDimensions = useCallback((size: { width: number; height: number }) => {
    setScreenPixelSize((current) => (current && current.width === size.width && current.height === size.height ? current : size));
    onDimensions(size);
  }, [onDimensions]);

  const videoStyle = useMemo(() => {
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
  }, [geometry]);

  const source = useMemo(() => (streamUrl ? h264SourceForUrl(streamUrl, streamToken) : null), [streamToken, streamUrl]);

  return (
    <div
      data-android-stage=""
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
            onFrame={onFrame}
            className="ring-1 ring-inset ring-fg/[0.06]"
          />
        ) : null}
      </div>
      <AppleDeviceFlatView
        screenPixelSize={screenPixelSize}
        devicePointSize={devicePixelSize}
        orientation="portrait"
        ariaLabel="Android emulator screen"
        interactive={interactive}
        onDeviceInput={onDeviceInput}
        onDeviceScroll={onDeviceScroll}
        onDeviceKey={onDeviceKey}
        onGeometryChange={setGeometry}
      />
      {children}
    </div>
  );
}
