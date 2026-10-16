import crypto from "node:crypto";
import http from "node:http";

/**
 * How long one loopback probe waits for the listener's 426 before it gives up.
 *
 * This is a bound on "the peer never answers at all", not a patience budget for
 * a slow peer: ADE's own listener answers this exact request in a few
 * milliseconds (measured 1-9ms on a quiet loopback), and the listener shares
 * this process's event loop, so nothing in ADE's path can legitimately need
 * more. A peer that is not ADE and does not speak HTTP at all (a wedged or
 * suspended process holding 127.0.0.1:<port>, or a raw TCP listener) is what
 * this deadline exists to bound.
 */
export const SYNC_LOOPBACK_PROBE_TIMEOUT_MS = 1_500;

/**
 * Attempts one loopback assertion may spend before it declares a port shadowed.
 *
 * A timeout is not evidence about who owns the port. The answer can have been
 * written by our own listener and simply not read in time, because this process
 * blocked its event loop between the listener's write and the probe's read (a
 * long synchronous sqlite/JSON/gzip step is enough): with the answer already in
 * the socket buffer, the expired deadline wins and the probe reports exactly
 * the timeout a shadowed port reports. Re-probing once separates the two — a
 * shadowed port stays silent (or answers with a foreign identity), while the
 * port that was merely busy answers on the second attempt, when the loop has
 * drained. Only a probe with NO answer is repeated; a peer that answered is
 * decided on that answer.
 */
export const SYNC_LOOPBACK_PROBE_ATTEMPTS = 2;

/**
 * Identity header ADE's sync WebSocket servers stamp on the 426 Upgrade
 * Required response they return for non-upgrade HTTP requests. Its value is a
 * fresh per-listener nonce known to in-process validators. A bare `ws` server
 * (or another ADE process) can also answer plain GETs with 426, but cannot
 * present this listener instance's expected identity.
 */
export const SYNC_LOOPBACK_ADE_MARKER_HEADER = "x-ade-sync-loopback";

export function generateLoopbackNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Request handler for the http.Server that fronts an ADE sync WebSocketServer.
 * Non-upgrade HTTP requests get a 426 Upgrade Required carrying the ADE marker
 * header so `probeAdeLoopbackListener` can distinguish an ADE listener from a
 * bare/foreign `ws` process (which also answers plain GETs with a 426, but
 * without the marker). The WebSocketServer, constructed with `{ server }`,
 * intercepts `upgrade` requests before they reach this handler, so real sync
 * clients still complete the websocket handshake unchanged.
 */
export function writeAdeLoopbackUpgradeResponse(
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  nonce: string,
): void {
  // Mirror `ws`'s built-in 426 handler exactly (Content-Type + Content-Length
  // only) and add the ADE marker. Do NOT send `Connection: Upgrade` /
  // `Upgrade: websocket` on this NON-upgrade response: those confuse Node's http
  // server socket state machine and make every other keep-alive request return
  // 400, which would intermittently defeat the probe. The probe validates the
  // status code and the marker, so no extra headers are required.
  const body = "Upgrade Required";
  response.writeHead(426, {
    "Content-Type": "text/plain",
    "Content-Length": Buffer.byteLength(body),
    [SYNC_LOOPBACK_ADE_MARKER_HEADER]: nonce,
  });
  response.end(body);
}

export type SyncLoopbackProbeResult = {
  ok: boolean;
  port: number;
  statusCode: number | null;
  statusMessage: string | null;
  markerValue: string | null;
  checkedAt: string;
  reason: string | null;
  /**
   * The probe got no answer before its deadline. Distinct from the other
   * failures, which are answers about the port: a timeout says only that
   * nothing was read in time, so {@link assertAdeLoopbackListener} re-probes it
   * instead of treating it as proof of a foreign owner.
   */
  timedOut?: boolean;
};

export type SyncLoopbackValidationStatus = {
  port: number | null;
  loopbackAdeValidated: boolean;
  lastFailureAt: string | null;
  reason: string | null;
  lastSuccessAt: string | null;
};

export class LoopbackShadowedError extends Error {
  readonly code = "ELOOPBACKSHADOWED";
  readonly port: number;
  readonly failedAt: string;

  constructor(port: number, reason: string, failedAt = new Date().toISOString()) {
    super(reason);
    this.name = "LoopbackShadowedError";
    this.port = port;
    this.failedAt = failedAt;
  }
}

export function isLoopbackShadowedError(error: unknown): error is LoopbackShadowedError {
  return error instanceof LoopbackShadowedError
    || (error as { code?: unknown } | null | undefined)?.code === "ELOOPBACKSHADOWED";
}

/**
 * ADE's WebSocketServer answers a plain HTTP request with 426 Upgrade Required.
 * Probe the exact loopback route used by Tailscale Serve and the cloud relay so
 * a more-specific foreign 127.0.0.1 listener cannot hide behind a successful
 * wildcard bind.
 */
export async function probeAdeLoopbackListener(
  port: number,
  expectedNonce: string,
  timeoutMs = SYNC_LOOPBACK_PROBE_TIMEOUT_MS,
): Promise<SyncLoopbackProbeResult> {
  const checkedAt = new Date().toISOString();
  return await new Promise<SyncLoopbackProbeResult>((resolve) => {
    let settled = false;
    // Set by the socket deadline below, so the failure it produces can be told
    // apart from an answer about the port.
    let timedOut = false;
    const finish = (result: Omit<SyncLoopbackProbeResult, "port" | "checkedAt">): void => {
      if (settled) return;
      settled = true;
      resolve({ ...result, port, checkedAt });
    };
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: { connection: "close" },
    }, (response) => {
      response.resume();
      const statusCode = response.statusCode ?? null;
      const statusMessage = response.statusMessage ?? null;
      const rawMarker = response.headers[SYNC_LOOPBACK_ADE_MARKER_HEADER];
      const observedMarker = Array.isArray(rawMarker) ? rawMarker[0] : rawMarker;
      const markerValue = typeof observedMarker === "string" ? observedMarker : null;
      const hasExpectedNonce = expectedNonce.length > 0 && markerValue === expectedNonce;
      // A foreign/stale bare `ws` server and another ADE instance can both
      // return 426. Only this process knows the identity it expects from the
      // listener instance it just constructed.
      const ok = statusCode === 426 && hasExpectedNonce;
      finish({
        ok,
        statusCode,
        statusMessage,
        markerValue,
        reason: ok
          ? null
          : statusCode !== 426
            ? `Expected ADE 426 Upgrade Required on 127.0.0.1:${port}, received ${statusCode ?? "no status"}${statusMessage ? ` ${statusMessage}` : ""}.`
            : markerValue == null || markerValue.length === 0
              ? `The listener on 127.0.0.1:${port} returned 426 but did not present a loopback identity in ${SYNC_LOOPBACK_ADE_MARKER_HEADER}.`
              : expectedNonce.length === 0
                ? `The listener on 127.0.0.1:${port} cannot be ADE-validated because the expected loopback identity is empty.`
                : `The listener on 127.0.0.1:${port} returned 426 but presented a different loopback identity — another process owns 127.0.0.1:${port}.`,
      });
    });
    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy(new Error(`Loopback ADE probe timed out after ${timeoutMs}ms.`));
    });
    request.once("error", (error) => {
      finish({
        ok: false,
        statusCode: null,
        statusMessage: null,
        markerValue: null,
        timedOut,
        reason: `ADE loopback probe failed on 127.0.0.1:${port}: ${error.message}`,
      });
    });
  });
}

export async function assertAdeLoopbackListener(
  port: number,
  expectedNonce: string,
  probe: (port: number, expectedNonce: string) => Promise<SyncLoopbackProbeResult> = probeAdeLoopbackListener,
): Promise<SyncLoopbackProbeResult> {
  let result = await probe(port, expectedNonce);
  // Only a probe that read no answer is repeated (see
  // SYNC_LOOPBACK_PROBE_ATTEMPTS): the port may be ours with the answer lost to
  // a busy event loop. A foreign peer that answers is decided immediately, and
  // a foreign peer that stays silent is still declared shadowed once the
  // attempts run out, so a shadow never gets through.
  for (
    let attempt = 1;
    attempt < SYNC_LOOPBACK_PROBE_ATTEMPTS && !result.ok && result.timedOut === true;
    attempt += 1
  ) {
    result = await probe(port, expectedNonce);
  }
  if (!result.ok) {
    throw new LoopbackShadowedError(
      port,
      result.reason ?? `The listener on 127.0.0.1:${port} is not ADE.`,
      result.checkedAt,
    );
  }
  return result;
}
