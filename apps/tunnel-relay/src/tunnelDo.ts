import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  CONNECTION_ID_PATTERN,
  CONTROL_EPOCH_PATTERN,
  constantTimeEqual,
  DEFAULT_MAX_TUNNELS_PER_MACHINE,
  generateConnectionId,
  jsonResponse,
  routeTunnelPath,
  verifySignedQuery,
  type TunnelRelayEnv,
} from "./relay";

// Application close codes must live in 4000-4999. Documented in the README.
export const CLOSE_PARTNER_CLOSED = 4000; // the other end closed without an application code
export const CLOSE_HOST_OFFLINE = 4501; // no usable host control/bridge socket
export const CLOSE_IDLE = 4502; // pipe pair idle past IDLE_MS, swept by the alarm
export const CLOSE_TOO_MANY = 4503; // machine already at MAX_TUNNELS_PER_MACHINE
export const CLOSE_CLIENT_GONE = 4504; // pipe arrived but its phone had already left
export const CLOSE_CONTROL_REPLACED = 4505; // a newer host control socket took over
export const CLOSE_PRE_PIPE_BUFFER_OVERFLOW = 4506; // bounded early-frame buffer overflow
export const CLOSE_BRIDGE_REJECTED = 4507; // host rejected an open it could not service
export const CLOSE_STALE_PIPE = 4508; // pipe epoch/id did not match one pending client
export const CLOSE_FORWARD_FAILED = 4509; // one side could not receive a forwarded frame
export const CLOSE_NOT_READY = 4510; // v2 client sent data before relay readiness

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
// Persisting last-activity into the socket attachment on every frame would be
// wasteful; a 60s granularity is plenty against a 10-minute idle threshold.
const ACTIVITY_WRITE_THROTTLE_MS = 60 * 1000;
// Legacy clients send hello before the bridge is ready. Keep a bounded,
// in-memory-only fallback for them. Ready-v2 clients send no ADE frames until
// the host confirms both relay pipe and local bridge are open, so hibernation
// cannot lose their first protocol frame and no per-frame DO storage is needed.
const MAX_BUFFERED_CLIENT_FRAMES = 64;
const MAX_BUFFERED_CLIENT_BYTES = 256 * 1024;
export const RELAY_READY_VERSION = 2;
export const LEGACY_CONTROL_EPOCH = "legacy-v1";
const MAX_CLOSE_REASON_BYTES = 123;
const WS_OPEN = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function applicationCloseCode(code: unknown, fallback: number): number {
  return typeof code === "number" && Number.isInteger(code) && code >= 4000 && code <= 4999
    ? code
    : fallback;
}

function sanitizedCloseReason(reason: unknown, fallback: string): string {
  const raw = typeof reason === "string" ? reason : "";
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || fallback;
  const encoded = textEncoder.encode(clean);
  if (encoded.byteLength <= MAX_CLOSE_REASON_BYTES) return clean;
  return textDecoder.decode(encoded.slice(0, MAX_CLOSE_REASON_BYTES)).replace(/\uFFFD$/, "").trimEnd();
}

function bufferedFrameBytes(message: string | ArrayBuffer): number {
  return typeof message === "string" ? textEncoder.encode(message).byteLength : message.byteLength;
}

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
  /** Absent on sockets hibernated by the pre-epoch Worker. */
  epoch?: string;
  readyVersion?: typeof RELAY_READY_VERSION;
  established?: boolean;
  /** Legacy pre-ready bytes exist only in this instance's bounded memory. */
  legacyBuffered?: true;
  /** Pre-deploy data socket whose volatile pre-ready state cannot be proven. */
  legacyStateUnknown?: true;
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
  // Bounded fallback only for clients that predate ready-v2. New clients never
  // send ADE frames before ready, so hibernation does not depend on this map.
  private readonly pendingClientFrames = new Map<
    string,
    { frames: (string | ArrayBuffer)[]; bytes: number }
  >();
  private readonly terminalSocketLogs = new WeakSet<WebSocket>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: TunnelRelayEnv,
  ) {}

  /** One-time deploy migration for hibernated pre-epoch socket attachments. */
  private normalizedAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment?.role) return null;
    if (attachment.epoch) return attachment;
    const migrated = {
      ...attachment,
      epoch: LEGACY_CONTROL_EPOCH,
      ...(attachment.role !== "control" && !attachment.established
        ? { legacyStateUnknown: true as const }
        : {}),
    } satisfies SocketAttachment;
    ws.serializeAttachment(migrated);
    return migrated;
  }

  private epochOf(attachment: SocketAttachment | null): string | null {
    return attachment?.epoch ?? (attachment?.role ? LEGACY_CONTROL_EPOCH : null);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = routeTunnelPath(url.pathname);
    if (!route) return new Response("not found", { status: 404 });

    if (route.kind === "claim") return this.handleClaim(request);
    if (route.kind === "host") return this.handleHost(request, url, route.machineKey);
    if (route.kind === "pipe") return this.handlePipe(request, url, route.machineKey, route.id);
    if (route.kind === "connect") return this.handleConnect(request, url);
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
    if (!secret) {
      logTunnel("auth_failed", { role: "host", machineKey: machineKey.slice(0, 8), reason: "unknown_machine" });
      return new Response("unknown machine", { status: 401 });
    }
    const ts = url.searchParams.get("ts") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    const requestedEpoch = url.searchParams.get("epoch")?.trim() ?? "";
    if (requestedEpoch && !CONTROL_EPOCH_PATTERN.test(requestedEpoch)) {
      return new Response("invalid epoch", { status: 401 });
    }
    const epoch = requestedEpoch || LEGACY_CONTROL_EPOCH;
    const verified = await verifySignedQuery({
      secret,
      base: requestedEpoch
        ? buildHostSignatureBase(machineKey, requestedEpoch, ts)
        : buildHostSignatureBase(machineKey, ts),
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
      const attachment = this.normalizedAttachment(existing);
      if (attachment?.role === "control") {
        this.closePendingForControlEpoch(
          this.epochOf(attachment) ?? LEGACY_CONTROL_EPOCH,
          CLOSE_CONTROL_REPLACED,
          "control replaced",
        );
      }
      try {
        existing.close(CLOSE_CONTROL_REPLACED, "replaced by newer host");
      } catch {
        // already closing
      }
    }
    logTunnel("host_registered", { machineKey: machineKey.slice(0, 8) });
    return this.acceptSocket({ role: "control", epoch });
  }

  private async handlePipe(request: Request, url: URL, machineKey: string, id: string): Promise<Response> {
    const notWs = await this.requireWebSocket(request);
    if (notWs) return notWs;
    const secret = await this.loadSecret();
    if (!secret) {
      logTunnel("auth_failed", { role: "pipe", machineKey: machineKey.slice(0, 8), reason: "unknown_machine" });
      return new Response("unknown machine", { status: 401 });
    }
    const ts = url.searchParams.get("ts") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    const requestedEpoch = url.searchParams.get("epoch")?.trim() ?? "";
    if (requestedEpoch && !CONTROL_EPOCH_PATTERN.test(requestedEpoch)) {
      return new Response("invalid epoch", { status: 401 });
    }
    const epoch = requestedEpoch || LEGACY_CONTROL_EPOCH;
    const verified = await verifySignedQuery({
      secret,
      base: requestedEpoch
        ? buildPipeSignatureBase(machineKey, id, requestedEpoch, ts)
        : buildPipeSignatureBase(machineKey, id, ts),
      timestamp: ts,
      signature: sig,
    });
    if (!verified.ok) return new Response(verified.reason, { status: 401 });

    const client = this.clientForId(id, epoch);
    if (!client) {
      // The phone hung up (or timed out) before the host's pipe arrived.
      return this.acceptSocket({ role: "pipe", id, epoch }, (server) => {
        try {
          server.close(CLOSE_STALE_PIPE, "stale pipe");
        } catch {
          // already closing
        }
      });
    }
    if (this.pipeForId(id, epoch)) {
      return this.acceptSocket({ role: "pipe", id, epoch }, (server) => {
        try {
          server.close(CLOSE_STALE_PIPE, "duplicate pipe");
        } catch {
          // already closing
        }
      });
    }
    const control = this.currentControl();
    const controlAttachment = control ? this.normalizedAttachment(control) : null;
    if (this.epochOf(controlAttachment) !== epoch) {
      return this.acceptSocket({ role: "pipe", id, epoch }, (server) => {
        try {
          server.close(CLOSE_STALE_PIPE, "stale control epoch");
        } catch {
          // already closing
        }
      });
    }
    // Pairing is not data-ready until the brain confirms its local bridge is
    // also OPEN with an epoch-matched control {t:"ready"} message. A legacy
    // pipe arrival already proves its old Node bridge is OPEN, so that branch
    // becomes ready immediately for both old and ready-v2 clients.
    const response = await this.acceptSocket({ role: "pipe", id, epoch });
    if (!requestedEpoch) this.markPairReady(id, epoch);
    return response;
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    const notWs = await this.requireWebSocket(request);
    if (notWs) return notWs;
    const control = this.currentControl();
    if (!control) {
      // No host is registered — accept then close so the phone gets a clean,
      // distinguishable code rather than a bare handshake failure.
      logTunnel("connect_rejected", { reason: "host_offline" });
      return this.acceptSocket({ role: "client", epoch: "offline" }, (server) => {
        try {
          server.close(CLOSE_HOST_OFFLINE, "host offline");
        } catch {
          // already closing
        }
      });
    }

    const activeClients = this.openSocketsForRole("client").length;
    const maxTunnels = this.maxTunnels();
    if (activeClients >= maxTunnels) {
      logTunnel("connect_rejected", { reason: "too_many", activeClients, maxTunnels });
      const controlAttachment = this.normalizedAttachment(control);
      return this.acceptSocket({
        role: "client",
        epoch: this.epochOf(controlAttachment) ?? LEGACY_CONTROL_EPOCH,
      }, (server) => {
        try {
          server.close(CLOSE_TOO_MANY, "too many tunnels");
        } catch {
          // already closing
        }
      });
    }

    const controlAttachment = this.normalizedAttachment(control);
    const controlEpoch = this.epochOf(controlAttachment);
    if (!controlAttachment || !controlEpoch) {
      return this.acceptSocket({ role: "client", epoch: "offline" }, (server) => {
        try {
          server.close(CLOSE_HOST_OFFLINE, "host offline");
        } catch {
          // already closing
        }
      });
    }
    const readyVersion = url.searchParams.get("ready") === String(RELAY_READY_VERSION)
      ? RELAY_READY_VERSION
      : undefined;
    const id = generateConnectionId();
    let negotiationAccepted = true;
    const response = await this.acceptSocket({
      role: "client",
      id,
      epoch: controlEpoch,
      ...(readyVersion ? { readyVersion } : {}),
    }, (server) => {
      if (!readyVersion) return;
      try {
        // This immediate frame distinguishes a ready-v2 Worker from an older
        // Worker that ignores `?ready=2`. It must precede the control open.
        server.send(JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }));
      } catch {
        negotiationAccepted = false;
        this.closePair(server, this.normalizedAttachment(server), CLOSE_FORWARD_FAILED, "relay negotiation failed");
      }
    });
    if (!negotiationAccepted) return response;
    try {
      // Released hosts (and the new Node client's legacy fallback) accept the
      // historical open shape strictly. A migrated pre-epoch control must
      // therefore never receive additive epoch/readiness fields.
      control.send(JSON.stringify(controlEpoch === LEGACY_CONTROL_EPOCH
        ? { t: "open", id }
        : {
            t: "open",
            id,
            epoch: controlEpoch,
            ...(readyVersion ? { readyVersion } : {}),
          }));
    } catch {
      // The control socket died between lookup and signaling. Do not leave the
      // phone occupying a tunnel slot while it waits for a pipe that cannot come.
      logTunnel("connect_rejected", { reason: "host_offline" });
      const client = this.clientForId(id, controlEpoch);
      try {
        client?.close(CLOSE_HOST_OFFLINE, "host offline");
      } catch {
        // already closing
      }
      return response;
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
    const epoch = attachment.epoch ?? LEGACY_CONTROL_EPOCH;
    const tags: string[] = [attachment.role];
    if (attachment.id) tags.push(`conn:${attachment.id}`);
    tags.push(`epoch:${epoch}`);
    this.state.acceptWebSocket(server, tags);
    server.serializeAttachment({ ...attachment, epoch, ts: Date.now() } satisfies SocketAttachment);
    if (afterAccept) afterAccept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private isOpen(ws: WebSocket): boolean {
    return ws.readyState === WS_OPEN;
  }

  private openSocketsForRole(role: SocketRole): WebSocket[] {
    return this.state.getWebSockets(role).filter((ws) => {
      if (!this.isOpen(ws)) return false;
      const attachment = this.normalizedAttachment(ws);
      return attachment?.role === role && Boolean(this.epochOf(attachment));
    });
  }

  private currentControl(): WebSocket | null {
    return this.openSocketsForRole("control").at(-1) ?? null;
  }

  private clientForId(id: string, epoch: string): WebSocket | null {
    for (const ws of this.state.getWebSockets(`conn:${id}`)) {
      const att = this.normalizedAttachment(ws);
      if (this.isOpen(ws) && att?.role === "client" && this.epochOf(att) === epoch) return ws;
    }
    return null;
  }

  private pipeForId(id: string, epoch: string): WebSocket | null {
    for (const ws of this.state.getWebSockets(`conn:${id}`)) {
      const att = this.normalizedAttachment(ws);
      if (this.isOpen(ws) && att?.role === "pipe" && this.epochOf(att) === epoch) return ws;
    }
    return null;
  }

  private partnerOf(ws: WebSocket, att: SocketAttachment): WebSocket | null {
    if (!att.id) return null;
    const partnerRole: SocketRole | null = att.role === "client"
      ? "pipe"
      : att.role === "pipe"
        ? "client"
        : null;
    if (!partnerRole) return null;
    for (const candidate of this.state.getWebSockets(`conn:${att.id}`)) {
      if (candidate === ws || !this.isOpen(candidate)) continue;
      const candidateAttachment = this.normalizedAttachment(candidate);
      if (
        candidateAttachment?.role === partnerRole
        && this.epochOf(candidateAttachment) === this.epochOf(att)
      ) {
        return candidate;
      }
    }
    return null;
  }

  private controlMessageMatchesEpoch(messageEpoch: unknown, attachment: SocketAttachment): boolean {
    const epoch = this.epochOf(attachment);
    return epoch === LEGACY_CONTROL_EPOCH
      ? messageEpoch == null || messageEpoch === LEGACY_CONTROL_EPOCH
      : messageEpoch === epoch;
  }

  private migrateHibernatedLegacyPair(
    ws: WebSocket,
    attachment: SocketAttachment,
    partner: WebSocket | null,
  ): SocketAttachment | null {
    if (!attachment.legacyStateUnknown || !attachment.id || !partner) return null;
    const partnerAttachment = this.normalizedAttachment(partner);
    if (
      !partnerAttachment?.legacyStateUnknown
      || partnerAttachment.id !== attachment.id
      || this.epochOf(partnerAttachment) !== LEGACY_CONTROL_EPOCH
    ) {
      return null;
    }
    const now = Date.now();
    const {
      legacyBuffered: _sourceBuffered,
      legacyStateUnknown: _sourceUnknown,
      ...sourceAttachment
    } = attachment;
    const {
      legacyBuffered: _partnerBuffered,
      legacyStateUnknown: _partnerUnknown,
      ...cleanPartnerAttachment
    } = partnerAttachment;
    const migratedSource = { ...sourceAttachment, established: true, ts: now } satisfies SocketAttachment;
    ws.serializeAttachment(migratedSource);
    partner.serializeAttachment({
      ...cleanPartnerAttachment,
      established: true,
      ts: now,
    } satisfies SocketAttachment);
    return migratedSource;
  }

  private maxTunnels(): number {
    const raw = Number(this.env.MAX_TUNNELS_PER_MACHINE ?? DEFAULT_MAX_TUNNELS_PER_MACHINE);
    return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : DEFAULT_MAX_TUNNELS_PER_MACHINE;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let att = this.normalizedAttachment(ws);
    if (!att) return;

    if (att.role === "control") {
      // Native WebSocket ping/pong frames are handled by the Cloudflare edge
      // without waking this object. The JSON ping branch remains only for old
      // hosts; unknown types stay ignored for forward/backward compatibility.
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as {
            t?: unknown;
            id?: unknown;
            epoch?: unknown;
            code?: unknown;
            reason?: unknown;
          };
          if (parsed?.t === "ping") {
            ws.send(JSON.stringify({ t: "pong" }));
          } else if (
            parsed?.t === "reject"
            && typeof parsed.id === "string"
            && CONNECTION_ID_PATTERN.test(parsed.id)
            && this.controlMessageMatchesEpoch(parsed.epoch, att)
          ) {
            const epoch = this.epochOf(att) ?? LEGACY_CONTROL_EPOCH;
            const client = this.clientForId(parsed.id, epoch);
            if (!client) return;
            const clientAttachment = client.deserializeAttachment() as SocketAttachment | null;
            if (clientAttachment?.established) return;
            const code = applicationCloseCode(parsed.code, CLOSE_BRIDGE_REJECTED);
            const reason = sanitizedCloseReason(parsed.reason, "bridge rejected");
            this.pendingClientFrames.delete(parsed.id);
            logTunnel("connect_rejected", { reason: "bridge_rejected", code });
            this.closePair(client, clientAttachment, code, reason);
          } else if (
            parsed?.t === "ready"
            && typeof parsed.id === "string"
            && CONNECTION_ID_PATTERN.test(parsed.id)
            && this.controlMessageMatchesEpoch(parsed.epoch, att)
          ) {
            this.markPairReady(parsed.id, this.epochOf(att) ?? LEGACY_CONTROL_EPOCH);
          }
        } catch {
          // ignore malformed control frames
        }
      }
      return;
    }

    let partner = this.partnerOf(ws, att);
    if (att.legacyStateUnknown) {
      const migrated = this.migrateHibernatedLegacyPair(ws, att, partner);
      if (!migrated) {
        this.closePair(ws, att, CLOSE_FORWARD_FAILED, "legacy relay state unavailable after deploy");
        return;
      }
      att = migrated;
      partner = this.partnerOf(ws, att);
    }
    // A pair hibernated by the legacy Worker has neither epoch nor established
    // markers. The complementary socket itself proves that old pairing was
    // complete, so migrate it before forwarding the first post-deploy frame.
    if (!att.established && this.epochOf(att) === LEGACY_CONTROL_EPOCH && partner && att.id) {
      this.markPairReady(att.id, LEGACY_CONTROL_EPOCH);
      att = this.normalizedAttachment(ws);
      if (!att || !this.isOpen(ws)) return;
      partner = this.partnerOf(ws, att);
    }
    if (att.established) {
      if (!partner) {
        this.closePair(ws, att, CLOSE_FORWARD_FAILED, "relay partner unavailable");
        return;
      }
      try {
        partner.send(message);
      } catch {
        this.closePair(ws, att, CLOSE_FORWARD_FAILED, "relay forwarding failed");
        return;
      }
    } else if (att.role === "client" && att.id) {
      if (att.readyVersion === RELAY_READY_VERSION) {
        this.closePair(ws, att, CLOSE_NOT_READY, "relay bridge not ready");
        return;
      }
      if (att.legacyBuffered && !this.pendingClientFrames.has(att.id)) {
        this.closePair(ws, att, CLOSE_FORWARD_FAILED, "legacy pre-ready buffer unavailable");
        return;
      }
      // Pipe not attached yet — hold the frame so the phone's hello isn't lost.
      const buffered = this.pendingClientFrames.get(att.id) ?? { frames: [], bytes: 0 };
      const nextBytes = buffered.bytes + bufferedFrameBytes(message);
      if (buffered.frames.length >= MAX_BUFFERED_CLIENT_FRAMES || nextBytes > MAX_BUFFERED_CLIENT_BYTES) {
        // Dropping mid-stream would corrupt the byte-for-byte sync protocol;
        // fail the tunnel loudly so the phone reconnects instead of hanging.
        this.pendingClientFrames.delete(att.id);
        try {
          ws.close(CLOSE_PRE_PIPE_BUFFER_OVERFLOW, "pre-pipe buffer overflow");
        } catch {
          // already closing
        }
        return;
      }
      buffered.frames.push(message);
      buffered.bytes = nextBytes;
      this.pendingClientFrames.set(att.id, buffered);
      if (!att.legacyBuffered) {
        // One attachment write per legacy connection records only that volatile
        // buffered data exists, never the ADE frame/token itself. A reconstructed
        // instance can then fail loudly instead of silently losing the hello.
        att = { ...att, legacyBuffered: true, ts: Date.now() };
        ws.serializeAttachment(att satisfies SocketAttachment);
      }
    } else if (att.role === "pipe") {
      this.closePair(ws, att, CLOSE_NOT_READY, "relay bridge not ready");
      return;
    }
    this.touch(ws, att);
  }

  private touch(ws: WebSocket, att: SocketAttachment): void {
    const now = Date.now();
    if (now - att.ts < ACTIVITY_WRITE_THROTTLE_MS) return;
    ws.serializeAttachment({ ...att, ts: now } satisfies SocketAttachment);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    this.logSocketTerminal(ws, "socket_closed", code, reason || "peer closed");
    this.teardownPartner(ws, code, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.logSocketTerminal(ws, "socket_error", CLOSE_PARTNER_CLOSED, "websocket error");
    this.teardownPartner(ws, CLOSE_PARTNER_CLOSED, "partner error");
  }

  private logSocketTerminal(ws: WebSocket, kind: "socket_closed" | "socket_error", code: number, reason: string): void {
    if (this.terminalSocketLogs.has(ws)) return;
    this.terminalSocketLogs.add(ws);
    const attachment = this.normalizedAttachment(ws);
    logTunnel(kind, {
      role: attachment?.role ?? null,
      connectionId: attachment?.id ?? null,
      epochMode: this.epochOf(attachment) === LEGACY_CONTROL_EPOCH ? "legacy" : "epoch",
      code,
      reason: sanitizedCloseReason(reason, kind === "socket_error" ? "websocket error" : "peer closed"),
      established: attachment?.established === true,
    });
  }

  private teardownPartner(ws: WebSocket, sourceCode: number, sourceReason: string): void {
    const att = this.normalizedAttachment(ws);
    if (!att) return;
    if (att.role === "control") {
      this.closePendingForControlEpoch(
        this.epochOf(att) ?? LEGACY_CONTROL_EPOCH,
        sourceCode === CLOSE_CONTROL_REPLACED ? CLOSE_CONTROL_REPLACED : CLOSE_HOST_OFFLINE,
        sourceReason || "host offline",
      );
      return;
    }
    if (att.id) this.pendingClientFrames.delete(att.id);
    const partner = this.partnerOf(ws, att);
    if (partner) {
      const code = applicationCloseCode(sourceCode, CLOSE_PARTNER_CLOSED);
      const reason = sanitizedCloseReason(sourceReason, "partner closed");
      try {
        partner.close(code, reason);
      } catch {
        // already closing
      }
    }
  }

  private markPairReady(id: string, epoch: string): void {
    const client = this.clientForId(id, epoch);
    const pipe = this.pipeForId(id, epoch);
    if (!client || !pipe) {
      if (client) {
        const clientAttachment = client.deserializeAttachment() as SocketAttachment | null;
        this.closePair(client, clientAttachment, CLOSE_BRIDGE_REJECTED, "relay pipe unavailable");
      }
      return;
    }
    const clientAttachment = this.normalizedAttachment(client);
    const pipeAttachment = this.normalizedAttachment(pipe);
    if (!clientAttachment || !pipeAttachment || clientAttachment.established || pipeAttachment.established) return;
    if (clientAttachment.legacyStateUnknown || pipeAttachment.legacyStateUnknown) {
      this.closePair(client, clientAttachment, CLOSE_FORWARD_FAILED, "legacy relay state unavailable after deploy");
      return;
    }
    const buffered = this.pendingClientFrames.get(id);
    if (clientAttachment.legacyBuffered && !buffered) {
      this.closePair(client, clientAttachment, CLOSE_FORWARD_FAILED, "legacy pre-ready buffer unavailable");
      return;
    }
    try {
      if (clientAttachment.readyVersion === RELAY_READY_VERSION) {
        client.send(JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }));
      } else {
        for (const frame of buffered?.frames ?? []) pipe.send(frame);
      }
    } catch {
      this.closePair(client, clientAttachment, CLOSE_FORWARD_FAILED, "relay readiness forwarding failed");
      return;
    }
    this.pendingClientFrames.delete(id);
    const now = Date.now();
    const {
      legacyBuffered: _legacyBuffered,
      legacyStateUnknown: _legacyStateUnknown,
      ...cleanClientAttachment
    } = clientAttachment;
    client.serializeAttachment({ ...cleanClientAttachment, established: true, ts: now } satisfies SocketAttachment);
    pipe.serializeAttachment({ ...pipeAttachment, established: true, ts: now } satisfies SocketAttachment);
  }

  private closePair(
    socket: WebSocket,
    attachment: SocketAttachment | null,
    code: number,
    reason: string,
  ): void {
    const closeCode = applicationCloseCode(code, CLOSE_FORWARD_FAILED);
    const closeReason = sanitizedCloseReason(reason, "relay forwarding failed");
    if (closeCode === CLOSE_FORWARD_FAILED) {
      logTunnel("forward_failed", {
        connectionId: attachment?.id ?? null,
        sourceRole: attachment?.role ?? null,
        reason: closeReason,
      });
    }
    if (attachment?.id) this.pendingClientFrames.delete(attachment.id);
    const partner = attachment ? this.partnerOf(socket, attachment) : null;
    for (const candidate of [socket, partner]) {
      if (!candidate) continue;
      try {
        candidate.close(closeCode, closeReason);
      } catch {
        // already closing
      }
    }
  }

  private closePendingForControlEpoch(epoch: string, code: number, reason: string): void {
    for (const client of this.openSocketsForRole("client")) {
      let attachment = this.normalizedAttachment(client);
      if (
        attachment?.id
        && !attachment.established
        && epoch === LEGACY_CONTROL_EPOCH
        && this.pipeForId(attachment.id, epoch)
      ) {
        this.markPairReady(attachment.id, epoch);
        attachment = this.normalizedAttachment(client);
      }
      if (!attachment || this.epochOf(attachment) !== epoch || attachment.established) continue;
      this.closePair(client, attachment, code, reason);
    }
  }

  private async ensureSweepScheduled(): Promise<void> {
    const hasNonControlSocket = this.state.getWebSockets().some((ws) => {
      const att = this.normalizedAttachment(ws);
      return att?.role === "client" || att?.role === "pipe";
    });
    if (hasNonControlSocket && (await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const byId = new Map<string, { sockets: WebSocket[]; maxTs: number }>();
    let remainingNonControl = 0;
    for (const ws of this.state.getWebSockets()) {
      const att = this.normalizedAttachment(ws);
      if (att?.role !== "client" && att?.role !== "pipe") continue;
      remainingNonControl += 1;
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
          remainingNonControl -= 1;
        } catch {
          // already closing
        }
      }
    }

    if (remainingNonControl > 0) {
      await this.state.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
  }
}
