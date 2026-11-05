/*
 * What both device adapters (`appleDevice.ts`, `androidDevice.ts`) share: the
 * relay ticket, the stream URL for this tab's route, and the error fallback
 * for a host without the commands. A leaf module, so neither adapter imports
 * the other.
 */

/** The relay pipe kind for a device stream (`syncTunnelClientService.ts`). */
export const APPLE_STREAM_PIPE_KIND = "apple-stream";

/** A relay ticket as `apple.streamTicket` and `android.streamTicket` answer it. */
export type StreamTicket = {
  url: string | null;
  path: string;
  token: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  expiresAt: string;
};

export function unavailable(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

/**
 * Absolute stream URL for this tab's route.
 *
 * Exported and pure so the relay branch — the one a test can never reach by
 * standing up a real tunnel — is covered by a unit test rather than by hope.
 */
export function resolveAppleStreamUrl(
  endpoint: string | null,
  ticketPath: string,
): { url: string | null; forwarded: boolean; error: string | null } {
  if (!ticketPath) {
    return { url: null, forwarded: false, error: "The live view returned no address." };
  }
  if (!endpoint) {
    return {
      url: null,
      forwarded: false,
      error: "The live view needs a connection to the ADE machine that owns the device.",
    };
  }
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    return { url: null, forwarded: false, error: "The ADE connection has no usable address." };
  }
  // A relay endpoint pairs this tab with a brain-side pipe socket; the pipe,
  // not the tab, decides which local path to dial, so the path rides as a
  // parameter instead of being appended to the relay's own URL.
  if (/\/connect\/[^/]+$/.test(base.pathname)) {
    const relay = new URL(base.toString());
    relay.searchParams.set("kind", APPLE_STREAM_PIPE_KIND);
    relay.searchParams.set("path", ticketPath);
    return { url: relay.toString(), forwarded: true, error: null };
  }
  const [path, query] = ticketPath.split("?");
  const direct = new URL(path ?? "", base);
  direct.search = query ? `?${query}` : "";
  return { url: direct.toString(), forwarded: false, error: null };
}

/**
 * Puts the ticket's token on a resolved stream URL.
 *
 * The token cannot ride a WebSocket header from a browser, so it rides the
 * query the brain also accepts. `H264StreamView` still passes the token
 * separately for the loopback transport; this is the other one.
 */
export function withStreamTicketToken(
  resolved: { url: string | null; forwarded: boolean; error: string | null },
  ticket: StreamTicket | null,
): { url: string | null; forwarded: boolean; error: string | null } {
  if (!resolved.url || !ticket) return resolved;
  const withToken = new URL(resolved.url);
  if (!withToken.searchParams.get("kind")) {
    withToken.searchParams.set("token", ticket.token);
  } else {
    withToken.searchParams.set("path", `${ticket.path}?token=${ticket.token}`);
  }
  return { ...resolved, url: withToken.toString() };
}

/** How many tickets a tab keeps that no socket has used yet. */
const STREAM_TICKET_BOOK_MAX = 8;

/**
 * The tickets a tab was handed, by the URL each `startStream` answered with.
 * Tickets are single-use, so `resolveStreamUrl` must use the ticket behind the
 * URL it was given: two viewers (the pane and the floating player) that start
 * at once each get their own, never the newest one.
 */
export function createStreamTicketBook() {
  const tickets = new Map<string, { laneId: string; ticket: StreamTicket }>();
  return {
    add(laneId: string, ticket: StreamTicket): void {
      tickets.set(ticket.url ?? ticket.path, { laneId, ticket });
      while (tickets.size > STREAM_TICKET_BOOK_MAX) {
        const oldest = tickets.keys().next().value;
        if (oldest === undefined) break;
        tickets.delete(oldest);
      }
    },
    /** The ticket behind `streamUrl`; with no URL, the newest one. */
    find(streamUrl: string | null): StreamTicket | null {
      if (typeof streamUrl === "string") return tickets.get(streamUrl)?.ticket ?? null;
      return [...tickets.values()].at(-1)?.ticket ?? null;
    },
    /** A stop: the lane's unused tickets go (all of them without a lane). */
    forgetLane(laneId: string | null): void {
      for (const [key, entry] of tickets) if (!laneId || entry.laneId === laneId) tickets.delete(key);
    },
  };
}
