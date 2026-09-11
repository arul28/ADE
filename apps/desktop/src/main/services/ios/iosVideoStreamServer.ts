import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_HEADER_BYTES,
  IOS_VIDEO_RECORD_MAGIC,
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
  IOS_VIDEO_STREAM_PATH,
  type IosSimulatorStreamTransport,
} from "../../../shared/types/iosSimulator";
import { createH264AnnexBParser, type H264AccessUnit } from "./h264AnnexB";

/**
 * Serves a live H.264 stream of one simulator over loopback HTTP.
 *
 * The older live view has the renderer capture the real Simulator.app window,
 * which is the cheapest path that exists but only works when the simulator runs
 * on the same Mac as the ADE window. A chat pinned to a remote Mac therefore had
 * a live view it could never show. This server runs on the machine that owns the
 * simulator, encodes there, and hands out a URL. When that machine is remote the
 * desktop opens the same SSH port forward it already opens for a lane preview
 * server, so nothing new crosses the network boundary.
 *
 * The bytes do NOT go through the runtime RPC channel. That channel delivers
 * events to a remote desktop by polling a cursor every 750 ms with a 1 MiB
 * per-event ceiling, which is correct for state changes and useless for video.
 */

/**
 * A client this far behind is not going to catch up. Dropping an access unit
 * would corrupt every later frame, because the encoder emits exactly one IDR at
 * the start of a run, so the only honest recovery is to close the response and
 * let the reader reconnect into a fresh keyframe.
 */
const MAX_CLIENT_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Keep the encoder warm briefly so a reload does not pay a restart. */
const ENCODER_IDLE_STOP_MS = 3_000;

/**
 * What `start` returns, as opposed to what a status read reports.
 *
 * The shared type marks `url` and `token` nullable because `getStreamStatus`
 * redacts them. The call that creates the stream always has both, and saying so
 * here spares every caller a narrowing it does not need.
 */
export type IosSimulatorStreamTransportWithSecret = IosSimulatorStreamTransport & {
  url: string;
  token: string;
};

export type IosVideoEncoderProcess = {
  onData: (handler: (chunk: Uint8Array) => void) => void;
  onError: (handler: (error: Error) => void) => void;
  onExit: (handler: (code: number | null, signal: string | null) => void) => void;
  kill: () => void;
  pid: number | null;
};

export type IosVideoEncoderOptions = {
  deviceUdid: string;
  fps: number;
  scaleFactor: number | null;
  compressionQuality: number | null;
};

export type IosVideoStreamServerDeps = {
  startEncoder: (options: IosVideoEncoderOptions) => Promise<IosVideoEncoderProcess>;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  now?: () => number;
};

export type IosVideoStreamMetrics = {
  frames: number;
  bytes: number;
  keyframes: number;
  clients: number;
  fps: number | null;
  bitrateKbps: number | null;
  lastFrameAtMs: number | null;
  lastError: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
};

type StreamClient = {
  response: ServerResponse;
  backlogBytes: number;
  sentConfig: boolean;
};

/**
 * Builds one framed record. The reader needs the length before the payload
 * because a chunked HTTP body has no message boundaries of its own.
 */
export function encodeVideoRecord(
  type: number,
  payload: Uint8Array,
  options: { keyframe?: boolean } = {},
): Uint8Array {
  const record = new Uint8Array(IOS_VIDEO_RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, IOS_VIDEO_RECORD_MAGIC, false);
  view.setUint8(4, type);
  view.setUint8(5, options.keyframe ? IOS_VIDEO_RECORD_FLAG_KEYFRAME : 0);
  view.setUint16(6, 0, false);
  view.setUint32(8, payload.byteLength, false);
  record.set(payload, IOS_VIDEO_RECORD_HEADER_BYTES);
  return record;
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is constant length whatever the caller sends.
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function createIosVideoStreamServer(deps: IosVideoStreamServerDeps) {
  const now = deps.now ?? (() => Date.now());

  let server: Server | null = null;
  let port = 0;
  let token = "";
  let encoder: IosVideoEncoderProcess | null = null;
  let encoderOptions: IosVideoEncoderOptions | null = null;
  let encoderStarting: Promise<void> | null = null;
  /**
   * Which start attempt is current.
   *
   * Two readers connecting in the same tick both ask for a restart, and a start
   * is asynchronous, so without this the second attempt overwrites the first
   * and the first process is left running with nobody holding its handle.
   */
  let encoderGeneration = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let parser = createH264AnnexBParser();
  let clients = new Set<StreamClient>();
  let disposed = false;

  let metrics: IosVideoStreamMetrics = {
    frames: 0,
    bytes: 0,
    keyframes: 0,
    clients: 0,
    fps: null,
    bitrateKbps: null,
    lastFrameAtMs: null,
    lastError: null,
    codec: null,
    width: null,
    height: null,
  };
  let windowStartedAtMs = now();
  let windowFrames = 0;
  let windowBytes = 0;

  const resetMetrics = () => {
    metrics = {
      ...metrics,
      frames: 0,
      bytes: 0,
      keyframes: 0,
      fps: null,
      bitrateKbps: null,
      lastFrameAtMs: null,
      codec: null,
      width: null,
      height: null,
    };
    windowStartedAtMs = now();
    windowFrames = 0;
    windowBytes = 0;
  };

  const configPayload = (): Uint8Array | null => {
    const sets = parser.parameterSets();
    if (!sets.codec) return null;
    return new TextEncoder().encode(JSON.stringify({
      codec: sets.codec,
      width: sets.width,
      height: sets.height,
      annexB: true,
    }));
  };

  const dropClient = (client: StreamClient, reason: string) => {
    if (!clients.delete(client)) return;
    metrics = { ...metrics, clients: clients.size };
    deps.logger.debug("ios_simulator.video_client_dropped", { reason, clients: clients.size });
    client.response.destroy();
    scheduleEncoderIdleStop();
  };

  const writeToClient = (client: StreamClient, record: Uint8Array) => {
    client.backlogBytes += record.byteLength;
    if (client.backlogBytes > MAX_CLIENT_BACKLOG_BYTES) {
      dropClient(client, "backlog");
      return;
    }
    // The completion callback fires for a synchronous write too, so subtracting
    // here as well double-counts the release and pushes the drop threshold far
    // past the ceiling this rule exists to enforce. Release in one place only.
    let released = false;
    client.response.write(record, () => {
      if (released) return;
      released = true;
      client.backlogBytes = Math.max(0, client.backlogBytes - record.byteLength);
    });
  };

  const broadcast = (unit: H264AccessUnit) => {
    metrics = {
      ...metrics,
      frames: metrics.frames + 1,
      bytes: metrics.bytes + unit.bytes.byteLength,
      keyframes: metrics.keyframes + (unit.keyframe ? 1 : 0),
      lastFrameAtMs: now(),
    };
    windowFrames += 1;
    windowBytes += unit.bytes.byteLength;
    const elapsedMs = now() - windowStartedAtMs;
    if (elapsedMs >= 1_000) {
      metrics = {
        ...metrics,
        fps: Math.round((windowFrames * 1000) / elapsedMs),
        bitrateKbps: Math.round((windowBytes * 8) / elapsedMs),
      };
      windowStartedAtMs = now();
      windowFrames = 0;
      windowBytes = 0;
    }

    const sets = parser.parameterSets();
    if (sets.codec && (metrics.codec !== sets.codec || metrics.width !== sets.width)) {
      metrics = { ...metrics, codec: sets.codec, width: sets.width, height: sets.height };
    }

    const config = configPayload();
    const record = encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, unit.bytes, {
      keyframe: unit.keyframe,
    });
    for (const client of [...clients]) {
      if (!client.sentConfig) {
        // A decoder cannot start on a P-frame. Hold the client back until the
        // encoder emits its next keyframe, which a restart guarantees.
        if (!unit.keyframe || !config) continue;
        writeToClient(client, encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_CONFIG, config));
        client.sentConfig = true;
      }
      writeToClient(client, record);
    }
  };

  const stopEncoder = () => {
    // Anything still starting belongs to a superseded attempt now.
    encoderGeneration += 1;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const running = encoder;
    encoder = null;
    encoderStarting = null;
    parser.reset();
    parser = createH264AnnexBParser();
    resetMetrics();
    running?.kill();
  };

  function scheduleEncoderIdleStop(): void {
    if (clients.size > 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size === 0) stopEncoder();
    }, ENCODER_IDLE_STOP_MS);
    idleTimer.unref?.();
  }

  /**
   * Restarts the encoder so the next access unit is a keyframe.
   *
   * `idb video-stream` emits exactly one IDR, at the start of a run. A reader
   * that attaches later therefore has nothing to configure its decoder with, and
   * no amount of waiting produces one. A restart is the only way to give it a
   * keyframe; every reader already attached simply reconfigures and continues.
   */
  const restartEncoder = async (): Promise<void> => {
    if (disposed) return;
    const options = encoderOptions;
    if (!options) return;
    stopEncoder();
    for (const client of clients) client.sentConfig = false;
    const generation = ++encoderGeneration;

    const pending = (async () => {
      const started = await deps.startEncoder(options);
      if (disposed || generation !== encoderGeneration) {
        started.kill();
        return;
      }
      encoder = started;
      started.onData((chunk) => {
        if (encoder !== started) return;
        for (const unit of parser.push(chunk)) broadcast(unit);
      });
      started.onError((error) => {
        if (encoder !== started) return;
        metrics = { ...metrics, lastError: error.message };
        deps.logger.debug("ios_simulator.video_encoder_error", { error: error.message });
      });
      started.onExit((code, signal) => {
        if (encoder !== started) return;
        encoder = null;
        const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        metrics = { ...metrics, lastError: `The simulator video encoder stopped (${detail}).` };
        for (const client of [...clients]) dropClient(client, "encoder-exit");
      });
      deps.logger.info("ios_simulator.video_encoder_started", {
        deviceUdid: options.deviceUdid,
        fps: options.fps,
        pid: started.pid,
      });
    })();

    encoderStarting = pending.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      metrics = { ...metrics, lastError: message };
      for (const client of [...clients]) dropClient(client, "encoder-start-failed");
      throw error;
    }).finally(() => {
      if (encoderStarting === pending) encoderStarting = null;
    }) as Promise<void>;

    await encoderStarting;
  };

  const handleRequest = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Every request answers CORS: the renderer's origin is `app:` or `file:`,
    // which is opaque, so a same-origin check would reject the only legitimate
    // caller. The token is what actually authorises the read.
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");

    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Headers": "*" });
      response.end();
      return;
    }
    if (url.pathname !== IOS_VIDEO_STREAM_PATH || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    const supplied = url.searchParams.get("token") ?? "";
    if (!token || !supplied || !safeEqual(supplied, token)) {
      response.writeHead(403).end();
      return;
    }
    if (!encoderOptions) {
      response.writeHead(409).end();
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      Connection: "keep-alive",
    });
    // Nagle batches small writes, which is exactly wrong for a live view: it
    // trades latency for a saving this bitrate does not need.
    request.socket.setNoDelay(true);
    // Node holds the head until the first body write, and the first body write
    // is the first keyframe. A reader would therefore sit in `fetch` for as
    // long as the encoder takes to start, unable to tell a slow start from a
    // dead server.
    response.flushHeaders();
    const client: StreamClient = { response, backlogBytes: 0, sentConfig: false };
    clients.add(client);
    metrics = { ...metrics, clients: clients.size };
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    response.on("close", () => {
      if (clients.delete(client)) metrics = { ...metrics, clients: clients.size };
      scheduleEncoderIdleStop();
    });
    void restartEncoder().catch((error) => {
      deps.logger.debug("ios_simulator.video_encoder_restart_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /** Binds the loopback listener once, and mints this stream's token. */
  const ensureServer = async (): Promise<{ port: number; token: string }> => {
    // Rotated per stream on purpose. The token is the only thing standing
    // between a local process and the simulator's screen, so one that escapes
    // — into a log line, a shell history, a transcript — stops working as soon
    // as the stream it belonged to ends.
    token = randomBytes(32).toString("hex");
    if (server && port) return { port, token };
    const next = createServer(handleRequest);
    // A stream that goes quiet must not be torn down by the default timeout.
    next.keepAliveTimeout = 0;
    next.headersTimeout = 60_000;
    next.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      next.once("error", reject);
      next.listen(0, "127.0.0.1", () => {
        next.removeListener("error", reject);
        resolve();
      });
    });
    const address = next.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      next.close();
      throw new Error("The simulator video server could not bind a loopback port.");
    }
    server = next;
    port = address.port;
    deps.logger.info("ios_simulator.video_server_listening", { port });
    return { port, token };
  };

  return {
    /**
     * Starts serving `options.deviceUdid` and returns the URL to read it from.
     * The encoder itself does not start until a reader attaches.
     */
    async start(options: IosVideoEncoderOptions): Promise<IosSimulatorStreamTransportWithSecret> {
      if (disposed) throw new Error("The simulator video server has been disposed.");
      const sameDevice = encoderOptions?.deviceUdid === options.deviceUdid;
      encoderOptions = options;
      if (!sameDevice) {
        stopEncoder();
        for (const client of [...clients]) dropClient(client, "device-changed");
      }
      const bound = await ensureServer();
      const sets = parser.parameterSets();
      return {
        url: `http://127.0.0.1:${bound.port}${IOS_VIDEO_STREAM_PATH}?token=${bound.token}`,
        port: bound.port,
        token: bound.token,
        codec: sets.codec,
        width: sets.width,
        height: sets.height,
      };
    },

    stop(): void {
      encoderOptions = null;
      for (const client of [...clients]) dropClient(client, "stopped");
      stopEncoder();
    },

    metrics(): IosVideoStreamMetrics {
      return { ...metrics, clients: clients.size };
    },

    clientCount(): number {
      return clients.size;
    },

    dispose(): void {
      disposed = true;
      this.stop();
      clients = new Set();
      const running = server;
      server = null;
      port = 0;
      token = "";
      running?.close();
    },
  };
}

export type IosVideoStreamServer = ReturnType<typeof createIosVideoStreamServer>;
