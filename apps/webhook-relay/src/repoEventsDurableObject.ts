const BROADCAST_DEBOUNCE_MS = 1_000;
const SUBSCRIPTION_LIFETIME_MS = 4 * 60 * 60_000;
const SUBSCRIPTION_EXPIRED_CLOSE_CODE = 4401;
const PENDING_BROADCAST_STORAGE_KEY = "pendingBroadcastRepo";

type SocketAttachment = {
  expiresAt: number;
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Hibernating, repo-scoped wake-up fanout. D1 cursors remain the durable event
 * stream; this object sends only a coalesced hint that clients should drain it.
 */
export class RepoEventsDurableObject implements DurableObject {
  constructor(private readonly state: DurableObjectState) {
    // Application-level text "ping" receives text "pong" at the edge without
    // waking the object. Native WebSocket protocol ping/pong is automatic too.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe") return await this.subscribe(request, url);
    if (url.pathname === "/notify") return await this.notify(request);
    return text("not found", 404);
  }

  private async subscribe(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") return text("method not allowed", 405);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return text("expected websocket", 426);
    }
    const repo = url.searchParams.get("repo")?.trim() ?? "";
    if (!repo.includes("/")) return json({ ok: false, error: "repo is required" }, { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const expiresAt = Date.now() + SUBSCRIPTION_LIFETIME_MS;
    this.state.acceptWebSocket(server, ["subscriber", `repo:${repo.toLowerCase()}`]);
    server.serializeAttachment({ expiresAt } satisfies SocketAttachment);
    await this.ensureAlarmBy(expiresAt);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async notify(request: Request): Promise<Response> {
    if (request.method !== "POST") return text("method not allowed", 405);
    let repo = "";
    try {
      const body = await request.json() as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const value = (body as Record<string, unknown>).repo;
        repo = typeof value === "string" ? value.trim() : "";
      }
    } catch {
      return json({ ok: false, error: "invalid json" }, { status: 400 });
    }
    if (!repo.includes("/")) return json({ ok: false, error: "repo is required" }, { status: 400 });

    await this.state.storage.transaction(async (transaction) => {
      const pending = await transaction.get<string>(PENDING_BROADCAST_STORAGE_KEY);
      if (!pending) await transaction.put(PENDING_BROADCAST_STORAGE_KEY, repo);
    });
    // Do not push an existing debounce deadline out. An earlier expiry alarm
    // may fire first; it will broadcast the pending hint and then reschedule.
    await this.ensureAlarmBy(Date.now() + BROADCAST_DEBOUNCE_MS);
    return json({ ok: true }, { status: 202 });
  }

  private async ensureAlarmBy(deadline: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || current <= Date.now() || current > deadline) {
      await this.state.storage.setAlarm(deadline);
    }
  }

  async alarm(): Promise<void> {
    // Atomically claim the pending broadcast so a notify racing this alarm
    // either lands in this frame or remains queued for the next one.
    const repo = await this.state.storage.transaction(async (transaction) => {
      const pending = await transaction.get<string>(PENDING_BROADCAST_STORAGE_KEY) ?? null;
      if (pending) await transaction.delete(PENDING_BROADCAST_STORAGE_KEY);
      return pending;
    });

    const now = Date.now();
    let earliestExpiry: number | null = null;
    const frame = repo ? JSON.stringify({ t: "github_delivery", repo }) : null;
    for (const socket of this.state.getWebSockets("subscriber")) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.expiresAt <= now) {
        try {
          socket.close(SUBSCRIPTION_EXPIRED_CLOSE_CODE, "subscription expired");
        } catch {
          // The peer may already be closing.
        }
        continue;
      }
      earliestExpiry = earliestExpiry === null
        ? attachment.expiresAt
        : Math.min(earliestExpiry, attachment.expiresAt);
      if (frame) {
        try {
          socket.send(frame);
        } catch {
          // A failed wake-up is recovered by the client's safety poll.
        }
      }
    }

    if (earliestExpiry !== null) await this.ensureAlarmBy(earliestExpiry);
  }

  webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): void {
    // Only the auto-response heartbeat is part of this signaling protocol.
  }

  webSocketClose(_socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {}

  webSocketError(_socket: WebSocket, _error: unknown): void {}
}
