import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import { postToPublicHttps, publicHttpsUrlProblem } from "../../../../desktop/src/main/services/net/publicHttpsPost";
import type { RemoteMcpConnectionSummary } from "../../../../desktop/src/shared/types/remoteMcp";
import { MCP_EVENT_NAMES, mcpHubCovers, mcpHubHead, mcpHubPositionAt, onMcpEvent, type McpEventName, type McpHubPosition } from "./remoteMcpEventHub";
import {
  EVENTS_ERROR,
  McpEventsError,
  boundedInteger,
  canonicalJson,
  decodeCursor,
  decodePosition,
  encodeCursor,
  encodePosition,
  eventName,
  invalid,
  isRecord,
  parseFilter,
  type MachineRead,
  type McpOccurrence,
  type ReadHereArgs,
} from "./remoteMcpEventCatalog";
import { REMOTE_MCP_VAULT_KIND, REMOTE_MCP_VAULT_SCOPE, type RemoteMcpVault } from "./remoteMcpStore";

/**
 * ADE MCP Events webhooks (`events/subscribe`). A subscription is kept in the
 * account vault, so every machine knows it within one sync, and each machine
 * POSTs its own events, signed per Standard Webhooks. Nothing goes through
 * ADE's servers.
 *
 * Also accepted for clients built on the draft before the SEP (ChatGPT, the
 * AI SDK): `webhook-id` equal to the body's `eventId`, which is made per
 * subscription (a digest of the subscription and the event), as t3code's
 * bridge does.
 */

const DEFAULT_TTL_MS = 60 * 60_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 100;
const SECRET_GRACE_MS = 5 * 60_000;
/** The whole POST, not only a silent socket: a slow endpoint can't hold the others. */
const POST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_READ_BYTES = 8 * 1024;
const VERIFICATIONS_PER_HOST_PER_MINUTE = 10;
/** A failed endpoint check answers again from memory this long, so retrying a bad URL sends nothing. */
const VERIFICATION_FAILURE_MEMORY_MS = 60_000;
/** Delay before each try of one event: five tries over about 7.5 minutes. */
const RETRY_DELAYS_MS = [0, 30_000, 60_000, 2 * 60_000, 4 * 60_000];
const DELIVERIES_PER_PASS = 20;
/** Subscriptions sent to at once: one slow endpoint holds only its own. */
const PARALLEL_DELIVERIES = 4;
const SUBSCRIPTION_KEY_PREFIX = "event-sub:";
/** A turn's reply reaches its transcript file within about 100 ms of the turn's end; a webhook waits this long for it. */
const REPLY_SETTLE_MS = 600;
/** An expired subscription its own machine never came back to remove: any machine removes it after this. */
const ORPHAN_AFTER_MS = 24 * 60 * 60_000;

// ── Webhook transport ────────────────────────────────────────────────────────

type McpWebhookFailure = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

type WebhookAnswer = { status: number; body?: string; failure?: McpWebhookFailure; privateAddress?: boolean };

/** A public https URL, or why it can't be one. */
function webhookUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "`delivery.url` is required.";
  switch (publicHttpsUrlProblem(value)) {
    case "invalid": return "`delivery.url` isn't a valid URL.";
    case "not_https": return "`delivery.url` must use https.";
    case "credentials": return "`delivery.url` can't carry a user name or password.";
    case "private": return "`delivery.url` must be a public address, not this computer or a private network.";
    default: return null;
  }
}

/** One POST, with the answer read (at most 8 KiB) only when asked. */
async function postWebhook(url: string, headers: Record<string, string>, body: string, readBody: boolean): Promise<WebhookAnswer> {
  const answer = await postToPublicHttps(url, headers, body, {
    timeoutMs: POST_TIMEOUT_MS,
    ...(readBody ? { maxBodyBytes: MAX_RESPONSE_READ_BYTES } : {}),
  });
  const failure: McpWebhookFailure | undefined = answer.error === "timeout" || answer.error === "tls_error"
    ? answer.error
    : answer.error ? "connection_refused"
    : answer.status >= 500 ? "http_5xx"
    : answer.status >= 300 ? "http_4xx"
    : undefined;
  return {
    status: answer.status,
    ...(answer.body !== undefined ? { body: answer.body } : {}),
    ...(failure ? { failure } : {}),
    ...(answer.error === "private_address" ? { privateAddress: true } : {}),
  };
}

function secretBytes(secret: string): Buffer | null {
  if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret)) return null;
  const bytes = Buffer.from(secret.slice("whsec_".length), "base64");
  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

/** Standard Webhooks headers; a second secret during rotation adds a second signature. */
function signedHeaders(args: { secrets: string[]; webhookId: string; subscriptionId: string; body: string }): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signatures = args.secrets.flatMap((secret) => {
    const key = secretBytes(secret);
    return key ? [`v1,${createHmac("sha256", key).update(`${args.webhookId}.${timestamp}.${args.body}`).digest("base64")}`] : [];
  });
  return {
    "content-type": "application/json",
    "user-agent": "ADE MCP events",
    "webhook-id": args.webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
    "x-mcp-subscription-id": args.subscriptionId,
  };
}

const controlMessageId = (type: string): string => `msg_${type}_${randomBytes(12).toString("base64url")}`;

// ── Subscriptions (account vault) ────────────────────────────────────────────

type StoredSubscription = {
  v: 1;
  id: string;
  /** The ADE MCP connection that subscribed: the principal. */
  connectionId: string;
  name: McpEventName;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  previousSecret?: string;
  previousSecretUntil?: number;
  createdAt: number;
  /** Events since then: what a machine delivers first. */
  startAt: number;
  refreshBefore: number;
  /** The client's last cursor, for a machine starting this subscription after a restart. */
  cursor: string | null;
  /** `arguments.machine` resolved: only that machine delivers. */
  machineKey: string | null;
  /** The machine that took the subscribe: it removes it once expired or revoked. */
  servedBy: string;
};

function parseSubscription(raw: string | null): StoredSubscription | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.v !== 1 || typeof value.id !== "string" || typeof value.connectionId !== "string") return null;
    if (typeof value.url !== "string" || typeof value.secret !== "string" || typeof value.refreshBefore !== "number") return null;
    if (!(MCP_EVENT_NAMES as readonly string[]).includes(String(value.name))) return null;
    return value as unknown as StoredSubscription;
  } catch {
    return null;
  }
}

function createSubscriptionStore(vault: RemoteMcpVault, warn: (event: string, data: Record<string, unknown>) => void) {
  let cache = new Map<string, { updatedAt: string; subscription: StoredSubscription | null }>();
  const keyOf = (id: string) => `${SUBSCRIPTION_KEY_PREFIX}${id}`;
  return {
    list(): StoredSubscription[] {
      const next = new Map<string, { updatedAt: string; subscription: StoredSubscription | null }>();
      const out: StoredSubscription[] = [];
      for (const row of vault.list(REMOTE_MCP_VAULT_SCOPE)) {
        if (row.kind !== REMOTE_MCP_VAULT_KIND || !row.key.startsWith(SUBSCRIPTION_KEY_PREFIX) || row.deleted || !row.readable) continue;
        const cached = cache.get(row.key);
        const subscription = cached && cached.updatedAt === row.updatedAt
          ? cached.subscription
          : parseSubscription(vault.get(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, row.key));
        // The key names the record; a value claiming another id is not trusted.
        const trusted = subscription && keyOf(subscription.id) === row.key ? subscription : null;
        next.set(row.key, { updatedAt: row.updatedAt, subscription: trusted });
        if (trusted) out.push(trusted);
      }
      cache = next;
      return out;
    },
    save(subscription: StoredSubscription): void {
      if (!vault.set(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, keyOf(subscription.id), JSON.stringify(subscription))) {
        throw new Error("ADE couldn't save the subscription to your account vault. Try again shortly.");
      }
    },
    remove(id: string): void {
      try {
        vault.remove(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, keyOf(id));
      } catch (error) {
        warn("remote_mcp.events_unsubscribe_failed", { id, error: getErrorMessage(error) });
      }
    },
  };
}

// ── Subscribe and deliver ────────────────────────────────────────────────────

export type McpWebhooksDeps = {
  vault: RemoteMcpVault;
  /** The connection behind a principal, or null when it was removed. */
  connection: (id: string) => RemoteMcpConnectionSummary | null;
  /** This machine answers ADE MCP now; one that doesn't sends no webhooks. */
  servingHere: () => boolean;
  /** Pushes the vault soon, so the other machines see a new subscription. */
  syncSoon: () => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  now: () => number;
  /** This machine's key in a cursor. */
  selfKey: () => string;
  /** This machine's matching events after a position. */
  readHere: (args: ReadHereArgs) => Promise<MachineRead>;
  /** The key of the machine `machine` names, checked against the connection. */
  machineKeyNamed: (connection: RemoteMcpConnectionSummary, machine: string) => Promise<string>;
};

export function createMcpWebhooks(deps: McpWebhooksDeps) {
  const { now, warn, selfKey, readHere } = deps;
  const store = createSubscriptionStore(deps.vault, warn);

  /** Per (connection, url): when it last passed the check. */
  const verifiedRecently = new Map<string, number>();
  const verificationsByHost = new Map<string, number[]>();
  /** Sets `key` as the newest entry and drops the oldest past 1,000, so an app cycling URLs can't grow these. */
  const rememberCapped = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.delete(key);
    map.set(key, value);
    if (map.size > 1_000) map.delete(map.keys().next().value!);
  };
  /** Per (connection, url): a check running now, or one that failed lately. */
  const verificationsRunning = new Map<string, Promise<void>>();
  const verificationFailures = new Map<string, { at: number; error: McpEventsError }>();

  /** One check per (connection, url) at a time; a failure is remembered for a minute. */
  const verifyOnce = async (pairKey: string, subscriptionId: string, url: string, secret: string): Promise<void> => {
    const failed = verificationFailures.get(pairKey);
    if (failed && now() - failed.at < VERIFICATION_FAILURE_MEMORY_MS) throw failed.error;
    let running = verificationsRunning.get(pairKey);
    if (!running) {
      running = verify(subscriptionId, url, secret).then(() => {
        verificationFailures.delete(pairKey);
        rememberCapped(verifiedRecently, pairKey, now());
      }, (error: unknown) => {
        // The rate limit is about this minute, not about the endpoint: not remembered.
        if (error instanceof McpEventsError && error.code !== EVENTS_ERROR.resourceExhausted) {
          rememberCapped(verificationFailures, pairKey, { at: now(), error });
        }
        throw error;
      }).finally(() => verificationsRunning.delete(pairKey));
      verificationsRunning.set(pairKey, running);
    }
    await running;
  };

  const verify = async (subscriptionId: string, url: string, secret: string): Promise<void> => {
    const host = new URL(url).hostname;
    const recent = (verificationsByHost.get(host) ?? []).filter((at) => now() - at < 60_000);
    if (recent.length >= VERIFICATIONS_PER_HOST_PER_MINUTE) {
      throw new McpEventsError(EVENTS_ERROR.resourceExhausted, `Too many endpoint checks for ${host} this minute. Try again shortly.`, { limit: "verifications" });
    }
    rememberCapped(verificationsByHost, host, [...recent, now()]);
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    const answer = await postWebhook(url, signedHeaders({ secrets: [secret], webhookId: controlMessageId("verification"), subscriptionId, body }), body, true);
    if (answer.privateAddress) throw invalid("`delivery.url` resolves to a private address. Use a public https URL.");
    if (answer.failure || answer.status < 200 || answer.status >= 300) {
      throw new McpEventsError(EVENTS_ERROR.callbackEndpoint, "The webhook endpoint didn't accept ADE's check.", { reason: answer.failure ?? "http_4xx" });
    }
    let echoed: unknown = null;
    try {
      const parsed: unknown = JSON.parse(answer.body ?? "");
      echoed = isRecord(parsed) ? parsed.challenge : null;
    } catch {
      echoed = null;
    }
    const expected = Buffer.from(challenge);
    const given = Buffer.from(typeof echoed === "string" ? echoed : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new McpEventsError(EVENTS_ERROR.callbackEndpoint, "The webhook endpoint didn't echo ADE's challenge.", { reason: "challenge_failed" });
    }
  };

  const subscriptionId = (connectionId: string, url: string, name: string, args: unknown): string =>
    `sub_${createHash("sha256").update(canonicalJson([connectionId, url, name, args ?? {}])).digest("base64url").slice(0, 22)}`;

  const subscribe = async (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => {
    const name = eventName(params.name);
    const filter = parseFilter([name], params.arguments);
    const delivery = isRecord(params.delivery) ? params.delivery : null;
    if (!delivery) throw invalid("`delivery` is required: {mode: \"webhook\", url, secret}.");
    if (delivery.mode !== undefined && delivery.mode !== "webhook") {
      throw new McpEventsError(EVENTS_ERROR.unsupported, "ADE delivers events by poll or webhook.", { feature: "deliveryMode", value: delivery.mode });
    }
    const urlProblem = webhookUrlProblem(delivery.url);
    if (urlProblem) throw invalid(urlProblem);
    const url = String(delivery.url).trim();
    const secret = typeof delivery.secret === "string" ? delivery.secret.trim() : "";
    if (!secretBytes(secret)) throw invalid("`delivery.secret` must be `whsec_` and the base64 of 24 to 64 random bytes.");
    const cursor = params.cursor === undefined || params.cursor === null ? null : String(params.cursor);
    decodeCursor(cursor);
    const ttlMs = params.ttlMs === undefined
      ? DEFAULT_TTL_MS
      // No expiry is not granted: a day, refreshed like any other.
      : params.ttlMs === null ? MAX_TTL_MS : boundedInteger(params.ttlMs, "ttlMs", DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
    const args = isRecord(params.arguments) ? params.arguments : {};
    const id = subscriptionId(connection.id, url, name, args);
    const all = store.list();
    const existing = all.find((entry) => entry.id === id) ?? null;
    const live = existing && existing.refreshBefore > now() ? existing : null;
    if (!live && all.filter((entry) => entry.connectionId === connection.id && entry.refreshBefore > now()).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      throw new McpEventsError(EVENTS_ERROR.resourceExhausted, `One app can keep at most ${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions.`, { limit: "subscriptions", max: MAX_SUBSCRIPTIONS_PER_CONNECTION });
    }
    // Only that machine delivers; a machine left out of ADE MCP is refused, never widened to all.
    const machineKey = filter.machine ? await deps.machineKeyNamed(connection, filter.machine) : connection.onlyMachine?.machineKey ?? null;
    const pairKey = `${connection.id}\n${url}`;
    const known = all.some((entry) => entry.connectionId === connection.id && entry.url === url && entry.refreshBefore > now())
      || (verifiedRecently.get(pairKey) ?? 0) > now() - MAX_TTL_MS;
    if (!known) await verifyOnce(pairKey, id, url, secret);
    const at = now();
    const rotated = live && live.secret !== secret;
    const record: StoredSubscription = {
      v: 1,
      id,
      connectionId: connection.id,
      name,
      arguments: args,
      url,
      secret,
      ...(rotated ? { previousSecret: live.secret, previousSecretUntil: at + SECRET_GRACE_MS } : {}),
      ...(!rotated && live?.previousSecret && (live.previousSecretUntil ?? 0) > at
        ? { previousSecret: live.previousSecret, previousSecretUntil: live.previousSecretUntil }
        : {}),
      createdAt: live?.createdAt ?? at,
      startAt: live?.startAt ?? at,
      refreshBefore: at + ttlMs,
      cursor: cursor ?? live?.cursor ?? null,
      machineKey,
      servedBy: selfKey(),
    };
    store.save(record);
    deps.syncSoon();
    kick();
    const state = states.get(id);
    return {
      id,
      refreshBefore: new Date(record.refreshBefore).toISOString(),
      cursor: encodeCursor({ t: record.startAt, m: state ? { [selfKey()]: encodePosition(state.after) } : {} }),
      truncated: false,
      ...(live && state
        ? {
          deliveryStatus: {
            active: true,
            lastDeliveryAt: state.lastDeliveryAt ? new Date(state.lastDeliveryAt).toISOString() : null,
            lastError: state.lastError,
            ...(state.failedSince ? { failedSince: new Date(state.failedSince).toISOString() } : {}),
          },
        }
        : {}),
    };
  };

  const unsubscribe = (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>): void => {
    const name = eventName(params.name);
    const delivery = isRecord(params.delivery) ? params.delivery : null;
    const url = typeof delivery?.url === "string" ? delivery.url.trim() : "";
    if (!url) throw invalid("`delivery.url` is required.");
    const id = subscriptionId(connection.id, url, name, isRecord(params.arguments) ? params.arguments : {});
    if (!store.list().some((entry) => entry.id === id)) {
      throw new McpEventsError(EVENTS_ERROR.notFound, "No subscription matches that event, arguments and URL.", { kind: "subscription" });
    }
    store.remove(id);
    states.delete(id);
    // A delivery still waiting for a free slot must not start for it.
    waiting.delete(id);
    deps.syncSoon();
  };

  // ── Delivery (each machine sends its own events) ───────────────────────────

  type Pending = { eventId: string; seq: number; body: string; attempts: number; nextAt: number };
  type DeliveryState = {
    after: McpHubPosition;
    /** This run started after the subscription did: tell the app it may have missed events. */
    gapOwed: boolean;
    /** Waiting for a turn's reply to reach its file, until then. */
    settleAt: number | null;
    pending: Pending | null;
    lastDeliveryAt: number | null;
    lastError: McpWebhookFailure | null;
    failedSince: number | null;
  };
  const states = new Map<string, DeliveryState>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const secretsOf = (subscription: StoredSubscription): string[] =>
    subscription.previousSecret && (subscription.previousSecretUntil ?? 0) > now()
      ? [subscription.secret, subscription.previousSecret]
      : [subscription.secret];

  const sendControl = async (subscription: StoredSubscription, body: Record<string, unknown>): Promise<void> => {
    const text = JSON.stringify(body);
    await postWebhook(subscription.url, signedHeaders({
      secrets: secretsOf(subscription),
      webhookId: controlMessageId(String(body.type)),
      subscriptionId: subscription.id,
      body: text,
    }), text, false).catch((error: unknown) => {
      warn("remote_mcp.events_control_failed", { subscriptionId: subscription.id, type: String(body.type), error: getErrorMessage(error) });
    });
  };

  const stateFor = (subscription: StoredSubscription): DeliveryState => {
    let state = states.get(subscription.id);
    if (!state) {
      // The client's cursor (a poll's, or a delivery's after a restart) is where to resume:
      // this machine's position when it is from this run, else the time the cursor began.
      const given = (() => {
        try {
          return decodeCursor(subscription.cursor);
        } catch {
          return null;
        }
      })();
      const fromCursor = decodePosition(given?.m[selfKey()]);
      const resumed = fromCursor && fromCursor.boot === mcpHubHead().boot ? fromCursor : null;
      const startMs = given ? Math.min(given.t, subscription.startAt) : subscription.startAt;
      const after = resumed ?? mcpHubPositionAt(startMs);
      const gapOwed = !resumed && !mcpHubCovers(startMs);
      state = { after, gapOwed, settleAt: null, pending: null, lastDeliveryAt: null, lastError: null, failedSince: null };
      states.set(subscription.id, state);
    }
    return state;
  };

  /** True when the event is finished with: delivered, refused for good, or out of tries. */
  const attempt = async (subscription: StoredSubscription, state: DeliveryState, pending: Pending): Promise<boolean> => {
    const answer = await postWebhook(subscription.url, signedHeaders({
      secrets: secretsOf(subscription),
      // The draft bridge: the body's per-subscription `eventId`, reused on every retry.
      webhookId: pending.eventId,
      subscriptionId: subscription.id,
      body: pending.body,
    }), pending.body, false);
    if (answer.status >= 200 && answer.status < 300) {
      state.lastDeliveryAt = now();
      state.lastError = null;
      state.failedSince = null;
      return true;
    }
    state.lastError = answer.failure ?? "http_4xx";
    state.failedSince ??= now();
    pending.attempts += 1;
    const delay = RETRY_DELAYS_MS[pending.attempts];
    if (answer.privateAddress || answer.status === 410 || answer.status === 413 || delay === undefined) {
      warn("remote_mcp.events_delivery_dropped", { subscriptionId: subscription.id, status: answer.status, attempts: pending.attempts });
      return true;
    }
    pending.nextAt = now() + delay;
    return false;
  };

  /** Sends a subscription its waiting events, in order. True when more wait than one pass sends. */
  const deliver = async (subscription: StoredSubscription): Promise<boolean> => {
    const state = stateFor(subscription);
    const filter = parseFilter([subscription.name], subscription.arguments);
    for (let sent = 0; sent < DELIVERIES_PER_PASS; sent += 1) {
      if (!state.pending) {
        const read = await readHere({ filter, part: encodePosition(state.after), sinceMs: null, max: 1, maxAgeMs: null });
        const first = read.events[0];
        if (read.truncated || state.gapOwed) {
          state.gapOwed = false;
          // Past the gap, so the next pass doesn't report it again.
          if (read.truncated) state.after = first ? { boot: mcpHubHead().boot, seq: first.seq - 1 } : decodePosition(read.part) ?? state.after;
          await sendControl(subscription, { type: "gap", cursor: encodeCursor({ t: subscription.startAt, m: { [selfKey()]: encodePosition(state.after) } }) });
        }
        if (!first) {
          state.after = decodePosition(read.part) ?? state.after;
          return false;
        }
        const age = now() - Date.parse(first.occurrence.timestamp);
        if (first.occurrence.name === "chat.turn_ended" && filter.includeReply && !first.occurrence.data.reply && age < REPLY_SETTLE_MS) {
          state.settleAt = now() + (REPLY_SETTLE_MS - age);
          return false;
        }
        state.settleAt = null;
        const entryPosition = { boot: mcpHubHead().boot, seq: first.seq };
        // Clients built on the draft before the SEP require `webhook-id` = body `eventId`. One
        // per subscription, so two subscriptions on one URL never share an id a receiver drops.
        const deliveryId = `evt_${createHash("sha256").update(`${subscription.id}:${first.occurrence.eventId}`).digest("base64url").slice(0, 22)}`;
        const occurrence: McpOccurrence = {
          ...first.occurrence,
          eventId: deliveryId,
          // Safe to keep: everything up to this event is delivered or given up on.
          cursor: encodeCursor({ t: subscription.startAt, m: { [selfKey()]: encodePosition(entryPosition) } }),
        };
        state.pending = { eventId: deliveryId, seq: first.seq, body: JSON.stringify(occurrence), attempts: 0, nextAt: now() };
      }
      const pending = state.pending;
      if (pending.nextAt > now()) return false;
      // Each POST waits on the last: stop the moment the app is revoked, the subscription
      // is removed or expires, or this machine stops serving, so no more chat data goes out.
      if (
        states.get(subscription.id) !== state
        || subscription.refreshBefore <= now()
        || !deps.connection(subscription.connectionId)
        || !deps.servingHere()
      ) return false;
      const finished = await attempt(subscription, state, pending);
      if (!finished) return false;
      state.after = { boot: mcpHubHead().boot, seq: pending.seq };
      state.pending = null;
    }
    // More waiting: the next pass sends them.
    return true;
  };

  /**
   * Up to `PARALLEL_DELIVERIES` subscriptions deliver at once, each on its own:
   * a slow endpoint holds only its own slot, and the others go on.
   */
  const delivering = new Set<string>();
  /** Asked for while delivering: runs once more after. */
  const again = new Set<string>();
  const waiting = new Map<string, () => Promise<boolean | void>>();
  const pump = (): void => {
    for (const [id, task] of waiting) {
      if (delivering.size >= PARALLEL_DELIVERIES) return;
      waiting.delete(id);
      delivering.add(id);
      void task().then((more) => {
        if (more) again.add(id);
      }).finally(() => {
        delivering.delete(id);
        if (again.delete(id)) kick();
        pump();
        scheduleRetry();
      });
    }
  };
  /** The subscriptions the current run queued: a waiting task no run still wants is dropped. */
  let queuedThisRun = new Set<string>();
  const enqueue = (id: string, task: () => Promise<boolean | void>): void => {
    queuedThisRun.add(id);
    if (delivering.has(id)) again.add(id);
    else waiting.set(id, task);
  };

  const run = (): void => {
    const subscriptions = store.list();
    const self = selfKey();
    const ids = new Set(subscriptions.map((entry) => entry.id));
    for (const id of states.keys()) if (!ids.has(id)) states.delete(id);
    queuedThisRun = new Set();
    const serving = deps.servingHere();
    for (const subscription of subscriptions) {
      const owner = subscription.servedBy === self;
      if (subscription.refreshBefore <= now()) {
        // Its own machine removes it; any machine does once that one stayed away a day.
        if (owner || subscription.refreshBefore <= now() - ORPHAN_AFTER_MS) store.remove(subscription.id);
        states.delete(subscription.id);
        continue;
      }
      const connection = deps.connection(subscription.connectionId);
      if (!connection) {
        if (owner) {
          enqueue(subscription.id, async () => {
            await sendControl(subscription, { type: "terminated", error: { code: EVENTS_ERROR.forbidden, message: "Access revoked: the app's ADE MCP connection was removed." } });
            store.remove(subscription.id);
          });
        }
        states.delete(subscription.id);
        continue;
      }
      const onlyKey = subscription.machineKey ?? connection.onlyMachine?.machineKey ?? null;
      if (!serving || (onlyKey && onlyKey !== self)) continue;
      enqueue(subscription.id, () => deliver(subscription).catch((error: unknown) => {
        warn("remote_mcp.events_delivery_failed", { subscriptionId: subscription.id, error: getErrorMessage(error) });
        return false;
      }));
    }
    // Expired, removed, revoked or no longer served here since it was queued: it waits no more.
    for (const id of waiting.keys()) if (!queuedThisRun.has(id)) waiting.delete(id);
    pump();
    scheduleRetry();
  };

  let timerAt = 0;
  /** Runs the subscriptions once, `ms` from now, in place of any run already set. */
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timerAt = now() + ms;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, ms);
    timer.unref?.();
  };

  /**
   * The next try or settled reply any subscription waits for, unless a run is
   * already set. One delivering now is left out: its own end runs it again.
   */
  const scheduleRetry = (): void => {
    if (timer) return;
    const next = Math.min(...[...states].flatMap(([id, state]) => delivering.has(id) ? [] : [
      ...(state.pending ? [state.pending.nextAt] : []),
      ...(state.settleAt !== null ? [state.settleAt] : []),
    ]));
    if (Number.isFinite(next)) arm(Math.max(250, next - now()));
  };

  /** Checks the subscriptions soon: a new event, a new subscription, or the service's refresh. */
  const kick = (): void => {
    // A run already due this soon stays: events less than 250 ms apart must not keep pushing it back.
    if (timer && timerAt <= now() + 250) return;
    arm(250);
  };

  // Only when some subscription exists: a machine with none does nothing per event.
  let hasSubscriptions = false;
  const noticeSubscriptions = (): void => {
    hasSubscriptions = store.list().length > 0;
  };
  noticeSubscriptions();
  onMcpEvent(() => {
    if (hasSubscriptions) kick();
  });

  return {
    subscribe: async (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => {
      const answer = await subscribe(connection, params);
      hasSubscriptions = true;
      return answer;
    },
    unsubscribe: (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>): void => {
      unsubscribe(connection, params);
      noticeSubscriptions();
    },
    /** The service's periodic refresh: subscriptions from other machines, expiry and revocation. */
    refresh(): void {
      noticeSubscriptions();
      if (hasSubscriptions || states.size) kick();
    },
  };
}
