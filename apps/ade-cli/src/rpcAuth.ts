import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-boot bearer auth for the loopback TCP JSON-RPC listener.
 *
 * The headless unix socket is protected by 0600 file permissions, but any
 * local user on the machine can connect to a 127.0.0.1 TCP port, so TCP
 * clients must present this token with every request. The token is embedded
 * in the ADE_RPC_URL value (`tcp://127.0.0.1:<port>?token=<token>`) so it
 * propagates to legitimate clients through the same channel as the URL.
 *
 * Mirrors the desktop built-in-browser bridge auth
 * (apps/desktop/src/main/services/builtInBrowser/desktopBridgeServer.ts):
 * 256-bit random token, per-request param, timing-safe comparison.
 */

export const ADE_RPC_AUTH_PARAM = "__adeRpcAuth";

export function generateRpcAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

export function parseRpcUrlAuthToken(socketPath: string): string | null {
  if (!socketPath.startsWith("tcp://")) return null;
  try {
    const token = new URL(socketPath).searchParams.get("token");
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function withRpcAuthParam(
  params: unknown,
  authToken: string | null,
): unknown {
  if (!authToken) return params;
  if (params === undefined || params === null) {
    return { [ADE_RPC_AUTH_PARAM]: authToken };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    // Positional (array) or primitive params have nowhere to carry the token;
    // the server would deny the request anyway, so fail loudly at the client
    // instead of shipping a request that dies with a confusing policy error.
    throw new Error(
      "ADE TCP RPC requests must use object params so the auth token can be attached.",
    );
  }
  return { ...(params as Record<string, unknown>), [ADE_RPC_AUTH_PARAM]: authToken };
}

export function safeRpcAuthTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
