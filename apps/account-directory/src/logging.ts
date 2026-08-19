/**
 * Every structured line this Worker emits, in one place.
 *
 * They share a service name and a correlation id on purpose: support joins them
 * to the request the client already logged, and to each other. Nothing here
 * ever carries a full machine key, a token, or a pairing grant.
 */

const SERVICE = "ade-account-directory";

export function logActivityRelayFailure(args: {
  correlationId: string;
  operation: "purge" | "restore";
  machineKey: string;
  reason: string;
  attempts: number;
}): void {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    svc: SERVICE,
    kind: "activity_relay_failed",
    correlationId: args.correlationId,
    operation: args.operation,
    // The machine key is a capability-shaped secret; log only a tail marker.
    machine: args.machineKey.slice(-6),
    attempts: args.attempts,
    reason: args.reason.slice(0, 300),
  }));
}

/**
 * One line per refused machine-membership change.
 *
 * Every refusal on this worker is a user who cannot get their computer back
 * onto their account, and the request that produced it is long gone by the time
 * they ask for help. Support has no other window into that: the client reports
 * only the code, and the D1 tables record what the state IS, never why a call
 * was turned away. So each refusal path emits exactly one line, and the fields
 * are chosen to be joinable — `correlationId` ties it to the request the client
 * logged, `userId` to the account, the prefixes to the specific install.
 *
 * PREFIXES ONLY. A machine key is a capability-shaped secret and a pairing
 * grant is a live credential; eight characters identify a row for a human
 * reading logs and are useless to anyone who reads them. Nothing here ever
 * carries a full key, a token, or a grant in any form.
 */
export function logDirectoryRefusal(args: {
  event: "directory.register_refused" | "directory.remove_refused" | "directory.supersede_refused";
  userId: string;
  machineKey: string;
  deviceId: string | null;
  code: string;
  correlationId: string;
  /** Optional finer classification for support; the wire `code` stays the contract. */
  reason?: string;
}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: SERVICE,
    event: args.event,
    userId: args.userId,
    machineKeyPrefix: args.machineKey.slice(0, 8),
    deviceIdPrefix: args.deviceId ? args.deviceId.slice(0, 8) : null,
    code: args.code,
    correlationId: args.correlationId,
    ...(args.reason ? { reason: args.reason.slice(0, 300) } : {}),
  }));
}

/**
 * One line per diagnostics upload, stored or refused.
 *
 * The route stores bytes it never parses, so this line is the only record that
 * an upload happened at all — and the only way to tell "the user's report never
 * arrived" from "it arrived and was refused for being too large".
 */
export function logDiagnosticsUpload(args: {
  outcome: "stored" | "rejected";
  status: number;
  reason?: string;
  identity: string;
  authenticated: boolean;
  bytes: number;
}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: SERVICE,
    kind: "diagnostics_upload",
    outcome: args.outcome,
    status: args.status,
    ...(args.reason ? { reason: args.reason } : {}),
    // The identity is already a hash for anonymous callers; a signed-in one is
    // truncated for the same reason every other log line here truncates.
    identity: args.identity.slice(0, 24),
    authenticated: args.authenticated,
    bytes: args.bytes,
  }));
}

export function logDirectoryLifecycle(args: {
  correlationId: string;
  /** The matched account route's kind, or null for anything else. */
  route: string | null;
  method: string;
  status: number;
  durationMs: number;
}): void {
  const outcome = args.status < 400
    ? "ok"
    : args.status < 500
      ? "client_error"
      : "server_error";
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: SERVICE,
    kind: "request_completed",
    correlationId: args.correlationId,
    route: args.route ?? "other",
    method: args.method,
    status: args.status,
    outcome,
    durationMs: Math.max(0, Math.round(args.durationMs)),
  }));
}
