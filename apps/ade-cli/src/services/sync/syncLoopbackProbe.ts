import http from "node:http";

export const SYNC_LOOPBACK_PROBE_TIMEOUT_MS = 1_500;

export type SyncLoopbackProbeResult = {
  ok: boolean;
  port: number;
  statusCode: number | null;
  statusMessage: string | null;
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
      const ok = statusCode === 426
        && (statusMessage == null || statusMessage.toLowerCase() === "upgrade required");
      finish({
        ok,
        statusCode,
        statusMessage,
        reason: ok
          ? null
          : `Expected ADE 426 Upgrade Required on 127.0.0.1:${port}, received ${statusCode ?? "no status"}${statusMessage ? ` ${statusMessage}` : ""}.`,
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
        reason: `ADE loopback probe failed on 127.0.0.1:${port}: ${error.message}`,
      });
    });
  });
}

export async function assertAdeLoopbackListener(
  port: number,
  probe: (port: number) => Promise<SyncLoopbackProbeResult> = probeAdeLoopbackListener,
): Promise<SyncLoopbackProbeResult> {
  const result = await probe(port);
  if (!result.ok) {
    throw new LoopbackShadowedError(
      port,
      result.reason ?? `The listener on 127.0.0.1:${port} is not ADE.`,
      result.checkedAt,
    );
  }
  return result;
}
