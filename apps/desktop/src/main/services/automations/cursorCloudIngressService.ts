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
  readCursorCloudRelayPersistedState,
  readCursorCloudWebhookBinding,
  readCursorCloudWebhookSecret,
  resolveCursorCloudRelayBaseUrl,
  type CursorCloudRelayCredentialStore,
} from "./cursorCloudRelayConfig";

const DEFAULT_CURSOR_CLOUD_RELAY_POLL_INTERVAL_MS = 45_000;
const CURSOR_CLOUD_RELAY_PAGE_LIMIT = 500;
const CURSOR_CLOUD_RELAY_MAX_PAGES_PER_POLL = 20;
const MIN_CURSOR_WEBHOOK_SECRET_LENGTH = 32;

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
  };
}

export function createCursorCloudIngressService(deps: CursorCloudIngressServiceDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollIntervalMs = Math.max(1_000, deps.pollIntervalMs ?? DEFAULT_CURSOR_CLOUD_RELAY_POLL_INTERVAL_MS);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight: Promise<void> | null = null;
  // Latched by `stop` and never cleared. The runtime that owns this service
  // closes its database immediately after stopping it, and a poll already in
  // flight outlives that close: every `db` write below runs from a detached
  // promise, so a write against a closed store becomes an unhandled rejection
  // that ends the process. The CLI's headless runtime makes this load-bearing.
  // It opens a runtime per command and tears it down while `start`'s first poll
  // is still awaiting the relay, which is how `ade plugin doctor` outside an ADE
  // project died with exit 1 and no output.
  let stopped = false;

  /**
   * Run a state write that a stopped runtime must not turn into a failure.
   *
   * After `stop` the store is closed or closing, so the write is skipped. A
   * write that still throws is logged at debug and swallowed: nothing awaits
   * these calls, and the poll they belong to has no one left to report to.
   */
  const writeGuarded = (event: string, write: () => void): void => {
    if (stopped) return;
    try {
      write();
    } catch (error: unknown) {
      deps.logger.debug(event, { error: errorMessage(error) });
    }
  };

  const setLastError = (message: string | null): void => {
    writeGuarded("automations.cursor_cloud_relay_last_error_write_skipped", () => {
      deps.db.setJson(CURSOR_CLOUD_RELAY_LAST_ERROR_REF, message);
    });
  };

  const setRelayCursor = (cursor: string | null): void => {
    writeGuarded("automations.cursor_cloud_relay_cursor_write_skipped", () => {
      deps.cursorStore.set({ source: "cursor-relay", cursor });
    });
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

  const registerSecret = async (args: {
    relayBaseUrl: string;
    secret: string;
  }): Promise<void> => {
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
  };

  const setup = async (): Promise<CursorCloudIngressStatus> => {
    try {
      const relayBaseUrl = resolveCursorCloudRelayBaseUrl(deps.db);
      const storedSecret = readCursorCloudWebhookSecret(deps.db, deps.credentialStore);
      const secret = storedSecret && storedSecret.length >= MIN_CURSOR_WEBHOOK_SECRET_LENGTH
        ? storedSecret
        : randomBytes(32).toString("hex");
      await registerSecret({ relayBaseUrl, secret });
      persistCursorCloudWebhookSecret(deps.credentialStore, secret);
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
    if (stopped) return false;
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
    if (stopped) return;
    let status = getStatus();
    if (status.state === "unconfigured" || (status.state === "error" && !status.webhookId)) {
      try {
        status = await setup();
      } catch {
        return;
      }
      if (stopped) return;
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
    if (stopped) return;
    if (!binding?.secret && !accountAccessToken) {
      throw new Error("Cursor Cloud webhook secret is unavailable.");
    }

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
      if (stopped) return;
      if (!response.ok) {
        const detail = isRecord(rawPayload) ? readString(rawPayload, "error") : null;
        throw new Error(detail ?? `Cursor Cloud relay poll failed (HTTP ${response.status}).`);
      }
      const payload = parseRelayEventsResponse(rawPayload);
      if (payload.cursorExpired) {
        setRelayCursor(payload.nextCursor);
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
        // The dispatch is awaited, so a stop can land inside it. Returning here
        // leaves the cursor where it was, and the delivery replays on the next
        // runtime rather than being acknowledged against a closing store.
        if (stopped) return;
        if (!newestEventAt || Date.parse(record.createdAt) > Date.parse(newestEventAt)) {
          newestEventAt = record.createdAt;
        }
      }
      if (payload.nextCursor) {
        setRelayCursor(payload.nextCursor);
      }
      if (newestEventAt) {
        writeGuarded("automations.cursor_cloud_relay_last_event_write_skipped", () => {
          deps.db.setJson(CURSOR_CLOUD_RELAY_LAST_EVENT_AT_REF, newestEventAt);
        });
      }
      setLastError(null);
      if (payload.events.length < CURSOR_CLOUD_RELAY_PAGE_LIMIT || !payload.nextCursor) return;
    }
  };

  const pollNow = async (): Promise<void> => {
    if (pollInFlight) return pollInFlight;
    pollInFlight = poll()
      .catch((error: unknown) => {
        // A throw from inside this handler rejects a promise nothing awaits:
        // both `start` and the interval call `pollNow` detached. Reporting the
        // failure must never be able to become a second, fatal failure.
        try {
          const message = errorMessage(error);
          setLastError(message);
          deps.logger.warn("automations.cursor_cloud_relay_poll_failed", { error: message });
        } catch {
          // Status persistence and logging are both best effort at this point.
        }
      })
      .finally(() => {
        pollInFlight = null;
      });
    return pollInFlight;
  };

  const start = (): void => {
    if (pollTimer || stopped) return;
    void pollNow();
    pollTimer = setInterval(() => void pollNow(), pollIntervalMs);
    pollTimer.unref?.();
  };

  const stop = (): void => {
    // Latched before the timer is cleared so a poll that resumes between the
    // two observes the stop, and never restarted: the owning runtime is going
    // away, and a later `start` would poll against a closed database.
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
