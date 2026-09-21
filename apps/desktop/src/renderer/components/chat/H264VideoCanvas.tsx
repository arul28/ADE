import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";
import { createH264FrameGate } from "./h264FrameGate";
import {
  IosSimVideoProtocolError,
  createIosSimVideoRecordParser,
  type IosSimVideoRecord,
} from "./iosSimVideoRecords";

/**
 * Plays a host-encoded H.264 stream: the iOS simulator's, or a lane's macOS
 * display. Both features hand it the same thing — a token-guarded loopback URL
 * carrying framed access units — so it is named for the transport it reads and
 * not for either caller.
 *
 * Window capture cannot cross a machine boundary, because the renderer captures
 * a window that only exists on the host Mac. This component reads access units
 * over loopback HTTP instead, decodes them with the platform decoder, and draws
 * them to a canvas. The decode is hardware accelerated on Apple silicon and on
 * Windows.
 *
 * The frames are the screen itself, not a window, so the canvas has no bezel
 * and no chrome. A caller that maps a click to a screen point therefore needs
 * no heuristic: the canvas IS the screen.
 */

export type H264VideoStatus = "connecting" | "playing" | "error" | "stopped";

type VideoDecoderLike = {
  configure: (config: { codec: string; optimizeForLatency?: boolean }) => void;
  readonly decodeQueueSize: number;
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

/**
 * A second record source: pushed records instead of a fetchable URL.
 *
 * The hosted web client cannot reach the lane's loopback URL, so its Mac
 * Desktop stream arrives as sync-socket notifications. The decoder does not
 * care where a record came from, so it consumes both through the same
 * `IosSimVideoRecord` shape.
 */
export type H264VideoRecordSource = {
  subscribe(handlers: {
    onRecord: (record: IosSimVideoRecord) => void;
    onError: (message: string) => void;
    onEnd: () => void;
  }): () => void;
};

export type H264VideoCanvasProps = {
  /** The URL `startStream` handed back, already localised for this machine. */
  url?: string | null;
  /** Pushed records instead of a URL. Takes precedence when both are present. */
  source?: H264VideoRecordSource | null;
  className?: string;
  /** Bumping this reconnects. Use it after a port forward is rebuilt. */
  reconnectNonce?: number;
  onStatus?: (status: H264VideoStatus, error: string | null) => void;
  onDimensions?: (size: { width: number; height: number }) => void;
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
};

export function H264VideoCanvas({
  url = null,
  source = null,
  className,
  reconnectNonce = 0,
  onStatus,
  onDimensions,
  onCanvas,
}: H264VideoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const [status, setStatus] = useState<H264VideoStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  /**
   * The status this component has already reported.
   *
   * The decode loop runs once per frame. Reading `status` from the effect's
   * closure never observes the update, so an unguarded report fired the parent
   * callback thirty times a second, and the parent rebuilds its live-view
   * object on every call — a full drawer re-render per frame.
   */
  const reportedRef = useRef<{ status: H264VideoStatus; error: string | null } | null>(null);

  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const dimensionsRef = useRef(onDimensions);
  dimensionsRef.current = onDimensions;

  const report = useCallback((next: H264VideoStatus, nextError: string | null) => {
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
    if (!url && !source) {
      report("stopped", null);
      return;
    }
    const scope = globalThis as unknown as WebCodecsWindow;
    const VideoDecoderCtor = scope.VideoDecoder;
    const EncodedVideoChunkCtor = scope.EncodedVideoChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
      report("error", "This build cannot decode the video stream.");
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
      if (cancelled) {
        frame.close();
        return;
      }
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
        // Playing is a drawn frame, not an accepted chunk: an encoded chunk
        // says the decoder took the bytes, and a decoder that then errors out
        // would still have claimed the picture was up.
        report("playing", null);
      } finally {
        // A VideoFrame holds a GPU buffer. Not closing it stalls the decoder
        // within a few frames.
        frame.close();
      }
    };

    // One record pipeline for both sources: the URL reader feeds it parsed
    // records, a push subscription hands it the same shapes directly. The URL
    // path carries no sequence numbers, so the gate only applies to pushes;
    // a decoder error or a rebuild resets it for both.
    const gate = createH264FrameGate();
    let configured = false;
    const consume = (record: IosSimVideoRecord): void => {
      if (record.kind === "config") {
        decoder?.close();
        decoder = new VideoDecoderCtor({
          output: drawFrame,
          error: (decodeError) => {
            if (cancelled) return;
            // The decoder's references are gone; hold P-frames until the host
            // repeats the parameter sets in front of the next keyframe.
            gate.requireKeyframe();
            report("error", decodeError.message);
          },
        });
        // No `description`: the stream is Annex-B, and a decoder configured
        // without one expects exactly that.
        decoder.configure({ codec: record.codec, optimizeForLatency: true });
        // The decoder must never fall behind the stream: with a queue the
        // picture shows where the pointer WAS. Drop delta frames while the
        // decoder still holds more than one so it always paints the newest.
        configured = true;
        gate.reset();
        if (record.width && record.height) {
          dimensionsRef.current?.({ width: record.width, height: record.height });
        }
        return;
      }
      if (!configured || !decoder || decoder.state === "closed") return;
      if (record.seq !== undefined && !gate.shouldDeliver(record.keyframe, record.seq)) return;
      // Newest frame wins: a delta that would sit behind one already queued is
      // dropped, so the picture never shows where the pointer WAS. A keyframe
      // is always decoded, because the next delta needs it.
      if (!record.keyframe && decoder.decodeQueueSize > 1) return;
      timestampUs += 33_333;
      decoder.decode(new EncodedVideoChunkCtor({
        type: record.keyframe ? "key" : "delta",
        timestamp: timestampUs,
        data: record.bytes,
      }));
    };

    let unsubscribe: (() => void) | null = null;
    if (source) {
      unsubscribe = source.subscribe({
        onRecord: (record) => {
          if (!cancelled) consume(record);
        },
        onError: (message) => {
          if (!cancelled) report("error", message);
        },
        onEnd: () => {
          if (!cancelled) report("stopped", null);
        },
      });
    } else if (url) {
      const run = async () => {
        try {
          const response = await fetch(url, { signal: abort.signal, cache: "no-store" });
          if (!response.ok) {
            throw new Error(response.status === 403
              ? "The video stream refused this token."
              : `The video stream answered ${response.status}.`);
          }
          const body = response.body;
          if (!body) throw new Error("The video stream sent no body.");
          const reader = body.getReader();
          const parser = createIosSimVideoRecordParser();

          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            if (!value) continue;
            for (const record of parser.push(value)) {
              if (cancelled) break;
              consume(record);
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
    }

    return () => {
      cancelled = true;
      abort.abort();
      unsubscribe?.();
      try {
        if (decoder && decoder.state !== "closed") decoder.close();
      } catch {
        // A decoder already torn down by an error throws on close. Nothing to do.
      }
      decoder = null;
    };
  }, [url, source, reconnectNonce, report]);

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
