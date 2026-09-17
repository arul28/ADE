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

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";

import type { Logger } from "../logging/logger";
import {
  MAC_DESKTOP_ACTIVE_FPS,
  MAC_DESKTOP_IDLE_FPS,
  MAC_DESKTOP_IDLE_STREAM_AFTER_MS,
  MAC_DESKTOP_STREAM_PATH,
} from "../../../shared/types/macDesktop";

/** A reader this far behind will not catch up; close it and let it reconnect. */
const MAX_CLIENT_BACKLOG_BYTES = 4 * 1024 * 1024;

/**
 * How long the encoder stays warm after the last reader leaves.
 *
 * A page reload drops and re-adds a client inside a few hundred milliseconds;
 * tearing the encoder down for that costs a restart and a fresh keyframe for
 * nothing.
 */
const ZERO_CLIENT_GRACE_MS = 3_000;

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
};

type LaneClient = {
  response: ServerResponse;
  upstream: Socket;
  backlogBytes: number;
};

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
  graceTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is constant length whatever the caller sends.
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

const clampFps = (value: number | null | undefined, fallback: number): number => {
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
    deps.logger.debug("mac_desktop.stream_client_dropped", {
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
    const elapsedMs = now() - lane.windowStartedAtMs;
    if (elapsedMs < 1_000) return;
    lane.bitrateKbps = Math.round((lane.bytesInWindow * 8) / elapsedMs);
    lane.bytesInWindow = 0;
    lane.windowStartedAtMs = now();
  };

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // The renderer's origin is opaque (`app:`/`file:`), so a same-origin check
    // would reject the only legitimate caller. The token is the authorisation.
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");

    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Headers": "*" });
      response.end();
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

    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      Connection: "keep-alive",
    });
    // Nagle trades latency for a saving this bitrate does not need.
    request.socket.setNoDelay(true);
    // Node holds the head until the first body write, and the first body write
    // waits on the helper's first keyframe. Without this a reader cannot tell a
    // slow encoder start from a dead server.
    response.flushHeaders();

    const client: LaneClient = { response, upstream, backlogBytes: 0 };
    lane.clients.add(client);
    if (lane.graceTimer) {
      clearTimeout(lane.graceTimer);
      lane.graceTimer = null;
    }

    upstream.setNoDelay?.(true);
    upstream.on("data", (chunk: Buffer) => {
      recordBytes(lane, chunk.byteLength);
      client.backlogBytes += chunk.byteLength;
      if (client.backlogBytes > MAX_CLIENT_BACKLOG_BYTES) {
        dropClient(lane, client, "backlog");
        return;
      }
      let released = false;
      client.response.write(chunk, () => {
        if (released) return;
        released = true;
        client.backlogBytes = Math.max(0, client.backlogBytes - chunk.byteLength);
      });
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
      throw new Error("The Mac Desktop video server could not bind a loopback port.");
    }
    server = next;
    port = address.port;
    deps.logger.info("mac_desktop.stream_server_listening", { port });
    return port;
  };

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
     * The token is rotated per start on purpose: it is the only thing between a
     * local process and the lane's screen, so one that escapes into a log or a
     * transcript stops working when the stream it belonged to ends.
     */
    async start(args: MacDesktopStreamStartArgs): Promise<MacDesktopStreamTransportWithSecret> {
      if (disposed) throw new Error("The Mac Desktop video server has been disposed.");
      const bound = await ensureServer();
      const existing = lanes.get(args.laneId);
      if (existing) stopLane(args.laneId, "restarted");
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
        graceTimer: null,
        idleTimer: null,
      };
      lanes.set(args.laneId, lane);
      scheduleIdleDrop(lane);
      return {
        url: `http://127.0.0.1:${bound}${MAC_DESKTOP_STREAM_PATH}?lane=${encodeURIComponent(args.laneId)}&token=${lane.token}`,
        port: bound,
        token: lane.token,
        codec: lane.codec,
        width: lane.width,
        height: lane.height,
      };
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
