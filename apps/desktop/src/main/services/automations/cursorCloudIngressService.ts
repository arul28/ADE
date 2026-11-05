import { randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { ACCOUNT_RELAY_TOKEN_HEADER } from "../github/githubRelayConfig";
import {
  CURSOR_CLOUD_RELAY_LAST_ERROR_REF,
  CURSOR_CLOUD_RELAY_LAST_EVENT_AT_REF,
  CURSOR_CLOUD_WEBHOOK_ID,
  clearCursorCloudRelayRegistration,
  clearCursorCloudWebhookSecret,
  persistCursorCloudRelayRegistration,
  persistCursorCloudWebhookSecret,
  persistCursorCloudWebhookSecretId,
  readCursorCloudRelayPersistedState,
  readCursorCloudRegisteredSecretId,
  readCursorCloudWebhookBinding,
  readCursorCloudWebhookSecret,
  readCursorCloudWebhookSecretId,
  resolveCursorCloudRelayBaseUrl,
  type CursorCloudRelayCredentialStore,
} from "./cursorCloudRelayConfig";

const DEFAULT_CURSOR_CLOUD_RELAY_POLL_INTERVAL_MS = 45_000;
const CURSOR_CLOUD_RELAY_PAGE_LIMIT = 500;
const CURSOR_CLOUD_RELAY_MAX_PAGES_PER_POLL = 20;
const SECRET_ID_BACKFILL_FIRST_RETRY_MS = 60_000;
const SECRET_ID_BACKFILL_MAX_RETRY_MS = 60 * 60_000;
const MIN_CURSOR_WEBHOOK_SECRET_LENGTH = 32;
const UNAUTHORIZED_FIRST_PAUSE_MS = 5 * 60_000;
const UNAUTHORIZED_MAX_PAUSE_MS = 6 * 60 * 60_000;
const CURSOR_CLOUD_RELAY_UNAUTHORIZED_MESSAGE =
  "The Cursor Cloud relay refused this computer's credentials. Sign in to ADE again, or set up Cursor Cloud events again.";

export type CursorCloudIngressStatus = {
  state: "unconfigured" | "ready" | "error";
  webhookId: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  relayBaseUrl: string;
};

export type CursorCloudIngressEventRecord = {
  id: string;
  source: "relay";
  deliveryId: string;
  eventId: string;
  agentId: string;
  status: string;
  summary: string;
  branchName: string | null;
  prUrl: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type CursorCloudIngressCursorStore = {
  get: (source: "cursor-relay") => string | null;
  set: (args: { source: "cursor-relay"; cursor: string | null }) => void;
};

export type CursorCloudIngressServiceDeps = {
  db: Pick<AdeDb, "getJson" | "setJson" | "get" | "run">;
  projectId: string;
  credentialStore: CursorCloudRelayCredentialStore;
  getAccountAccessToken?: () => Promise<string | null>;
  cursorStore: CursorCloudIngressCursorStore;
  /** Awaited before the cursor advances past the delivery. */
  dispatch: (record: CursorCloudIngressEventRecord) => void | Promise<void>;
  logger: Logger;
  /**
   * Polling (and the first relay registration) only runs while this returns
   * true. Every poll is a relay request, and an always-on poll from every
   * brain is what turned an unused feature into a billed full-table scan.
   */
  wantsEvents?: () => boolean;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
};

type CursorCloudRelayEvent = {
  cursor: string;
  eventId: string;
  eventType: string;
  status: string;
  agentId: string;
  createdAt: string;
  body: string;
};

type CursorCloudRelayEventsResponse = {
  events: CursorCloudRelayEvent[];
  nextCursor: string | null;
  cursorExpired: boolean;
  /** False when a signed-in poll sent a secret the relay no longer holds. */
  secretKnown: boolean;
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

/**
 * The account a token names (its JWT `sub`), read without verifying it: only
 * to tell a new sign-in from a refreshed token for the same account.
 */
function accountTokenSubject(token: string | null): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return isRecord(claims) ? readString(claims, "sub") : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRelaySequence(cursor: string): number | null {
  const match = /^seq:(\d+)$/.exec(cursor.trim());
  return match ? Number(match[1]) : null;
}

function parseCreatedAt(payload: Record<string, unknown>, relayCreatedAt: string): string {
  const timestamp = payload.timestamp;
  if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) {
    return new Date(timestamp).toISOString();
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const date = new Date(ms);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (Number.isFinite(Date.parse(relayCreatedAt))) return new Date(relayCreatedAt).toISOString();
  return new Date().toISOString();
}

export function mapCursorCloudRelayEventToRecord(event: CursorCloudRelayEvent): CursorCloudIngressEventRecord {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(event.body) as unknown;
    if (!isRecord(parsed)) throw new Error("payload must be an object");
    payload = parsed;
  } catch (error: unknown) {
    throw new Error(`Cursor Cloud relay event '${event.eventId}' has an invalid body: ${errorMessage(error)}`);
  }

  const agentId = readString(payload, "id") ?? event.agentId;
  const status = readString(payload, "status") ?? event.status;
  const target = readNested(payload, "target");
  const branchName = readString(target, "branchName");
  const prUrl = readString(target, "prUrl");
  const summary = readString(payload, "summary")
    ?? `Cursor Cloud agent ${agentId} ${status}`;

  return {
    id: randomUUID(),
    source: "relay",
    deliveryId: event.eventId,
    eventId: event.eventId,
    agentId,
    status,
    summary,
    branchName,
    prUrl,
    payload,
    createdAt: parseCreatedAt(payload, event.createdAt),
  };
}

function parseRelayEventsResponse(value: unknown): CursorCloudRelayEventsResponse {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new Error("Cursor Cloud relay returned an invalid events response.");
  }
  const events = value.events.map((entry) => {
    if (!isRecord(entry)) throw new Error("Cursor Cloud relay returned an invalid event.");
    const cursor = readString(entry, "cursor");
    const eventId = readString(entry, "eventId");
    const eventType = readString(entry, "eventType") ?? "statusChange";
    const status = readString(entry, "status");
    const agentId = readString(entry, "agentId");
    const createdAt = readString(entry, "createdAt");
    const body = typeof entry.body === "string" ? entry.body : null;
    if (!cursor || !eventId || !status || !agentId || !createdAt || body == null) {
      throw new Error("Cursor Cloud relay returned an incomplete event.");
    }
    return { cursor, eventId, eventType, status, agentId, createdAt, body };
  });
  return {
    events,
    nextCursor: typeof value.nextCursor === "string" && value.nextCursor.trim() ? value.nextCursor.trim() : null,
    cursorExpired: value.cursorExpired === true,
    secretKnown: value.secretKnown !== false,
  };
}

export function createCursorCloudIngressService(deps: CursorCloudIngressServiceDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollIntervalMs = Math.max(1_000, deps.pollIntervalMs ?? DEFAULT_CURSOR_CLOUD_RELAY_POLL_INTERVAL_MS);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight: Promise<void> | null = null;
  // A poll already running when the service stops can finish after the
  // database is closed. Its failure is then expected and must not be written.
  let stopped = false;
  // Registrations made before the relay answered an id get one. A failed
  // backfill (or a relay too old to return an id) tries again later, with a
  // longer wait each time.
  let secretIdBackfillAt = 0;
  let secretIdBackfillDelayMs = SECRET_ID_BACKFILL_FIRST_RETRY_MS;
  // A refused poll is retried once, after registering the secret again. Past
  // that the credentials are wrong in a way another poll cannot fix, so polling
  // pauses, longer each time, until a pause ends or setup runs again.
  // Signing in to another account (or at all) ends the pause: the refusal was
  // about the credentials polling had then.
  let unauthorizedPausedUntil = 0;
  let unauthorizedPauseMs = UNAUTHORIZED_FIRST_PAUSE_MS;
  let unauthorizedPausedAccount: string | null = null;
  const clearUnauthorizedPause = (): void => {
    unauthorizedPausedUntil = 0;
    unauthorizedPauseMs = UNAUTHORIZED_FIRST_PAUSE_MS;
    unauthorizedPausedAccount = null;
  };
  const pauseAfterUnauthorized = (
    accountAccessToken: string | null,
    credentials: { hasSecret: boolean; hasAccountToken: boolean },
  ): void => {
    unauthorizedPausedUntil = Date.now() + unauthorizedPauseMs;
    unauthorizedPausedAccount = accountTokenSubject(accountAccessToken);
    deps.logger.warn("automations.cursor_cloud_relay_unauthorized", {
      pausedUntil: new Date(unauthorizedPausedUntil).toISOString(),
      ...credentials,
    });
    unauthorizedPauseMs = Math.min(unauthorizedPauseMs * 2, UNAUTHORIZED_MAX_PAUSE_MS);
  };

  const setLastError = (message: string | null): void => {
    deps.db.setJson(CURSOR_CLOUD_RELAY_LAST_ERROR_REF, message);
  };

  const getStatus = (): CursorCloudIngressStatus => {
    const relayBaseUrl = resolveCursorCloudRelayBaseUrl(deps.db);
    const persisted = readCursorCloudRelayPersistedState(deps.db);
    let secret: string | null = null;
    let secretError: string | null = null;
    try {
      secret = readCursorCloudWebhookSecret(deps.db, deps.credentialStore);
    } catch (error: unknown) {
      secretError = errorMessage(error);
    }
    const configured = Boolean(persisted.configured && secret && secret.length >= MIN_CURSOR_WEBHOOK_SECRET_LENGTH);
    const lastError = secretError ?? persisted.lastError;
    const state: CursorCloudIngressStatus["state"] = lastError
      ? "error"
      : !configured
        ? "unconfigured"
        : "ready";
    return {
      state,
      webhookId: configured ? CURSOR_CLOUD_WEBHOOK_ID : null,
      lastEventAt: persisted.lastEventAt,
      lastError,
      relayBaseUrl,
    };
  };

  const readAccountAccessToken = async (): Promise<string | null> => {
    return deps.getAccountAccessToken
      ? await deps.getAccountAccessToken().catch(() => null)
      : null;
  };

  /** Registers the secret; resolves with the relay's id for it, when the relay answers one. */
  const registerSecret = async (args: {
    relayBaseUrl: string;
    secret: string;
  }): Promise<string | null> => {
    const accountAccessToken = await readAccountAccessToken();
    const response = await fetchImpl(`${args.relayBaseUrl}/cursor/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.secret}`,
        ...(accountAccessToken ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret: args.secret }),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = isRecord(payload) ? readString(payload, "error") : null;
      throw new Error(detail ?? `Cursor Cloud relay registration failed (HTTP ${response.status}).`);
    }
    return readCursorCloudRegisteredSecretId(payload);
  };

  /** Registers the stored secret again and keeps the id the relay answers. */
  const reregisterSecret = async (args: { relayBaseUrl: string; secret: string }): Promise<void> => {
    const secretId = await registerSecret(args);
    // A setup or teardown while the call was out replaced the secret, and this
    // id names the old one. `setup` writes a secret and its id together.
    if (readCursorCloudWebhookSecret(deps.db, deps.credentialStore) !== args.secret) return;
    persistCursorCloudWebhookSecretId(deps.credentialStore, secretId);
  };

  const setup = async (): Promise<CursorCloudIngressStatus> => {
    clearUnauthorizedPause();
    try {
      const relayBaseUrl = resolveCursorCloudRelayBaseUrl(deps.db);
      const storedSecret = readCursorCloudWebhookSecret(deps.db, deps.credentialStore);
      const secret = storedSecret && storedSecret.length >= MIN_CURSOR_WEBHOOK_SECRET_LENGTH
        ? storedSecret
        : randomBytes(32).toString("hex");
      const secretId = await registerSecret({ relayBaseUrl, secret });
      persistCursorCloudWebhookSecret(deps.credentialStore, secret);
      persistCursorCloudWebhookSecretId(deps.credentialStore, secretId);
      persistCursorCloudRelayRegistration(deps.db);
      deps.logger.info("automations.cursor_cloud_relay_configured", {
        webhookId: CURSOR_CLOUD_WEBHOOK_ID,
      });
      return getStatus();
    } catch (error: unknown) {
      const message = errorMessage(error);
      setLastError(message);
      deps.logger.warn("automations.cursor_cloud_relay_setup_failed", { error: message });
      throw error;
    }
  };

  const teardown = async (): Promise<CursorCloudIngressStatus> => {
    clearUnauthorizedPause();
    try {
      clearCursorCloudWebhookSecret(deps.credentialStore);
      clearCursorCloudRelayRegistration(deps.db);
      deps.cursorStore.set({ source: "cursor-relay", cursor: null });
      deps.logger.info("automations.cursor_cloud_relay_removed", { webhookId: CURSOR_CLOUD_WEBHOOK_ID });
      return getStatus();
    } catch (error: unknown) {
      const message = errorMessage(error);
      setLastError(message);
      deps.logger.warn("automations.cursor_cloud_relay_teardown_failed", { error: message });
      throw error;
    }
  };

  const persistRecord = (record: CursorCloudIngressEventRecord): boolean => {
    const existing = deps.db.get<{ id: string }>(
      `select id from cursor_cloud_ingress_events
        where project_id = ? and delivery_id = ?
        limit 1`,
      [deps.projectId, record.deliveryId],
    );
    if (existing) return false;
    deps.db.run(
      `insert into cursor_cloud_ingress_events(
        id, project_id, source, delivery_id, event_id, agent_id, status,
        summary, payload_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        deps.projectId,
        record.source,
        record.deliveryId,
        record.eventId,
        record.agentId,
        record.status,
        record.summary,
        record.payload ? JSON.stringify(record.payload) : null,
        record.createdAt,
      ],
    );
    return true;
  };

  const poll = async (): Promise<void> => {
    if (deps.wantsEvents && !deps.wantsEvents()) return;
    if (Date.now() < unauthorizedPausedUntil) {
      // No subject is a failed token read as often as a sign-out; only a
      // signed-in account other than the paused one ends the pause.
      const account = accountTokenSubject(await readAccountAccessToken());
      if (account === null || account === unauthorizedPausedAccount) return;
      clearUnauthorizedPause();
    }
    let status = getStatus();
    if (status.state === "unconfigured" || (status.state === "error" && !status.webhookId)) {
      try {
        status = await setup();
      } catch {
        return;
      }
    }
    if (status.state === "error" && status.webhookId) {
      setLastError(null);
      status = getStatus();
    }
    if (status.state !== "ready") return;
    const binding = readCursorCloudWebhookBinding({
      db: deps.db,
      credentialStore: deps.credentialStore,
    });
    const accountAccessToken = await readAccountAccessToken();
    if (!binding?.secret && !accountAccessToken) {
      throw new Error("Cursor Cloud webhook secret is unavailable.");
    }
    // Registering again is idempotent. It gives this computer's secret its own
    // relay row and id, so another computer on the account cannot replace it.
    if (binding?.secret && Date.now() >= secretIdBackfillAt && !readCursorCloudWebhookSecretId(deps.credentialStore)) {
      try {
        await reregisterSecret({ relayBaseUrl: status.relayBaseUrl, secret: binding.secret });
      } catch (error: unknown) {
        deps.logger.warn("automations.cursor_cloud_relay_secret_id_backfill_failed", { error: errorMessage(error) });
      }
      if (!readCursorCloudWebhookSecretId(deps.credentialStore)) {
        secretIdBackfillAt = Date.now() + secretIdBackfillDelayMs;
        secretIdBackfillDelayMs = Math.min(secretIdBackfillDelayMs * 2, SECRET_ID_BACKFILL_MAX_RETRY_MS);
      }
    }

    let reregisteredAfterUnauthorized = false;
    for (let page = 0; page < CURSOR_CLOUD_RELAY_MAX_PAGES_PER_POLL; page += 1) {
      const cursor = deps.cursorStore.get("cursor-relay");
      const url = new URL(`${status.relayBaseUrl}/cursor/events`);
      url.searchParams.set("limit", String(CURSOR_CLOUD_RELAY_PAGE_LIMIT));
      if (cursor) url.searchParams.set("after", cursor);
      const response = await fetchImpl(url, {
        headers: {
          ...(binding?.secret ? { authorization: `Bearer ${binding.secret}` } : {}),
          ...(accountAccessToken ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      const rawPayload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        if (response.status === 401) {
          // The relay sweeps unowned secrets it has not heard from in weeks.
          // Re-registering the stored secret is idempotent and restores
          // access, so it is tried once and the same page asked again.
          const credentials = { hasSecret: Boolean(binding?.secret), hasAccountToken: Boolean(accountAccessToken) };
          if (binding?.secret && !reregisteredAfterUnauthorized) {
            reregisteredAfterUnauthorized = true;
            try {
              await reregisterSecret({ relayBaseUrl: status.relayBaseUrl, secret: binding.secret });
            } catch (error: unknown) {
              pauseAfterUnauthorized(accountAccessToken, credentials);
              throw error;
            }
            page -= 1;
            continue;
          }
          pauseAfterUnauthorized(accountAccessToken, credentials);
          throw new Error(CURSOR_CLOUD_RELAY_UNAUTHORIZED_MESSAGE);
        }
        const detail = isRecord(rawPayload) ? readString(rawPayload, "error") : null;
        throw new Error(detail ?? `Cursor Cloud relay poll failed (HTTP ${response.status}).`);
      }
      const payload = parseRelayEventsResponse(rawPayload);
      clearUnauthorizedPause();
      // Signed in, the poll still works without the secret, but webhooks
      // signed with it would be refused. Register it again; the events below
      // are still valid, so a failed registration only waits for the next poll.
      if (page === 0 && !payload.secretKnown && binding?.secret) {
        try {
          await reregisterSecret({ relayBaseUrl: status.relayBaseUrl, secret: binding.secret });
          deps.logger.info("automations.cursor_cloud_relay_secret_reregistered", { webhookId: CURSOR_CLOUD_WEBHOOK_ID });
        } catch (error: unknown) {
          deps.logger.warn("automations.cursor_cloud_relay_secret_reregister_failed", { error: errorMessage(error) });
        }
      }
      if (payload.cursorExpired) {
        deps.cursorStore.set({ source: "cursor-relay", cursor: payload.nextCursor });
        setLastError(null);
        deps.logger.info("automations.cursor_cloud_relay_cursor_reset", { cursor: payload.nextCursor });
        return;
      }

      const ordered = [...payload.events].sort(
        (a, b) => (parseRelaySequence(a.cursor) ?? 0) - (parseRelaySequence(b.cursor) ?? 0),
      );
      let newestEventAt: string | null = null;
      for (const event of ordered) {
        const record = mapCursorCloudRelayEventToRecord(event);
        if (!persistRecord(record)) continue;
        await deps.dispatch(record);
        if (!newestEventAt || Date.parse(record.createdAt) > Date.parse(newestEventAt)) {
          newestEventAt = record.createdAt;
        }
      }
      if (payload.nextCursor) {
        deps.cursorStore.set({ source: "cursor-relay", cursor: payload.nextCursor });
      }
      if (newestEventAt) deps.db.setJson(CURSOR_CLOUD_RELAY_LAST_EVENT_AT_REF, newestEventAt);
      setLastError(null);
      if (payload.events.length < CURSOR_CLOUD_RELAY_PAGE_LIMIT || !payload.nextCursor) return;
    }
  };

  const pollNow = async (): Promise<void> => {
    if (pollInFlight) return pollInFlight;
    pollInFlight = poll()
      .catch((error: unknown) => {
        if (stopped) return;
        const message = errorMessage(error);
        setLastError(message);
        deps.logger.warn("automations.cursor_cloud_relay_poll_failed", { error: message });
      })
      .finally(() => {
        pollInFlight = null;
      });
    return pollInFlight;
  };

  const start = (): void => {
    if (pollTimer) return;
    stopped = false;
    void pollNow();
    pollTimer = setInterval(() => void pollNow(), pollIntervalMs);
    pollTimer.unref?.();
  };

  const stop = (): void => {
    stopped = true;
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const getWebhookBinding = () => readCursorCloudWebhookBinding({
    db: deps.db,
    credentialStore: deps.credentialStore,
  });

  return {
    getStatus,
    setup,
    teardown,
    start,
    stop,
    pollNow,
    getWebhookBinding,
  };
}

export type CursorCloudIngressService = ReturnType<typeof createCursorCloudIngressService>;
