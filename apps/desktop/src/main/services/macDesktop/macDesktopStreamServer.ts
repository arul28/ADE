/**
 * The token-guarded loopback endpoint the live view reads a lane's display from.
 *
 * Mirrors `iosVideoStreamServer.ts`: one loopback HTTP listener, a token minted
 * per `startStream`, framed H.264 records on the wire, and the same 12-byte
 * record header the renderer's reader already understands. The bytes do not go
 * through the runtime RPC channel, for the same reason they do not there — that
 * channel polls a cursor every 750ms with a per-event ceiling, which is right
 * for state and useless for video.
 *
 * Two differences from the simulator server, both forced by the shape of this
 * feature:
 *
 * 1. **Many lanes at once.** Each lane has its own display, its own token and
 *    its own encoder, so state is per lane and the URL names the lane.
 * 2. **The encoder is the helper.** `ade-desktop-driver` already encodes and
 *    already frames; this server opens a TCP connection to the port the helper
 *    handed back and copies bytes. One upstream connection per reader, so a
 *    reader that attaches late gets the helper's own config record and
 *    keyframe rather than waiting for the next one on a shared pipe.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

import type { Logger } from "../logging/logger";
import {
  ZERO_CLIENT_GRACE_MS,
  answerLoopbackPreamble,
  bindLoopbackServer,
  openStreamBody,
  pipeWithBacklog,
  safeEqual,
} from "../media/loopbackTokenServer";
import {
  createVideoRecordSplitter,
  encodeVideoRecord,
  VideoRecordFramingError,
} from "../media/videoRecords";
import {
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";
import {
  MAC_DESKTOP_ACTIVE_FPS,
  MAC_DESKTOP_IDLE_FPS,
  MAC_DESKTOP_IDLE_STREAM_AFTER_MS,
  MAC_DESKTOP_REAL_INPUT_COMMANDS,
  MAC_DESKTOP_STREAM_PATH,
  type MacDesktopRealInputCommand,
} from "../../../shared/types/macDesktop";

export type MacDesktopStreamTransportWithSecret = {
  url: string;
  port: number;
  token: string;
  codec: string | null;
  width: number | null;
  height: number | null;
};

export type MacDesktopStreamStartArgs = {
  laneId: string;
  /** Loopback TCP port the helper writes this lane's framed H.264 to. */
  sourcePort: number;
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  idleFps?: number | null;
};

export type MacDesktopStreamLaneMetrics = {
  laneId: string;
  running: boolean;
  clients: number;
  fps: number;
  idleFps: number;
  idle: boolean;
  bitrateKbps: number | null;
  lastError: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  port: number;
  /** When this run was started. */
  startedAtMs: number;
  /** When a reader was last sent bytes, or null for never. */
  lastBytesAtMs: number | null;
};

export type MacDesktopStreamServerDeps = {
  logger: Logger;
  now?: () => number;
  /**
   * Asks the helper to change the encoder's rate. Called when a lane goes idle
   * and again on the next action — never on a timer that runs regardless.
   */
  setRate?: (args: { laneId: string; fps: number }) => void | Promise<void>;
  /** Fired after the grace period once a lane has no readers left. */
  onZeroClients?: (laneId: string) => void;
  /** Test seam. Defaults to `net.connect`. */
  connectUpstream?: (port: number) => Socket;
  /**
   * The takeover fast path: a real-input command for a lane whose stream
   * token the caller presented. Absent on hosts with no input module.
   */
  postRealInput?: (args: {
    laneId: string;
    controllerId: string;
    chatSessionId?: string | null;
    command: MacDesktopRealInputCommand;
    payload: Record<string, unknown>;
  }) => Promise<void>;
};

export const MAC_DESKTOP_INPUT_PATH = "/mac-desktop/input";
const MAX_INPUT_BODY_BYTES = 16 * 1024;
const INPUT_COMMANDS = new Set<string>(MAC_DESKTOP_REAL_INPUT_COMMANDS);

type LaneClient = {
  response: ServerResponse;
  upstream: Socket;
  backlogBytes: number;
};

/**
 * Rewrites the helper's config record into the one the renderer parses.
 *
 * The Swift driver writes the bare codec string — `avc1.640032`, an 11-byte
 * payload — while the renderer's reader `JSON.parse`s the config payload, so
 * forwarding the helper's bytes untouched produced a stream that arrived and
 * then failed to configure a decoder. Rewriting here, rather than in the
 * driver, also lets the config carry the display's width and height, which the
 * encoder does not know and `stream.start` already told this process.
 *
 * Returns null when the payload names no codec at all; the caller drops the
 * record rather than sending a config a decoder cannot use.
 */
export function normalizeConfigPayload(
  payload: Buffer,
  size: { width: number | null; height: number | null },
): { json: Buffer; codec: string; width: number | null; height: number | null } | null {
  const text = payload.toString("utf8").trim();
  let codec = text;
  let width = size.width;
  let height = size.height;
  if (text.startsWith("{")) {
    let parsed: { codec?: unknown; width?: unknown; height?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return null;
    }
    codec = typeof parsed.codec === "string" ? parsed.codec : "";
    if (typeof parsed.width === "number") width = parsed.width;
    if (typeof parsed.height === "number") height = parsed.height;
  }
  if (!codec) return null;
  return {
    json: Buffer.from(JSON.stringify({
      codec,
      width: width ?? null,
      height: height ?? null,
      // The driver emits Annex-B access units, same as the simulator encoder,
      // so the decoder is configured without a `description`.
      annexB: true,
    })),
    codec,
    width,
    height,
  };
}

type LaneStream = {
  laneId: string;
  token: string;
  sourcePort: number;
  codec: string | null;
  width: number | null;
  height: number | null;
  activeFps: number;
  idleFps: number;
  idle: boolean;
  clients: Set<LaneClient>;
  bytesInWindow: number;
  windowStartedAtMs: number;
  bitrateKbps: number | null;
  lastError: string | null;
  startedAtMs: number;
  lastBytesAtMs: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/** The one FPS clamp: 1..60, rounded, with a fallback for a missing number. */
export const clampFps = (value: number | null | undefined, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(60, Math.round(value)));
};

export function createMacDesktopStreamServer(deps: MacDesktopStreamServerDeps) {
  const now = deps.now ?? (() => Date.now());
  const connectUpstream = deps.connectUpstream ?? ((port: number) => netConnect({ host: "127.0.0.1", port }));

  const lanes = new Map<string, LaneStream>();
  let server: Server | null = null;
  let port = 0;
  let disposed = false;

  const applyRate = (lane: LaneStream, fps: number): void => {
    void Promise.resolve(deps.setRate?.({ laneId: lane.laneId, fps })).catch((error) => {
      deps.logger.debug("mac_desktop.stream_set_rate_failed", {
        laneId: lane.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const scheduleIdleDrop = (lane: LaneStream): void => {
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      lane.idleTimer = null;
      if (lane.idle) return;
      lane.idle = true;
      applyRate(lane, lane.idleFps);
    }, MAC_DESKTOP_IDLE_STREAM_AFTER_MS);
    lane.idleTimer.unref?.();
  };

  const dropClient = (lane: LaneStream, client: LaneClient, reason: string): void => {
    if (!lane.clients.delete(client)) return;
    // Info, not debug: a reader coming and going is rare, and it is the one
    // fact that tells a stream nobody read from a stream whose reader left.
    deps.logger.info("mac_desktop.stream_client_dropped", {
      laneId: lane.laneId,
      reason,
      clients: lane.clients.size,
    });
    client.upstream.destroy();
    client.response.destroy();
    scheduleZeroClientStop(lane);
  };

  function scheduleZeroClientStop(lane: LaneStream): void {
    if (lane.clients.size > 0) return;
    if (lane.graceTimer) clearTimeout(lane.graceTimer);
    lane.graceTimer = setTimeout(() => {
      lane.graceTimer = null;
      if (lane.clients.size > 0) return;
      deps.onZeroClients?.(lane.laneId);
    }, ZERO_CLIENT_GRACE_MS);
    lane.graceTimer.unref?.();
  }

  const recordBytes = (lane: LaneStream, byteLength: number): void => {
    lane.bytesInWindow += byteLength;
    lane.lastBytesAtMs = now();
    const elapsedMs = now() - lane.windowStartedAtMs;
    if (elapsedMs < 1_000) return;
    lane.bitrateKbps = Math.round((lane.bytesInWindow * 8) / elapsedMs);
    lane.bytesInWindow = 0;
    lane.windowStartedAtMs = now();
  };

  /**
   * `POST /mac-desktop/input?lane=…&token=…` with a JSON body
   * `{controllerId, chatSessionId?, command, payload}`. Same token as the
   * stream, so only a viewer that was handed the lane's transport can drive it;
   * the lease check inside `postRealInput` decides whether that viewer may.
   */
  const handleInput = (request: IncomingMessage, response: ServerResponse, url: URL): void => {
    const laneId = url.searchParams.get("lane")?.trim() ?? "";
    const supplied = url.searchParams.get("token") ?? "";
    const lane = laneId ? lanes.get(laneId) ?? null : null;
    if (!lane || !lane.token || !supplied || !safeEqual(supplied, lane.token) || !deps.postRealInput) {
      response.writeHead(403).end();
      return;
    }
    request.socket.setNoDelay(true);
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BODY_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        response.writeHead(400).end();
        return;
      }
      const command = typeof body.command === "string" ? body.command : "";
      const controllerId = typeof body.controllerId === "string" ? body.controllerId.trim() : "";
      const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : null;
      if (!INPUT_COMMANDS.has(command) || !controllerId || !payload) {
        response.writeHead(400).end();
        return;
      }
      void deps.postRealInput!({
        laneId,
        controllerId,
        chatSessionId: typeof body.chatSessionId === "string" ? body.chatSessionId : null,
        command: command as MacDesktopRealInputCommand,
        payload,
      }).then(
        () => { response.writeHead(204).end(); },
        (error: unknown) => {
          const err = error as { code?: unknown; message?: unknown };
          response.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({
            code: typeof err?.code === "string" ? err.code : "MAC_DESKTOP_INPUT_FAILED",
            message: typeof err?.message === "string" ? err.message : String(error),
          }));
        },
      );
    });
  };

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (answerLoopbackPreamble(request, response)) return;
    if (url.pathname === MAC_DESKTOP_INPUT_PATH && request.method === "POST") {
      handleInput(request, response, url);
      return;
    }
    if (url.pathname !== MAC_DESKTOP_STREAM_PATH || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    const laneId = url.searchParams.get("lane")?.trim() ?? "";
    const supplied = url.searchParams.get("token") ?? "";
    const lane = laneId ? lanes.get(laneId) ?? null : null;
    // One answer for "no such lane" and "wrong token": a 404 that distinguishes
    // them tells a local prober which lane ids exist on this Mac.
    if (!lane || !lane.token || !supplied || !safeEqual(supplied, lane.token)) {
      response.writeHead(403).end();
      return;
    }

    let upstream: Socket;
    try {
      upstream = connectUpstream(lane.sourcePort);
    } catch (error) {
      lane.lastError = error instanceof Error ? error.message : String(error);
      response.writeHead(502).end();
      return;
    }

    openStreamBody(request, response);

    const client: LaneClient = { response, upstream, backlogBytes: 0 };
    lane.clients.add(client);
    deps.logger.info("mac_desktop.stream_client_attached", {
      laneId: lane.laneId,
      clients: lane.clients.size,
      afterMs: now() - lane.startedAtMs,
    });
    if (lane.graceTimer) {
      clearTimeout(lane.graceTimer);
      lane.graceTimer = null;
    }

    const splitter = createVideoRecordSplitter();
    let sentConfig: string | null = null;
    pipeWithBacklog(upstream, client, response, {
      onBytes: (byteLength) => recordBytes(lane, byteLength),
      onDrop: (reason) => dropClient(lane, client, reason),
      transform: (chunk) => {
        let records;
        try {
          records = splitter.push(chunk);
        } catch (error) {
          lane.lastError = error instanceof VideoRecordFramingError
            ? error.message
            : error instanceof Error ? error.message : String(error);
          dropClient(lane, client, "framing-error");
          return [];
        }
        const out: Uint8Array[] = [];
        for (const record of records) {
          if (record.type !== IOS_VIDEO_RECORD_TYPE_CONFIG) {
            out.push(record.raw);
            continue;
          }
          const config = normalizeConfigPayload(record.payload, lane);
          if (!config) continue;
          lane.codec = config.codec;
          lane.width = config.width;
          lane.height = config.height;
          const json = config.json.toString("utf8");
          // The renderer tears its decoder down and rebuilds it on every config
          // record, which costs a keyframe wait. The helper re-sends the same
          // one on attach and on transition, so only a change is worth sending.
          if (sentConfig === json) continue;
          sentConfig = json;
          out.push(encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_CONFIG, config.json));
        }
        return out;
      },
    });
    upstream.on("error", (error: Error) => {
      lane.lastError = error.message;
      dropClient(lane, client, "upstream-error");
    });
    upstream.on("close", () => dropClient(lane, client, "upstream-closed"));
    response.on("close", () => dropClient(lane, client, "client-closed"));
  };

  const ensureServer = async (): Promise<number> => {
    if (server && port) return port;
    const bound = await bindLoopbackServer(handleRequest, {
      bindErrorMessage: "The Mac Desktop video server could not bind a loopback port.",
    });
    server = bound.server;
    port = bound.port;
    deps.logger.info("mac_desktop.stream_server_listening", { port });
    return port;
  };

  const transportFor = (lane: LaneStream): MacDesktopStreamTransportWithSecret => ({
    url: `http://127.0.0.1:${port}${MAC_DESKTOP_STREAM_PATH}?lane=${encodeURIComponent(lane.laneId)}&token=${lane.token}`,
    port,
    token: lane.token,
    codec: lane.codec,
    width: lane.width,
    height: lane.height,
  });

  const metricsFor = (lane: LaneStream): MacDesktopStreamLaneMetrics => ({
    laneId: lane.laneId,
    running: true,
    clients: lane.clients.size,
    fps: lane.idle ? lane.idleFps : lane.activeFps,
    idleFps: lane.idleFps,
    idle: lane.idle,
    bitrateKbps: lane.bitrateKbps,
    lastError: lane.lastError,
    codec: lane.codec,
    width: lane.width,
    height: lane.height,
    port,
    startedAtMs: lane.startedAtMs,
    lastBytesAtMs: lane.lastBytesAtMs,
  });

  const stopLane = (laneId: string, reason: string): boolean => {
    const lane = lanes.get(laneId);
    if (!lane) return false;
    lanes.delete(laneId);
    if (lane.graceTimer) clearTimeout(lane.graceTimer);
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    for (const client of [...lane.clients]) {
      lane.clients.delete(client);
      client.upstream.destroy();
      client.response.destroy();
    }
    deps.logger.debug("mac_desktop.stream_lane_stopped", { laneId, reason });
    return true;
  };

  return {
    /**
     * Starts serving a lane and mints its token.
     *
     * A token is minted per *run*, not per call. It is the only thing between a
     * local process and the lane's screen, so one that escapes into a log or a
     * transcript stops working when the stream it belonged to ends — but
     * rotating it while the stream is still running would have made the second
     * viewer of a lane silently evict the first, whose URL carries the old
     * token. Starting a lane that is already serving therefore returns the
     * transport it is already serving on, unchanged; `stop` is the only thing
     * that ends a run.
     */
    async start(args: MacDesktopStreamStartArgs): Promise<MacDesktopStreamTransportWithSecret> {
      if (disposed) throw new Error("The Mac Desktop video server has been disposed.");
      await ensureServer();
      const existing = lanes.get(args.laneId);
      if (existing) return transportFor(existing);
      const lane: LaneStream = {
        laneId: args.laneId,
        token: randomBytes(32).toString("hex"),
        sourcePort: args.sourcePort,
        codec: args.codec ?? null,
        width: args.width ?? null,
        height: args.height ?? null,
        activeFps: clampFps(args.fps, MAC_DESKTOP_ACTIVE_FPS),
        idleFps: clampFps(args.idleFps, MAC_DESKTOP_IDLE_FPS),
        idle: false,
        clients: new Set(),
        bytesInWindow: 0,
        windowStartedAtMs: now(),
        bitrateKbps: null,
        lastError: null,
        startedAtMs: now(),
        lastBytesAtMs: null,
        graceTimer: null,
        idleTimer: null,
      };
      lanes.set(args.laneId, lane);
      scheduleIdleDrop(lane);
      return transportFor(lane);
    },

    /**
     * The transport a lane is currently served on, token included, or null.
     *
     * The service reads this instead of re-starting a running lane, which is
     * the same thing `start` now does — this is the read that says so.
     */
    getTransport(laneId: string): MacDesktopStreamTransportWithSecret | null {
      const lane = lanes.get(laneId);
      return lane ? transportFor(lane) : null;
    },

    /**
     * Something happened on this display — an agent action, a takeover, a key.
     * Returns to full rate now and schedules the drop back to idle.
     */
    noteActivity(laneId: string): void {
      const lane = lanes.get(laneId);
      if (!lane) return;
      if (lane.idle) {
        lane.idle = false;
        applyRate(lane, lane.activeFps);
      }
      scheduleIdleDrop(lane);
    },

    isStreaming(laneId: string): boolean {
      return lanes.has(laneId);
    },

    clientCount(laneId: string): number {
      return lanes.get(laneId)?.clients.size ?? 0;
    },

    totalClients(): number {
      let total = 0;
      for (const lane of lanes.values()) total += lane.clients.size;
      return total;
    },

    metrics(laneId: string): MacDesktopStreamLaneMetrics | null {
      const lane = lanes.get(laneId);
      return lane ? metricsFor(lane) : null;
    },

    recordError(laneId: string, message: string): void {
      const lane = lanes.get(laneId);
      if (lane) lane.lastError = message;
    },

    stop(laneId: string): boolean {
      return stopLane(laneId, "stopped");
    },

    port(): number {
      return port;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const laneId of [...lanes.keys()]) stopLane(laneId, "disposed");
      const running = server;
      server = null;
      port = 0;
      running?.close();
    },
  };
}

export type MacDesktopStreamServer = ReturnType<typeof createMacDesktopStreamServer>;
