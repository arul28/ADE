import net from "node:net";
import { randomUUID } from "node:crypto";
import type { PairedRuntimePortForward } from "../../../shared/types/pairedRuntime";
import {
  BACKPRESSURE_POLL_MS,
  decodeStrictBase64,
  FORWARD_DATA_CHUNK_BYTES,
  PEER_BACKPRESSURE_BYTES,
} from "../sync/syncProtocol";
import type { AuthenticatedSyncConnection } from "./syncRuntimeTransport";

const LOCAL_FORWARD_HOST = "127.0.0.1" as const;
/** Local→remote queue ceiling. A healthy upload pauses the socket well before this. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
/**
 * Remote→local pause point. Past this the browser socket is full, so the peer
 * must stop sending until `drain`. A 49MB dev-server bundle crosses it; closing
 * here is what left the remote browser on a blank document.
 */
const DEFAULT_INBOUND_PAUSE_BYTES = 4 * 1024 * 1024;
/**
 * Bytes we will hold while paused for a peer that ignores `fwd_pause`.
 * A transfer that drains stays near the pause point; one that never drains
 * stops here instead of growing without bound.
 */
const DEFAULT_INBOUND_HARD_CAP_BYTES = 64 * 1024 * 1024;
/** A socket that stays paused this long is not a live browser. */
const DEFAULT_INBOUND_STALL_MS = 60_000;

type ActiveSocket = {
  socket: net.Socket;
  forwardId: string;
  ownerSockets: Map<string, ActiveSocket>;
  outboundPending: Buffer[];
  outboundPendingBytes: number;
  outboundTimer: ReturnType<typeof setInterval> | null;
  remoteClosed: boolean;
  /** Remote→local bytes held while the local socket is above the pause point. */
  inboundQueue: Buffer[];
  inboundQueueBytes: number;
  inboundPaused: boolean;
  inboundTimer: ReturnType<typeof setInterval> | null;
  inboundStallTimer: ReturnType<typeof setTimeout> | null;
  /** One `drain` listener at a time. The poll must not stack a new one per blocked write. */
  drainArmed: boolean;
};

type ForwardEntry = PairedRuntimePortForward & {
  server: net.Server;
  sockets: Map<string, ActiveSocket>;
};

function normalizeRemoteHost(value: string): "127.0.0.1" | "localhost" {
  const host = value.trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost") return host;
  throw new Error("Paired runtime forwards may target only 127.0.0.1 or localhost.");
}

function normalizeRemotePort(value: number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Remote port must be an integer from 1 to 65535 (received ${String(value)}).`);
  }
  return port;
}

function forwardKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function normalizePositive(value: number | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function snapshot(entry: ForwardEntry): PairedRuntimePortForward {
  return {
    remoteHost: entry.remoteHost,
    remotePort: entry.remotePort,
    localHost: entry.localHost,
    localPort: entry.localPort,
    localUrl: entry.localUrl,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

export class SyncPortForwardClient {
  private readonly forwards = new Map<string, Promise<ForwardEntry>>();
  private readonly sockets = new Map<string, ActiveSocket>();
  private readonly removeEnvelopeListener: () => void;
  private readonly removeCloseListener: () => void;
  private readonly removeErrorListener: () => void;
  private disposed = false;

  private readonly inboundPauseBytes: number;
  private readonly inboundHardCapBytes: number;
  private readonly inboundStallMs: number;

  constructor(
    private readonly connection: AuthenticatedSyncConnection,
    private readonly options: {
      createServer?: typeof net.createServer;
      /** Test seam. Production pauses at 4 MiB. */
      inboundPauseBytes?: number;
      /** Test seam. Production refuses to queue more than 64 MiB while paused. */
      inboundHardCapBytes?: number;
      /** Test seam. Production closes a forward that stays paused for 60s. */
      inboundStallMs?: number;
    } = {},
  ) {
    this.inboundPauseBytes = normalizePositive(options.inboundPauseBytes, DEFAULT_INBOUND_PAUSE_BYTES);
    this.inboundHardCapBytes = Math.max(
      this.inboundPauseBytes,
      normalizePositive(options.inboundHardCapBytes, DEFAULT_INBOUND_HARD_CAP_BYTES),
    );
    this.inboundStallMs = normalizePositive(options.inboundStallMs, DEFAULT_INBOUND_STALL_MS);
    if (connection.hello.features?.portForward !== true) {
      throw new Error("The paired machine does not advertise port-forward support.");
    }
    this.removeEnvelopeListener = connection.onEnvelope((envelope) => {
      if (envelope.type !== "fwd_data" && envelope.type !== "fwd_close") return;
      const payload = envelope.payload as {
        forwardId?: unknown;
        data?: unknown;
        reason?: unknown;
      };
      if (typeof payload.forwardId !== "string") return;
      const active = this.sockets.get(payload.forwardId);
      if (!active) return;
      if (envelope.type === "fwd_close") {
        active.remoteClosed = true;
        this.closeActiveSocket(active, false);
        return;
      }
      const bytes = decodeStrictBase64(payload.data);
      if (!bytes) {
        this.closeActiveSocket(active, true, "Forward received invalid base64 data.");
        return;
      }
      this.acceptInbound(active, bytes);
    });
    this.removeCloseListener = connection.onClose(() => this.dispose(false));
    this.removeErrorListener = connection.onError(() => this.dispose(false));
  }

  async ensureForward(
    remoteHostValue: string,
    remotePortValue: number,
  ): Promise<PairedRuntimePortForward> {
    if (this.disposed) throw new Error("Sync port-forward client is closed.");
    const remoteHost = normalizeRemoteHost(remoteHostValue);
    const remotePort = normalizeRemotePort(remotePortValue);
    const key = forwardKey(remoteHost, remotePort);
    const existing = this.forwards.get(key);
    if (existing) {
      const entry = await existing;
      entry.lastUsedAt = Date.now();
      return snapshot(entry);
    }

    const pending = this.createForward(remoteHost, remotePort);
    this.forwards.set(key, pending);
    try {
      const entry = await pending;
      entry.server.once("close", () => {
        if (this.forwards.get(key) === pending) this.forwards.delete(key);
      });
      return snapshot(entry);
    } catch (error) {
      if (this.forwards.get(key) === pending) this.forwards.delete(key);
      throw error;
    }
  }

  dispose(notifyRemote = true): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeEnvelopeListener();
    this.removeCloseListener();
    this.removeErrorListener();
    for (const active of [...this.sockets.values()]) {
      this.closeActiveSocket(active, notifyRemote, "Port-forward client closed.");
    }
    for (const pending of this.forwards.values()) {
      void pending.then((entry) => {
        try {
          entry.server.close();
        } catch {
          // Best-effort listener cleanup.
        }
      }).catch(() => {});
    }
    this.forwards.clear();
  }

  private async createForward(
    remoteHost: "127.0.0.1" | "localhost",
    remotePort: number,
  ): Promise<ForwardEntry> {
    const sockets = new Map<string, ActiveSocket>();
    const server = (this.options.createServer ?? net.createServer)((socket) => {
      if (this.disposed) {
        socket.destroy();
        return;
      }
      const forwardId = randomUUID();
      const active: ActiveSocket = {
        socket,
        forwardId,
        ownerSockets: sockets,
        outboundPending: [],
        outboundPendingBytes: 0,
        outboundTimer: null,
        remoteClosed: false,
        inboundQueue: [],
        inboundQueueBytes: 0,
        inboundPaused: false,
        inboundTimer: null,
        inboundStallTimer: null,
        drainArmed: false,
      };
      sockets.set(forwardId, active);
      this.sockets.set(forwardId, active);
      socket.on("data", (data) => this.sendLocalData(active, Buffer.from(data)));
      socket.once("error", () => this.closeActiveSocket(active, true, "Local forward socket failed."));
      socket.once("close", () => this.closeActiveSocket(active, !active.remoteClosed));
      try {
        this.connection.send("fwd_open", { forwardId, host: remoteHost, port: remotePort });
      } catch {
        this.closeActiveSocket(active, false);
      }
    });

    return await new Promise<ForwardEntry>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        try {
          server.close();
        } catch {
          // The listener may not have bound yet.
        }
        reject(error);
      };
      server.once("error", fail);
      server.listen(0, LOCAL_FORWARD_HOST, () => {
        if (settled) return;
        if (this.disposed) {
          fail(new Error("Sync port-forward client closed before the listener was ready."));
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") {
          fail(new Error("Local paired-runtime forward did not bind to a TCP port."));
          return;
        }
        settled = true;
        server.off("error", fail);
        server.on("error", () => {
          for (const active of [...sockets.values()]) {
            this.closeActiveSocket(active, true, "Local forward listener failed.");
          }
          try {
            server.close();
          } catch {
            // The listener may already be closed.
          }
        });
        const createdAt = Date.now();
        resolve({
          remoteHost,
          remotePort,
          localHost: LOCAL_FORWARD_HOST,
          localPort: address.port,
          localUrl: `http://${LOCAL_FORWARD_HOST}:${address.port}`,
          createdAt,
          lastUsedAt: createdAt,
          server,
          sockets,
        });
      });
    });
  }

  private acceptInbound(active: ActiveSocket, bytes: Buffer): void {
    if (!this.sockets.has(active.forwardId)) return;
    if (active.inboundPaused || active.inboundQueueBytes > 0) {
      this.enqueueInbound(active, bytes);
      return;
    }
    const accepted = active.socket.write(bytes);
    if (!accepted || active.socket.writableLength > this.inboundPauseBytes) {
      this.pauseInbound(active);
    }
  }

  private enqueueInbound(active: ActiveSocket, bytes: Buffer): void {
    if (active.inboundQueueBytes + bytes.byteLength > this.inboundHardCapBytes) {
      this.closeActiveSocket(active, true, "Forwarded data exceeded the local pending buffer limit.");
      return;
    }
    active.inboundQueue.push(bytes);
    active.inboundQueueBytes += bytes.byteLength;
  }

  /**
   * The local browser socket is full. Tell the paired machine to stop reading
   * its TCP socket, and hold only the bytes already in flight.
   */
  private pauseInbound(active: ActiveSocket): void {
    if (active.inboundPaused || !this.sockets.has(active.forwardId)) return;
    active.inboundPaused = true;
    try {
      this.connection.send("fwd_pause", { forwardId: active.forwardId });
    } catch {
      this.closeActiveSocket(active, false);
      return;
    }
    this.armInboundWatch(active);
  }

  private armInboundWatch(active: ActiveSocket): void {
    if (!active.inboundTimer) {
      active.inboundTimer = setInterval(() => this.flushInbound(active, false), BACKPRESSURE_POLL_MS);
      active.inboundTimer.unref?.();
    }
    this.armInboundStall(active);
    this.armInboundDrain(active);
  }

  private armInboundDrain(active: ActiveSocket): void {
    if (active.drainArmed) return;
    active.drainArmed = true;
    active.socket.once("drain", () => {
      active.drainArmed = false;
      this.flushInbound(active, true);
    });
  }

  private armInboundStall(active: ActiveSocket): void {
    if (active.inboundStallTimer) clearTimeout(active.inboundStallTimer);
    active.inboundStallTimer = setTimeout(() => {
      if (!this.sockets.has(active.forwardId) || !active.inboundPaused) return;
      this.closeActiveSocket(active, true, "Local forward socket did not drain in time.");
    }, this.inboundStallMs);
    active.inboundStallTimer.unref?.();
  }

  private flushInbound(active: ActiveSocket, fromDrain: boolean): void {
    if (!this.sockets.has(active.forwardId) || !active.inboundPaused) return;
    while (
      active.inboundQueue.length > 0
      && active.socket.writableLength <= this.inboundPauseBytes
    ) {
      const chunk = active.inboundQueue[0]!;
      const accepted = active.socket.write(chunk);
      active.inboundQueue.shift();
      active.inboundQueueBytes -= chunk.byteLength;
      if (!accepted || active.socket.writableLength > this.inboundPauseBytes) {
        this.armInboundStall(active);
        this.armInboundDrain(active);
        return;
      }
    }
    if (active.inboundQueue.length > 0 || active.socket.writableLength > this.inboundPauseBytes) {
      return;
    }
    // `write()` returned false around the socket high-water mark, long before
    // the pause ceiling. Resuming on the poll while bytes are still buffered
    // would ask the peer for another burst the browser has not read.
    if (!fromDrain && active.socket.writableLength > 0) return;
    this.resumeInbound(active);
  }

  private resumeInbound(active: ActiveSocket): void {
    if (!active.inboundPaused || !this.sockets.has(active.forwardId)) return;
    active.inboundPaused = false;
    this.clearInboundTimers(active);
    try {
      this.connection.send("fwd_resume", { forwardId: active.forwardId });
    } catch {
      this.closeActiveSocket(active, false);
    }
  }

  private clearInboundTimers(active: ActiveSocket): void {
    if (active.inboundTimer) clearInterval(active.inboundTimer);
    active.inboundTimer = null;
    if (active.inboundStallTimer) clearTimeout(active.inboundStallTimer);
    active.inboundStallTimer = null;
  }

  private sendLocalData(active: ActiveSocket, data: Buffer): void {
    for (let offset = 0; offset < data.byteLength; offset += FORWARD_DATA_CHUNK_BYTES) {
      const chunk = Buffer.from(data.subarray(
        offset,
        Math.min(data.byteLength, offset + FORWARD_DATA_CHUNK_BYTES),
      ));
      if (
        active.outboundPending.length > 0
        || this.connection.bufferedAmount() >= PEER_BACKPRESSURE_BYTES
      ) {
        if (active.outboundPendingBytes + chunk.byteLength > MAX_PENDING_BYTES) {
          this.closeActiveSocket(active, true, "Forwarded data exceeded the sync pending buffer limit.");
          return;
        }
        active.outboundPending.push(chunk);
        active.outboundPendingBytes += chunk.byteLength;
        active.socket.pause();
        this.scheduleOutboundFlush(active);
        continue;
      }
      try {
        this.connection.send("fwd_data", {
          forwardId: active.forwardId,
          data: chunk.toString("base64"),
        });
      } catch {
        this.closeActiveSocket(active, false);
        return;
      }
    }
  }

  private scheduleOutboundFlush(active: ActiveSocket): void {
    if (active.outboundTimer) return;
    active.outboundTimer = setInterval(() => {
      if (!this.sockets.has(active.forwardId)) {
        if (active.outboundTimer) clearInterval(active.outboundTimer);
        active.outboundTimer = null;
        return;
      }
      while (
        active.outboundPending.length > 0
        && this.connection.bufferedAmount() < PEER_BACKPRESSURE_BYTES
      ) {
        const chunk = active.outboundPending.shift()!;
        active.outboundPendingBytes -= chunk.byteLength;
        try {
          this.connection.send("fwd_data", {
            forwardId: active.forwardId,
            data: chunk.toString("base64"),
          });
        } catch {
          this.closeActiveSocket(active, false);
          return;
        }
      }
      if (active.outboundPending.length > 0) return;
      if (active.outboundTimer) clearInterval(active.outboundTimer);
      active.outboundTimer = null;
      active.socket.resume();
    }, BACKPRESSURE_POLL_MS);
    active.outboundTimer.unref?.();
  }

  private closeActiveSocket(
    active: ActiveSocket,
    notifyRemote: boolean,
    reason = "Local forward socket closed.",
  ): void {
    if (!this.sockets.delete(active.forwardId)) return;
    active.ownerSockets.delete(active.forwardId);
    if (active.outboundTimer) clearInterval(active.outboundTimer);
    active.outboundTimer = null;
    active.outboundPending = [];
    active.outboundPendingBytes = 0;
    this.clearInboundTimers(active);
    active.drainArmed = false;
    active.inboundQueue = [];
    active.inboundQueueBytes = 0;
    active.inboundPaused = false;
    if (notifyRemote) {
      try {
        this.connection.send("fwd_close", { forwardId: active.forwardId, reason });
      } catch {
        // The connection is already gone.
      }
    }
    try {
      active.socket.destroy();
    } catch {
      // Best-effort local socket teardown.
    }
  }
}

export function createSyncPortForwardClient(
  connection: AuthenticatedSyncConnection,
): SyncPortForwardClient {
  return new SyncPortForwardClient(connection);
}
