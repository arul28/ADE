import { WebSocket, type RawData } from "ws";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  defaultRelayUrl,
  httpToWsUrl,
  signRelayHmacHex,
  type SyncCloudRelayStore,
} from "./syncCloudRelayStore";

type Logger = {
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  error?: (event: string, data?: Record<string, unknown>) => void;
  debug?: (event: string, data?: Record<string, unknown>) => void;
};

export type SyncTunnelClientStatus = {
  enabled: boolean;
  connected: boolean;
  activeTunnels: number;
  lastError: string | null;
  relayUrl: string;
  machineKey: string;
};

export type SyncTunnelClientService = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): SyncTunnelClientStatus;
  dispose(): Promise<void>;
};

type MachineIdentity = { machineKey: string; secret: string };

type SyncTunnelClientArgs = {
  logger?: Logger;
  /** Local ADE sync WebSocket server port, or null when the host isn't up. */
  getSyncPort: () => number | null;
  configStore: SyncCloudRelayStore;
  /** Overrides the identity from configStore (e.g. a shared machine store). */
  machineIdentity?: () => MachineIdentity | null;
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/**
 * Exponential backoff with full jitter, capped at 60s. Exposed for tests so the
 * reconnect schedule is verifiable without waiting on real timers.
 */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export type ControlMessage = { t: "open"; id: string } | { t: "pong" } | { t: "ping" };

/** Parses a host control frame; returns null for anything unrecognized. */
export function parseControlMessage(raw: string): ControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const t = (parsed as { t?: unknown }).t;
  if (t === "open") {
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" && /^[a-f0-9]{8,32}$/i.test(id) ? { t: "open", id } : null;
  }
  if (t === "pong") return { t: "pong" };
  if (t === "ping") return { t: "ping" };
  return null;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/**
 * Brain-side tunnel client. When enabled, keeps a signed control WebSocket open
 * to the relay; for each `{t:"open", id}` it opens a dedicated pipe socket to
 * the relay and a local socket to the sync server, then pipes bytes 1:1. The
 * sync protocol passes through untouched. The control socket reconnects with
 * jittered exponential backoff.
 */
export function createSyncTunnelClientService(args: SyncTunnelClientArgs): SyncTunnelClientService {
  const log = args.logger ?? {};
  let control: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let started = false;
  let stopped = false;
  let connected = false;
  let lastError: string | null = null;
  let claimed = false;
  const tunnels = new Set<Tunnel>();

  const identity = (): MachineIdentity => {
    const override = args.machineIdentity?.();
    return override ?? args.configStore.getMachineIdentity();
  };

  const relayHttpUrl = (): string => args.configStore.getRelayUrl() || defaultRelayUrl();

  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = computeBackoffMs(attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectControl();
    }, delay);
    reconnectTimer.unref?.();
  };

  const claimOnce = async (id: MachineIdentity): Promise<void> => {
    if (claimed) return;
    const url = `${relayHttpUrl().replace(/\/+$/, "")}/machines/${id.machineKey}/claim`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: id.secret }),
      signal: AbortSignal.timeout(CONNECT_DEADLINE_MS),
    });
    if (!response.ok) {
      throw new Error(`claim failed (${response.status})`);
    }
    claimed = true;
    log.info?.("sync_tunnel.claimed", { machineKey: id.machineKey });
  };

  const connectControl = async (): Promise<void> => {
    if (stopped || control) return;
    const id = identity();
    try {
      await claimOnce(id);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn?.("sync_tunnel.claim_failed", { error: lastError });
      scheduleReconnect();
      return;
    }

    const ts = nowSeconds();
    const sig = signRelayHmacHex(id.secret, buildHostSignatureBase(id.machineKey, ts));
    const wsBase = httpToWsUrl(relayHttpUrl());
    const url = `${wsBase}/host/${id.machineKey}?ts=${ts}&sig=${sig}`;
    const socket = new WebSocket(url);
    control = socket;
    armOpenDeadline(socket, () => {
      lastError = "relay control socket connect timed out";
    });

    socket.on("open", () => {
      attempt = 0;
      connected = true;
      lastError = null;
      log.info?.("sync_tunnel.control_open", { machineKey: id.machineKey });
    });
    socket.on("message", (raw: RawData) => {
      const message = parseControlMessage(rawToText(raw));
      if (message?.t === "open") void openTunnel(id, message.id);
    });
    socket.on("error", (error: Error) => {
      lastError = error.message;
      log.warn?.("sync_tunnel.control_error", { error: error.message });
    });
    socket.on("close", () => {
      connected = false;
      if (control === socket) control = null;
      if (!stopped) scheduleReconnect();
    });
  };

  const openTunnel = async (id: MachineIdentity, connectionId: string): Promise<void> => {
    const port = args.getSyncPort();
    if (port == null) {
      log.warn?.("sync_tunnel.no_sync_port", { connectionId });
      return;
    }
    const ts = nowSeconds();
    const sig = signRelayHmacHex(id.secret, buildPipeSignatureBase(id.machineKey, connectionId, ts));
    const pipeUrl = `${httpToWsUrl(relayHttpUrl())}/host/${id.machineKey}/pipe/${connectionId}?ts=${ts}&sig=${sig}`;

    const pipe = new WebSocket(pipeUrl);
    const local = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    armOpenDeadline(pipe, () => {
      lastError = "relay pipe connect timed out";
    });
    armOpenDeadline(local, () => {
      lastError = "local sync socket connect timed out";
    });
    const tunnel: Tunnel = { pipe, local, connectionId };
    tunnels.add(tunnel);

    const closeBoth = (): void => {
      if (!tunnels.delete(tunnel)) return;
      try {
        pipe.close();
      } catch {
        // ignore
      }
      try {
        local.close();
      } catch {
        // ignore
      }
      log.debug?.("sync_tunnel.closed", { connectionId });
    };

    // Byte-for-byte forwarding in both directions; the `isBinary` flag preserves
    // text-vs-binary framing so the sync protocol rides through unmodified.
    // The relay flushes the phone's buffered pre-pipe frames (its hello) the
    // instant this pipe opens — usually BEFORE the local socket to the sync
    // host has finished connecting — so each direction buffers until its
    // target opens rather than dropping those first frames.
    const forwardOrBuffer = makeBufferedForwarder(() => closeBoth());
    pipe.on("message", (data: RawData, isBinary: boolean) => forwardOrBuffer(local, data, isBinary));
    local.on("message", (data: RawData, isBinary: boolean) => forwardOrBuffer(pipe, data, isBinary));
    pipe.on("close", closeBoth);
    local.on("close", closeBoth);
    pipe.on("error", (error: Error) => {
      lastError = error.message;
      closeBoth();
    });
    local.on("error", (error: Error) => {
      lastError = error.message;
      closeBoth();
    });
    log.debug?.("sync_tunnel.open", { connectionId });
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;
      if (!args.configStore.isEnabled()) {
        log.info?.("sync_tunnel.disabled");
        return;
      }
      await connectControl();
    },

    async stop(): Promise<void> {
      stopped = true;
      started = false;
      clearReconnect();
      if (control) {
        try {
          control.close();
        } catch {
          // ignore
        }
        control = null;
      }
      for (const tunnel of [...tunnels]) {
        tunnels.delete(tunnel);
        try {
          tunnel.pipe.close();
        } catch {
          // ignore
        }
        try {
          tunnel.local.close();
        } catch {
          // ignore
        }
      }
      connected = false;
    },

    getStatus(): SyncTunnelClientStatus {
      const { machineKey } = identity();
      return {
        enabled: args.configStore.isEnabled(),
        connected,
        activeTunnels: tunnels.size,
        lastError,
        relayUrl: relayHttpUrl(),
        machineKey,
      };
    },

    async dispose(): Promise<void> {
      await this.stop();
    },
  };
}

type Tunnel = { pipe: WebSocket; local: WebSocket; connectionId: string };

function forward(target: WebSocket, data: RawData, isBinary: boolean): void {
  if (target.readyState !== WebSocket.OPEN) return;
  try {
    target.send(data, { binary: isBinary });
  } catch {
    // The target is mid-close; its close handler tears the pair down.
  }
}

/** Deadline for the claim POST and every socket to reach OPEN. */
export const CONNECT_DEADLINE_MS = 15_000;

const sharedTunnelClients = new Map<string, SyncTunnelClientService>();

/**
 * Machine-level singleton keyed by the relay config file path. Every project
 * scope in the multi-project daemon shares ONE tunnel client — a per-scope
 * instance would re-register the same machineKey with the relay on every
 * project open and churn the host connection paired phones dial through.
 */
export function getSharedSyncTunnelClientService(
  key: string,
  make: () => SyncTunnelClientService,
): SyncTunnelClientService {
  let existing = sharedTunnelClients.get(key);
  if (!existing) {
    existing = make();
    sharedTunnelClients.set(key, existing);
  }
  return existing;
}

/** Shutdown-path lookup: never mints a client just to stop it. */
export function peekSharedSyncTunnelClientService(key: string): SyncTunnelClientService | undefined {
  return sharedTunnelClients.get(key);
}

/**
 * Terminates a socket that has not opened within the deadline so a stalled
 * relay or dead local sync port surfaces as an error + reconnect instead of a
 * silently hung tunnel. No-op once the socket opens or closes first.
 */
function armOpenDeadline(socket: WebSocket, onTimeout: () => void): void {
  const timer = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      onTimeout();
      try {
        socket.terminate();
      } catch {
        // already dead
      }
    }
  }, CONNECT_DEADLINE_MS);
  timer.unref?.();
  const clear = () => clearTimeout(timer);
  socket.once("open", clear);
  socket.once("close", clear);
  socket.once("error", clear);
}

/** Frames buffered per still-connecting target before the pair is torn down. */
export const MAX_PENDING_TUNNEL_FRAMES = 64;

/**
 * Forwards frames to a target socket, buffering (bounded, in order) while the
 * target is still CONNECTING and flushing on `open`. A closed/closing target
 * or an overflowing buffer tears the pair down via `onOverflow` — dropping
 * frames mid-stream would corrupt the sync protocol.
 */
export function makeBufferedForwarder(onOverflow: () => void) {
  const pending = new Map<WebSocket, Array<{ data: RawData; isBinary: boolean }>>();
  return (target: WebSocket, data: RawData, isBinary: boolean): void => {
    if (target.readyState === WebSocket.OPEN) {
      forward(target, data, isBinary);
      return;
    }
    if (target.readyState !== WebSocket.CONNECTING) return;
    let queue = pending.get(target);
    if (!queue) {
      queue = [];
      pending.set(target, queue);
      target.once("open", () => {
        const frames = pending.get(target) ?? [];
        pending.delete(target);
        for (const frame of frames) forward(target, frame.data, frame.isBinary);
      });
    }
    if (queue.length >= MAX_PENDING_TUNNEL_FRAMES) {
      pending.delete(target);
      onOverflow();
      return;
    }
    queue.push({ data, isBinary });
  };
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}
