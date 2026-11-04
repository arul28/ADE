/**
 * The token-guarded loopback endpoint a viewer reads an emulator's picture from.
 *
 * Mirrors `macDesktopStreamServer.ts`: one loopback HTTP listener for every
 * emulator on this machine, a token minted per run, and ADE's video records on
 * the wire, so the renderer's reader, the relay and the web and phone viewers
 * play Android unchanged.
 *
 * One difference, forced by scrcpy: the encoder is shared. The Mac Desktop
 * helper opens one upstream per reader and hands each its own keyframe; here
 * one scrcpy server feeds every reader, and it sends a keyframe only at start,
 * after a reset, and every 10 s. So this server keeps the last config record
 * and the last keyframe (with its SPS and PPS) and gives a reader that joins:
 *
 * 1. the config record;
 * 2. the cached keyframe, so it paints at once;
 * 3. nothing more until the next keyframe, when deltas were sent after the
 *    cached one. Those deltas reference frames this reader never had, and
 *    decoding them paints corruption. The server asks the encoder for that
 *    keyframe (`requestKeyframe`, scrcpy's reset), so the wait is one encoder
 *    restart, not up to 10 s.
 *
 * Holding the deltas here, rather than sending them for the player to drop,
 * matters: the player redials after a second of deltas it cannot use, and a
 * redial is a new reader, which would ask for another keyframe in a loop.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { Logger } from "../logging/logger";
import {
  answerLoopbackPreamble,
  bindLoopbackServer,
  openStreamBody,
  safeEqual,
  writeWithBacklog,
} from "../media/loopbackTokenServer";
import type { ScrcpyRecordOutput, ScrcpyVideoConfig } from "./scrcpyVideo";

const ANDROID_STREAM_PATH = "/android/stream";

/**
 * A keyframe request that produced no keyframe in this time is asked again.
 * An encoder restart on the emulator takes well under a second.
 */
const KEYFRAME_REQUEST_RETRY_MS = 2_000;
/** The window fps and bitrate are measured over. */
const RATE_WINDOW_MS = 2_000;

export type AndroidStreamServerTransport = {
  url: string;
  port: number;
  token: string;
};

export type AndroidStreamMetrics = {
  key: string;
  readers: number;
  /** Access units per second over the last two seconds. */
  fps: number;
  bytesPerSecond: number;
  config: ScrcpyVideoConfig | null;
  totals: { accessUnits: number; keyframes: number; configs: number; bytes: number; keyframeRequests: number };
  startedAtMs: number;
  firstConfigAtMs: number | null;
  firstKeyframeAtMs: number | null;
  lastError: string | null;
};

export type AndroidStreamServerDeps = {
  logger?: Logger | null;
  now?: () => number;
  /** Asks the device's encoder for a keyframe now. */
  requestKeyframe: (key: string) => void;
};

type Reader = {
  response: ServerResponse;
  backlogBytes: number;
  /** Deltas are held from this reader until the next keyframe. */
  waitingForKeyframe: boolean;
};

type DeviceStream = {
  key: string;
  token: string;
  readers: Set<Reader>;
  config: (ScrcpyVideoConfig & { record: Uint8Array }) | null;
  lastKeyframe: Uint8Array | null;
  deltasSinceKeyframe: number;
  keyframeRequestedAtMs: number | null;
  /** Arrival times and sizes of recent access units, for fps and bytes/s. */
  recent: Array<{ atMs: number; bytes: number }>;
  totals: AndroidStreamMetrics["totals"];
  startedAtMs: number;
  firstConfigAtMs: number | null;
  firstKeyframeAtMs: number | null;
  lastError: string | null;
};

export function createAndroidStreamServer(deps: AndroidStreamServerDeps) {
  const now = deps.now ?? (() => Date.now());
  const streams = new Map<string, DeviceStream>();
  let server: Server | null = null;
  let port = 0;
  let disposed = false;
  /** The bind in flight, so two first starts share one server. */
  let binding: Promise<number> | null = null;

  const dropReader = (stream: DeviceStream, reader: Reader, reason: string): void => {
    if (!stream.readers.delete(reader)) return;
    // Info, not debug: a reader coming and going is rare, and it is the one
    // fact that tells a stream nobody read from a stream whose reader left.
    deps.logger?.info("android.stream_reader_dropped", { key: stream.key, reason, readers: stream.readers.size });
    reader.response.destroy();
  };

  const write = (stream: DeviceStream, reader: Reader, record: Uint8Array): boolean =>
    writeWithBacklog(reader, reader.response, record, (reason) => dropReader(stream, reader, reason));

  const requestKeyframe = (stream: DeviceStream): void => {
    const at = stream.keyframeRequestedAtMs;
    if (at !== null && now() - at < KEYFRAME_REQUEST_RETRY_MS) return;
    stream.keyframeRequestedAtMs = now();
    stream.totals.keyframeRequests += 1;
    deps.requestKeyframe(stream.key);
  };

  const attachReader = (stream: DeviceStream, response: ServerResponse): Reader => {
    const reader: Reader = { response, backlogBytes: 0, waitingForKeyframe: true };
    stream.readers.add(reader);
    // Before the first config there is nothing to send; the config branch of
    // `publish` writes it to every reader, this one included.
    if (stream.config) {
      write(stream, reader, stream.config.record);
      if (stream.lastKeyframe) {
        write(stream, reader, stream.lastKeyframe);
        reader.waitingForKeyframe = stream.deltasSinceKeyframe > 0;
      }
      if (reader.waitingForKeyframe) requestKeyframe(stream);
    }
    deps.logger?.info("android.stream_reader_attached", {
      key: stream.key,
      readers: stream.readers.size,
      afterMs: now() - stream.startedAtMs,
      waitingForKeyframe: reader.waitingForKeyframe,
    });
    return reader;
  };

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (answerLoopbackPreamble(request, response)) return;
    if (url.pathname !== ANDROID_STREAM_PATH || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    const key = url.searchParams.get("device")?.trim() ?? "";
    const supplied = url.searchParams.get("token") ?? "";
    const stream = key ? streams.get(key) ?? null : null;
    // One answer for "no such device" and "wrong token", so a local prober
    // learns nothing about which emulators run here.
    if (!stream || !supplied || !safeEqual(supplied, stream.token)) {
      response.writeHead(403).end();
      return;
    }
    openStreamBody(request, response);
    const reader = attachReader(stream, response);
    response.on("close", () => dropReader(stream, reader, "client-closed"));
  };

  /**
   * Binds the loopback server once, memoized on the bind itself so two
   * emulators starting together share one listener. A bind that lands after
   * `dispose` closes what it bound.
   */
  const ensureServer = (): Promise<number> => {
    if (server && port) return Promise.resolve(port);
    if (binding) return binding;
    const attempt = bindLoopbackServer(handleRequest, {
      bindErrorMessage: "The Android video server could not bind a loopback port.",
    }).then((bound) => {
      if (disposed) {
        bound.server.close();
        throw new Error("The Android video server has been disposed.");
      }
      server = bound.server;
      port = bound.port;
      deps.logger?.info("android.stream_server_listening", { port });
      return port;
    }).finally(() => {
      if (binding === attempt) binding = null;
    });
    binding = attempt;
    return attempt;
  };

  const transportFor = (stream: DeviceStream): AndroidStreamServerTransport => ({
    url: `http://127.0.0.1:${port}${ANDROID_STREAM_PATH}?device=${encodeURIComponent(stream.key)}&token=${stream.token}`,
    port,
    token: stream.token,
  });

  const countAccessUnit = (stream: DeviceStream, bytes: number): void => {
    const at = now();
    stream.recent.push({ atMs: at, bytes });
    while (stream.recent.length > 0 && at - stream.recent[0].atMs > RATE_WINDOW_MS) stream.recent.shift();
    stream.totals.accessUnits += 1;
    stream.totals.bytes += bytes;
  };

  const stopStream = (key: string, reason: string): boolean => {
    const stream = streams.get(key);
    if (!stream) return false;
    streams.delete(key);
    for (const reader of [...stream.readers]) {
      stream.readers.delete(reader);
      reader.response.destroy();
    }
    deps.logger?.debug("android.stream_stopped", { key, reason });
    return true;
  };

  return {
    /**
     * Starts serving a device and mints its token. A device already serving
     * keeps its token: a second viewer must not evict the first, whose URL
     * carries it. `stop` is the only thing that ends a run.
     */
    async start(key: string): Promise<AndroidStreamServerTransport> {
      if (disposed) throw new Error("The Android video server has been disposed.");
      await ensureServer();
      if (disposed) throw new Error("The Android video server has been disposed.");
      const existing = streams.get(key);
      if (existing) return transportFor(existing);
      const stream: DeviceStream = {
        key,
        token: randomBytes(32).toString("hex"),
        readers: new Set(),
        config: null,
        lastKeyframe: null,
        deltasSinceKeyframe: 0,
        keyframeRequestedAtMs: null,
        recent: [],
        totals: { accessUnits: 0, keyframes: 0, configs: 0, bytes: 0, keyframeRequests: 0 },
        startedAtMs: now(),
        firstConfigAtMs: null,
        firstKeyframeAtMs: null,
        lastError: null,
      };
      streams.set(key, stream);
      return transportFor(stream);
    },

    /** Hands one record from the device's encoder to every reader that can use it. */
    publish(key: string, output: ScrcpyRecordOutput): void {
      const stream = streams.get(key);
      if (!stream) return;
      if (output.kind === "config") {
        stream.config = { codec: output.codec, width: output.width, height: output.height, record: output.record };
        // The old keyframe belongs to the old size; a reader that joins now
        // waits for the first one at the new size.
        stream.lastKeyframe = null;
        stream.deltasSinceKeyframe = 0;
        // An encoder always opens with a keyframe after its config, so a
        // reader that joins in between waits for it without asking.
        stream.keyframeRequestedAtMs = now();
        stream.totals.configs += 1;
        stream.firstConfigAtMs ??= now();
        for (const reader of [...stream.readers]) {
          // The player rebuilds its decoder on a config and needs a keyframe after it.
          reader.waitingForKeyframe = true;
          write(stream, reader, output.record);
        }
        return;
      }
      countAccessUnit(stream, output.record.byteLength);
      if (output.keyframe) {
        stream.lastKeyframe = output.record;
        stream.deltasSinceKeyframe = 0;
        stream.keyframeRequestedAtMs = null;
        stream.totals.keyframes += 1;
        stream.firstKeyframeAtMs ??= now();
        for (const reader of [...stream.readers]) {
          reader.waitingForKeyframe = false;
          write(stream, reader, output.record);
        }
        return;
      }
      stream.deltasSinceKeyframe += 1;
      for (const reader of [...stream.readers]) {
        if (!reader.waitingForKeyframe) write(stream, reader, output.record);
      }
    },

    getTransport(key: string): AndroidStreamServerTransport | null {
      const stream = streams.get(key);
      return stream ? transportFor(stream) : null;
    },

    metrics(key: string): AndroidStreamMetrics | null {
      const stream = streams.get(key);
      if (!stream) return null;
      const at = now();
      const recent = stream.recent.filter((entry) => at - entry.atMs <= RATE_WINDOW_MS);
      const seconds = RATE_WINDOW_MS / 1_000;
      return {
        key,
        readers: stream.readers.size,
        fps: Math.round((recent.length / seconds) * 10) / 10,
        bytesPerSecond: Math.round(recent.reduce((sum, entry) => sum + entry.bytes, 0) / seconds),
        config: stream.config ? { codec: stream.config.codec, width: stream.config.width, height: stream.config.height } : null,
        totals: { ...stream.totals },
        startedAtMs: stream.startedAtMs,
        firstConfigAtMs: stream.firstConfigAtMs,
        firstKeyframeAtMs: stream.firstKeyframeAtMs,
        lastError: stream.lastError,
      };
    },

    readerCount(key: string): number {
      return streams.get(key)?.readers.size ?? 0;
    },

    recordError(key: string, message: string): void {
      const stream = streams.get(key);
      if (stream) stream.lastError = message;
    },

    stop(key: string): boolean {
      return stopStream(key, "stopped");
    },

    port(): number {
      return port;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const key of [...streams.keys()]) stopStream(key, "disposed");
      const running = server;
      server = null;
      port = 0;
      running?.close();
    },
  };
}

export type AndroidStreamServer = ReturnType<typeof createAndroidStreamServer>;
