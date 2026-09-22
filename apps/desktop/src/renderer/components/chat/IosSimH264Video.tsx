import { useCallback, useEffect, useRef, useState } from "react";
import { APPLE_STREAM_NOT_RUNNING_CODE } from "../../../shared/types/iosSimulator";
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

/** Consecutive decoder failures inside the window that mean the stream is gone. */
export const DECODE_FAILURE_LIMIT = 3;
export const DECODE_FAILURE_WINDOW_MS = 5_000;

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
  /**
   * The stream token `startStream` handed back ALONGSIDE the url.
   *
   * The helper's frame server authorises on `Authorization: bearer <token>`
   * and strips the query string before it matches the path, so a token carried
   * in the URL is not merely redundant — it is never read, and the request is
   * answered 403. The reader therefore has to send the header, which is also
   * why this is a `fetch` with a streaming body rather than an `<img>` or a
   * `<video src>`: neither can set one.
   */
  token?: string | null;
  className?: string;
  /** Bumping this reconnects. Use it after a port forward is rebuilt. */
  reconnectNonce?: number;
  onStatus?: (status: IosSimH264Status, error: string | null) => void;
  onDimensions?: (size: { width: number; height: number }) => void;
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
  /**
   * Fired once per frame actually drawn to the canvas.
   *
   * The frame-time watchdog and the 3D presenter's texture upload both key off
   * "a frame landed", and neither can learn it from `onStatus`: `playing` is
   * reported once and then deduplicated for the life of the stream.
   */
  onFrame?: () => void;
};

/**
 * True for the brain-relayed stream.
 *
 * On this Mac the reader dials the helper's loopback body directly. Off it —
 * the hosted web client, or a desktop bound to another Mac — the only route is
 * the brain's forwarder at `/apple/stream/<ticket>`, which is a WebSocket
 * because a browser cannot set an Authorization header on a `fetch` to a
 * machine it reaches through a relay, and because the viewer has to be able to
 * say `{t:"hidden"}` back up the same channel.
 */
export function isAppleStreamSocketUrl(url: string): boolean {
  return url.startsWith("ws://") || url.startsWith("wss://");
}

async function* readAppleStreamBody(
  url: string,
  token: string | null,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    // Lower-case header name on purpose: the helper lower-cases both sides
    // before its constant-time compare, and `bearer` is the scheme it expects
    // verbatim.
    headers: token ? { authorization: `bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(response.status === 403
      ? "The simulator video stream refused this token."
      : `The simulator video stream answered ${response.status}.`);
  }
  const body = response.body;
  if (!body) throw new Error("The simulator video stream sent no body.");
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}

/**
 * The relayed stream, as an async chunk source.
 *
 * The brain sends one binary frame per record, so no re-framing happens here —
 * the same byte-stream parser reads both transports. `{t:"visible"}` on open
 * and `{t:"hidden"}` on teardown are what let the brain stop encoding for a
 * viewer that went away, which is the whole point of the control direction.
 */
async function* readAppleStreamSocket(
  url: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const queue: Uint8Array[] = [];
  let notify: (() => void) | null = null;
  let ended: Error | null | undefined;
  const wake = (): void => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") return;
    queue.push(new Uint8Array(event.data as ArrayBuffer));
    wake();
  };
  socket.onopen = () => {
    try {
      socket.send(JSON.stringify({ t: "visible" }));
    } catch {
      // The close handler below reports the failure.
    }
  };
  socket.onerror = () => {
    if (ended === undefined) ended = new Error("The simulator video stream could not be reached.");
    wake();
  };
  socket.onclose = (event: CloseEvent) => {
    if (ended === undefined) {
      ended = event.code === 4401
        ? new Error("The simulator video stream refused this ticket.")
        : null;
    }
    wake();
  };
  const onAbort = (): void => {
    if (ended === undefined) ended = null;
    wake();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (ended !== undefined) {
        if (ended) throw ended;
        return;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "hidden" }));
    } catch {
      // Closing anyway.
    }
    try {
      socket.close();
    } catch {
      // already closing
    }
  }
}

export function IosSimH264Video({
  url,
  token = null,
  className,
  reconnectNonce = 0,
  onStatus,
  onDimensions,
  onCanvas,
  onFrame,
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
  /**
   * When the decoder last failed, and how many times in a row.
   *
   * One rejected access unit is not a dead stream. It happens when the
   * decoder is fed a delta frame whose reference it never saw — after a
   * reattach, or when a second reader joins between an IDR and the frames
   * that depend on it — and the fix is to build a new decoder and ask the
   * helper for a fresh keyframe, which it emits whenever a reader attaches.
   * Round 2 reported the first failure as an error instead, which closed the
   * decoder, froze the picture on its last frame and put "Something went
   * wrong with the simulator · Decoding error." over a device that was fine.
   */
  const decodeFailuresRef = useRef<number[]>([]);
  const [recoveryNonce, setRecoveryNonce] = useState(0);

  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const dimensionsRef = useRef(onDimensions);
  dimensionsRef.current = onDimensions;
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;

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
    // One redial per failed decoder. The error callback can fire several
    // times for one bad access unit.
    let recovering = false;
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
        frameRef.current?.();
      } finally {
        // A VideoFrame holds a GPU buffer. Not closing it stalls the decoder
        // within a few frames.
        frame.close();
      }
    };

    const run = async () => {
      try {
        const chunks = isAppleStreamSocketUrl(url)
          ? readAppleStreamSocket(url, abort.signal)
          : readAppleStreamBody(url, token, abort.signal);
        const parser = createIosSimVideoRecordParser();
        let configured = false;

        for await (const value of chunks) {
          if (cancelled) break;
          if (!value) continue;
          for (const record of parser.push(value)) {
            if (record.kind === "config") {
              decoder?.close();
              decoder = new VideoDecoderCtor({
                output: drawFrame,
                error: (decodeError) => {
                  if (cancelled || recovering) return;
                  const now = Date.now();
                  const recent = decodeFailuresRef.current
                    .filter((at) => now - at < DECODE_FAILURE_WINDOW_MS);
                  recent.push(now);
                  decodeFailuresRef.current = recent;
                  if (recent.length >= DECODE_FAILURE_LIMIT) {
                    // Not one bad frame: something is actually wrong. Say the
                    // sentence the viewer maps to "Video stopped." with a
                    // Reconnect, never the generic "something went wrong".
                    report("error", `${APPLE_STREAM_NOT_RUNNING_CODE}: ${decodeError.message}`);
                    return;
                  }
                  // Keep the last good frame on the canvas and redial, which
                  // makes the helper emit a keyframe for the new reader.
                  recovering = true;
                  setRecoveryNonce((nonce) => nonce + 1);
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
            // A stream that draws again has recovered; a later single failure
            // must not inherit this one's count.
            if (decodeFailuresRef.current.length > 0) decodeFailuresRef.current = [];
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
  }, [url, token, reconnectNonce, recoveryNonce, report]);

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
