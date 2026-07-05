import { TunnelDurableObject } from "./tunnelDo";

export type TunnelRelayEnv = {
  /** Durable Object namespace; one instance per machineKey via idFromName. */
  TUNNEL: DurableObjectNamespace;
  /** Optional override for the max concurrent tunnels per machine. */
  MAX_TUNNELS_PER_MACHINE?: string;
};

export { TunnelDurableObject };

// A machineKey is an unguessable per-machine identifier the brain generates and
// claims; phones learn it out-of-band (QR). 32-64 hex keeps it copy-paste safe.
export const MACHINE_KEY_PATTERN = /^[a-f0-9]{32,64}$/i;
// Connection ids are minted by the relay, never trusted from a peer; keep them
// short and hex so they round-trip cleanly through the signed pipe path.
export const CONNECTION_ID_PATTERN = /^[a-f0-9]{8,32}$/i;
export const SIGNATURE_TIMESTAMP_SKEW_SECONDS = 5 * 60;
export const DEFAULT_MAX_TUNNELS_PER_MACHINE = 16;

const encoder = new TextEncoder();

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Canonical strings every signed WebSocket upgrade commits to. Binding the
 * role, machineKey (and connection id, for pipes) plus a timestamp stops a
 * captured signature from being replayed against a different role/id or after
 * the skew window closes. Identical shape to apps/push-relay's HMAC design.
 */
export function buildHostSignatureBase(machineKey: string, timestamp: string): string {
  return `host:${machineKey}:${timestamp}`;
}

export function buildPipeSignatureBase(machineKey: string, id: string, timestamp: string): string {
  return `pipe:${machineKey}:${id}:${timestamp}`;
}

export function parseTimestampSeconds(raw: string): number | null {
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length === 13 ? Math.floor(numeric / 1000) : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export type SignedQueryResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies a signed WebSocket upgrade: timestamp within skew and the hex HMAC
 * of `base` under `secret` matching `sig`. Pure so it can be unit tested
 * without a live Durable Object.
 */
export async function verifySignedQuery(args: {
  secret: string;
  base: string;
  timestamp: string;
  signature: string;
  nowSeconds?: number;
  skewSeconds?: number;
}): Promise<SignedQueryResult> {
  const { secret, base, timestamp, signature } = args;
  if (!timestamp || !signature) return { ok: false, reason: "missing ts or sig" };
  const timestampSeconds = parseTimestampSeconds(timestamp);
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = args.skewSeconds ?? SIGNATURE_TIMESTAMP_SKEW_SECONDS;
  if (timestampSeconds == null || Math.abs(nowSeconds - timestampSeconds) > skew) {
    return { ok: false, reason: "stale or invalid timestamp" };
  }
  const expected = await hmacSha256Hex(secret, base);
  if (!constantTimeEqual(expected, signature)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

/** 16 hex chars of CSPRNG output — unguessable and matches CONNECTION_ID_PATTERN. */
export function generateConnectionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)).buffer);
}

export type TunnelRoute =
  | { kind: "claim"; machineKey: string }
  | { kind: "host"; machineKey: string }
  | { kind: "pipe"; machineKey: string; id: string }
  | { kind: "connect"; machineKey: string };

/**
 * Pure path router. Returns the matched tunnel route or null; the machineKey
 * pattern is enforced here so an invalid key never reaches a Durable Object.
 */
export function routeTunnelPath(pathname: string): TunnelRoute | null {
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    // Malformed percent-encoding (e.g. "/host/%") — fail closed to a 404.
    return null;
  }
  if (parts.length === 3 && parts[0] === "machines" && parts[2] === "claim") {
    return validKey(parts[1]) ? { kind: "claim", machineKey: parts[1] } : null;
  }
  if (parts.length === 2 && parts[0] === "host") {
    return validKey(parts[1]) ? { kind: "host", machineKey: parts[1] } : null;
  }
  if (parts.length === 4 && parts[0] === "host" && parts[2] === "pipe") {
    return validKey(parts[1]) && CONNECTION_ID_PATTERN.test(parts[3])
      ? { kind: "pipe", machineKey: parts[1], id: parts[3] }
      : null;
  }
  if (parts.length === 2 && parts[0] === "connect") {
    return validKey(parts[1]) ? { kind: "connect", machineKey: parts[1] } : null;
  }
  return null;
}

function validKey(value: string | undefined): value is string {
  return typeof value === "string" && MACHINE_KEY_PATTERN.test(value);
}

export async function handleRequest(request: Request, env: TunnelRelayEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "ade-tunnel-relay" });
  }

  const route = routeTunnelPath(url.pathname);
  if (!route) return textResponse("not found", 404);

  // Every route is scoped to a single machine → a single Durable Object
  // instance. The DO owns the claim secret, signature verification, and the
  // per-connection socket pairing; the worker is a thin, stateless router.
  const stub = env.TUNNEL.get(env.TUNNEL.idFromName(route.machineKey));
  return stub.fetch(request);
}
