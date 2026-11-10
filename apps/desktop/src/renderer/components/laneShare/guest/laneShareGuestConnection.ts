import { LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS, type LaneShareGuestState } from "../../../../shared/laneShareRights";
import type { LaneShareConnectTicket, LaneShareGuestBridge } from "../../../../shared/types/laneShare";
import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import {
  SYNC_CHUNKED_ENVELOPES_CAPABILITY,
  type SyncCommandResultPayload,
  type SyncDpopProof,
  type SyncEnvelope,
  type SyncHelloErrorPayload,
  type SyncHelloOkPayload,
  type SyncHelloPayload,
  type SyncHeartbeatPayload,
} from "../../../../shared/types/sync";
import { isChatToolType } from "../../../../shared/sessionSpawnNesting";
import { isTrackedAgentCliToolType, type TerminalToolType } from "../../../../shared/types/sessions";
import { dpopPublicKeyThumbprint, exportPublicKeyX963Base64, generateDpopKeyPair, signDpopProof } from "../../../webclient/sync/dpop";
import { randomHex } from "../../../webclient/sync/ids";
import { relayTransportFrame, withRelayReadyNegotiation } from "../../../webclient/sync/relayReady";
import {
  createEnvelopeChunkAssembler,
  decodeEnvelopeText,
  encodeEnvelopeText,
  parseEnvelopeChunkPayload,
} from "../../../webclient/sync/wireProtocol";

/**
 * The guest's connection to the machine of another person that shares ONE
 * lane with this account (lane sharing, README "Lane sharing").
 *
 * It is kept apart from the owner's paired sync connection by construction:
 * - It is its own class. It never registers as a sync client, never touches a
 *   project database, and has no changeset or catalog path at all: an inbound
 *   envelope of a type not in `GUEST_INBOUND_TYPES` is dropped.
 * - Its hello carries only `{kind:"guest", deviceId, ticket, dpop}`
 *   (`buildLaneShareGuestHello`). No account token, relay token or pairing
 *   secret exists in this module.
 * - Every session envelope must name a session of the granted lane that this
 *   connection listed and subscribed to; everything else is dropped.
 * - Commands go only through `GUEST_ACTIONS`, with no project id.
 * - What the host sends is data of another person: this module hands it to
 *   the guest view as plain values and runs nothing because of it.
 *
 * The DPoP key is made per connection object, in memory, not extractable.
 * A ticket is used once and never stored or logged; each reconnect asks the
 * account directory for a new one.
 */

/** Session kinds as the guest sees them. */
export type LaneShareGuestSessionKind = "chat" | "subagent" | "cli" | "shell";

export type LaneShareGuestSession = {
  sessionId: string;
  laneId: string;
  kind: LaneShareGuestSessionKind;
  title: string;
  status: string;
  toolType: string | null;
  parentSessionId: string | null;
  startedAt: string | null;
  /** A CLI session's launch model and mode, as the host sends them (hidden models come as null). */
  modelId: string | null;
  permissionMode: string | null;
};

export type LaneShareGuestStopReason =
  | "ended"
  | "not_for_account"
  | "signed_out"
  | "paused"
  | "refused"
  | "old_host"
  | "access_changed"
  | "untrusted_relay"
  | "closed";

export type LaneShareGuestConnectionState =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; hostName: string | null; hostPlatform: string | null; selfUserId: string | null }
  | { kind: "retrying"; attempt: number; retryAt: number; message: string }
  | { kind: "host_offline"; retryAt: number; message: string }
  | { kind: "stopped"; reason: LaneShareGuestStopReason; message: string };

export type LaneShareGuestChatSnapshot = {
  sessionId: string;
  events: AgentChatEventEnvelope[];
  turnActive: boolean | null;
  truncated: boolean;
};

export type LaneShareGuestTerminalEvent =
  | { kind: "snapshot"; sessionId: string; transcript: string; delta: boolean }
  | { kind: "data"; sessionId: string; data: string }
  | { kind: "exit"; sessionId: string; exitCode: number | null };

export type LaneShareGuestConnectionEvents = {
  state: (state: LaneShareGuestConnectionState) => void;
  sessions: (sessions: LaneShareGuestSession[]) => void;
  chatSnapshot: (snapshot: LaneShareGuestChatSnapshot) => void;
  chatEvent: (envelope: AgentChatEventEnvelope) => void;
  terminal: (event: LaneShareGuestTerminalEvent) => void;
  /** The host closed and opened again with other rights; re-read the guest state. */
  accessChanged: () => void;
  /** The host says presence, rights or limits changed (no data); re-read the guest state. */
  guestStateChanged: () => void;
};

/** A socket as the browser and Electron renderer give it. */
export type LaneShareGuestSocket = {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type LaneShareGuestConnectionOptions = {
  grantId: string;
  /** The granted lane, from the received list. hello_ok must name it. */
  laneId: string;
  directory: Pick<LaneShareGuestBridge, "connect">;
  createSocket?: (url: string) => LaneShareGuestSocket;
  /** A short name of this device for the host's logs (the host shows its own label). */
  deviceName?: string;
  now?: () => number;
};

/** Envelope types a guest connection reads. Every other type is dropped. */
const GUEST_INBOUND_TYPES: ReadonlySet<string> = new Set([
  "hello_ok",
  "hello_error",
  "heartbeat",
  "command_ack",
  "command_result",
  "chat_subscribe",
  "chat_event",
  "terminal_snapshot",
  "terminal_data",
  "terminal_exit",
  "terminal_input_ack",
  "lane_share_guest_changed",
  "envelope_chunk",
]);

/**
 * Commands this client sends, and where its lane or session id goes. The
 * host keeps its own, longer list and decides; this list only keeps the
 * client from asking for anything else.
 */
const GUEST_ACTIONS: Readonly<Record<string, "lane" | "session" | "none">> = Object.freeze({
  "laneShare.getGuestState": "none",
  "work.listSessions": "lane",
  "chat.create": "lane",
  "chat.send": "session",
  "chat.steer": "session",
  "chat.interrupt": "session",
  "chat.createDraft": "session",
  "chat.updateSession": "session",
  "chat.approve": "session",
  "chat.respondToInput": "session",
  "chat.getSummary": "session",
  "chat.listThreadComments": "session",
  "chat.createThreadComment": "session",
  "work.startCliSession": "lane",
});

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const HOST_OFFLINE_RETRY_MS = 60_000;
const OPEN_TIMEOUT_MS = 15_000;
const HELLO_TIMEOUT_MS = 20_000;
const RELAY_READY_WINDOW_MS = 4_000;
const COMMAND_TIMEOUT_MS = 45_000;
const INBOUND_STALE_MS = 75_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const CHAT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const TERMINAL_SNAPSHOT_MAX_BYTES = 256 * 1024;
/** The host answers each typed line (taken, or refused with its reason); no answer in time reads as lost. */
const TERMINAL_INPUT_TIMEOUT_MS = 10_000;
/** The host's close code for a guest it stops (`ws.close(4003, reason)`). */
const HOST_GUEST_CLOSE_CODE = 4003;
const HOST_ENDED_REASON = "Lane share ended";
/** ADE Relay: the owner's computer has no live connection to the relay (`tunnelDo.ts`). */
const RELAY_HOST_OFFLINE_CODE = 4501;
const SOCKET_OPEN = 1;

/** Hello errors that end the attempt with a clear state (no retry loop). */
const OLD_HOST_MESSAGE = "The owner's computer needs an ADE update to share lanes.";
const STOP_CODES: Readonly<Record<string, LaneShareGuestStopReason>> = {
  lane_share_refused: "refused",
  lane_share_paused: "paused",
  invalid_hello: "old_host",
  unsupported_auth: "old_host",
  protocol_version_mismatch: "old_host",
};

export type LaneShareGuestHelloInput = {
  deviceId: string;
  deviceName: string;
  siteId: string;
  ticket: string;
  dpop: SyncDpopProof;
};

/**
 * The guest hello, and nothing else: the ticket from the account directory
 * and a DPoP proof over it. No account token, relay token or pairing secret.
 */
export function buildLaneShareGuestHello(input: LaneShareGuestHelloInput): SyncHelloPayload {
  return {
    peer: {
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: "unknown",
      deviceType: "browser",
      siteId: input.siteId,
      dbVersion: 0,
      capabilities: [SYNC_CHUNKED_ENVELOPES_CAPABILITY],
    },
    auth: { kind: "guest", deviceId: input.deviceId, ticket: input.ticket, dpop: input.dpop },
  };
}

function codedError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

/** A session row of the granted lane, or null for anything else. */
function guestSessionFromRow(row: unknown, laneId: string): LaneShareGuestSession | null {
  const sessionId = stringField(row, "id") ?? stringField(row, "sessionId");
  if (!sessionId || stringField(row, "laneId") !== laneId) return null;
  const toolType = stringField(row, "toolType");
  const parentSessionId = stringField(row, "orchestrationParentSessionId");
  const launch = (row as { resumeMetadata?: { launch?: unknown } | null }).resumeMetadata?.launch;
  const kind: LaneShareGuestSessionKind = isChatToolType(toolType)
    ? (parentSessionId ? "subagent" : "chat")
    : isTrackedAgentCliToolType((toolType ?? null) as TerminalToolType | null)
      ? "cli"
      : "shell";
  return {
    sessionId,
    laneId,
    kind,
    title: (stringField(row, "title") ?? "Untitled").slice(0, 300),
    status: stringField(row, "status") ?? "unknown",
    toolType,
    parentSessionId,
    startedAt: stringField(row, "startedAt"),
    modelId: stringField(launch, "model")?.slice(0, 200) ?? null,
    permissionMode: stringField(launch, "permissionMode")?.slice(0, 80) ?? null,
  };
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const sessions = result && typeof result === "object" ? (result as { sessions?: unknown }).sessions : null;
  return Array.isArray(sessions) ? sessions : [];
}

function textOf(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Listeners = { [K in keyof LaneShareGuestConnectionEvents]: Set<LaneShareGuestConnectionEvents[K]> };

export class LaneShareGuestConnection {
  readonly grantId: string;
  readonly laneId: string;
  private readonly options: LaneShareGuestConnectionOptions;
  private readonly deviceId = `lsg-${randomHex(16)}`;
  private readonly siteId = randomHex(16);
  private keyPair: Promise<CryptoKeyPair> | null = null;
  private socket: LaneShareGuestSocket | null = null;
  private generation = 0;
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS;
  private accessChangedRetry = false;
  private stateValue: LaneShareGuestConnectionState = { kind: "idle" };
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pendingInputs = new Map<string, PendingCommand & { sessionId: string }>();
  private readonly sessions = new Map<string, LaneShareGuestSession>();
  private readonly chatSubscriptions = new Set<string>();
  private readonly terminalSubscriptions = new Set<string>();
  private readonly chunks = createEnvelopeChunkAssembler({ maxConcurrentChunks: 4 });
  private readonly listeners: Listeners = {
    state: new Set(),
    sessions: new Set(),
    chatSnapshot: new Set(),
    chatEvent: new Set(),
    terminal: new Set(),
    accessChanged: new Set(),
    guestStateChanged: new Set(),
  };

  constructor(options: LaneShareGuestConnectionOptions) {
    this.options = options;
    this.grantId = options.grantId;
    this.laneId = options.laneId;
  }

  get state(): LaneShareGuestConnectionState {
    return this.stateValue;
  }

  listSessions(): LaneShareGuestSession[] {
    return [...this.sessions.values()];
  }

  on<K extends keyof LaneShareGuestConnectionEvents>(event: K, listener: LaneShareGuestConnectionEvents[K]): () => void {
    (this.listeners[event] as Set<LaneShareGuestConnectionEvents[K]>).add(listener);
    return () => {
      (this.listeners[event] as Set<LaneShareGuestConnectionEvents[K]>).delete(listener);
    };
  }

  private emit<K extends keyof LaneShareGuestConnectionEvents>(event: K, ...args: Parameters<LaneShareGuestConnectionEvents[K]>): void {
    for (const listener of this.listeners[event] as Set<(...values: unknown[]) => void>) {
      try {
        listener(...args);
      } catch {
        // A view's listener error never breaks the connection.
      }
    }
  }

  private setState(state: LaneShareGuestConnectionState): void {
    this.stateValue = state;
    this.emit("state", state);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Opens the connection (or keeps it open). Idempotent. */
  start(): void {
    if (this.wanted && this.stateValue.kind !== "stopped") return;
    this.wanted = true;
    this.attempt = 0;
    void this.open();
  }

  /** Closes the connection for good (view closed, share left). */
  stop(): void {
    this.wanted = false;
    this.clearTimers();
    this.closeSocket(1000, "Guest closed the shared lane", ["lane_share_connection_closed", "Not sent: the shared lane was closed."]);
    if (this.stateValue.kind !== "stopped") this.setState({ kind: "idle" });
  }

  /** Ask the account directory for a new ticket now (Reconnect button). */
  reconnect(): void {
    this.wanted = true;
    this.attempt = 0;
    this.accessChangedRetry = false;
    this.clearRetry();
    void this.open();
  }

  private stopWith(reason: LaneShareGuestStopReason, message: string): void {
    this.wanted = false;
    this.clearTimers();
    this.closeSocket(1000, "Guest stopped", [`lane_share_${reason}`, `Not sent: ${message}`]);
    this.setState({ kind: "stopped", reason, message });
  }

  private async open(): Promise<void> {
    if (!this.wanted) return;
    this.closeSocket(1000, "Guest reconnecting");
    const generation = this.generation;
    this.attempt += 1;
    this.setState({ kind: "connecting", attempt: this.attempt });
    let ticket: LaneShareConnectTicket;
    let keyPair: CryptoKeyPair;
    try {
      this.keyPair ??= generateDpopKeyPair({ extractable: false });
      keyPair = await this.keyPair;
      const thumbprint = await dpopPublicKeyThumbprint(keyPair.publicKey);
      ticket = await this.options.directory.connect({ grantId: this.grantId, dpopThumbprint: thumbprint });
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleDirectoryError(error);
      return;
    }
    if (generation !== this.generation || !this.wanted) return;
    if (ticket.laneId !== this.laneId) {
      this.stopWith("access_changed", "This share now names another lane. Open it again from Shared with me.");
      return;
    }
    if (!ticket.ticket || !ticket.relayUrl) {
      this.setState({
        kind: "host_offline",
        retryAt: this.now() + HOST_OFFLINE_RETRY_MS,
        message: "The owner's computer is offline. ADE tries again in a minute.",
      });
      this.scheduleRetry(HOST_OFFLINE_RETRY_MS);
      return;
    }
    this.dial(generation, ticket.relayUrl, ticket.ticket, keyPair);
  }

  private handleDirectoryError(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error ?? "");
    const match = /^(?:Error invoking remote method '[^']+':\s*)?(?:Error:\s*)?([a-z_]+):\s*(.*)$/s.exec(text);
    const code = match?.[1] ?? null;
    const message = (match?.[2] ?? text).trim();
    if (code === "share_closed") return this.stopWith("ended", "This share has ended.");
    if (code === "not_found") return this.stopWith("not_for_account", "This share is not for this account.");
    if (code === "signed_out") return this.stopWith("signed_out", "Sign in to your ADE account to open shared lanes.");
    if (code === "no_directory") {
      return this.stopWith("signed_out", "Shared lanes need your ADE account on this device. Sign in, then try again.");
    }
    if (code === "untrusted_relay") return this.stopWith("untrusted_relay", message);
    if (code === "invalid_args") return this.stopWith("refused", message || "That lane share link is not valid.");
    this.scheduleBackoff(code === "rate_limited" ? "Too many tries. ADE waits, then tries again." : "The account directory can't be reached. ADE tries again.");
  }

  private dial(generation: number, relayUrl: string, ticket: string, keyPair: CryptoKeyPair): void {
    let socket: LaneShareGuestSocket;
    try {
      const create = this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as LaneShareGuestSocket);
      socket = create(withRelayReadyNegotiation(relayUrl));
    } catch {
      this.scheduleBackoff("The connection to the owner's computer failed. ADE tries again.");
      return;
    }
    this.socket = socket;
    let helloSent = false;
    let helloDone = false;
    let relayAccepted = false;
    const deadline = setTimeout(() => {
      if (generation !== this.generation || helloDone) return;
      this.closeSocket(4000, "Guest hello timeout");
      this.scheduleBackoff("The owner's computer did not answer. ADE tries again.");
    }, OPEN_TIMEOUT_MS + HELLO_TIMEOUT_MS);
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const sendHello = async () => {
      if (helloSent || generation !== this.generation) return;
      helloSent = true;
      if (readyTimer) clearTimeout(readyTimer);
      try {
        const publicKeyX963Base64 = await exportPublicKeyX963Base64(keyPair.publicKey);
        const dpop = await signDpopProof({
          privateKey: keyPair.privateKey,
          publicKeyX963Base64,
          deviceId: this.deviceId,
          secret: ticket,
        });
        if (generation !== this.generation) return;
        socket.send(encodeEnvelopeText({
          type: "hello",
          requestId: `hello-${randomHex(8)}`,
          payload: buildLaneShareGuestHello({
            deviceId: this.deviceId,
            deviceName: (this.options.deviceName ?? "ADE guest").slice(0, 64),
            siteId: this.siteId,
            ticket,
            dpop,
          }),
        }));
      } catch {
        if (generation !== this.generation) return;
        this.closeSocket(4000, "Guest hello failed");
        this.scheduleBackoff("The connection to the owner's computer failed. ADE tries again.");
      }
    };
    socket.onopen = () => {
      if (generation !== this.generation) return;
      // The relay confirms the host side first (`accepted`, then `ready`).
      readyTimer = setTimeout(() => {
        if (generation !== this.generation || helloSent) return;
        this.closeSocket(4000, "Relay not ready");
        this.offlineOrBackoff();
      }, RELAY_READY_WINDOW_MS);
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      this.lastInboundAt = this.now();
      const transport = relayTransportFrame(event.data);
      if (transport) {
        if (transport.t === "accepted") relayAccepted = true;
        else if (relayAccepted) void sendHello();
        return;
      }
      const text = textOf(event.data);
      if (text == null) return;
      void this.receive(text, generation, {
        onHelloOk: (payload) => {
          helloDone = true;
          clearTimeout(deadline);
          this.handleHelloOk(payload, generation);
        },
        onHelloError: (payload) => {
          helloDone = true;
          clearTimeout(deadline);
          this.handleHelloError(payload);
        },
      });
    };
    socket.onerror = () => {
      // onclose follows and decides.
    };
    socket.onclose = (event) => {
      clearTimeout(deadline);
      if (readyTimer) clearTimeout(readyTimer);
      if (generation !== this.generation) return;
      this.closeSocket(1000, "Closed by the other side");
      if (!this.wanted || this.stateValue.kind === "stopped") return;
      if (event.code === HOST_GUEST_CLOSE_CODE) {
        if (event.reason === HOST_ENDED_REASON) {
          this.stopWith("ended", "The owner ended this share.");
          return;
        }
        // Access changed on the host (rights, account, paused). One new
        // ticket shows what is left; a second refusal stops with its reason.
        if (this.accessChangedRetry) {
          this.stopWith("access_changed", "Your access to this lane changed. Open it again from Shared with me.");
          return;
        }
        this.accessChangedRetry = true;
        this.attempt = 0;
        void this.open();
        return;
      }
      if (event.code === RELAY_HOST_OFFLINE_CODE) {
        this.setState({
          kind: "host_offline",
          retryAt: this.now() + HOST_OFFLINE_RETRY_MS,
          message: "The owner's computer is offline. ADE tries again in a minute.",
        });
        this.scheduleRetry(HOST_OFFLINE_RETRY_MS);
        return;
      }
      if (!helloDone) {
        this.offlineOrBackoff();
        return;
      }
      this.scheduleBackoff("The connection to the owner's computer dropped. ADE reconnects.");
    };
  }

  private offlineOrBackoff(): void {
    if (this.attempt >= 3) {
      this.setState({
        kind: "host_offline",
        retryAt: this.now() + HOST_OFFLINE_RETRY_MS,
        message: "The owner's computer is not reachable. ADE tries again in a minute.",
      });
      this.scheduleRetry(HOST_OFFLINE_RETRY_MS);
      return;
    }
    this.scheduleBackoff("The owner's computer is not reachable yet. ADE tries again.");
  }

  private handleHelloOk(payload: SyncHelloOkPayload, generation: number): void {
    const info = payload.laneShareGuest;
    const grant = info?.grants?.find((entry) => entry.grantId === this.grantId);
    if (!grant) {
      // A host that did not answer as a lane share host.
      this.stopWith("old_host", OLD_HOST_MESSAGE);
      return;
    }
    if (grant.laneId !== this.laneId) {
      this.stopWith("access_changed", "This share now names another lane. Open it again from Shared with me.");
      return;
    }
    const changed = this.accessChangedRetry;
    this.accessChangedRetry = false;
    this.attempt = 0;
    this.heartbeatIntervalMs = Math.max(5_000, Math.floor(payload.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS));
    this.startLiveTimers(generation);
    const hidden = payload.brain?.deviceName === "Shared computer" && payload.brain?.platform === "unknown";
    this.setState({
      kind: "connected",
      hostName: hidden ? null : (payload.brain?.deviceName ?? null),
      hostPlatform: hidden ? null : (payload.brain?.platform ?? null),
      selfUserId: typeof info?.userId === "string" ? info.userId : null,
    });
    if (changed) this.emit("accessChanged");
    void this.refreshSessions().catch(() => undefined);
  }

  private handleHelloError(payload: SyncHelloErrorPayload): void {
    const code = typeof payload?.code === "string" ? payload.code : "";
    const message = typeof payload?.message === "string" && payload.message.trim()
      ? payload.message.trim().slice(0, 300)
      : "The owner's computer refused the connection.";
    const stop = STOP_CODES[code];
    if (stop === "old_host") return this.stopWith("old_host", OLD_HOST_MESSAGE);
    if (stop) return this.stopWith(stop, message);
    if (code === "lane_share_unavailable") {
      this.setState({ kind: "host_offline", retryAt: this.now() + HOST_OFFLINE_RETRY_MS, message });
      this.scheduleRetry(HOST_OFFLINE_RETRY_MS);
      return;
    }
    if (code === "account_session_changed") {
      return this.stopWith("access_changed", "The owner's computer changed accounts. This share no longer works there.");
    }
    // `auth_failed` and unknown codes: a new ticket may work; a few tries, then stop.
    if (this.attempt >= 3) return this.stopWith("refused", message);
    this.scheduleBackoff(message);
  }

  private async receive(
    text: string,
    generation: number,
    hello: { onHelloOk: (payload: SyncHelloOkPayload) => void; onHelloError: (payload: SyncHelloErrorPayload) => void },
  ): Promise<void> {
    let envelope: SyncEnvelope;
    try {
      envelope = await decodeEnvelopeText(text);
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    if (envelope.type === "envelope_chunk") {
      const chunk = parseEnvelopeChunkPayload(envelope.payload);
      const assembled = chunk ? this.chunks.add(chunk) : null;
      if (!assembled) return;
      try {
        envelope = await decodeEnvelopeText(assembled);
      } catch {
        return;
      }
      if (envelope.type === "envelope_chunk" || generation !== this.generation) return;
    }
    this.route(envelope, hello);
  }

  /** Admits one envelope from the host, or drops it. */
  private route(
    envelope: SyncEnvelope,
    hello: { onHelloOk: (payload: SyncHelloOkPayload) => void; onHelloError: (payload: SyncHelloErrorPayload) => void },
  ): void {
    if (!GUEST_INBOUND_TYPES.has(envelope.type)) return;
    const payload = envelope.payload as Record<string, unknown> | null;
    switch (envelope.type) {
      case "hello_ok":
        if (this.stateValue.kind === "connecting") hello.onHelloOk(envelope.payload as SyncHelloOkPayload);
        return;
      case "hello_error":
        if (this.stateValue.kind === "connecting") hello.onHelloError(envelope.payload as SyncHelloErrorPayload);
        return;
      case "heartbeat": {
        const beat = envelope.payload as SyncHeartbeatPayload | null;
        if (beat?.kind === "ping") {
          this.sendEnvelope("heartbeat", { kind: "pong", sentAt: beat.sentAt ?? new Date().toISOString(), dbVersion: 0 }, envelope.requestId ?? null);
        }
        return;
      }
      case "command_ack":
        return;
      case "command_result": {
        const result = envelope.payload as SyncCommandResultPayload | null;
        const pending = result?.commandId ? this.pending.get(result.commandId) : undefined;
        if (!pending || !result) return;
        this.pending.delete(result.commandId);
        clearTimeout(pending.timer);
        if (result.ok) {
          pending.resolve(result.result);
        } else {
          const code = typeof result.error?.code === "string" ? result.error.code : "command_failed";
          const message = typeof result.error?.message === "string" ? result.error.message.slice(0, 300) : "The owner's computer refused this.";
          pending.reject(codedError(code, message));
        }
        return;
      }
      case "chat_subscribe": {
        const sessionId = stringField(payload, "sessionId");
        if (!sessionId || !this.chatSubscriptions.has(sessionId) || !this.sessions.has(sessionId)) return;
        const events = Array.isArray(payload?.events) ? payload.events as AgentChatEventEnvelope[] : [];
        this.emit("chatSnapshot", {
          sessionId,
          events: events.filter((entry) => entry && typeof entry === "object" && entry.sessionId === sessionId && entry.event && typeof entry.event === "object"),
          turnActive: typeof payload?.turnActive === "boolean" ? payload.turnActive : null,
          truncated: payload?.truncated === true,
        });
        return;
      }
      case "chat_event": {
        const entry = envelope.payload as AgentChatEventEnvelope | null;
        const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : null;
        if (!entry || !sessionId || !this.chatSubscriptions.has(sessionId) || !this.sessions.has(sessionId)) return;
        if (!entry.event || typeof entry.event !== "object") return;
        this.emit("chatEvent", entry);
        if (entry.event.type === "done" || (entry.event.type === "status" && entry.event.turnStatus !== "started")) {
          void this.refreshSessions().catch(() => undefined);
        }
        return;
      }
      case "terminal_snapshot":
      case "terminal_data":
      case "terminal_exit": {
        const sessionId = stringField(payload, "sessionId");
        if (!sessionId || !this.terminalSubscriptions.has(sessionId) || !this.sessions.has(sessionId)) return;
        if (envelope.type === "terminal_snapshot") {
          const transcript = typeof payload?.transcript === "string" ? payload.transcript : "";
          this.emit("terminal", { kind: "snapshot", sessionId, transcript, delta: payload?.delta === true });
        } else if (envelope.type === "terminal_data") {
          const data = typeof payload?.data === "string" ? payload.data : "";
          this.emit("terminal", { kind: "data", sessionId, data });
        } else {
          const exitCode = typeof payload?.exitCode === "number" ? payload.exitCode : null;
          this.emit("terminal", { kind: "exit", sessionId, exitCode });
        }
        return;
      }
      case "terminal_input_ack": {
        const inputId = stringField(payload, "inputId");
        const pending = inputId ? this.pendingInputs.get(inputId) : undefined;
        if (!pending || stringField(payload, "sessionId") !== pending.sessionId) return;
        this.pendingInputs.delete(inputId!);
        clearTimeout(pending.timer);
        if (payload?.ok === true) {
          pending.resolve(undefined);
        } else {
          // The host's refusal code (`lane_share_*`) and message, shown as text.
          const error = payload?.error as { code?: unknown; message?: unknown } | undefined;
          const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "terminal_input_refused";
          pending.reject(codedError(code, typeof error?.message === "string" && error.message.trim() ? error.message.slice(0, 300) : "The owner's computer did not take this line."));
        }
        return;
      }
      case "lane_share_guest_changed":
        if (stringField(payload, "grantId") === this.grantId) this.emit("guestStateChanged");
        return;
      default:
        return;
    }
  }

  private sendEnvelope(type: SyncEnvelope["type"], payload: unknown, requestId: string | null = null): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(encodeEnvelopeText({ type, requestId, payload }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One command on the shared lane. Only `GUEST_ACTIONS`; the lane id of a
   * lane command is this share's lane, never a value from the caller. Errors
   * are `code: message` (`lane_share_*` from the host).
   */
  async call<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const scope = GUEST_ACTIONS[action];
    if (!scope) throw codedError("forbidden_command", "This is not available on a shared lane.");
    if (this.stateValue.kind !== "connected") {
      throw codedError("lane_share_not_connected", "Not sent: the owner's computer is not connected.");
    }
    const { laneId: _ignored, projectId: _project, ...rest } = args;
    const commandArgs = scope === "lane" ? { ...rest, laneId: this.laneId } : rest;
    if (scope === "session") {
      const key = action === "chat.createDraft" ? "originSessionId" : "sessionId";
      const sessionId = typeof commandArgs[key] === "string" ? commandArgs[key] as string : "";
      if (!this.sessions.has(sessionId)) throw codedError("forbidden_command", "That chat is not part of this shared lane.");
    }
    const commandId = `lsg-${randomHex(12)}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(codedError("timeout", "The owner's computer did not answer in time."));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(commandId, { resolve, reject, timer });
    });
    const sent = this.sendEnvelope("command", { commandId, action, args: commandArgs }, commandId);
    if (!sent) {
      const pending = this.pending.get(commandId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(commandId);
      }
      throw codedError("lane_share_not_connected", "Not sent: the owner's computer is not connected.");
    }
    return await promise as T;
  }

  async getGuestState(): Promise<LaneShareGuestState> {
    const state = await this.call<LaneShareGuestState>("laneShare.getGuestState");
    if (!state || typeof state !== "object" || state.grantId !== this.grantId || state.laneId !== this.laneId) {
      throw codedError("lane_share_unavailable", "The owner's computer sent an answer for another share.");
    }
    return state;
  }

  /** Lists the sessions of the granted lane. Rows of any other lane are dropped. */
  async refreshSessions(): Promise<LaneShareGuestSession[]> {
    const result = await this.call("work.listSessions", { limit: 200 });
    const next = new Map<string, LaneShareGuestSession>();
    for (const row of rowsOf(result)) {
      const session = guestSessionFromRow(row, this.laneId);
      if (session) next.set(session.sessionId, session);
    }
    this.sessions.clear();
    for (const [id, session] of next) this.sessions.set(id, session);
    for (const id of [...this.chatSubscriptions]) if (!next.has(id)) this.chatSubscriptions.delete(id);
    for (const id of [...this.terminalSubscriptions]) if (!next.has(id)) this.terminalSubscriptions.delete(id);
    const list = this.listSessions();
    this.emit("sessions", list);
    return list;
  }

  /** Subscribes to one chat of the lane (a transcript tail, then live events). */
  subscribeChat(sessionId: string): () => void {
    if (!this.sessions.has(sessionId)) return () => undefined;
    this.chatSubscriptions.add(sessionId);
    this.sendEnvelope("chat_subscribe", { sessionId, maxBytes: CHAT_SNAPSHOT_MAX_BYTES });
    return () => {
      if (!this.chatSubscriptions.delete(sessionId)) return;
      this.sendEnvelope("chat_unsubscribe", { sessionId });
    };
  }

  /** Subscribes to one CLI session or shell of the lane, read only. */
  subscribeTerminal(sessionId: string): () => void {
    if (!this.sessions.has(sessionId)) return () => undefined;
    this.terminalSubscriptions.add(sessionId);
    this.sendEnvelope("terminal_subscribe", { sessionId, maxBytes: TERMINAL_SNAPSHOT_MAX_BYTES });
    return () => {
      if (!this.terminalSubscriptions.delete(sessionId)) return;
      this.sendEnvelope("terminal_unsubscribe", { sessionId });
    };
  }

  /**
   * Types one line into a CLI session of the lane, through the host's
   * `terminal_input` gate: a CLI session (never a shell), the typing right,
   * and one counted message per line. The host refuses without an answer, so
   * no answer in time reads as a refusal.
   */
  async sendTerminalLine(sessionId: string, line: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.kind !== "cli" || !this.terminalSubscriptions.has(sessionId)) {
      throw codedError("forbidden_command", "You can type only in a CLI session of this shared lane.");
    }
    if (this.stateValue.kind !== "connected") {
      throw codedError("lane_share_not_connected", "Not sent: the owner's computer is not connected.");
    }
    // One line of plain text: no control bytes, no second line.
    const text = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS);
    const inputId = `lsg-${randomHex(12)}`;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInputs.delete(inputId);
        reject(codedError("terminal_input_timeout", "The owner's computer did not answer in time. The line may not have been typed."));
      }, TERMINAL_INPUT_TIMEOUT_MS);
      this.pendingInputs.set(inputId, { resolve: resolve as (value: unknown) => void, reject, timer, sessionId });
    });
    if (!this.sendEnvelope("terminal_input", { sessionId, data: `${text}\r`, inputId })) {
      const pending = this.pendingInputs.get(inputId);
      if (pending) clearTimeout(pending.timer);
      this.pendingInputs.delete(inputId);
      throw codedError("lane_share_not_connected", "Not sent: the owner's computer is not connected.");
    }
    return await promise;
  }

  private scheduleBackoff(message: string): void {
    if (!this.wanted) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0]!;
    this.setState({ kind: "retrying", attempt: this.attempt, retryAt: this.now() + delay, message });
    this.scheduleRetry(delay);
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetry();
    if (!this.wanted) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, delayMs);
  }

  private startLiveTimers(generation: number): void {
    this.clearLiveTimers();
    this.lastInboundAt = this.now();
    const ping = () => {
      this.heartbeatTimer = setTimeout(() => {
        if (generation !== this.generation) return;
        this.sendEnvelope("heartbeat", { kind: "ping", sentAt: new Date().toISOString(), dbVersion: 0 });
        ping();
      }, this.heartbeatIntervalMs * 2);
    };
    ping();
    this.staleTimer = setInterval(() => {
      if (generation !== this.generation) return;
      if (this.now() - this.lastInboundAt <= INBOUND_STALE_MS) return;
      this.closeSocket(4000, "Guest inbound stale");
      this.scheduleBackoff("The connection to the owner's computer went quiet. ADE reconnects.");
    }, 15_000);
  }

  private clearLiveTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.heartbeatTimer = null;
    this.staleTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearTimers(): void {
    this.clearRetry();
    this.clearLiveTimers();
  }

  /**
   * Closes the socket on our side. Its onclose is ignored (the generation
   * moves on), so the caller decides what comes next. Commands in flight are
   * refused with `rejection`, never sent later.
   */
  private closeSocket(
    code: number,
    reason: string,
    rejection: [string, string] = ["lane_share_connection_lost", "Not sent: the connection to the owner's computer closed."],
  ): void {
    this.generation += 1;
    this.clearLiveTimers();
    this.chunks.reset();
    this.chatSubscriptions.clear();
    this.terminalSubscriptions.clear();
    this.rejectPending(rejection[0], rejection[1]);
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private rejectPending(code: string, message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(codedError(code, message));
      this.pending.delete(id);
    }
    for (const [id, pending] of this.pendingInputs) {
      clearTimeout(pending.timer);
      pending.reject(codedError(code, message));
      this.pendingInputs.delete(id);
    }
  }
}
