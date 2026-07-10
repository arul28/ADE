import net from "node:net";
import { randomUUID } from "node:crypto";
import type { PairedRuntimePortForward } from "../../../shared/types/pairedRuntime";
import type { AuthenticatedSyncConnection } from "./syncRuntimeTransport";

const LOCAL_FORWARD_HOST = "127.0.0.1" as const;
const FORWARD_DATA_CHUNK_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const PEER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 25;

type ActiveSocket = {
  socket: net.Socket;
  forwardId: string;
  ownerSockets: Map<string, ActiveSocket>;
  outboundPending: Buffer[];
  outboundPendingBytes: number;
  outboundTimer: ReturnType<typeof setInterval> | null;
  remoteClosed: boolean;
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

function strictBase64Bytes(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  if (value === "") return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value)) {
    return null;
  }
  return Buffer.from(value, "base64");
}

export class SyncPortForwardClient {
  private readonly forwards = new Map<string, Promise<ForwardEntry>>();
  private readonly sockets = new Map<string, ActiveSocket>();
  private readonly removeEnvelopeListener: () => void;
  private readonly removeCloseListener: () => void;
  private readonly removeErrorListener: () => void;
  private disposed = false;

  constructor(
    private readonly connection: AuthenticatedSyncConnection,
    private readonly options: { createServer?: typeof net.createServer } = {},
  ) {
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
      const bytes = strictBase64Bytes(payload.data);
      if (!bytes) {
        this.closeActiveSocket(active, true, "Forward received invalid base64 data.");
        return;
      }
      if (!active.socket.write(bytes) || active.socket.writableLength > MAX_PENDING_BYTES) {
        if (active.socket.writableLength > MAX_PENDING_BYTES) {
          this.closeActiveSocket(active, true, "Forwarded data exceeded the local pending buffer limit.");
        }
      }
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
