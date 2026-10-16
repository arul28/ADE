import { WebSocket, type RawData } from "ws";
import { isRecord } from "../shared/utils";

/**
 * A wake-up WebSocket to the ADE relay. The relay sends a small frame when new
 * events are waiting; the caller then polls the relay's event list. Frames are
 * hints only, so a missed or malformed frame costs nothing but latency.
 */

export type RelayWakeTarget = { url: string; headers: Record<string, string> };

export type RelayWakeSocket = {
  connected: () => boolean;
  stop: () => void;
};

const CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** After the relay refuses the caller (401/403), retry rarely: access seldom changes on its own. */
const REFUSED_RETRY_MS = 10 * 60_000;

/** Full-jitter exponential backoff for relay reconnects. */
export function computeRelayReconnectBackoffMs(
  attempt: number,
  limits: { baseMs: number; capMs: number } = { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(limits.capMs, limits.baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export function rawDataToText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

export function createRelayWakeSocket(args: {
  /** Null when there is nothing to subscribe to yet; the socket asks again later. */
  resolveTarget: () => Promise<RelayWakeTarget | null>;
  /** The frame `t` value that means "new events are waiting". */
  frameType: string;
  onWake: () => void;
  onConnectedChange: (connected: boolean) => void;
  onConnecting?: () => void;
}): RelayWakeSocket {
  let socket: WebSocket | null = null;
  let isConnected = false;
  let halted = false;
  let attempt = 0;
  let refused = false;
  let retryTimer: NodeJS.Timeout | null = null;

  const scheduleRetry = (): void => {
    if (halted || retryTimer) return;
    const delay = refused ? REFUSED_RETRY_MS : computeRelayReconnectBackoffMs(attempt);
    refused = false;
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
    retryTimer.unref?.();
  };

  const connect = async (): Promise<void> => {
    if (halted || socket) return;
    const target = await args.resolveTarget().catch(() => null);
    if (halted || socket) return;
    if (!target) {
      scheduleRetry();
      return;
    }
    let next: WebSocket;
    try {
      next = new WebSocket(target.url, { headers: target.headers });
    } catch {
      scheduleRetry();
      return;
    }
    socket = next;
    args.onConnecting?.();
    const connectTimer = setTimeout(() => {
      if (socket === next && next.readyState === WebSocket.CONNECTING) next.terminate();
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();
    next.on("unexpected-response", (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) refused = true;
      next.terminate();
    });
    next.on("open", () => {
      if (socket !== next) return;
      clearTimeout(connectTimer);
      attempt = 0;
      isConnected = true;
      args.onConnectedChange(true);
    });
    next.on("message", (raw: RawData) => {
      if (socket !== next) return;
      try {
        const frame = JSON.parse(rawDataToText(raw)) as unknown;
        if (isRecord(frame) && frame.t === args.frameType) args.onWake();
      } catch {
        // Frames are hints; ignore anything unexpected.
      }
    });
    next.on("error", () => {
      // `close` owns reconnects.
    });
    next.on("close", () => {
      clearTimeout(connectTimer);
      if (socket !== next) return;
      socket = null;
      const wasConnected = isConnected;
      isConnected = false;
      if (wasConnected) args.onConnectedChange(false);
      scheduleRetry();
    });
  };

  void connect();
  return {
    connected: () => isConnected,
    stop: () => {
      halted = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const current = socket;
      socket = null;
      isConnected = false;
      try {
        current?.close();
      } catch {
        // Already closing.
      }
    },
  };
}
