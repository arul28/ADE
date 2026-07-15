import crypto from "node:crypto";
import http from "node:http";

export const SYNC_LOOPBACK_PROBE_TIMEOUT_MS = 1_500;

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
      request.destroy(new Error(`Loopback ADE probe timed out after ${timeoutMs}ms.`));
    });
    request.once("error", (error) => {
      finish({
        ok: false,
        statusCode: null,
        statusMessage: null,
        markerValue: null,
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
  const result = await probe(port, expectedNonce);
  if (!result.ok) {
    throw new LoopbackShadowedError(
      port,
      result.reason ?? `The listener on 127.0.0.1:${port} is not ADE.`,
      result.checkedAt,
    );
  }
  return result;
}
