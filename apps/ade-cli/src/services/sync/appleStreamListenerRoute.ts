/**
 * Routes `/apple/stream/<ticket>` sockets on the sync listener to the brain's
 * video forwarder.
 *
 * The listener is machine-wide and outlives project switches; the forwarder is
 * built next to the project's simulator service. Rather than thread the
 * forwarder through every listener constructor — two call sites, both of which
 * already juggle handoff, adoption, and rebinding — the active one registers
 * itself here, the same module-handle shape the recording service uses for its
 * one turn-end hook.
 *
 * The upgrade itself is NOT special-cased at the HTTP layer. The sync
 * WebSocketServer already accepts any path, so an apple socket completes the
 * ordinary handshake and is diverted on `connection`, before the sync host ever
 * sees it. That keeps the listener's bind, loopback-probe, and peer-handoff
 * wiring exactly as it was.
 */

export { APPLE_STREAM_PATH_PREFIX } from "../../../../desktop/src/main/services/ios/appleStreamRelay";

export type AppleStreamSocketRouter = {
  ticketFromUrl(url: string | null | undefined): string | null;
  attach(
    socket: {
      send(data: Uint8Array): void;
      close(code?: number, reason?: string): void;
      on(event: "message", listener: (data: unknown, isBinary?: boolean) => void): void;
      on(event: "close" | "error", listener: (...args: unknown[]) => void): void;
    },
    args: { ticket: string; token: string | null },
  ): Promise<boolean>;
};

let activeRouter: AppleStreamSocketRouter | null = null;

/** Claims the handle. Returns a detach that only clears its own registration. */
export function setActiveAppleStreamRouter(router: AppleStreamSocketRouter | null): () => void {
  activeRouter = router;
  return () => {
    if (activeRouter === router) activeRouter = null;
  };
}

export function getActiveAppleStreamRouter(): AppleStreamSocketRouter | null {
  return activeRouter;
}

/** The `?token=` a browser must use, because it cannot set an Authorization header. */
export function appleStreamTokenFromRequest(request: {
  url?: string | null;
  headers?: Record<string, unknown>;
}): string | null {
  const header = request.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string") {
    const match = /^Bearer[ ]+(\S+)$/i.exec(value.trim());
    if (match?.[1]) return match[1];
  }
  const url = request.url ?? "";
  const queryIndex = url.indexOf("?");
  if (queryIndex < 0) return null;
  const token = new URLSearchParams(url.slice(queryIndex + 1)).get("token");
  return token && token.trim() ? token.trim() : null;
}

/**
 * Divert an apple stream socket, or leave it for the sync host.
 *
 * Returns true when the socket has been taken over (accepted or refused — the
 * caller must not also hand it to a host in either case).
 */
export function tryRouteAppleStreamSocket(
  ws: {
    send(data: Uint8Array, options?: { compress?: boolean }): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: never[]) => void): void;
  },
  request: { url?: string | null; headers?: Record<string, unknown> },
  router: AppleStreamSocketRouter | null = activeRouter,
): boolean {
  const ticket = router?.ticketFromUrl(request.url ?? null) ?? null;
  if (!router || !ticket) return false;
  const token = appleStreamTokenFromRequest(request);
  // H.264 access units are already compressed; running them through
  // permessage-deflate burns CPU on both ends for a fraction of a percent.
  const socket = {
    send: (data: Uint8Array) => ws.send(data, { compress: false }),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    on: (event: string, listener: (...args: never[]) => void) => ws.on(event, listener),
  } as Parameters<AppleStreamSocketRouter["attach"]>[0];
  void router.attach(socket, { ticket, token }).catch(() => {
    try {
      ws.close(1011, "stream unavailable");
    } catch {
      // already closing
    }
  });
  return true;
}
