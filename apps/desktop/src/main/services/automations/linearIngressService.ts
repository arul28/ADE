import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";
import type { AutomationLinearIngressStatus } from "../../../shared/types/automations";
import { linearIngressKindFromParts } from "../../../shared/types/linearSync";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { LinearWebhookSummary } from "../cto/linearClient";
import { ACCOUNT_RELAY_TOKEN_HEADER } from "../github/githubRelayConfig";
import {
  LINEAR_RELAY_LAST_ERROR_REF,
  LINEAR_RELAY_LAST_EVENT_AT_REF,
  clearLinearRelayRegistration,
  clearLinearWebhookSecret,
  persistLinearRelayRegistration,
  persistLinearWebhookSecret,
  readLinearRelayPersistedState,
  readLinearWebhookSecret,
  resolveLinearRelayBaseUrl,
  type LinearRelayCredentialStore,
} from "./linearRelayConfig";

const DEFAULT_LINEAR_RELAY_POLL_INTERVAL_MS = 45_000;
// While a wake-up socket is connected, polling is only a safety net.
const SUBSCRIBED_SAFETY_POLL_INTERVAL_MS = 5 * 60_000;
const WAKE_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const WAKE_SOCKET_MAX_BACKOFF_MS = 60_000;
const LINEAR_RELAY_PAGE_LIMIT = 500;
const LINEAR_RELAY_MAX_PAGES_PER_POLL = 20;
// Sentinel webhook id for workspaces whose events arrive through the ADE
// Linear OAuth app: no workspace webhook exists to create or delete.
const ADE_APP_WEBHOOK_ID = "ade-linear-app";

type LinearAccessCredentials = {
  ensureFreshToken: (opts?: { force?: boolean }) => Promise<void>;
  getToken: () => string | null;
  getStatus: () => { authMode: string | null };
};

// Relay auth wants OAuth tokens Bearer-prefixed and API keys raw — shared by
// the desktop and headless wiring so the branching cannot drift between them.
export function createLinearAccessTokenGetter(
  credentials: LinearAccessCredentials,
): () => Promise<string | null> {
  return async () => {
    await credentials.ensureFreshToken();
    const token = credentials.getToken()?.trim() ?? "";
    if (!token) return null;
    if (credentials.getStatus().authMode === "oauth") {
      return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    }
    return token.replace(/^bearer\s+/i, "");
  };
}

function parseRelaySequence(cursor: string): number | null {
  const match = /^seq:(\d+)$/.exec(cursor.trim());
  return match ? Number(match[1]) : null;
}
const LINEAR_WEBHOOK_RESOURCE_TYPES = ["Issue", "Comment", "IssueLabel", "ProjectUpdate", "InitiativeUpdate", "User"];
const LINEAR_WEBHOOK_LABEL = "ADE automations";

type LinearWebhookClient = {
  listWebhooks: () => Promise<LinearWebhookSummary[]>;
  createWebhook: (params: {
    url: string;
    secret: string;
    label?: string;
    resourceTypes?: string[];
    allPublicTeams?: boolean;
  }) => Promise<LinearWebhookSummary>;
  deleteWebhook: (webhookId: string) => Promise<void>;
};

type LinearRelayEvent = {
  cursor: string;
  eventId: string;
  eventType: string;
  action: string;
  createdAt: string;
  body: string;
  /** Set by the relay for Linear agent sessions: the ADE account the session was routed to. */
  routedAccountId?: string | null;
};

type LinearRelayEventsResponse = {
  events: LinearRelayEvent[];
  nextCursor: string | null;
  cursorExpired: boolean;
};

export type LinearIngressStatus = AutomationLinearIngressStatus;

export type LinearIngressCursorStore = {
  get: (source: "linear-relay") => string | null;
  set: (args: { source: "linear-relay"; cursor: string | null }) => void;
};

export type LinearIngressServiceDeps = {
  db: Pick<AdeDb, "getJson" | "setJson" | "get" | "run">;
  projectId: string;
  credentialStore: LinearRelayCredentialStore;
  getLinearClient: () => LinearWebhookClient | null;
  /** Raw API key or an OAuth value already prefixed with `Bearer `. */
  getLinearAccessToken: () => string | null | Promise<string | null>;
  getAccountAccessToken?: () => Promise<string | null>;
  cursorStore: LinearIngressCursorStore;
  /** Awaited before the cursor advances past the delivery. */
  dispatch: (record: LinearIngressEventRecord) => void | Promise<void>;
  logger: Logger;
  hasEnabledLinearRules: () => boolean;
  /**
   * True when something besides automation rules needs Linear events on this
   * machine (Linear-linked lanes, the ADE agent). Polls also run then.
   */
  wantsLinearEvents?: () => boolean;
  /** WebSocket target for this account's Linear agent wake-ups (null = none). */
  getAgentSubscribeTarget?: () => Promise<{ url: string; headers: Record<string, string> } | null>;
  /**
   * True when the project's Linear connection is an OAuth token issued to the
   * bundled ADE Linear app — its webhook is auto-provisioned by Linear, so
   * setup skips webhook creation and runs automatically on the first poll.
   */
  isAdeAppConnection?: () => boolean;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNested(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseCreatedAt(payload: Record<string, unknown>, relayCreatedAt: string): string {
  const createdAt = readString(payload, "createdAt");
  if (createdAt && Number.isFinite(Date.parse(createdAt))) return new Date(createdAt).toISOString();
  const webhookTimestamp = Number(payload.webhookTimestamp);
  const webhookDate = new Date(webhookTimestamp);
  if (Number.isFinite(webhookDate.getTime())) return webhookDate.toISOString();
  if (Number.isFinite(Date.parse(relayCreatedAt))) return new Date(relayCreatedAt).toISOString();
  return new Date().toISOString();
}

function mapRelayEventToRecord(event: LinearRelayEvent): LinearIngressEventRecord {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(event.body) as unknown;
    if (!isRecord(parsed)) throw new Error("payload must be an object");
    payload = parsed;
  } catch (error: unknown) {
    throw new Error(`Linear relay event '${event.eventId}' has an invalid body: ${errorMessage(error)}`);
  }

  const entityType = readString(payload, "type") ?? event.eventType;
  const action = readString(payload, "action") ?? event.action ?? null;
  const data = readNested(payload, "data");
  const nestedIssue = readNested(data, "issue");
  const isIssue = entityType.toLowerCase() === "issue";
  const issue = isIssue ? data : nestedIssue;
  const issueId = isIssue ? readString(issue, "id") ?? readString(data, "issueId") : null;
  const issueIdentifier = isIssue ? readString(issue, "identifier") ?? readString(data, "issueIdentifier") : null;
  const title = readString(issue, "title") ?? readString(data, "title");
  const summary = issueIdentifier && title
    ? `${issueIdentifier}: ${title}`
    : title
      ? `Linear ${entityType} ${action ?? "event"}: ${title}`
      : `Linear ${entityType} ${action ?? "event"}`;

  return {
    id: randomUUID(),
    source: "relay",
    deliveryId: event.eventId,
    eventId: event.eventId,
    kind: linearIngressKindFromParts(entityType, action),
    entityType,
    action,
    issueId,
    issueIdentifier,
    summary,
    payload,
    createdAt: parseCreatedAt(payload, event.createdAt),
    ...(event.routedAccountId !== undefined ? { routedAccountId: event.routedAccountId } : {}),
  };
}

function parseRelayEventsResponse(value: unknown): LinearRelayEventsResponse {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new Error("Linear relay returned an invalid events response.");
  }
  const events = value.events.map((entry) => {
    if (!isRecord(entry)) throw new Error("Linear relay returned an invalid event.");
    const cursor = readString(entry, "cursor");
    const eventId = readString(entry, "eventId");
    const eventType = readString(entry, "eventType");
    const action = readString(entry, "action");
    const createdAt = readString(entry, "createdAt");
    const body = typeof entry.body === "string" ? entry.body : null;
    if (!cursor || !eventId || !eventType || !action || !createdAt || body == null) {
      throw new Error("Linear relay returned an incomplete event.");
    }
    const routedAccountId = entry.routedAccountId === null ? null : readString(entry, "routedAccountId") ?? undefined;
    return { cursor, eventId, eventType, action, createdAt, body, ...(routedAccountId !== undefined ? { routedAccountId } : {}) };
  });
  return {
    events,
    nextCursor: typeof value.nextCursor === "string" && value.nextCursor.trim() ? value.nextCursor.trim() : null,
    cursorExpired: value.cursorExpired === true,
  };
}

export function createLinearIngressService(deps: LinearIngressServiceDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollIntervalMs = Math.max(1_000, deps.pollIntervalMs ?? DEFAULT_LINEAR_RELAY_POLL_INTERVAL_MS);
  let pollTimer: NodeJS.Timeout | null = null;
  let pollInFlight: Promise<void> | null = null;
  // A poll already running when the service stops can finish after the
  // database is closed. Its failure is then expected and must not be written.
  let stopped = false;

  const setLastError = (message: string | null): void => {
    deps.db.setJson(LINEAR_RELAY_LAST_ERROR_REF, message);
  };

  const getStatus = (): LinearIngressStatus => {
    const relayBaseUrl = resolveLinearRelayBaseUrl(deps.db);
    const persisted = readLinearRelayPersistedState(deps.db);
    let secret: string | null = null;
    let secretError: string | null = null;
    try {
      secret = readLinearWebhookSecret(deps.db, deps.credentialStore);
    } catch (error: unknown) {
      secretError = errorMessage(error);
    }
    const configured = Boolean(persisted.webhookId && persisted.organizationId && secret);
    const lastError = secretError ?? persisted.lastError;
    const state: LinearIngressStatus["state"] = lastError
      ? "error"
      : !configured
        ? "unconfigured"
        : !deps.hasEnabledLinearRules()
          ? "disabled"
          : "ready";
    return {
      state,
      webhookId: persisted.webhookId,
      organizationId: persisted.organizationId,
      lastEventAt: persisted.lastEventAt,
      lastError,
      relayBaseUrl,
      appManaged: persisted.webhookId === ADE_APP_WEBHOOK_ID || Boolean(deps.isAdeAppConnection?.()),
    };
  };

  const requireAuthorization = async (): Promise<string> => {
    const authorization = (await deps.getLinearAccessToken())?.trim() ?? "";
    if (!authorization) throw new Error("Connect Linear before configuring webhook ingestion.");
    return authorization;
  };

  const readAccountAccessToken = async (): Promise<string | null> => {
    return deps.getAccountAccessToken
      ? await deps.getAccountAccessToken().catch(() => null)
      : null;
  };

  const registerOrganization = async (args: {
    relayBaseUrl: string;
    authorization: string;
    secret: string;
  }): Promise<string> => {
    const accountAccessToken = await readAccountAccessToken();
    const response = await fetchImpl(`${args.relayBaseUrl}/linear/orgs/register`, {
      method: "POST",
      headers: {
        authorization: args.authorization,
        ...(accountAccessToken ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret: args.secret }),
    });
    const payload = await response.json().catch(() => null) as unknown;
    const organizationId = isRecord(payload) ? readString(payload, "organizationId") : null;
    if (!response.ok || !organizationId) {
      const detail = isRecord(payload) ? readString(payload, "error") : null;
      throw new Error(detail ?? `Linear relay registration failed (HTTP ${response.status}).`);
    }
    return organizationId;
  };

  const setup = async (): Promise<LinearIngressStatus> => {
    let createdWebhookId: string | null = null;
    try {
      const client = deps.getLinearClient();
      if (!client) throw new Error("Connect Linear before configuring webhook ingestion.");
      const authorization = await requireAuthorization();
      const relayBaseUrl = resolveLinearRelayBaseUrl(deps.db);

      if (deps.isAdeAppConnection?.()) {
        // The ADE Linear OAuth app already delivers this workspace's events
        // (Linear auto-provisions the app webhook on authorization and signs
        // with the app-level secret the relay knows). Registration only
        // resolves and pins the organization id for the read route.
        const secret = randomBytes(32).toString("hex");
        const organizationId = await registerOrganization({ relayBaseUrl, authorization, secret });
        persistLinearWebhookSecret(deps.credentialStore, secret);
        persistLinearRelayRegistration(deps.db, { webhookId: ADE_APP_WEBHOOK_ID, organizationId });
        deps.logger.info("automations.linear_relay_configured", { organizationId, webhookId: ADE_APP_WEBHOOK_ID, appManaged: true });
        return getStatus();
      }

      const webhookUrl = `${relayBaseUrl}/linear/webhook`;
      const persisted = readLinearRelayPersistedState(deps.db);
      const storedSecret = readLinearWebhookSecret(deps.db, deps.credentialStore);
      const webhooks = await client.listWebhooks();
      const matching = webhooks.filter((webhook) => normalizeUrl(webhook.url) === normalizeUrl(webhookUrl));
      let webhook = matching.find((entry) => entry.id === persisted.webhookId && entry.enabled) ?? null;
      let secret = webhook ? storedSecret : null;

      if (webhook && !secret) {
        // The persisted hook's signing secret is gone (e.g. credential store
        // reset). Its secret is unknowable, so rotate instead of failing on
        // every setup attempt.
        webhook = null;
      }
      if (!webhook && matching.length > 0) {
        // A hook we cannot sign for has an unknowable secret. Rotate it
        // instead of registering a secret that Linear will not use.
        await Promise.all(matching.map((entry) => client.deleteWebhook(entry.id)));
      }
      if (!webhook) {
        secret = randomBytes(32).toString("hex");
        webhook = await client.createWebhook({
          url: webhookUrl,
          secret,
          resourceTypes: LINEAR_WEBHOOK_RESOURCE_TYPES,
          allPublicTeams: true,
          label: LINEAR_WEBHOOK_LABEL,
        });
        createdWebhookId = webhook.id;
      }
      if (!secret) throw new Error("Linear webhook signing secret is unavailable.");

      const organizationId = await registerOrganization({ relayBaseUrl, authorization, secret });
      persistLinearWebhookSecret(deps.credentialStore, secret);
      persistLinearRelayRegistration(deps.db, { webhookId: webhook.id, organizationId });
      deps.logger.info("automations.linear_relay_configured", {
        organizationId,
        webhookId: webhook.id,
        reusedWebhook: createdWebhookId == null,
      });
      return getStatus();
    } catch (error: unknown) {
      if (createdWebhookId) {
        await deps.getLinearClient()?.deleteWebhook(createdWebhookId).catch(() => undefined);
      }
      const message = errorMessage(error);
      setLastError(message);
      deps.logger.warn("automations.linear_relay_setup_failed", { error: message });
      throw error;
    }
  };

  const teardown = async (): Promise<LinearIngressStatus> => {
    const persisted = readLinearRelayPersistedState(deps.db);
    try {
      if (persisted.webhookId && persisted.webhookId !== ADE_APP_WEBHOOK_ID) {
        const client = deps.getLinearClient();
        if (!client) throw new Error("Connect Linear before removing the configured webhook.");
        await client.deleteWebhook(persisted.webhookId);
      }
      clearLinearWebhookSecret(deps.credentialStore);
      clearLinearRelayRegistration(deps.db);
      deps.cursorStore.set({ source: "linear-relay", cursor: null });
      deps.logger.info("automations.linear_relay_removed", { webhookId: persisted.webhookId });
      return getStatus();
    } catch (error: unknown) {
      const message = errorMessage(error);
      setLastError(message);
      deps.logger.warn("automations.linear_relay_teardown_failed", { error: message });
      throw error;
    }
  };

  /** Returns false when the delivery was already persisted (replay). */
  const persistRecord = (record: LinearIngressEventRecord): boolean => {
    const existing = deps.db.get<{ id: string }>(
      `select id from linear_ingress_events
        where project_id = ? and delivery_id = ?
        limit 1`,
      [deps.projectId, record.deliveryId],
    );
    if (existing) return false;
    deps.db.run(
      `insert into linear_ingress_events(
        id, project_id, source, delivery_id, event_id, entity_type, action,
        issue_id, issue_identifier, summary, payload_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        deps.projectId,
        record.source,
        record.deliveryId,
        record.eventId,
        record.entityType ?? "",
        record.action ?? null,
        record.issueId,
        record.issueIdentifier,
        record.summary,
        record.payload ? JSON.stringify(record.payload) : null,
        record.createdAt,
      ],
    );
    return true;
  };

  const wantsEvents = (): boolean => deps.hasEnabledLinearRules() || deps.wantsLinearEvents?.() === true;

  const poll = async (): Promise<void> => {
    if (!wantsEvents()) return;
    let status = getStatus();
    if (
      deps.isAdeAppConnection?.()
      && (status.state === "unconfigured" || (status.state === "error" && !status.organizationId))
    ) {
      // App-connected workspaces need no manual connect step: events already
      // flow to the relay, only the organization id is missing locally. A
      // transient registration failure must keep retrying on later polls —
      // a successful registration clears the recorded error.
      try {
        status = await setup();
      } catch {
        return; // setup recorded the error; surface via status
      }
    }
    if (status.state === "error" && status.webhookId && status.organizationId) {
      // A configured relay should recover from transient poll errors. Clear the
      // previous attempt before re-evaluating readiness; secret-store failures
      // remain errors because getStatus recreates them immediately.
      setLastError(null);
      status = getStatus();
    }
    if (status.state !== "ready" || !status.organizationId) return;
    const authorization = (await deps.getLinearAccessToken())?.trim() ?? "";
    const accountAccessToken = await readAccountAccessToken();
    if (!authorization && !accountAccessToken) {
      throw new Error("Connect Linear before configuring webhook ingestion.");
    }

    // Drain full pages within one tick so a backlog larger than one page is
    // delivered this poll instead of trickling out one page per interval.
    for (let page = 0; page < LINEAR_RELAY_MAX_PAGES_PER_POLL; page += 1) {
      const cursor = deps.cursorStore.get("linear-relay");
      const url = new URL(`${status.relayBaseUrl}/linear/orgs/${encodeURIComponent(status.organizationId)}/events`);
      url.searchParams.set("limit", String(LINEAR_RELAY_PAGE_LIMIT));
      if (cursor) url.searchParams.set("after", cursor);
      const response = await fetchImpl(url, {
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(accountAccessToken ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken } : {}),
        },
        // pollInFlight only clears in `finally`; an unbounded hung request
        // would block scheduled and manual polls until restart.
        signal: AbortSignal.timeout(30_000),
      });
      const rawPayload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const detail = isRecord(rawPayload) ? readString(rawPayload, "error") : null;
        throw new Error(detail ?? `Linear relay poll failed (HTTP ${response.status}).`);
      }
      const payload = parseRelayEventsResponse(rawPayload);
      if (payload.cursorExpired) {
        deps.cursorStore.set({ source: "linear-relay", cursor: payload.nextCursor });
        setLastError(null);
        deps.logger.info("automations.linear_relay_cursor_reset", { cursor: payload.nextCursor });
        return;
      }

      // Cursored relay pages are oldest-first, fresh reads newest-first; sort
      // by relay sequence so dispatch order never depends on the read path.
      const ordered = [...payload.events].sort(
        (a, b) => (parseRelaySequence(a.cursor) ?? 0) - (parseRelaySequence(b.cursor) ?? 0),
      );
      let newestEventAt: string | null = null;
      for (const event of ordered) {
        const record = mapRelayEventToRecord(event);
        // A replay (at-least-once relay, cursor reset) must not re-trigger
        // automations: dispatch only deliveries persisted for the first time.
        if (!persistRecord(record)) continue;
        await deps.dispatch(record);
        if (!newestEventAt || Date.parse(record.createdAt) > Date.parse(newestEventAt)) {
          newestEventAt = record.createdAt;
        }
      }
      if (payload.nextCursor) {
        deps.cursorStore.set({ source: "linear-relay", cursor: payload.nextCursor });
      }
      if (newestEventAt) deps.db.setJson(LINEAR_RELAY_LAST_EVENT_AT_REF, newestEventAt);
      setLastError(null);
      if (payload.events.length < LINEAR_RELAY_PAGE_LIMIT || !payload.nextCursor) return;
    }
  };

  // A wake-up that arrives while a poll is running may be for an event that poll
  // already missed, so it asks for one more poll after the running one.
  let repollRequested = false;

  const pollNow = async (): Promise<void> => {
    if (pollInFlight) {
      repollRequested = true;
      return pollInFlight;
    }
    pollInFlight = poll()
      .catch((error: unknown) => {
        if (stopped) return;
        const message = errorMessage(error);
        setLastError(message);
        deps.logger.warn("automations.linear_relay_poll_failed", { error: message });
      })
      .finally(() => {
        pollInFlight = null;
        if (repollRequested && !stopped) {
          repollRequested = false;
          void pollNow();
        }
      });
    return pollInFlight;
  };

  // ---- wake-up sockets ----------------------------------------------------
  // Two relay topics wake this machine: the account topic (Linear agent
  // sessions routed to this person) and the organization topic (every Linear
  // event in the workspace). Each frame only means "poll now"; the durable
  // cursor and replay guard above stay the source of truth.
  type WakeSocket = { stop: () => void; connected: () => boolean };
  const wakeSockets: WakeSocket[] = [];

  const reschedulePolling = (): void => {
    if (!pollTimer || stopped) return;
    clearInterval(pollTimer);
    const subscribed = wakeSockets.some((socket) => socket.connected());
    pollTimer = setInterval(() => void pollNow(), subscribed ? Math.max(pollIntervalMs, SUBSCRIBED_SAFETY_POLL_INTERVAL_MS) : pollIntervalMs);
    pollTimer.unref?.();
  };

  const createWakeSocket = (
    name: string,
    resolveTarget: () => Promise<{ url: string; headers: Record<string, string> } | null>,
  ): WakeSocket => {
    let socket: WebSocket | null = null;
    let isConnected = false;
    let halted = false;
    let attempt = 0;
    let retryTimer: NodeJS.Timeout | null = null;

    const scheduleRetry = (): void => {
      if (halted || retryTimer) return;
      const delay = Math.min(WAKE_SOCKET_MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 500);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
      retryTimer.unref?.();
    };

    const connect = async (): Promise<void> => {
      if (halted || socket) return;
      const target = wantsEvents() ? await resolveTarget().catch(() => null) : null;
      if (halted || socket) return;
      if (!target) {
        scheduleRetry();
        return;
      }
      let next: WebSocket;
      try {
        next = new WebSocket(target.url, { headers: target.headers });
      } catch {
        scheduleRetry();
        return;
      }
      socket = next;
      const connectTimer = setTimeout(() => {
        if (socket === next && next.readyState === WebSocket.CONNECTING) next.terminate();
      }, WAKE_SOCKET_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
      next.on("open", () => {
        if (socket !== next) return;
        clearTimeout(connectTimer);
        attempt = 0;
        isConnected = true;
        reschedulePolling();
        void pollNow();
      });
      next.on("message", (raw: RawData) => {
        if (socket !== next) return;
        try {
          const frame = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)) as unknown;
          if (isRecord(frame) && frame.t === "linear_delivery") void pollNow();
        } catch {
          // Frames are hints; ignore anything unexpected.
        }
      });
      next.on("error", () => {
        // `close` owns reconnects.
      });
      next.on("close", () => {
        clearTimeout(connectTimer);
        if (socket !== next) return;
        socket = null;
        const wasConnected = isConnected;
        isConnected = false;
        if (wasConnected) reschedulePolling();
        scheduleRetry();
      });
      deps.logger.debug?.("automations.linear_wake_socket_connecting", { name });
    };

    void connect();
    return {
      connected: () => isConnected,
      stop: () => {
        halted = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        const current = socket;
        socket = null;
        isConnected = false;
        try {
          current?.close();
        } catch {
          // Already closing.
        }
      },
    };
  };

  const resolveOrgSubscribeTarget = async (): Promise<{ url: string; headers: Record<string, string> } | null> => {
    const status = getStatus();
    if (!status.organizationId) return null;
    const authorization = (await deps.getLinearAccessToken())?.trim() ?? "";
    const accountAccessToken = await readAccountAccessToken();
    if (!authorization && !accountAccessToken) return null;
    const base = status.relayBaseUrl.replace(/^http/i, "ws");
    return {
      url: `${base}/linear/orgs/${encodeURIComponent(status.organizationId)}/subscribe`,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(accountAccessToken ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken } : {}),
      },
    };
  };

  const start = (): void => {
    if (pollTimer) return;
    stopped = false;
    void pollNow();
    pollTimer = setInterval(() => void pollNow(), pollIntervalMs);
    pollTimer.unref?.();
    wakeSockets.push(createWakeSocket("org", resolveOrgSubscribeTarget));
    if (deps.getAgentSubscribeTarget) wakeSockets.push(createWakeSocket("agent", deps.getAgentSubscribeTarget));
  };

  const stop = (): void => {
    stopped = true;
    for (const socket of wakeSockets.splice(0)) socket.stop();
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  return {
    getStatus,
    setup,
    teardown,
    start,
    stop,
    pollNow,
  };
}

export type LinearIngressService = ReturnType<typeof createLinearIngressService>;
