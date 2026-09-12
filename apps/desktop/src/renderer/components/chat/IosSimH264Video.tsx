import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";
import {
  IosSimVideoProtocolError,
  createIosSimVideoRecordParser,
} from "./iosSimVideoRecords";

/**
 * Plays the host-encoded simulator stream.
 *
 * The Simulator window capture path cannot cross a machine boundary, because
 * the renderer captures a window that only exists on the Mac. This component
 * reads H.264 access units over loopback HTTP instead, decodes them with the
 * platform decoder, and draws them to a canvas. The decode is hardware
 * accelerated on Apple silicon and on Windows.
 *
 * The frames are the device screen, not the Simulator window, so the canvas has
 * no bezel and no window chrome. A caller that maps a click to a device point
 * therefore needs no heuristic: the canvas IS the screen.
 */

export type IosSimH264Status = "connecting" | "playing" | "error" | "stopped";

type VideoDecoderLike = {
  configure: (config: { codec: string; optimizeForLatency?: boolean }) => void;
  decode: (chunk: unknown) => void;
  close: () => void;
  readonly state: string;
};

type VideoDecoderConstructor = new (init: {
  output: (frame: { displayWidth: number; displayHeight: number; close: () => void }) => void;
  error: (error: Error) => void;
}) => VideoDecoderLike;

type EncodedVideoChunkConstructor = new (init: {
  type: "key" | "delta";
  timestamp: number;
  data: Uint8Array;
}) => unknown;

type WebCodecsWindow = {
  VideoDecoder?: VideoDecoderConstructor;
  EncodedVideoChunk?: EncodedVideoChunkConstructor;
};

export function isWebCodecsAvailable(): boolean {
  const scope = globalThis as unknown as WebCodecsWindow;
  return typeof scope.VideoDecoder === "function" && typeof scope.EncodedVideoChunk === "function";
}

export type IosSimH264VideoProps = {
  /** The URL `startStream` handed back, already localised for this machine. */
  url: string;
  className?: string;
  /** Bumping this reconnects. Use it after a port forward is rebuilt. */
  reconnectNonce?: number;
  onStatus?: (status: IosSimH264Status, error: string | null) => void;
  onDimensions?: (size: { width: number; height: number }) => void;
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
};

export function IosSimH264Video({
  url,
  className,
  reconnectNonce = 0,
  onStatus,
  onDimensions,
  onCanvas,
}: IosSimH264VideoProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const [status, setStatus] = useState<IosSimH264Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  /**
   * The status this component has already reported.
   *
   * The decode loop runs once per frame. Reading `status` from the effect's
   * closure never observes the update, so an unguarded report fired the parent
   * callback thirty times a second, and the parent rebuilds its live-view
   * object on every call — a full drawer re-render per frame.
   */
  const reportedRef = useRef<{ status: IosSimH264Status; error: string | null } | null>(null);

  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const dimensionsRef = useRef(onDimensions);
  dimensionsRef.current = onDimensions;

  const report = useCallback((next: IosSimH264Status, nextError: string | null) => {
    const previous = reportedRef.current;
    if (previous && previous.status === next && previous.error === nextError) return;
    reportedRef.current = { status: next, error: nextError };
    setStatus(next);
    setError(nextError);
    statusRef.current?.(next, nextError);
  }, []);

  const setCanvasNode = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    contextRef.current = node?.getContext("2d", { alpha: false }) ?? null;
    onCanvas?.(node);
  }, [onCanvas]);

  useEffect(() => {
    if (!url) {
      report("stopped", null);
      return;
    }
    const scope = globalThis as unknown as WebCodecsWindow;
    const VideoDecoderCtor = scope.VideoDecoder;
    const EncodedVideoChunkCtor = scope.EncodedVideoChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
      report("error", "This build cannot decode the simulator video stream.");
      return;
    }

    const abort = new AbortController();
    let decoder: VideoDecoderLike | null = null;
    let cancelled = false;
    let timestampUs = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    // A reconnect starts from `connecting` again, so the guard above has to
    // forget what the previous run reported.
    reportedRef.current = null;
    report("connecting", null);

    const drawFrame = (frame: { displayWidth: number; displayHeight: number; close: () => void }) => {
      const canvas = canvasRef.current;
      const context = contextRef.current;
      if (!canvas || !context) {
        frame.close();
        return;
      }
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      if (frame.displayWidth !== lastWidth || frame.displayHeight !== lastHeight) {
        lastWidth = frame.displayWidth;
        lastHeight = frame.displayHeight;
        dimensionsRef.current?.({ width: frame.displayWidth, height: frame.displayHeight });
      }
      try {
        context.drawImage(frame as unknown as CanvasImageSource, 0, 0);
      } finally {
        // A VideoFrame holds a GPU buffer. Not closing it stalls the decoder
        // within a few frames.
        frame.close();
      }
    };

    const run = async () => {
      try {
        const response = await fetch(url, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) {
          throw new Error(response.status === 403
            ? "The simulator video stream refused this token."
            : `The simulator video stream answered ${response.status}.`);
        }
        const body = response.body;
        if (!body) throw new Error("The simulator video stream sent no body.");
        const reader = body.getReader();
        const parser = createIosSimVideoRecordParser();
        let configured = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          if (!value) continue;
          for (const record of parser.push(value)) {
            if (record.kind === "config") {
              decoder?.close();
              decoder = new VideoDecoderCtor({
                output: drawFrame,
                error: (decodeError) => {
                  if (cancelled) return;
                  report("error", decodeError.message);
                },
              });
              // No `description`: the stream is Annex-B, and a decoder
              // configured without one expects exactly that.
              decoder.configure({ codec: record.codec, optimizeForLatency: true });
              configured = true;
              if (record.width && record.height) {
                dimensionsRef.current?.({ width: record.width, height: record.height });
              }
              continue;
            }
            if (!configured || !decoder || decoder.state === "closed") continue;
            timestampUs += 33_333;
            decoder.decode(new EncodedVideoChunkCtor({
              type: record.keyframe ? "key" : "delta",
              timestamp: timestampUs,
              data: record.bytes,
            }));
            report("playing", null);
          }
        }
        if (!cancelled) report("stopped", null);
      } catch (caught) {
        if (cancelled || abort.signal.aborted) return;
        const message = caught instanceof IosSimVideoProtocolError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : String(caught);
        report("error", message);
      }
    };

    void run();

    return () => {
      cancelled = true;
      abort.abort();
      try {
        if (decoder && decoder.state !== "closed") decoder.close();
      } catch {
        // A decoder already torn down by an error throws on close. Nothing to do.
      }
      decoder = null;
    };
  }, [url, reconnectNonce, report]);

  return (
    <canvas
      ref={setCanvasNode}
      className={cn("h-full w-full object-contain", className)}
      data-testid="ios-h264-canvas"
      data-status={status}
      data-error={error ?? undefined}
    />
  );
}
