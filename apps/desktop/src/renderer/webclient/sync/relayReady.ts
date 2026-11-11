import type { SyncRelayClientAccepted, SyncRelayClientReady } from "../../../shared/types/sync";
import { SYNC_RELAY_READY_VERSION } from "../../../shared/types/sync";
import { randomHex } from "./ids";

/**
 * ADE Relay's socket handshake, for every browser-side client that dials
 * `wss://<relay>/connect/<machineKey>`: the paired sync connection
 * (`connection.ts`) and the lane share guest connection. `ready=2` asks the
 * relay to confirm the host side before any ADE data is sent; the relay then
 * sends an `accepted` frame and a `ready` frame, which are not ADE envelopes.
 */

/** How long a socket that asked for `ready=2` waits for the relay's first frame. */
export const RELAY_READY_NEGOTIATION_WINDOW_MS = 750;

export function withRelayReadyNegotiation(endpoint: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("ready", String(SYNC_RELAY_READY_VERSION));
  return url.toString();
}

export function browserConnectionCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const raw = randomHex(16).toLowerCase();
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

export function withRelayCorrelationId(endpoint: string, correlationId: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("cid", correlationId);
  return url.toString();
}

export function relayTransportFrame(data: unknown): SyncRelayClientAccepted | SyncRelayClientReady | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.v !== SYNC_RELAY_READY_VERSION) return null;
    if (parsed.t === "accepted") return { t: "accepted", v: SYNC_RELAY_READY_VERSION };
    if (parsed.t === "ready") return { t: "ready", v: SYNC_RELAY_READY_VERSION };
  } catch {
    // ADE envelopes and binary frames are handled by the normal decoder.
  }
  return null;
}
