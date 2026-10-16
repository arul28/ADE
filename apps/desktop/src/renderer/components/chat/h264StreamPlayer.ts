import { createH264FrameGate } from "./h264FrameGate";
import {
  IosSimVideoProtocolError,
  createIosSimVideoRecordParser,
  type IosSimVideoConfigRecord,
  type IosSimVideoRecord,
} from "./iosSimVideoRecords";

/**
 * Plays a host-encoded H.264 stream onto a canvas: the Apple device's, or a
 * lane's macOS display. Framework-free, so the one React view over it
 * (`H264StreamView`) stays thin and every transport gets the same decoder.
 *
 * Window capture cannot cross a machine boundary, because the renderer
 * captures a window that only exists on the host Mac. The host encodes
 * instead, this reads the access units, decodes them with the platform
 * decoder (WebCodecs — hardware accelerated on Apple silicon and on Windows)
 * and draws them to a canvas. The frames are the screen itself, not a window,
 * so the canvas has no bezel and no chrome: a caller that maps a click to a
 * screen point needs no heuristic, the canvas IS the screen.
 *
 * Three ways in, one pipeline:
 *
 * - `http`: a token-guarded loopback body (this Mac, or an SSH forward).
 * - `socket`: the brain's relay at `/apple/stream/<ticket>`, a WebSocket.
 * - `push`: records a caller hands over, e.g. sync-socket notifications in the
 *   hosted web client, which cannot reach the lane's loopback URL.
 */

export type H264StreamStatus = "connecting" | "playing" | "error" | "stopped";

export type H264RecordHandlers = {
  onRecord: (record: IosSimVideoRecord) => void;
  onError: (message: string) => void;
  onEnd: () => void;
};

/** Pushed records. `subscribe` returns the unsubscribe. */
export type H264PushSource = {
  kind: "push";
  subscribe(handlers: H264RecordHandlers): () => void;
};

export type H264StreamSource =
  | {
    kind: "http";
    url: string;
    /**
     * Sent as `authorization: bearer <token>`. The Apple helper's frame
     * server authorises on that header and strips the query string before it
     * matches the path, so a token carried in the URL is never read and the
     * request is answered 403. This is also why the reader is a streaming
     * `fetch` and not an `<img>` or a `<video src>`: neither can set a header.
     */
    bearerToken?: string | null;
  }
  | { kind: "socket"; url: string }
  | H264PushSource;

/** Consecutive decoder failures inside the window that mean the stream is gone. */
export const DECODE_FAILURE_LIMIT = 3;
export const DECODE_FAILURE_WINDOW_MS = 5_000;
/**
 * Chunks the decoder may still hold from an earlier turn of the event loop
 * before delta frames are skipped. The picture must never show where the
 * pointer WAS.
 */
export const MAX_DECODE_QUEUE = 1;

type DecodedFrame = { displayWidth: number; displayHeight: number; close: () => void };

type VideoDecoderLike = {
  configure: (config: { codec: string; optimizeForLatency?: boolean }) => void;
  readonly decodeQueueSize?: number;
  decode: (chunk: unknown) => void;
  close: () => void;
  readonly state: string;
};

type VideoDecoderConstructor = new (init: {
  output: (frame: DecodedFrame) => void;
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
 * The source for a stream address.
 *
 * On this Mac the reader dials the helper's loopback body directly. Off it —
 * the hosted web client, or a desktop bound to another Mac — the Apple route
 * is the brain's forwarder at `/apple/stream/<ticket>`, which is a WebSocket
 * because a browser cannot set an Authorization header on a `fetch` to a
 * machine it reaches through a relay, and because the viewer has to be able
 * to say `{t:"hidden"}` back up the same channel.
 */
export function h264SourceForUrl(url: string, bearerToken?: string | null): H264StreamSource {
  return url.startsWith("ws://") || url.startsWith("wss://")
    ? { kind: "socket", url }
    : { kind: "http", url, bearerToken: bearerToken ?? null };
}

export type H264StreamPlayerOptions = {
  source: H264StreamSource;
  canvas: HTMLCanvasElement | null;
  /**
   * What the error sentences call the stream: "The <name> refused this
   * token." Defaults to "video stream".
   */
  streamName?: string;
  /**
   * Prefixed to the error reported once the decoder has failed
   * `DECODE_FAILURE_LIMIT` times inside the window, so a caller can map it to
   * its own sentence (the Apple viewer's "Video stopped." with a Reconnect).
   */
  streamGoneCode?: string;
  onStatus?: (status: H264StreamStatus, error: string | null) => void;
  onDimensions?: (size: { width: number; height: number }) => void;
  /**
   * Fired once per frame actually drawn to the canvas.
   *
   * The frame-time watchdog and the 3D presenter's texture upload both key off
   * "a frame landed", and neither can learn it from `onStatus`: `playing` is
   * reported once and then deduplicated for the life of the stream.
   */
  onFrame?: () => void;
};

export type H264StreamPlayer = {
  /** Tear down: abort the read, unsubscribe, close the decoder. Idempotent. */
  stop(): void;
};

function errorMessage(caught: unknown): string {
  if (caught instanceof IosSimVideoProtocolError) return caught.message;
  return caught instanceof Error ? caught.message : String(caught);
}

async function* readHttpBody(
  url: string,
  bearerToken: string | null,
  name: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    // Lower-case header name on purpose: the helper lower-cases both sides
    // before its constant-time compare, and `bearer` is the scheme it expects
    // verbatim.
    headers: bearerToken ? { authorization: `bearer ${bearerToken}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(response.status === 403
      ? `The ${name} refused this token.`
      : `The ${name} answered ${response.status}.`);
  }
  const body = response.body;
  if (!body) throw new Error(`The ${name} sent no body.`);
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
async function* readSocket(
  url: string,
  name: string,
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
    if (ended === undefined) ended = new Error(`The ${name} could not be reached.`);
    wake();
  };
  socket.onclose = (event: CloseEvent) => {
    if (ended === undefined) {
      ended = event.code === 4401 ? new Error(`The ${name} refused this ticket.`) : null;
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

export function createH264StreamPlayer(options: H264StreamPlayerOptions): H264StreamPlayer {
  const { source, canvas, onStatus, onDimensions, onFrame } = options;
  const name = options.streamName ?? "video stream";
  let stopped = false;

  /**
   * The status already reported.
   *
   * The decode loop runs once per frame. An unguarded report fired the
   * caller's callback thirty times a second, and the caller rebuilt its
   * live-view object on every call — a full drawer re-render per frame.
   */
  let reported: { status: H264StreamStatus; error: string | null } | null = null;
  const report = (status: H264StreamStatus, error: string | null): void => {
    if (reported && reported.status === status && reported.error === error) return;
    reported = { status, error };
    onStatus?.(status, error);
  };

  const scope = globalThis as unknown as WebCodecsWindow;
  const VideoDecoderCtor = scope.VideoDecoder;
  const EncodedVideoChunkCtor = scope.EncodedVideoChunk;
  if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
    report("error", `This build cannot decode the ${name}.`);
    return { stop() {} };
  }

  const context = canvas?.getContext("2d", { alpha: false }) ?? null;
  // The decoder-safety gate: after a sequence gap, a config, a decoder error
  // or a skipped delta, only a keyframe may restart the picture.
  const gate = createH264FrameGate();
  let decoder: VideoDecoderLike | null = null;
  let lastConfig: IosSimVideoConfigRecord | null = null;
  let timestampUs = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  /**
   * When the decoder last failed, recently.
   *
   * One rejected access unit is not a dead stream. It happens when the
   * decoder is fed a delta frame whose reference it never saw — after a
   * reattach, or when a second reader joins between an IDR and the frames
   * that depend on it — and the fix is to build a new decoder and start again
   * from a keyframe. Reporting the first failure as an error instead closed
   * the decoder, froze the picture on its last frame and put "Something went
   * wrong with the simulator · Decoding error." over a device that was fine.
   */
  let failures: number[] = [];

  /**
   * Whether the decoder is behind the stream: it still holds more chunks than
   * it had a whole turn of the event loop to take. Sampled once per turn, at
   * the turn's first access unit, so a burst of records read in one chunk —
   * which fills the queue and drains in milliseconds — never counts against
   * itself. Deliberately the codec's
   * INPUT queue and not time-to-output: a decoder that holds frames for
   * reordering would read as late on an idle, one-frame-a-second screen.
   */
  let queueAtTurnStart: number | null = null;
  const decoderBehind = (active: VideoDecoderLike): boolean => {
    if (queueAtTurnStart === null) {
      queueAtTurnStart = active.decodeQueueSize ?? 0;
      setTimeout(() => {
        queueAtTurnStart = null;
      }, 0);
    }
    return queueAtTurnStart > MAX_DECODE_QUEUE;
  };

  const drawFrame = (frame: DecodedFrame): void => {
    try {
      if (stopped || !canvas || !context) return;
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      if (frame.displayWidth !== lastWidth || frame.displayHeight !== lastHeight) {
        lastWidth = frame.displayWidth;
        lastHeight = frame.displayHeight;
        onDimensions?.({ width: frame.displayWidth, height: frame.displayHeight });
      }
      context.drawImage(frame as unknown as CanvasImageSource, 0, 0);
      // Playing is a drawn frame, not an accepted chunk: an encoded chunk
      // says the decoder took the bytes, and a decoder that then errors out
      // would still have claimed the picture was up.
      report("playing", null);
      // A stream that draws again has recovered; a later single failure must
      // not inherit this one's count.
      if (failures.length > 0) failures = [];
      onFrame?.();
    } finally {
      // A VideoFrame holds a GPU buffer. Not closing it stalls the decoder
      // within a few frames.
      frame.close();
    }
  };

  const closeDecoder = (): void => {
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      // A decoder already torn down by an error throws on close. Nothing to do.
    }
    decoder = null;
    queueAtTurnStart = null;
  };

  let connection: AbortController | null = null;
  let unsubscribe: (() => void) | null = null;

  const buildDecoder = (config: IosSimVideoConfigRecord): void => {
    closeDecoder();
    let failed = false;
    const next: VideoDecoderLike = new VideoDecoderCtor({
      output: drawFrame,
      // The error callback can fire several times for one bad access unit;
      // only the first, from the decoder still in use, counts.
      error: (decodeError) => {
        if (stopped || failed || decoder !== next) return;
        failed = true;
        onDecoderError(decodeError);
      },
    });
    // No `description`: the stream is Annex-B, and a decoder configured
    // without one expects exactly that.
    next.configure({ codec: config.codec, optimizeForLatency: true });
    decoder = next;
  };

  const onDecoderError = (decodeError: Error): void => {
    // The decoder's references are gone; hold P-frames until a keyframe.
    gate.requireKeyframe();
    const now = Date.now();
    failures = failures.filter((at) => now - at < DECODE_FAILURE_WINDOW_MS);
    failures.push(now);
    if (failures.length >= DECODE_FAILURE_LIMIT) {
      // Not one bad frame: something is actually wrong. Say the sentence the
      // caller maps to "Video stopped." with a Reconnect, never the generic
      // "something went wrong".
      const code = options.streamGoneCode;
      report("error", code ? `${code}: ${decodeError.message}` : decodeError.message);
      return;
    }
    // Keep the last good frame on the canvas and start again. A reader the
    // host sees attach gets the config and a fresh keyframe, so a dialled
    // source redials; pushed records cannot be asked for one, so they get a
    // new decoder and wait for the host's next keyframe.
    report("connecting", null);
    if (source.kind === "push") {
      if (lastConfig) buildDecoder(lastConfig);
    } else {
      connect();
    }
  };

  const consume = (record: IosSimVideoRecord): void => {
    if (record.kind === "config") {
      lastConfig = record;
      buildDecoder(record);
      gate.reset();
      if (record.width && record.height) {
        onDimensions?.({ width: record.width, height: record.height });
      }
      return;
    }
    if (!decoder || decoder.state === "closed") return;
    // Sequence numbers exist only on pushed records; the keyframe wait
    // applies to every source.
    // Sampled before anything this turn is submitted, keyframes included.
    const behind = decoderBehind(decoder);
    if (!gate.shouldDeliver(record.keyframe, record.seq)) return;
    // Newest frame wins: a decoder behind the stream paints where the pointer
    // WAS, so a delta that would queue behind older ones is skipped. Skipping
    // one delta breaks the reference chain of every delta after it — decoding
    // those paints corruption that outlives the skip — so the skip also holds
    // the picture until the next keyframe. A keyframe is always decoded.
    if (!record.keyframe && behind) {
      gate.requireKeyframe();
      return;
    }
    timestampUs += 33_333;
    decoder.decode(new EncodedVideoChunkCtor({
      type: record.keyframe ? "key" : "delta",
      timestamp: timestampUs,
      data: record.bytes,
    }));
  };

  const connect = (): void => {
    if (source.kind === "push") return;
    connection?.abort();
    const abort = new AbortController();
    connection = abort;
    const current = (): boolean => !stopped && connection === abort;
    const run = async (): Promise<void> => {
      try {
        const chunks = source.kind === "socket"
          ? readSocket(source.url, name, abort.signal)
          : readHttpBody(source.url, source.bearerToken ?? null, name, abort.signal);
        const parser = createIosSimVideoRecordParser();
        for await (const value of chunks) {
          if (!current()) break;
          for (const record of parser.push(value)) {
            if (!current()) break;
            consume(record);
          }
        }
        if (current()) report("stopped", null);
      } catch (caught) {
        if (!current() || abort.signal.aborted) return;
        report("error", errorMessage(caught));
      }
    };
    void run();
  };

  report("connecting", null);
  if (source.kind === "push") {
    unsubscribe = source.subscribe({
      onRecord: (record) => {
        if (stopped) return;
        try {
          consume(record);
        } catch (caught) {
          report("error", errorMessage(caught));
        }
      },
      onError: (message) => {
        if (!stopped) report("error", message);
      },
      onEnd: () => {
        if (!stopped) report("stopped", null);
      },
    });
  } else {
    connect();
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      connection?.abort();
      connection = null;
      unsubscribe?.();
      unsubscribe = null;
      closeDecoder();
    },
  };
}
