import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import YAML from "yaml";
import { WebSocket, type RawData } from "ws";
import type { Logger } from "../logging/logger";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createLaneService } from "../lanes/laneService";
import type { createCtoStateService } from "./ctoStateService";
import type { createWorkerAgentService } from "./workerAgentService";
import type { createMissionService } from "../missions/missionService";
import type {
  AgentChatEventEnvelope,
  MissionsEventPayload,
  OpenclawBridgeConfig,
  OpenclawBridgeState,
  OpenclawBridgeStatus,
  OpenclawContextPolicy,
  OpenclawInboundEnvelope,
  OpenclawMessageRecord,
  OpenclawNotificationRoute,
  OpenclawNotificationType,
  OpenclawOutboundEnvelope,
  OpenclawTargetHint,
  TestEvent,
  OrchestratorRuntimeEvent,
} from "../../../shared/types";
import { getErrorMessage, nowIso, parseIsoToEpoch, stableStringify, writeTextAtomic } from "../shared/utils";

const DEFAULT_BRIDGE_PORT = 18791;
const HTTP_BODY_LIMIT_BYTES = 1_000_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_TTL_MS = 60 * 60 * 1000;
const HISTORY_CAP = 400;
const MAX_OUTBOX_ATTEMPTS = 10;
const MAX_RECONNECT_BACKOFF_MS = 30_000;
const CONNECT_CHALLENGE_TIMEOUT_MS = 2_000;
const TICK_WATCH_FLOOR_MS = 1_000;
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type OpenclawRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type OpenclawResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { message?: string };
};

type OpenclawEventFrame = {
  type: "evt";
  event: string;
  seq?: number;
  payload?: Record<string, unknown>;
};

type PersistedIdempotencyState = Record<string, number>;

type PersistedRouteCacheEntry = {
  agentId?: string | null;
  sessionKey?: string | null;
  channel?: string | null;
  replyChannel?: string | null;
  accountId?: string | null;
  replyAccountId?: string | null;
  threadId?: string | null;
  updatedAt: string;
  expiresAt: number;
};

type PersistedRouteCache = {
  byAgentId: Record<string, PersistedRouteCacheEntry>;
};

type OutboxEntry = {
  id: string;
  envelope: OpenclawOutboundEnvelope;
  queuedAt: string;
  attempts: number;
  lastAttemptAt?: string | null;
  lastError?: string | null;
};

type PendingWsRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
};

type ConversationRoute = PersistedRouteCacheEntry & {
  sessionId?: string | null;
  targetHint?: OpenclawTargetHint | null;
};

type PendingBridgeTurn = {
  requestId: string;
  mode: "hook" | "query" | "ambient";
  route: ConversationRoute;
  sessionId: string;
  displayText: string;
  createdAt: string;
  turnId?: string;
  chunks: string[];
  outputSent: boolean;
  resolve?: (value: { reply: string; sessionId: string; route: ConversationRoute }) => void;
  reject?: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

type OpenclawBridgeServiceArgs = {
  projectRoot: string;
  adeDir: string;
  laneService: ReturnType<typeof createLaneService>;
  agentChatService: ReturnType<typeof createAgentChatService>;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  missionService?: ReturnType<typeof createMissionService> | null;
  logger?: Logger | null;
  appVersion?: string;
  onStatusChange?: (status: OpenclawBridgeStatus) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function trimToNull(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}

function summarizeMessage(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sanitizeContext(context: unknown): Record<string, unknown> | null {
  if (!isRecord(context)) return null;
  return JSON.parse(stableStringify(context)) as Record<string, unknown>;
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily: string;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    params.platform,
    params.deviceFamily,
  ].join("|");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      if (
        parsed.version === 1
        && typeof parsed.deviceId === "string"
        && typeof parsed.publicKeyPem === "string"
        && typeof parsed.privateKeyPem === "string"
      ) {
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    // fall through to regeneration
  }
  const identity = generateDeviceIdentity();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...identity }, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
  return identity;
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem)));
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function defaultConfig(): OpenclawBridgeConfig {
  return {
    enabled: false,
    bridgePort: DEFAULT_BRIDGE_PORT,
    gatewayUrl: null,
    gatewayToken: null,
    deviceToken: null,
    hooksToken: null,
    allowedAgentIds: [],
    defaultTarget: "cto",
    allowEmployeeTargets: true,
    notificationRoutes: [],
  };
}

function normalizeNotificationRoute(value: unknown): OpenclawNotificationRoute | null {
  if (!isRecord(value)) return null;
  const notificationType = trimToNull(value.notificationType);
  if (notificationType !== "mission_complete" && notificationType !== "ci_broken" && notificationType !== "blocked_run") {
    return null;
  }
  return {
    notificationType,
    agentId: trimToNull(value.agentId),
    sessionKey: trimToNull(value.sessionKey),
    enabled: value.enabled !== false,
  };
}

function normalizeTargetHint(value: unknown, fallback: OpenclawTargetHint = "cto"): OpenclawTargetHint {
  const trimmed = trimToNull(value);
  if (trimmed === "cto") return "cto";
  if (trimmed?.startsWith("agent:")) return trimmed as OpenclawTargetHint;
  return fallback;
}

function normalizeConfig(value: unknown): OpenclawBridgeConfig {
  const source = isRecord(value) ? value : {};
  const allowedAgentIds = Array.isArray(source.allowedAgentIds)
    ? [...new Set(source.allowedAgentIds.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))]
    : [];
  const notificationRoutes = Array.isArray(source.notificationRoutes)
    ? source.notificationRoutes.map(normalizeNotificationRoute).filter((entry): entry is OpenclawNotificationRoute => entry != null)
    : [];
  const bridgePort = Number(source.bridgePort);
  return {
    enabled: source.enabled === true,
    bridgePort: Number.isFinite(bridgePort) ? Math.max(0, Math.floor(bridgePort)) : DEFAULT_BRIDGE_PORT,
    gatewayUrl: trimToNull(source.gatewayUrl),
    gatewayToken: trimToNull(source.gatewayToken),
    deviceToken: trimToNull(source.deviceToken),
    hooksToken: trimToNull(source.hooksToken),
    allowedAgentIds,
    defaultTarget: normalizeTargetHint(source.defaultTarget, "cto"),
    allowEmployeeTargets: source.allowEmployeeTargets !== false,
    notificationRoutes,
  };
}

function normalizeContextPolicy(value: OpenclawContextPolicy | undefined | null): OpenclawContextPolicy {
  return {
    shareMode: value?.shareMode === "full" ? "full" : "filtered",
    blockedCategories: Array.isArray(value?.blockedCategories)
      ? [...new Set(value.blockedCategories.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))]
      : [],
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > HTTP_BODY_LIMIT_BYTES) {
        reject(new Error("Request body exceeded the 1MB limit."));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON body: ${getErrorMessage(error)}`);
  }
}

function isResponseFrame(value: unknown): value is OpenclawResponseFrame {
  return isRecord(value) && value.type === "res" && typeof value.id === "string";
}

function isEventFrame(value: unknown): value is OpenclawEventFrame {
  return isRecord(value) && value.type === "evt" && typeof value.event === "string";
}

function getRequestToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice("bearer ".length).trim();
  }
  const header = req.headers["x-openclaw-hook-token"];
  if (typeof header === "string") return header.trim();
  if (Array.isArray(header) && header[0]) return header[0].trim();
  return null;
}

function createInitialStatus(config: OpenclawBridgeConfig, deviceId: string | null): OpenclawBridgeStatus {
  return {
    state: config.enabled ? "disconnected" : "disabled",
    enabled: config.enabled,
    fallbackMode: !config.gatewayUrl,
    httpListening: false,
    bridgePort: config.bridgePort,
    gatewayUrl: config.gatewayUrl,
    deviceId,
    paired: Boolean(config.deviceToken),
    deviceTokenStored: Boolean(config.deviceToken),
    lastConnectedAt: null,
    lastEventAt: null,
    lastMessageAt: null,
    lastError: null,
    queuedMessages: 0,
  };
}

export function createOpenclawBridgeService(args: OpenclawBridgeServiceArgs) {
  const logger = args.logger ?? null;
  const secretPath = path.join(args.adeDir, "local.secret.yaml");
  const ctoDir = path.join(args.adeDir, "cto");
  const devicePath = path.join(ctoDir, "openclaw-device.json");
  const historyPath = path.join(ctoDir, "openclaw-history.json");
  const outboxPath = path.join(ctoDir, "openclaw-outbox.json");
  const idempotencyPath = path.join(ctoDir, "openclaw-idempotency.json");
  const routeCachePath = path.join(ctoDir, "openclaw-routes.json");
  fs.mkdirSync(ctoDir, { recursive: true });

  const deviceIdentity = loadOrCreateDeviceIdentity(devicePath);
  let config = readConfig();
  let history = readJsonFile<OpenclawMessageRecord[]>(historyPath, []);
  let outbox = readJsonFile<OutboxEntry[]>(outboxPath, []);
  let idempotencyState = pruneIdempotencyState(readJsonFile<PersistedIdempotencyState>(idempotencyPath, {}));
  let routeCache = readJsonFile<PersistedRouteCache>(routeCachePath, { byAgentId: {} });

  let httpServer: http.Server | null = null;
  let currentHttpPort = Number.isFinite(config.bridgePort) ? config.bridgePort : DEFAULT_BRIDGE_PORT;
  let ws: WebSocket | null = null;
  let wsConnectNonce: string | null = null;
  let wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let lastSeq: number | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let lastTickAt: number | null = null;
  let requestedStop = false;
  const pendingWsRequests = new Map<string, PendingWsRequest>();
  const pendingTurnsBySession = new Map<string, PendingBridgeTurn[]>();
  const turnBindings = new Map<string, PendingBridgeTurn>();
  const activeSessionRoutes = new Map<string, ConversationRoute>();
  let status = createInitialStatus(config, deviceIdentity.deviceId);

  function readJsonFile<T>(filePath: string, fallback: T): T {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  function writeJsonFile(filePath: string, payload: unknown): void {
    writeTextAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  function readSecretDocument(): Record<string, unknown> {
    try {
      if (!fs.existsSync(secretPath)) return {};
      const parsed = YAML.parse(fs.readFileSync(secretPath, "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeSecretDocument(doc: Record<string, unknown>): void {
    writeTextAtomic(secretPath, YAML.stringify(doc, { indent: 2 }));
  }

  function readConfig(): OpenclawBridgeConfig {
    const doc = readSecretDocument();
    return normalizeConfig(doc.openclaw);
  }

  function persistConfig(next: OpenclawBridgeConfig): void {
    const doc = readSecretDocument();
    doc.openclaw = {
      enabled: next.enabled,
      bridgePort: next.bridgePort,
      gatewayUrl: next.gatewayUrl ?? null,
      gatewayToken: next.gatewayToken ?? null,
      deviceToken: next.deviceToken ?? null,
      hooksToken: next.hooksToken ?? null,
      allowedAgentIds: next.allowedAgentIds,
      defaultTarget: next.defaultTarget,
      allowEmployeeTargets: next.allowEmployeeTargets,
      notificationRoutes: next.notificationRoutes,
    };
    writeSecretDocument(doc);
  }

  function pruneIdempotencyState(raw: PersistedIdempotencyState): PersistedIdempotencyState {
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(raw).filter(([, expiresAt]) => Number.isFinite(expiresAt) && expiresAt > now),
    );
  }

  function persistRuntimeState(): void {
    writeJsonFile(historyPath, history.slice(-HISTORY_CAP));
    writeJsonFile(outboxPath, outbox);
    writeJsonFile(idempotencyPath, idempotencyState);
    writeJsonFile(routeCachePath, routeCache);
  }

  function setStatus(patch: Partial<OpenclawBridgeStatus>): void {
    status = {
      ...status,
      ...patch,
      enabled: config.enabled,
      fallbackMode: !config.gatewayUrl,
      bridgePort: currentHttpPort,
      gatewayUrl: config.gatewayUrl,
      paired: Boolean(config.deviceToken),
      deviceTokenStored: Boolean(config.deviceToken),
      queuedMessages: outbox.length,
      deviceId: deviceIdentity.deviceId,
    };
    args.onStatusChange?.(status);
  }

  function endpoints() {
    const base = status.httpListening ? `http://127.0.0.1:${currentHttpPort}` : null;
    return {
      healthUrl: base ? `${base}/openclaw/health` : null,
      hookUrl: base ? `${base}/openclaw/hook` : null,
      queryUrl: base ? `${base}/openclaw/query` : null,
    };
  }

  function readBridgeState(): OpenclawBridgeState {
    return {
      config,
      status,
      endpoints: endpoints(),
    };
  }

  function saveHistoryRecord(record: OpenclawMessageRecord): OpenclawMessageRecord {
    history = [...history.filter((entry) => entry.id !== record.id), record]
      .sort((a, b) => parseIsoToEpoch(a.createdAt) - parseIsoToEpoch(b.createdAt))
      .slice(-HISTORY_CAP);
    persistRuntimeState();
    setStatus({ lastMessageAt: record.createdAt });
    return record;
  }

  function getHistoryMessages(limit = 40): OpenclawMessageRecord[] {
    return [...history]
      .sort((a, b) => parseIsoToEpoch(b.createdAt) - parseIsoToEpoch(a.createdAt))
      .slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
  }

  function rememberRoute(route: ConversationRoute): void {
    const expiresAt = Date.now() + ROUTE_TTL_MS;
    const stored: PersistedRouteCacheEntry = {
      agentId: route.agentId ?? null,
      sessionKey: route.sessionKey ?? null,
      channel: route.channel ?? null,
      replyChannel: route.replyChannel ?? null,
      accountId: route.accountId ?? null,
      replyAccountId: route.replyAccountId ?? null,
      threadId: route.threadId ?? null,
      updatedAt: nowIso(),
      expiresAt,
    };
    if (route.agentId) {
      routeCache.byAgentId[route.agentId] = stored;
      persistRuntimeState();
    }
  }

  function pruneRouteCache(): void {
    const now = Date.now();
    for (const [agentId, entry] of Object.entries(routeCache.byAgentId)) {
      if ((entry?.expiresAt ?? 0) <= now) {
        delete routeCache.byAgentId[agentId];
      }
    }
  }

  function markIdempotency(key: string): void {
    idempotencyState[key] = Date.now() + IDEMPOTENCY_TTL_MS;
    idempotencyState = pruneIdempotencyState(idempotencyState);
    persistRuntimeState();
  }

  function hasSeenIdempotency(key: string): boolean {
    idempotencyState = pruneIdempotencyState(idempotencyState);
    return Number.isFinite(idempotencyState[key]);
  }

  function buildReplyText(turn: PendingBridgeTurn, fallbackMessage?: string): string {
    const text = turn.chunks.join("").trim();
    if (text.length) return text;
    return fallbackMessage?.trim() || "No reply was generated.";
  }

  async function resolveLaneId(): Promise<string> {
    const sessions = await args.agentChatService.listSessions();
    const mostRecent = sessions
      .slice()
      .sort((a, b) => parseIsoToEpoch(b.lastActivityAt) - parseIsoToEpoch(a.lastActivityAt))[0];
    if (mostRecent?.laneId) return mostRecent.laneId;
    const lanes = await args.laneService.list({ includeArchived: false });
    const laneId = lanes[0]?.id ?? null;
    if (!laneId) {
      throw new Error("No lane is available to host the OpenClaw bridge session.");
    }
    return laneId;
  }

  function resolveTarget(targetHint?: OpenclawTargetHint | null): { identityKey: "cto" | `agent:${string}`; resolvedTarget: OpenclawTargetHint; fallbackReason?: string } {
    const requestedTarget = normalizeTargetHint(targetHint, config.defaultTarget);
    if (requestedTarget === "cto") {
      return { identityKey: "cto", resolvedTarget: "cto" };
    }
    if (!config.allowEmployeeTargets) {
      return {
        identityKey: "cto",
        resolvedTarget: "cto",
        fallbackReason: `Employee targets are disabled; routed ${requestedTarget} to CTO instead.`,
      };
    }
    const slug = requestedTarget.slice("agent:".length).trim().toLowerCase();
    const workers = args.workerAgentService?.listAgents({ includeDeleted: false }) ?? [];
    const match = workers.find((agent) => agent.slug.toLowerCase() === slug && agent.deletedAt == null && agent.status !== "paused");
    if (!match) {
      return {
        identityKey: "cto",
        resolvedTarget: "cto",
        fallbackReason: `Unknown or unavailable worker '${slug}'; routed to CTO instead.`,
      };
    }
    return {
      identityKey: `agent:${match.id}`,
      resolvedTarget: `agent:${match.slug}`,
    };
  }

  function applyContextPolicy(context: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    const safe = sanitizeContext(context);
    if (!safe) return null;
    const policy = normalizeContextPolicy(args.ctoStateService?.getIdentity().openclawContextPolicy);
    if (policy.shareMode === "full") return safe;
    const blocked = new Set(policy.blockedCategories.map((entry) => entry.toLowerCase()));
    if (!blocked.size) return safe;
    return Object.fromEntries(
      Object.entries(safe).filter(([key]) => !blocked.has(key.toLowerCase())),
    );
  }

  function buildPromptFromInbound(
    envelope: OpenclawInboundEnvelope,
    requestId: string,
    resolvedTarget: OpenclawTargetHint,
    fallbackReason?: string,
  ): string {
    const sections = [
      "OpenClaw bridge request. Treat this routing context as turn-scoped bridge metadata only.",
      "Do not automatically promote it to durable ADE memory.",
      `Bridge request ID: ${requestId}`,
      envelope.agentId ? `Origin agent ID: ${envelope.agentId}` : null,
      envelope.sessionKey ? `Origin session key: ${envelope.sessionKey}` : null,
      envelope.channel ? `Origin channel: ${envelope.channel}` : null,
      envelope.threadId ? `Origin thread: ${envelope.threadId}` : null,
      `Resolved target: ${resolvedTarget}`,
      fallbackReason ? `Routing note: ${fallbackReason}` : null,
      envelope.context ? `Structured bridge context:\n${JSON.stringify(envelope.context, null, 2)}` : null,
      "",
      "User message:",
      envelope.message.trim(),
    ].filter((entry): entry is string => Boolean(entry));
    return sections.join("\n");
  }

  async function ensureTargetSession(targetHint?: OpenclawTargetHint | null): Promise<{
    sessionId: string;
    routeTarget: OpenclawTargetHint;
    fallbackReason?: string;
  }> {
    const laneId = await resolveLaneId();
    const resolved = resolveTarget(targetHint);
    const session = await args.agentChatService.ensureIdentitySession({
      identityKey: resolved.identityKey,
      laneId,
    });
    return {
      sessionId: session.id,
      routeTarget: resolved.resolvedTarget,
      fallbackReason: resolved.fallbackReason,
    };
  }

  function queuePendingTurn(turn: PendingBridgeTurn): void {
    const queue = pendingTurnsBySession.get(turn.sessionId) ?? [];
    queue.push(turn);
    pendingTurnsBySession.set(turn.sessionId, queue);
  }

  function dequeuePendingTurn(turn: PendingBridgeTurn): void {
    const queue = pendingTurnsBySession.get(turn.sessionId) ?? [];
    const nextQueue = queue.filter((entry) => entry.requestId !== turn.requestId);
    if (nextQueue.length) {
      pendingTurnsBySession.set(turn.sessionId, nextQueue);
    } else {
      pendingTurnsBySession.delete(turn.sessionId);
    }
    if (turn.turnId) {
      turnBindings.delete(turn.turnId);
    }
    if (turn.timeoutHandle) clearTimeout(turn.timeoutHandle);
  }

  async function sendOutboundNow(envelope: OpenclawOutboundEnvelope): Promise<OpenclawMessageRecord> {
    const requestId = trimToNull(envelope.requestId) ?? randomUUID();
    const filteredContext = applyContextPolicy(envelope.context);
    const message = filteredContext
      ? `${envelope.message.trim()}\n\n[filtered_context]\n${JSON.stringify(filteredContext, null, 2)}`
      : envelope.message.trim();
    const recordBase: OpenclawMessageRecord = {
      id: randomUUID(),
      requestId,
      direction: "outbound",
      mode: envelope.notificationType ? "notification" : "manual",
      status: "queued",
      agentId: envelope.agentId ?? null,
      sessionKey: envelope.sessionKey ?? null,
      body: message,
      summary: summarizeMessage(message),
      context: filteredContext,
      createdAt: nowIso(),
      metadata: envelope.notificationType ? { notificationType: envelope.notificationType } : undefined,
    };

    if (!ws || ws.readyState !== WebSocket.OPEN || !config.enabled || !config.gatewayUrl) {
      const queuedEnvelope = { ...envelope, requestId, context: filteredContext };
      outbox = [
        ...outbox.filter((entry) => entry.envelope.requestId !== requestId),
        {
          id: randomUUID(),
          envelope: queuedEnvelope,
          queuedAt: nowIso(),
          attempts: 0,
        },
      ];
      persistRuntimeState();
      setStatus({ queuedMessages: outbox.length });
      return saveHistoryRecord(recordBase);
    }

    try {
      if (envelope.sessionKey) {
        await requestGateway("chat.send", {
          sessionKey: envelope.sessionKey,
          message,
          deliver: envelope.deliver !== false,
          attachments: [],
          timeoutMs: envelope.timeoutMs ?? 60_000,
          idempotencyKey: requestId,
        });
      } else if (envelope.agentId) {
        await requestGateway("agent", {
          message,
          agentId: envelope.agentId,
          channel: envelope.channel ?? undefined,
          replyChannel: envelope.replyChannel ?? undefined,
          accountId: envelope.accountId ?? undefined,
          replyAccountId: envelope.replyAccountId ?? undefined,
          threadId: envelope.threadId ?? undefined,
          deliver: envelope.deliver !== false,
          bestEffortDeliver: envelope.bestEffort === true,
          inputProvenance: { kind: "tool", sourceTool: "ade:openclaw-bridge" },
          idempotencyKey: requestId,
          label: envelope.label ?? "ade-bridge",
        });
      } else {
        throw new Error("OpenClaw outbound envelope requires either sessionKey or agentId.");
      }
      return saveHistoryRecord({
        ...recordBase,
        status: "sent",
      });
    } catch (error) {
      const failure = saveHistoryRecord({
        ...recordBase,
        status: "failed",
        error: getErrorMessage(error),
      });
      if (envelope.bestEffort !== true) {
        outbox = [
          ...outbox.filter((entry) => entry.envelope.requestId !== requestId),
          {
            id: randomUUID(),
            envelope: { ...envelope, requestId, context: filteredContext },
            queuedAt: nowIso(),
            attempts: 1,
            lastAttemptAt: nowIso(),
            lastError: getErrorMessage(error),
          },
        ];
        persistRuntimeState();
      }
      throw Object.assign(new Error(getErrorMessage(error)), { record: failure });
    }
  }

  async function flushOutbox(): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN || !config.enabled || !config.gatewayUrl) return;
    const nextOutbox: OutboxEntry[] = [];
    for (const entry of outbox) {
      if (entry.attempts >= MAX_OUTBOX_ATTEMPTS) {
        saveHistoryRecord({
          id: randomUUID(),
          requestId: trimToNull(entry.envelope.requestId) ?? randomUUID(),
          direction: "outbound",
          mode: entry.envelope.notificationType ? "notification" : "manual",
          status: "failed",
          agentId: entry.envelope.agentId ?? null,
          sessionKey: entry.envelope.sessionKey ?? null,
          body: entry.envelope.message,
          summary: summarizeMessage(entry.envelope.message),
          context: sanitizeContext(entry.envelope.context),
          createdAt: nowIso(),
          error: entry.lastError ?? "Outbox attempts exhausted.",
        });
        continue;
      }
      try {
        await sendOutboundNow({
          ...entry.envelope,
          bestEffort: true,
        });
      } catch (error) {
        nextOutbox.push({
          ...entry,
          attempts: entry.attempts + 1,
          lastAttemptAt: nowIso(),
          lastError: getErrorMessage(error),
        });
      }
    }
    outbox = nextOutbox;
    persistRuntimeState();
    setStatus({ queuedMessages: outbox.length });
  }

  async function finalizeTurn(turn: PendingBridgeTurn, outcome: "completed" | "failed" | "interrupted", fallbackMessage?: string): Promise<void> {
    if (turn.outputSent) return;
    turn.outputSent = true;
    const reply = buildReplyText(turn, fallbackMessage);
    dequeuePendingTurn(turn);
    if (turn.mode === "query") {
      if (outcome === "failed") {
        turn.reject?.(new Error(reply));
      } else {
        turn.resolve?.({ reply, sessionId: turn.sessionId, route: turn.route });
      }
      return;
    }
    if (outcome === "failed" && !reply.trim().length) {
      saveHistoryRecord({
        id: randomUUID(),
        requestId: turn.requestId,
        direction: "outbound",
        mode: "reply",
        status: "failed",
        agentId: turn.route.agentId ?? null,
        sessionKey: turn.route.sessionKey ?? null,
        body: reply,
        summary: summarizeMessage(reply || fallbackMessage || "Bridge turn failed."),
        context: null,
        createdAt: nowIso(),
        error: fallbackMessage ?? "Bridge turn failed.",
      });
      return;
    }
    try {
      await sendOutboundNow({
        requestId: turn.requestId,
        sessionKey: turn.route.sessionKey ?? null,
        agentId: turn.route.agentId ?? null,
        channel: turn.route.channel ?? null,
        replyChannel: turn.route.replyChannel ?? null,
        accountId: turn.route.accountId ?? null,
        replyAccountId: turn.route.replyAccountId ?? null,
        threadId: turn.route.threadId ?? null,
        message: reply,
        bestEffort: true,
      });
    } catch (error) {
      logger?.warn("openclaw.reply_delivery_failed", {
        requestId: turn.requestId,
        error: getErrorMessage(error),
      });
    }
  }

  async function deliverNotification(type: OpenclawNotificationType, message: string, context?: Record<string, unknown> | null): Promise<void> {
    pruneRouteCache();
    const routes = config.notificationRoutes.filter((route) => route.enabled !== false && route.notificationType === type);
    for (const route of routes) {
      const remembered = route.agentId ? routeCache.byAgentId[route.agentId] : null;
      const sessionKey = trimToNull(route.sessionKey) ?? trimToNull(remembered?.sessionKey) ?? null;
      const outbound: OpenclawOutboundEnvelope = {
        requestId: randomUUID(),
        agentId: route.agentId ?? remembered?.agentId ?? null,
        sessionKey,
        message,
        context: context ?? null,
        notificationType: type,
        bestEffort: true,
      };
      try {
        await sendOutboundNow(outbound);
      } catch {
        // best effort queueing already handled in sendOutboundNow
      }
    }
  }

  async function dispatchInbound(
    mode: "hook" | "query",
    envelope: OpenclawInboundEnvelope,
    options?: {
      onQueryResolved?: (value: { reply: string; sessionId: string; route: ConversationRoute }) => void;
      onQueryRejected?: (error: Error) => void;
      timeoutMs?: number;
    },
  ): Promise<{ requestId: string; sessionId: string; routeTarget: OpenclawTargetHint; duplicate: boolean }> {
    const message = trimToNull(envelope.message);
    if (!message) {
      throw new Error("OpenClaw inbound message is required.");
    }
    const requestId = trimToNull(envelope.requestId) ?? trimToNull(envelope.idempotencyKey) ?? randomUUID();
    if (hasSeenIdempotency(requestId)) {
      saveHistoryRecord({
        id: randomUUID(),
        requestId,
        direction: "inbound",
        mode,
        status: "duplicate",
        agentId: envelope.agentId ?? null,
        sessionKey: envelope.sessionKey ?? null,
        targetHint: envelope.targetHint ?? null,
        body: message,
        summary: summarizeMessage(message),
        context: sanitizeContext(envelope.context),
        createdAt: nowIso(),
      });
      return { requestId, sessionId: "", routeTarget: config.defaultTarget, duplicate: true };
    }
    if (config.allowedAgentIds.length > 0) {
      const agentId = trimToNull(envelope.agentId);
      if (!agentId || !config.allowedAgentIds.includes(agentId)) {
        throw new Error("OpenClaw agent is not allowed by this bridge configuration.");
      }
    }

    markIdempotency(requestId);
    const normalizedContext = sanitizeContext(envelope.context);
    const targetSession = await ensureTargetSession(envelope.targetHint ?? config.defaultTarget);
    const route: ConversationRoute = {
      agentId: trimToNull(envelope.agentId),
      sessionKey: trimToNull(envelope.sessionKey),
      channel: trimToNull(envelope.channel),
      replyChannel: trimToNull(envelope.replyChannel),
      accountId: trimToNull(envelope.accountId),
      replyAccountId: trimToNull(envelope.replyAccountId),
      threadId: trimToNull(envelope.threadId),
      updatedAt: nowIso(),
      expiresAt: Date.now() + ROUTE_TTL_MS,
      sessionId: targetSession.sessionId,
      targetHint: targetSession.routeTarget,
    };
    activeSessionRoutes.set(targetSession.sessionId, route);
    rememberRoute(route);

    saveHistoryRecord({
      id: randomUUID(),
      requestId,
      direction: "inbound",
      mode,
      status: "received",
      agentId: route.agentId ?? null,
      sessionKey: route.sessionKey ?? null,
      targetHint: envelope.targetHint ?? null,
      resolvedTarget: targetSession.routeTarget,
      body: message,
      summary: summarizeMessage(message),
      context: normalizedContext,
      createdAt: nowIso(),
      metadata: targetSession.fallbackReason ? { fallbackReason: targetSession.fallbackReason } : undefined,
    });

    const pendingTurn: PendingBridgeTurn = {
      requestId,
      mode,
      route,
      sessionId: targetSession.sessionId,
      displayText: message,
      createdAt: nowIso(),
      chunks: [],
      outputSent: false,
      resolve: options?.onQueryResolved,
      reject: options?.onQueryRejected,
      timeoutHandle: mode === "query" && options?.timeoutMs
        ? setTimeout(() => {
            pendingTurn.reject?.(new Error("ADE timed out while waiting for the bridge reply."));
          }, options.timeoutMs)
        : undefined,
    };
    queuePendingTurn(pendingTurn);

    const promptText = buildPromptFromInbound(
      { ...envelope, message, context: normalizedContext },
      requestId,
      targetSession.routeTarget,
      targetSession.fallbackReason,
    );
    await args.agentChatService.sendMessage({
      sessionId: targetSession.sessionId,
      text: promptText,
      displayText: message,
    });

    return {
      requestId,
      sessionId: targetSession.sessionId,
      routeTarget: targetSession.routeTarget,
      duplicate: false,
    };
  }

  function clearConnectTimer(): void {
    if (wsConnectTimer) {
      clearTimeout(wsConnectTimer);
      wsConnectTimer = null;
    }
  }

  function clearTickTimer(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function flushPendingWsErrors(error: Error): void {
    for (const [, pending] of pendingWsRequests) pending.reject(error);
    pendingWsRequests.clear();
  }

  function queueConnectTimeout(): void {
    clearConnectTimer();
    wsConnectTimer = setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setStatus({
        state: "error",
        lastError: "OpenClaw gateway connect challenge timed out.",
      });
      ws.close(1008, "connect challenge timeout");
    }, CONNECT_CHALLENGE_TIMEOUT_MS);
  }

  function startTickWatch(intervalMs: number): void {
    clearTickTimer();
    tickTimer = setInterval(() => {
      if (!lastTickAt || !ws) return;
      if (Date.now() - lastTickAt > intervalMs * 2) {
        ws.close(4000, "tick timeout");
      }
    }, Math.max(intervalMs, TICK_WATCH_FLOOR_MS));
  }

  async function requestGateway(
    method: string,
    params: Record<string, unknown>,
    options?: { expectFinal?: boolean },
  ): Promise<Record<string, unknown>> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenClaw gateway is not connected.");
    }
    const id = randomUUID();
    const frame: OpenclawRequestFrame = { type: "req", id, method, params };
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      pendingWsRequests.set(id, {
        resolve,
        reject,
        expectFinal: options?.expectFinal === true,
      });
    });
    ws.send(JSON.stringify(frame));
    return await promise;
  }

  function sendConnectFrame(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN || !wsConnectNonce) return;
    const authToken = trimToNull(config.gatewayToken);
    const deviceToken = trimToNull(config.deviceToken);
    const signedAtMs = Date.now();
    const scopes = ["operator.admin"];
    const payload = buildDeviceAuthPayloadV3({
      deviceId: deviceIdentity.deviceId,
      clientId: "ade.openclaw.bridge",
      clientMode: "backend",
      role: "operator",
      scopes,
      signedAtMs,
      token: authToken,
      nonce: wsConnectNonce,
      platform: process.platform,
      deviceFamily: "ade",
    });
    const params = {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "ade.openclaw.bridge",
        displayName: "ADE OpenClaw Bridge",
        version: args.appVersion ?? "dev",
        platform: process.platform,
        deviceFamily: "ade",
        mode: "backend",
      },
      caps: [],
      auth: authToken || deviceToken
        ? {
            ...(authToken ? { token: authToken } : {}),
            ...(deviceToken ? { deviceToken } : {}),
          }
        : undefined,
      role: "operator",
      scopes,
      device: {
        id: deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
        signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce: wsConnectNonce,
      },
    };
    void requestGateway("connect", params)
      .then((hello) => {
        const nextDeviceToken = trimToNull(isRecord(hello.auth) ? hello.auth.deviceToken : null);
        if (nextDeviceToken && nextDeviceToken !== config.deviceToken) {
          config = { ...config, deviceToken: nextDeviceToken };
          persistConfig(config);
        }
        reconnectAttempt = 0;
        lastTickAt = Date.now();
        startTickWatch(
          Number.isFinite(Number(isRecord(hello.policy) ? hello.policy.tickIntervalMs : null))
            ? Math.max(1_000, Number((hello.policy as Record<string, unknown>).tickIntervalMs))
            : DEFAULT_TICK_INTERVAL_MS,
        );
        setStatus({
          state: "connected",
          lastConnectedAt: nowIso(),
          lastError: null,
          lastEventAt: nowIso(),
        });
        void flushOutbox();
      })
      .catch((error) => {
        setStatus({
          state: "error",
          lastError: getErrorMessage(error),
        });
        ws?.close(1008, "connect failed");
      });
  }

  function scheduleReconnect(): void {
    if (requestedStop || !config.enabled || !config.gatewayUrl) return;
    clearReconnectTimer();
    const delay = Math.min(1_000 * Math.max(1, 2 ** reconnectAttempt), MAX_RECONNECT_BACKOFF_MS);
    reconnectAttempt += 1;
    setStatus({ state: "reconnecting" });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectGateway();
    }, delay);
  }

  function handleWsMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isEventFrame(parsed)) {
        if (parsed.event === "connect.challenge") {
          const nonce = trimToNull(parsed.payload?.nonce);
          if (!nonce) {
            throw new Error("OpenClaw gateway connect challenge did not include a nonce.");
          }
          wsConnectNonce = nonce;
          clearConnectTimer();
          sendConnectFrame();
          return;
        }
        if (typeof parsed.seq === "number") {
          lastSeq = parsed.seq;
        }
        if (parsed.event === "tick") {
          lastTickAt = Date.now();
        }
        setStatus({ lastEventAt: nowIso() });
        return;
      }
      if (isResponseFrame(parsed)) {
        const pending = pendingWsRequests.get(parsed.id);
        if (!pending) return;
        const responseStatus = isRecord(parsed.payload) ? parsed.payload.status : null;
        if (pending.expectFinal && responseStatus === "accepted") return;
        pendingWsRequests.delete(parsed.id);
        if (parsed.ok) {
          pending.resolve(parsed.payload ?? {});
        } else {
          pending.reject(new Error(parsed.error?.message ?? "OpenClaw gateway returned an unknown error."));
        }
      }
    } catch (error) {
      logger?.warn("openclaw.ws_message_parse_failed", {
        error: getErrorMessage(error),
      });
    }
  }

  async function disconnectGateway(): Promise<void> {
    requestedStop = true;
    clearConnectTimer();
    clearReconnectTimer();
    clearTickTimer();
    flushPendingWsErrors(new Error("OpenClaw gateway disconnected."));
    if (ws) {
      const current = ws;
      ws = null;
      try {
        current.close();
      } catch {
        // best effort
      }
    }
    if (config.enabled) {
      setStatus({ state: "disconnected" });
    } else {
      setStatus({ state: "disabled" });
    }
  }

  async function connectGateway(): Promise<void> {
    requestedStop = false;
    clearReconnectTimer();
    clearConnectTimer();
    if (!config.enabled) {
      await disconnectGateway();
      return;
    }
    if (!config.gatewayUrl) {
      setStatus({
        state: "disconnected",
        lastError: "Gateway URL is not configured. HTTP fallback remains available.",
      });
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setStatus({ state: status.lastConnectedAt ? "reconnecting" : "connecting", lastError: null });
    try {
      ws = new WebSocket(config.gatewayUrl, { maxPayload: 25 * 1024 * 1024 });
      ws.on("open", () => {
        wsConnectNonce = null;
        queueConnectTimeout();
      });
      ws.on("message", (data: RawData) => {
        const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        handleWsMessage(raw);
      });
      ws.on("close", (code: number, reason: Buffer) => {
        ws = null;
        clearConnectTimer();
        clearTickTimer();
        flushPendingWsErrors(new Error(`gateway closed (${code}): ${String(reason)}`));
        if (code === 1008 && String(reason).toLowerCase().includes("device token mismatch") && !config.gatewayToken) {
          config = { ...config, deviceToken: null };
          persistConfig(config);
        }
        setStatus({
          state: config.enabled ? "disconnected" : "disabled",
          lastError: `Gateway closed (${code}): ${String(reason)}`,
        });
        scheduleReconnect();
      });
      ws.on("error", (error: Error) => {
        setStatus({
          state: "error",
          lastError: getErrorMessage(error),
        });
      });
    } catch (error) {
      setStatus({
        state: "error",
        lastError: getErrorMessage(error),
      });
      scheduleReconnect();
    }
  }

  async function restartHttpServer(): Promise<void> {
    if (httpServer) {
      const server = httpServer;
      httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setStatus({ httpListening: false });
    }
    httpServer = http.createServer((req, res) => {
      void handleHttpRequest(req, res).catch((error) => {
        jsonResponse(res, 500, { ok: false, error: getErrorMessage(error) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer!.once("error", reject);
      const requestedPort = Number.isFinite(config.bridgePort) ? config.bridgePort : DEFAULT_BRIDGE_PORT;
      httpServer!.listen(requestedPort, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address();
    currentHttpPort = typeof address === "object" && address
      ? address.port
      : (Number.isFinite(config.bridgePort) ? config.bridgePort : DEFAULT_BRIDGE_PORT);
    setStatus({ httpListening: true, bridgePort: currentHttpPort });
  }

  function authorizeRequest(req: IncomingMessage): void {
    const configured = trimToNull(config.hooksToken);
    if (!configured) return;
    const provided = getRequestToken(req);
    if (provided !== configured) {
      throw new Error("Invalid OpenClaw hook token.");
    }
  }

  async function handleQueryRequest(envelope: OpenclawInboundEnvelope, res: ServerResponse): Promise<void> {
    const timeoutMs = Number.isFinite(Number(envelope.timeoutMs))
      ? Math.max(1_000, Math.min(300_000, Math.floor(Number(envelope.timeoutMs))))
      : 120_000;
    const requestId = trimToNull(envelope.requestId) ?? trimToNull(envelope.idempotencyKey) ?? randomUUID();
    const result = await new Promise<{ reply: string; sessionId: string; route: ConversationRoute }>(async (resolve, reject) => {
      try {
        const dispatch = await dispatchInbound(
          "query",
          { ...envelope, requestId },
          {
            onQueryResolved: resolve,
            onQueryRejected: reject,
            timeoutMs,
          },
        );
        if (dispatch.duplicate) {
          reject(new Error("Duplicate idempotency key."));
          return;
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    jsonResponse(res, 200, {
      ok: true,
      requestId,
      reply: result.reply,
      sessionId: result.sessionId,
      route: {
        agentId: result.route.agentId ?? null,
        sessionKey: result.route.sessionKey ?? null,
        targetHint: result.route.targetHint ?? null,
      },
    });
  }

  async function handleHookRequest(envelope: OpenclawInboundEnvelope, res: ServerResponse): Promise<void> {
    const dispatch = await dispatchInbound("hook", envelope);
    jsonResponse(res, 202, {
      ok: true,
      accepted: true,
      duplicate: dispatch.duplicate,
      requestId: dispatch.requestId,
      sessionId: dispatch.sessionId,
      routeTarget: dispatch.routeTarget,
    });
  }

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (method === "GET" && pathname === "/openclaw/health") {
      jsonResponse(res, 200, {
        ok: true,
        projectRoot: args.projectRoot,
        state: readBridgeState(),
      });
      return;
    }
    if (pathname !== "/openclaw/hook" && pathname !== "/openclaw/query") {
      jsonResponse(res, 404, { ok: false, error: "Not found." });
      return;
    }
    if (method !== "POST") {
      jsonResponse(res, 405, { ok: false, error: "Method not allowed." });
      return;
    }
    authorizeRequest(req);
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!isRecord(parsed)) {
      jsonResponse(res, 400, { ok: false, error: "OpenClaw request body must be a JSON object." });
      return;
    }
    const envelope: OpenclawInboundEnvelope = {
      requestId: trimToNull(parsed.requestId) ?? undefined,
      idempotencyKey: trimToNull(parsed.idempotencyKey) ?? undefined,
      agentId: trimToNull(parsed.agentId),
      sessionKey: trimToNull(parsed.sessionKey),
      channel: trimToNull(parsed.channel),
      replyChannel: trimToNull(parsed.replyChannel),
      accountId: trimToNull(parsed.accountId),
      replyAccountId: trimToNull(parsed.replyAccountId),
      threadId: trimToNull(parsed.threadId),
      message: String(parsed.message ?? "").trim(),
      targetHint: parsed.targetHint ? normalizeTargetHint(parsed.targetHint, config.defaultTarget) : undefined,
      context: sanitizeContext(parsed.context),
      timeoutMs: Number.isFinite(Number(parsed.timeoutMs)) ? Number(parsed.timeoutMs) : undefined,
    };
    try {
      if (pathname === "/openclaw/query") {
        await handleQueryRequest(envelope, res);
      } else {
        await handleHookRequest(envelope, res);
      }
    } catch (error) {
      const statusCode = /timed out/i.test(getErrorMessage(error)) ? 504 : 400;
      jsonResponse(res, statusCode, { ok: false, error: getErrorMessage(error) });
    }
  }

  return {
    async start(): Promise<void> {
      idempotencyState = pruneIdempotencyState(idempotencyState);
      pruneRouteCache();
      persistRuntimeState();
      await restartHttpServer();
      if (config.enabled) {
        await connectGateway();
      } else {
        setStatus({ state: "disabled" });
      }
    },

    async stop(): Promise<void> {
      await disconnectGateway();
      // Clear all pending turn timeout handles and in-memory tracking maps.
      for (const queue of pendingTurnsBySession.values()) {
        for (const turn of queue) {
          if (turn.timeoutHandle) clearTimeout(turn.timeoutHandle);
          turn.reject?.(new Error("OpenClaw bridge stopped."));
        }
      }
      pendingTurnsBySession.clear();
      turnBindings.clear();
      activeSessionRoutes.clear();
      if (httpServer) {
        const server = httpServer;
        httpServer = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      setStatus({ httpListening: false, state: config.enabled ? "disconnected" : "disabled" });
    },

    getState(): OpenclawBridgeState {
      return readBridgeState();
    },

    listMessages(limit = 40): OpenclawMessageRecord[] {
      return getHistoryMessages(limit);
    },

    async updateConfig(patch: Partial<OpenclawBridgeConfig>): Promise<OpenclawBridgeState> {
      config = normalizeConfig({ ...config, ...patch });
      persistConfig(config);
      await restartHttpServer();
      if (config.enabled) {
        await connectGateway();
      } else {
        await disconnectGateway();
      }
      setStatus({
        state: config.enabled ? status.state : "disabled",
        lastError: config.enabled ? status.lastError : null,
      });
      return readBridgeState();
    },

    async testConnection(): Promise<OpenclawBridgeStatus> {
      await restartHttpServer();
      if (!config.enabled || !config.gatewayUrl) {
        setStatus({
          state: config.enabled ? "disconnected" : "disabled",
          lastError: config.enabled && !config.gatewayUrl
            ? "Gateway URL is not configured. HTTP fallback is ready."
            : null,
        });
        return status;
      }
      await connectGateway();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (status.state === "connected") return status;
        if (status.state === "error") break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return status;
    },

    async sendMessage(envelope: OpenclawOutboundEnvelope): Promise<OpenclawMessageRecord> {
      return await sendOutboundNow(envelope);
    },

    onAgentChatEvent(envelope: AgentChatEventEnvelope): void {
      const queue = pendingTurnsBySession.get(envelope.sessionId) ?? [];
      if (envelope.event.type === "user_message" && envelope.event.turnId) {
        const pending = queue.find((entry) => !entry.turnId);
        if (pending) {
          pending.turnId = envelope.event.turnId;
          turnBindings.set(envelope.event.turnId, pending);
          return;
        }
        const ambientRoute = activeSessionRoutes.get(envelope.sessionId);
        if (ambientRoute && ambientRoute.expiresAt > Date.now()) {
          const ambient: PendingBridgeTurn = {
            requestId: randomUUID(),
            mode: "ambient",
            route: ambientRoute,
            sessionId: envelope.sessionId,
            displayText: envelope.event.text,
            createdAt: nowIso(),
            turnId: envelope.event.turnId,
            chunks: [],
            outputSent: false,
          };
          turnBindings.set(envelope.event.turnId, ambient);
        }
        return;
      }

      const turnId = envelope.event.type === "done"
        ? envelope.event.turnId
        : "turnId" in envelope.event
          ? envelope.event.turnId
          : undefined;
      if (!turnId) return;
      const binding = turnBindings.get(turnId);
      if (!binding) return;

      if (envelope.event.type === "text") {
        binding.chunks.push(envelope.event.text);
        return;
      }

      if (envelope.event.type === "status" && envelope.event.turnStatus === "failed") {
        void finalizeTurn(binding, "failed", envelope.event.message ?? "ADE failed to complete the bridge turn.");
        return;
      }

      if (envelope.event.type === "status" && envelope.event.turnStatus === "interrupted") {
        void finalizeTurn(binding, "interrupted", envelope.event.message ?? "ADE interrupted the bridge turn.");
        return;
      }

      if (envelope.event.type === "error") {
        binding.chunks.push(`\n${envelope.event.message}`);
        return;
      }

      if (envelope.event.type === "done") {
        void finalizeTurn(binding, envelope.event.status === "failed" ? "failed" : envelope.event.status === "interrupted" ? "interrupted" : "completed");
      }
    },

    onMissionEvent(event: MissionsEventPayload): void {
      if (!event.missionId || event.reason !== "updated") return;
      const mission = args.missionService?.get(event.missionId);
      if (!mission || mission.status !== "completed") return;
      void deliverNotification(
        "mission_complete",
        `Mission completed: ${mission.title}`,
        {
          missionId: mission.id,
          status: mission.status,
          updatedAt: mission.updatedAt,
        },
      );
    },

    onTestEvent(event: TestEvent): void {
      if (event.type !== "run" || event.run.status !== "failed") return;
      void deliverNotification(
        "ci_broken",
        `CI/test run failed: ${event.run.suiteName}`,
        {
          suiteId: event.run.suiteId,
          runId: event.run.id,
          laneId: event.run.laneId,
          exitCode: event.run.exitCode,
        },
      );
    },

    onOrchestratorEvent(event: OrchestratorRuntimeEvent): void {
      const reason = (event.reason ?? "").toLowerCase();
      if (!reason.includes("blocked")) return;
      void deliverNotification(
        "blocked_run",
        `Orchestrator blocked: ${event.reason}`,
        {
          runId: event.runId ?? null,
          stepId: event.stepId ?? null,
          attemptId: event.attemptId ?? null,
        },
      );
    },
  };
}
