import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  constantTimeEqual,
  DEFAULT_MAX_TUNNELS_PER_MACHINE,
  generateConnectionId,
  jsonResponse,
  routeTunnelPath,
  verifySignedQuery,
  type TunnelRelayEnv,
} from "./relay";

// Application close codes must live in 4000-4999. Documented in the README.
const CLOSE_HOST_OFFLINE = 4501; // phone connected but no host control socket
const CLOSE_IDLE = 4502; // pipe pair idle past IDLE_MS, swept by the alarm
const CLOSE_TOO_MANY = 4503; // machine already at MAX_TUNNELS_PER_MACHINE
const CLOSE_CLIENT_GONE = 4504; // pipe arrived but its phone had already left
const CLOSE_CONTROL_REPLACED = 4505; // a newer host control socket took over
const CLOSE_PARTNER_CLOSED = 4000; // the other end of the tunnel closed cleanly

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
// Persisting last-activity into the socket attachment on every frame would be
// wasteful; a 60s granularity is plenty against a 10-minute idle threshold.
const ACTIVITY_WRITE_THROTTLE_MS = 60 * 1000;
// The phone is a sync client that sends its hello frame the instant it opens —
// before the brain's pipe socket has attached (the brain only learns of the
// tunnel via {t:"open"} and then dials the pipe). Buffer those first frames so
// none are dropped, bounded so a phone that never gets a pipe can't grow it.
const MAX_BUFFERED_CLIENT_FRAMES = 64;

/**
 * Structured single-line log. View live with `wrangler tail ade-tunnel-relay`,
 * or in the dashboard (observability enabled in wrangler.jsonc). Only lifecycle
 * and rejection events are logged — never per-frame — so a busy tunnel stays
 * cheap and the stream stays diagnosable.
 */
function logTunnel(kind: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-tunnel-relay", kind, ...fields }));
  } catch {
    console.log(`ade-tunnel-relay ${kind}`);
  }
}

type SocketRole = "control" | "client" | "pipe";

type SocketAttachment = {
  role: SocketRole;
  id?: string;
  ts: number;
};

/**
 * One instance per machineKey (via idFromName). Owns the claim secret, verifies
 * signed host/pipe upgrades, and pairs each phone socket (`/connect`) 1:1 with
 * a host pipe socket (`/host/:key/pipe/:id`). Once paired, frames pass through
 * untouched — the ADE sync protocol rides the tunnel byte-for-byte. Uses the
 * WebSocket Hibernation API so idle tunnels don't burn wall-clock duration.
 */
export class TunnelDurableObject implements DurableObject {
  // Frames a phone sent before its pipe attached, keyed by connectionId. Held
  // in memory only: the client + control sockets keep the object resident
  // during the sub-second open handshake, so this survives until the flush.
  private readonly pendingClientFrames = new Map<string, (string | ArrayBuffer)[]>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: TunnelRelayEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = routeTunnelPath(url.pathname);
    if (!route) return new Response("not found", { status: 404 });

    if (route.kind === "claim") return this.handleClaim(request);
    if (route.kind === "host") return this.handleHost(request, url, route.machineKey);
    if (route.kind === "pipe") return this.handlePipe(request, url, route.machineKey, route.id);
    if (route.kind === "connect") return this.handleConnect(request);
    return new Response("not found", { status: 404 });
  }

  private async handleClaim(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let secret = "";
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).secret === "string") {
        secret = ((parsed as Record<string, unknown>).secret as string).trim();
      }
    } catch {
      return jsonResponse({ ok: false, error: "invalid json" }, { status: 400 });
    }
    if (secret.length < 32 || secret.length > 128) {
      return jsonResponse({ ok: false, error: "secret must be 32-128 characters" }, { status: 400 });
    }
    const existing = await this.state.storage.get<string>("secret");
    if (existing) {
      if (constantTimeEqual(existing, secret)) return jsonResponse({ ok: true, claimed: false });
      return jsonResponse({ ok: false, error: "machine key is already claimed" }, { status: 409 });
    }
    await this.state.storage.put("secret", secret);
    return jsonResponse({ ok: true, claimed: true }, { status: 201 });
  }

  private async requireWebSocket(request: Request): Promise<Response | null> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    return null;
  }

  private async loadSecret(): Promise<string | null> {
    return (await this.state.storage.get<string>("secret")) ?? null;
  }

  private async handleHost(request: Request, url: URL, machineKey: string): Promise<Response> {
    const notWs = await this.requireWebSocket(request);
    if (notWs) return notWs;
    const secret = await this.loadSecret();
    if (!secret) return new Response("unknown machine", { status: 401 });
    const ts = url.searchParams.get("ts") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    const verified = await verifySignedQuery({
      secret,
      base: buildHostSignatureBase(machineKey, ts),
      timestamp: ts,
      signature: sig,
    });
    if (!verified.ok) {
      logTunnel("auth_failed", { role: "host", machineKey: machineKey.slice(0, 8), reason: verified.reason });
      return new Response(verified.reason, { status: 401 });
    }

    // Only one control socket per machine; a fresh host connection supersedes a
    // stale one (e.g. after the brain restarted before the old socket dropped).
    for (const existing of this.state.getWebSockets("control")) {
      try {
        existing.close(CLOSE_CONTROL_REPLACED, "replaced by newer host");
      } catch {
        // already closing
      }
    }
    logTunnel("host_registered", { machineKey: machineKey.slice(0, 8) });
    return this.acceptSocket({ role: "control" });
  }

  private async handlePipe(request: Request, url: URL, machineKey: string, id: string): Promise<Response> {
    const notWs = await this.requireWebSocket(request);
    if (notWs) return notWs;
    const secret = await this.loadSecret();
    if (!secret) return new Response("unknown machine", { status: 401 });
    const ts = url.searchParams.get("ts") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    const verified = await verifySignedQuery({
      secret,
      base: buildPipeSignatureBase(machineKey, id, ts),
      timestamp: ts,
      signature: sig,
    });
    if (!verified.ok) return new Response(verified.reason, { status: 401 });

    const client = this.clientForId(id);
    if (!client) {
      // The phone hung up (or timed out) before the host's pipe arrived.
      return this.acceptSocket({ role: "pipe", id }, (server) => {
        try {
          server.close(CLOSE_CLIENT_GONE, "client gone");
        } catch {
          // already closing
        }
      });
    }
    // Pipe paired with a live phone — flush any frames the phone sent while it
    // waited for us, in order, then let live forwarding take over.
    return this.acceptSocket({ role: "pipe", id }, (server) => {
      const buffered = this.pendingClientFrames.get(id);
      if (!buffered) return;
      this.pendingClientFrames.delete(id);
      for (const frame of buffered) {
        try {
          server.send(frame);
        } catch {
          // pipe already closing
        }
      }
    });
  }

  private async handleConnect(request: Request): Promise<Response> {
    const notWs = await this.requireWebSocket(request);
    if (notWs) return notWs;
    const control = this.state.getWebSockets("control")[0];
    if (!control) {
      // No host is registered — accept then close so the phone gets a clean,
      // distinguishable code rather than a bare handshake failure.
      logTunnel("connect_rejected", { reason: "host_offline" });
      return this.acceptSocket({ role: "client" }, (server) => {
        try {
          server.close(CLOSE_HOST_OFFLINE, "host offline");
        } catch {
          // already closing
        }
      });
    }

    const activeClients = this.state.getWebSockets("client").length;
    const maxTunnels = this.maxTunnels();
    if (activeClients >= maxTunnels) {
      logTunnel("connect_rejected", { reason: "too_many", activeClients, maxTunnels });
      return this.acceptSocket({ role: "client" }, (server) => {
        try {
          server.close(CLOSE_TOO_MANY, "too many tunnels");
        } catch {
          // already closing
        }
      });
    }

    const id = generateConnectionId();
    const response = await this.acceptSocket({ role: "client", id });
    try {
      control.send(JSON.stringify({ t: "open", id }));
    } catch {
      // Control socket died between the lookup and now; the phone socket will be
      // swept or closed when the (never-arriving) pipe times out.
    }
    await this.ensureSweepScheduled();
    return response;
  }

  /** Accepts a hibernatable WebSocket, tags it for lookup, and returns the 101. */
  private async acceptSocket(
    attachment: Omit<SocketAttachment, "ts">,
    afterAccept?: (server: WebSocket) => void,
  ): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const tags: string[] = [attachment.role];
    if (attachment.id) tags.push(`conn:${attachment.id}`);
    this.state.acceptWebSocket(server, tags);
    server.serializeAttachment({ ...attachment, ts: Date.now() } satisfies SocketAttachment);
    if (afterAccept) afterAccept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private clientForId(id: string): WebSocket | null {
    for (const ws of this.state.getWebSockets(`conn:${id}`)) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.role === "client") return ws;
    }
    return null;
  }

  private partnerOf(ws: WebSocket, att: SocketAttachment): WebSocket | null {
    if (!att.id) return null;
    for (const candidate of this.state.getWebSockets(`conn:${att.id}`)) {
      if (candidate !== ws) return candidate;
    }
    return null;
  }

  private maxTunnels(): number {
    const raw = Number(this.env.MAX_TUNNELS_PER_MACHINE ?? DEFAULT_MAX_TUNNELS_PER_MACHINE);
    return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : DEFAULT_MAX_TUNNELS_PER_MACHINE;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) return;

    if (att.role === "control") {
      // Control frames are signaling only; keep-alive pings get a pong, the
      // rest are ignored so the protocol can grow without breaking old hosts.
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as { t?: string };
          if (parsed?.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
        } catch {
          // ignore malformed control frames
        }
      }
      return;
    }

    const partner = this.partnerOf(ws, att);
    if (partner) {
      try {
        partner.send(message);
      } catch {
        // Partner is mid-close; the close handler will tear the pair down.
      }
    } else if (att.role === "client" && att.id) {
      // Pipe not attached yet — hold the frame so the phone's hello isn't lost.
      const buffered = this.pendingClientFrames.get(att.id) ?? [];
      if (buffered.length >= MAX_BUFFERED_CLIENT_FRAMES) {
        // Dropping mid-stream would corrupt the byte-for-byte sync protocol;
        // fail the tunnel loudly so the phone reconnects instead of hanging.
        this.pendingClientFrames.delete(att.id);
        try {
          ws.close(4506, "pre-pipe buffer overflow");
        } catch {
          // already closing
        }
        return;
      }
      buffered.push(message);
      this.pendingClientFrames.set(att.id, buffered);
    }
    this.touch(ws, att);
  }

  private touch(ws: WebSocket, att: SocketAttachment): void {
    const now = Date.now();
    if (now - att.ts < ACTIVITY_WRITE_THROTTLE_MS) return;
    ws.serializeAttachment({ ...att, ts: now } satisfies SocketAttachment);
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.teardownPartner(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.teardownPartner(ws);
  }

  private teardownPartner(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || att.role === "control") return;
    if (att.id) this.pendingClientFrames.delete(att.id);
    const partner = this.partnerOf(ws, att);
    if (partner) {
      try {
        partner.close(CLOSE_PARTNER_CLOSED, "partner closed");
      } catch {
        // already closing
      }
    }
  }

  private async ensureSweepScheduled(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const byId = new Map<string, { sockets: WebSocket[]; maxTs: number }>();
    let remaining = 0;
    for (const ws of this.state.getWebSockets()) {
      remaining += 1;
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att?.id) continue;
      const entry = byId.get(att.id) ?? { sockets: [], maxTs: 0 };
      entry.sockets.push(ws);
      entry.maxTs = Math.max(entry.maxTs, att.ts);
      byId.set(att.id, entry);
    }

    for (const entry of byId.values()) {
      if (now - entry.maxTs < IDLE_MS) continue;
      for (const ws of entry.sockets) {
        try {
          ws.close(CLOSE_IDLE, "idle timeout");
          remaining -= 1;
        } catch {
          // already closing
        }
      }
    }

    if (remaining > 0) {
      await this.state.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
  }
}
