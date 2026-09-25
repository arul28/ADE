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
  /** True while this router holds the ticket. Optional for routers that predate it. */
  hasTicket?(ticket: string): boolean;
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

/**
 * Every project's forwarder, newest last.
 *
 * One brain opens several projects, and each builds its own forwarder with its
 * own tickets. A single "active" handle meant the last project to open took
 * every socket, so a ticket from another project's forwarder was unknown and
 * the viewer was closed with 4401 ("the stream pass expired") every time.
 */
const routers: AppleStreamSocketRouter[] = [];

/** Registers a forwarder. Null clears them all. Returns a detach for this one only. */
export function setActiveAppleStreamRouter(router: AppleStreamSocketRouter | null): () => void {
  if (!router) {
    routers.length = 0;
    return () => {};
  }
  routers.push(router);
  return () => {
    const index = routers.lastIndexOf(router);
    if (index >= 0) routers.splice(index, 1);
  };
}

/**
 * One router over all registered forwarders: a socket goes to the forwarder
 * that issued its ticket, else to the newest, which refuses it with 4401.
 */
const combinedRouter: AppleStreamSocketRouter = {
  ticketFromUrl(url) {
    for (const router of routers) {
      const ticket = router.ticketFromUrl(url);
      if (ticket) return ticket;
    }
    return null;
  },
  hasTicket(ticket) {
    return routers.some((router) => router.hasTicket?.(ticket) === true);
  },
  attach(socket, args) {
    const owner = routers.find((router) => router.hasTicket?.(args.ticket) === true)
      ?? routers[routers.length - 1];
    return owner!.attach(socket, args);
  },
};

export function getActiveAppleStreamRouter(): AppleStreamSocketRouter | null {
  return routers.length > 0 ? combinedRouter : null;
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
  router: AppleStreamSocketRouter | null = getActiveAppleStreamRouter(),
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
