import net from "node:net";
import type {
  PairedRuntimeForwardClosePayload,
  PairedRuntimeForwardDataPayload,
  PairedRuntimeForwardOpenPayload,
  PairedRuntimeRpcClosePayload,
  PairedRuntimeRpcDataPayload,
  PairedRuntimeRpcOpenPayload,
  PairedRuntimeSyncEnvelope,
} from "../../../../desktop/src/shared/types/pairedRuntime";
import {
  startJsonRpcServer,
  type JsonRpcHandler,
  type JsonRpcTransport,
} from "../../jsonrpc";

const DEFAULT_PEER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_FORWARD_PENDING_BYTES = 4 * 1024 * 1024;
const DEFAULT_BACKPRESSURE_POLL_MS = 25;
const RPC_DATA_CHUNK_BYTES = 256 * 1024;
const FORWARD_DATA_CHUNK_BYTES = 64 * 1024;
const MAX_CHANNEL_ID_CHARS = 128;
const MAX_CLOSE_REASON_CHARS = 300;
// Per-peer resource caps. Each RPC channel spins a full JSON-RPC handler with
// its own (up to 64 MiB) line buffer, and each forward holds a live loopback
// socket fd, so an authenticated peer that opened unbounded channels could
// exhaust file descriptors / memory on the host. These ceilings are far above
// any legitimate desktop client's needs (one RPC channel + a handful of port
// forwards) while capping abuse.
const MAX_RPC_CHANNELS_PER_PEER = 32;
const MAX_FORWARDS_PER_PEER = 64;

export type SyncRuntimeRpcHandler = JsonRpcHandler & {
  dispose?: () => void;
  setNotifier?: (
    notify: ((method: string, params?: unknown) => void) | null,
  ) => void;
};

export type SyncRuntimeRpcHandlerFactory = () => SyncRuntimeRpcHandler;

let configuredRuntimeRpcHandlerFactory: SyncRuntimeRpcHandlerFactory | null = null;

/**
 * Installs the process-local `ade serve` multi-project handler factory. The
 * sync host consumes it lazily for each rpc_open, so every channel has the
 * same isolated request state as a unix/TCP/stdio runtime connection while
 * sharing the daemon's project/scope registries.
 */
export function setSyncRuntimeRpcHandlerFactory(
  factory: SyncRuntimeRpcHandlerFactory | null,
): () => void {
  const previous = configuredRuntimeRpcHandlerFactory;
  configuredRuntimeRpcHandlerFactory = factory;
  return () => {
    if (configuredRuntimeRpcHandlerFactory === factory) {
      configuredRuntimeRpcHandlerFactory = previous;
    }
  };
}

export function getSyncRuntimeRpcHandlerFactory(): SyncRuntimeRpcHandlerFactory | null {
  return configuredRuntimeRpcHandlerFactory;
}

export function isPairedRuntimeEnvelopeType(
  type: string,
): type is PairedRuntimeSyncEnvelope["type"] {
  return type === "rpc_open"
    || type === "rpc_data"
    || type === "rpc_close"
    || type === "fwd_open"
    || type === "fwd_data"
    || type === "fwd_close";
}

type LoggerLike = {
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

type RpcChannel = {
  handler: SyncRuntimeRpcHandler;
  stop: ReturnType<typeof startJsonRpcServer>;
  receive: (chunk: Buffer) => void;
};

type ForwardChannel = {
  socket: net.Socket;
  connected: boolean;
  inboundBeforeConnect: Buffer[];
  inboundBeforeConnectBytes: number;
  outboundPending: Buffer[];
  outboundPendingBytes: number;
  resumeTimer: ReturnType<typeof setInterval> | null;
};

type PeerChannels = {
  rpc: Map<string, RpcChannel>;
  forwards: Map<string, ForwardChannel>;
};

export type SyncPairedChannelServiceArgs<TPeer extends object> = {
  logger: LoggerLike;
  send: (
    peer: TPeer,
    type: PairedRuntimeSyncEnvelope["type"],
    payload:
      | PairedRuntimeRpcDataPayload
      | PairedRuntimeRpcClosePayload
      | PairedRuntimeForwardDataPayload
      | PairedRuntimeForwardClosePayload,
  ) => boolean;
  getBufferedAmount: (peer: TPeer) => number;
  createRpcHandler?: SyncRuntimeRpcHandlerFactory;
  peerBackpressureBytes?: number;
  forwardPendingBytes?: number;
  backpressurePollMs?: number;
  /** Test seam for an in-process TCP socket pair; production uses net.connect. */
  connectForward?: (options: net.NetConnectOpts) => net.Socket;
};

function normalizedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > MAX_CHANNEL_ID_CHARS) return null;
  return /^[a-zA-Z0-9._:-]+$/.test(id) ? id : null;
}

function closeReason(value: unknown, fallback: string): string {
  const reason = typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
  return reason.slice(0, MAX_CLOSE_REASON_CHARS);
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function allowedForwardHost(value: unknown): "127.0.0.1" | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" ? "127.0.0.1" : null;
}

function allowedForwardPort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function createSyncPairedChannelService<TPeer extends object>(
  args: SyncPairedChannelServiceArgs<TPeer>,
) {
  const peerBackpressureBytes = Math.max(
    1,
    Math.floor(args.peerBackpressureBytes ?? DEFAULT_PEER_BACKPRESSURE_BYTES),
  );
  const forwardPendingBytes = Math.max(
    1,
    Math.floor(args.forwardPendingBytes ?? DEFAULT_FORWARD_PENDING_BYTES),
  );
  const backpressurePollMs = Math.max(
    1,
    Math.floor(args.backpressurePollMs ?? DEFAULT_BACKPRESSURE_POLL_MS),
  );
  const peers = new Map<TPeer, PeerChannels>();

  const channelsFor = (peer: TPeer): PeerChannels => {
    const existing = peers.get(peer);
    if (existing) return existing;
    const created: PeerChannels = { rpc: new Map(), forwards: new Map() };
    peers.set(peer, created);
    return created;
  };

  const dropEmptyPeer = (peer: TPeer): void => {
    const channels = peers.get(peer);
    if (channels && channels.rpc.size === 0 && channels.forwards.size === 0) {
      peers.delete(peer);
    }
  };

  const sendRpcClose = (peer: TPeer, channelId: string, reason: string): void => {
    args.send(peer, "rpc_close", { channelId, reason });
  };

  const sendForwardClose = (peer: TPeer, forwardId: string, reason: string): void => {
    args.send(peer, "fwd_close", { forwardId, reason });
  };

  const closeRpc = (
    peer: TPeer,
    channelId: string,
    reason: string,
    notify: boolean,
  ): void => {
    const channels = peers.get(peer);
    const channel = channels?.rpc.get(channelId);
    if (!channels || !channel) return;
    channels.rpc.delete(channelId);
    try {
      channel.stop();
    } catch {
      // Best-effort teardown; the handler is disposed independently below.
    }
    try {
      channel.handler.dispose?.();
    } catch (error) {
      args.logger.warn("sync_paired.rpc_handler_dispose_failed", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (notify) sendRpcClose(peer, channelId, closeReason(reason, "RPC channel closed."));
    dropEmptyPeer(peer);
  };

  const closeForward = (
    peer: TPeer,
    forwardId: string,
    reason: string,
    notify: boolean,
  ): void => {
    const channels = peers.get(peer);
    const forward = channels?.forwards.get(forwardId);
    if (!channels || !forward) return;
    channels.forwards.delete(forwardId);
    if (forward.resumeTimer) clearInterval(forward.resumeTimer);
    forward.resumeTimer = null;
    try {
      forward.socket.destroy();
    } catch {
      // ignore socket teardown failures
    }
    if (notify) {
      sendForwardClose(
        peer,
        forwardId,
        closeReason(reason, "Remote TCP connection closed."),
      );
    }
    dropEmptyPeer(peer);
  };

  const closePeerForwards = (
    peer: TPeer,
    reason: string,
    notify: boolean,
  ): void => {
    const channels = peers.get(peer);
    if (!channels) return;
    for (const forwardId of [...channels.forwards.keys()]) {
      closeForward(peer, forwardId, reason, notify);
    }
  };

  const sendForwardChunk = (
    peer: TPeer,
    forwardId: string,
    chunk: Buffer,
  ): boolean => args.send(peer, "fwd_data", {
    forwardId,
    data: chunk.toString("base64"),
  });

  const flushForwardOutbound = (peer: TPeer, forwardId: string): void => {
    const forward = peers.get(peer)?.forwards.get(forwardId);
    if (!forward) return;
    while (
      forward.outboundPending.length > 0
      && args.getBufferedAmount(peer) < peerBackpressureBytes
    ) {
      const chunk = forward.outboundPending.shift()!;
      forward.outboundPendingBytes -= chunk.byteLength;
      if (!sendForwardChunk(peer, forwardId, chunk)) {
        closeForward(peer, forwardId, "Sync connection could not accept forwarded data.", true);
        return;
      }
    }
    if (forward.outboundPending.length > 0) return;
    if (forward.resumeTimer) clearInterval(forward.resumeTimer);
    forward.resumeTimer = null;
    forward.socket.resume();
  };

  const scheduleForwardResume = (peer: TPeer, forwardId: string): void => {
    const forward = peers.get(peer)?.forwards.get(forwardId);
    if (!forward || forward.resumeTimer) return;
    forward.resumeTimer = setInterval(
      () => flushForwardOutbound(peer, forwardId),
      backpressurePollMs,
    );
    forward.resumeTimer.unref?.();
  };

  const queueForwardOutbound = (
    peer: TPeer,
    forwardId: string,
    chunk: Buffer,
  ): boolean => {
    const forward = peers.get(peer)?.forwards.get(forwardId);
    if (!forward) return false;
    if (forward.outboundPendingBytes + chunk.byteLength > forwardPendingBytes) {
      closeForward(peer, forwardId, "Forwarded data exceeded the pending buffer limit.", true);
      return false;
    }
    forward.outboundPending.push(Buffer.from(chunk));
    forward.outboundPendingBytes += chunk.byteLength;
    forward.socket.pause();
    scheduleForwardResume(peer, forwardId);
    return true;
  };

  const handleForwardSocketData = (
    peer: TPeer,
    forwardId: string,
    data: Buffer,
  ): void => {
    for (let offset = 0; offset < data.byteLength; offset += FORWARD_DATA_CHUNK_BYTES) {
      const chunk = data.subarray(
        offset,
        Math.min(data.byteLength, offset + FORWARD_DATA_CHUNK_BYTES),
      );
      const forward = peers.get(peer)?.forwards.get(forwardId);
      if (!forward) return;
      if (
        forward.outboundPending.length > 0
        || args.getBufferedAmount(peer) >= peerBackpressureBytes
      ) {
        if (!queueForwardOutbound(peer, forwardId, chunk)) return;
        continue;
      }
      if (!sendForwardChunk(peer, forwardId, chunk)) {
        closeForward(peer, forwardId, "Sync connection could not accept forwarded data.", true);
        return;
      }
    }
  };

  const openRpc = (peer: TPeer, payload: PairedRuntimeRpcOpenPayload): void => {
    const channelId = normalizedId(payload.channelId);
    if (!channelId) return;
    const existingRpc = peers.get(peer)?.rpc;
    if (
      existingRpc
      && !existingRpc.has(channelId)
      && existingRpc.size >= MAX_RPC_CHANNELS_PER_PEER
    ) {
      sendRpcClose(peer, channelId, "Too many open runtime channels.");
      return;
    }
    const factory = args.createRpcHandler ?? getSyncRuntimeRpcHandlerFactory();
    if (!factory) {
      sendRpcClose(peer, channelId, "Runtime RPC channel is unavailable.");
      return;
    }
    closeRpc(peer, channelId, "RPC channel replaced.", true);

    let receive: ((chunk: Buffer) => void) | null = null;
    const transport: JsonRpcTransport = {
      onData(callback) {
        receive = callback;
      },
      write(data) {
        const bytes = Buffer.from(data, "utf8");
        for (let offset = 0; offset < bytes.byteLength; offset += RPC_DATA_CHUNK_BYTES) {
          const chunk = bytes.subarray(
            offset,
            Math.min(bytes.byteLength, offset + RPC_DATA_CHUNK_BYTES),
          );
          if (!args.send(peer, "rpc_data", {
            channelId,
            data: chunk.toString("base64"),
          })) {
            closeRpc(peer, channelId, "Sync connection could not accept RPC data.", true);
            closePeerForwards(peer, "Runtime RPC delivery failed.", true);
            return;
          }
        }
      },
      close() {
        const wasOpen = peers.get(peer)?.rpc.has(channelId) === true;
        closeRpc(peer, channelId, "RPC transport closed.", true);
        if (wasOpen) {
          closePeerForwards(peer, "RPC transport closed.", true);
        }
      },
    };

    let handler: SyncRuntimeRpcHandler;
    try {
      handler = factory();
    } catch (error) {
      sendRpcClose(
        peer,
        channelId,
        closeReason(
          error instanceof Error ? error.message : String(error),
          "Runtime RPC channel is unavailable.",
        ),
      );
      return;
    }
    const stop = startJsonRpcServer(handler, transport, {
      nonFatal: true,
      onError: (error, context) => {
        args.logger.warn("sync_paired.rpc_dispatch_failed", {
          channelId,
          context,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    handler.setNotifier?.((method, params) => stop.notify(method, params));
    if (!receive) {
      try {
        stop();
      } catch {}
      try {
        handler.dispose?.();
      } catch {}
      sendRpcClose(peer, channelId, "Runtime RPC transport did not initialize.");
      return;
    }
    channelsFor(peer).rpc.set(channelId, { handler, stop, receive });
  };

  const openForward = (
    peer: TPeer,
    payload: PairedRuntimeForwardOpenPayload,
  ): void => {
    const forwardId = normalizedId(payload.forwardId);
    if (!forwardId) return;
    const existingForwards = peers.get(peer)?.forwards;
    if (
      existingForwards
      && !existingForwards.has(forwardId)
      && existingForwards.size >= MAX_FORWARDS_PER_PEER
    ) {
      sendForwardClose(peer, forwardId, "Too many open port forwards.");
      return;
    }
    const host = allowedForwardHost(payload.host);
    const port = allowedForwardPort(payload.port);
    if (!host || port == null) {
      sendForwardClose(
        peer,
        forwardId,
        !host
          ? "Port forwards may connect only to 127.0.0.1 or localhost."
          : "Forward port must be an integer from 1 to 65535.",
      );
      return;
    }
    closeForward(peer, forwardId, "Forward replaced.", true);
    const socket = args.connectForward?.({ host, port }) ?? net.connect({ host, port });
    const forward: ForwardChannel = {
      socket,
      connected: false,
      inboundBeforeConnect: [],
      inboundBeforeConnectBytes: 0,
      outboundPending: [],
      outboundPendingBytes: 0,
      resumeTimer: null,
    };
    channelsFor(peer).forwards.set(forwardId, forward);

    socket.once("connect", () => {
      const current = peers.get(peer)?.forwards.get(forwardId);
      if (current !== forward) return;
      forward.connected = true;
      for (const chunk of forward.inboundBeforeConnect) {
        socket.write(chunk);
      }
      forward.inboundBeforeConnect = [];
      forward.inboundBeforeConnectBytes = 0;
      if (socket.writableLength > forwardPendingBytes) {
        closeForward(peer, forwardId, "Forwarded data exceeded the pending buffer limit.", true);
      }
    });
    socket.on("data", (chunk) => handleForwardSocketData(peer, forwardId, Buffer.from(chunk)));
    socket.once("error", (error) => {
      closeForward(peer, forwardId, error.message || "Remote TCP connection failed.", true);
    });
    socket.once("close", () => {
      closeForward(peer, forwardId, "Remote TCP connection closed.", true);
    });
  };

  const writeForward = (
    peer: TPeer,
    forwardId: string,
    bytes: Buffer,
  ): void => {
    const forward = peers.get(peer)?.forwards.get(forwardId);
    if (!forward) {
      sendForwardClose(peer, forwardId, "Forward is not open.");
      return;
    }
    if (!forward.connected) {
      if (forward.inboundBeforeConnectBytes + bytes.byteLength > forwardPendingBytes) {
        closeForward(peer, forwardId, "Forwarded data exceeded the pending buffer limit.", true);
        return;
      }
      forward.inboundBeforeConnect.push(Buffer.from(bytes));
      forward.inboundBeforeConnectBytes += bytes.byteLength;
      return;
    }
    forward.socket.write(bytes);
    if (forward.socket.writableLength > forwardPendingBytes) {
      closeForward(peer, forwardId, "Forwarded data exceeded the pending buffer limit.", true);
    }
  };

  const closePeer = (
    peer: TPeer,
    reason = "Sync connection closed.",
    notify = false,
  ): void => {
    const channels = peers.get(peer);
    if (!channels) return;
    for (const channelId of [...channels.rpc.keys()]) {
      closeRpc(peer, channelId, reason, notify);
    }
    closePeerForwards(peer, reason, notify);
    peers.delete(peer);
  };

  return {
    async handleEnvelope(
      peer: TPeer,
      type: PairedRuntimeSyncEnvelope["type"],
      payload: unknown,
      authenticatedWithPairing: boolean,
      // Whether the paired peer is a desktop runtime-host. The full runtime
      // JSON-RPC registry (~44 domains) and loopback port-forwarding are far
      // beyond the mobile command allowlist, so they are gated to desktop
      // clients even after successful pairing. Defaults to false so callers
      // must opt in explicitly.
      authorizedForRuntimeHost = false,
    ): Promise<boolean> {
      const value = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const idKey = type.startsWith("rpc_") ? "channelId" : "forwardId";
      const id = normalizedId(value[idKey]);
      if (!id) return true;
      if (!authenticatedWithPairing) {
        if (type.startsWith("rpc_")) {
          sendRpcClose(peer, id, "Paired device authentication is required.");
        } else {
          sendForwardClose(peer, id, "Paired device authentication is required.");
        }
        return true;
      }
      if (!authorizedForRuntimeHost) {
        if (type.startsWith("rpc_")) {
          sendRpcClose(peer, id, "Runtime channel is only available to desktop clients.");
        } else {
          sendForwardClose(peer, id, "Runtime channel is only available to desktop clients.");
        }
        return true;
      }

      switch (type) {
        case "rpc_open":
          openRpc(peer, { channelId: id });
          break;
        case "rpc_data": {
          const bytes = decodeBase64(value.data);
          const channel = peers.get(peer)?.rpc.get(id);
          if (!bytes || !channel) {
            if (!channel) sendRpcClose(peer, id, "RPC channel is not open.");
            else {
              closeRpc(peer, id, "RPC data was not valid base64.", true);
              closePeerForwards(peer, "RPC data was not valid base64.", true);
            }
            break;
          }
          channel.receive(bytes);
          break;
        }
        case "rpc_close":
          closeRpc(peer, id, closeReason(value.reason, "RPC channel closed by peer."), false);
          closePeerForwards(peer, "RPC channel closed by peer.", true);
          break;
        case "fwd_open":
          openForward(peer, {
            forwardId: id,
            host: typeof value.host === "string" ? value.host : "",
            port: Number(value.port),
          });
          break;
        case "fwd_data": {
          const bytes = decodeBase64(value.data);
          if (!bytes) {
            closeForward(peer, id, "Forward data was not valid base64.", true);
            break;
          }
          writeForward(peer, id, bytes);
          break;
        }
        case "fwd_close":
          closeForward(peer, id, closeReason(value.reason, "Forward closed by peer."), false);
          break;
      }
      return true;
    },

    closePeer,

    dispose(reason = "Sync host stopped."): void {
      for (const peer of [...peers.keys()]) {
        closePeer(peer, reason, false);
      }
    },
  };
}

export type SyncPairedChannelService<TPeer extends object> = ReturnType<
  typeof createSyncPairedChannelService<TPeer>
>;
