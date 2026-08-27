// ---------------------------------------------------------------------------
// One webhook drain for every plugin that declares `webhookIngress`.
//
// ## What this replaces
//
// Cursor Cloud got here first and got it right, bespoke: a secret registered
// with ADE's Cloudflare relay, a 45-second poll of `/cursor/events`, a paged
// `seq:N` cursor, and a sqlite replay guard so a backlog drain cannot re-fire
// automations (`automations/cursorCloudIngressService.ts`). Every line of that
// is correct and none of it was reusable — the routes, the table and the
// dispatch were all spelled "cursor".
//
// This is the same machine with the nouns removed. The relay now answers
// `/plugin/:pluginId/*` beside `/cursor/*`; a plugin declares its channels in
// its manifest; the host registers ONE secret per plugin, drains every declared
// plugin on one timer, and hands each delivery to the plugin's child as a
// `webhook.received` event. What the plugin does next — emit an automation
// trigger, write a collection row, post a notification — is the plugin's
// business through APIs that already exist, which is why the automation fan-out
// needs no plugin-specific code at all.
//
// ## Three properties that are requirements, not tuning
//
// 1. **One drain per plugin per machine.** The ledger and the poll cursor live
//    in a PROJECT database (`.ade/ade.db`) but a plugin child is machine-scoped
//    and the relay stream is per plugin, not per project. Two open projects
//    would otherwise both drain the same stream into the same child, and each
//    would think the other's delivery was new. `claimPluginIngress` elects one
//    owner per plugin across every project scope in this process; the loser
//    reports `state: "ready"` from the ledger it can see and polls nothing.
//
// 2. **At-least-once, acked, and bounded.** A delivery is stored before it is
//    delivered and stays pending until the child acks it, so a crash between
//    the two replays rather than loses. It is redelivered on later ticks up to
//    PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX and then abandoned, because a poison
//    body must not wake a plugin forever.
//
// 3. **The ledger is PRUNED.** The two older ingress tables are exempt from
//    retention because they are pure replay guards, and the 2026-07 daemon
//    wedge is what an unpruned one costs. This one is bounded on both axes —
//    14 days and PLUGIN_WEBHOOK_LEDGER_ROWS_MAX rows per plugin — which is safe
//    precisely because the relay's own retention is seven days: nothing pruned
//    here can ever be served again, so pruning cannot resurrect a delivery.
//
// ## What never crosses into a plugin child
//
// The relay secret (generated here, stored in the plugin secret store, never
// returned by any SDK verb), any header outside PLUGIN_WEBHOOK_HEADER_ALLOWLIST,
// and any body past PLUGIN_WEBHOOK_BODY_MAX_BYTES. When a channel declares
// `verify`, the third party's signature is checked constant-time against a
// plugin secret BEFORE any of that, and a delivery that fails is dropped and
// counted rather than delivered with a flag — a plugin cannot be trusted to
// re-check what the platform told it was checked.
// ---------------------------------------------------------------------------

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { ACCOUNT_RELAY_TOKEN_HEADER, DEFAULT_GITHUB_RELAY_API_BASE_URL } from "../github/githubRelayConfig";
import type { PluginManifestWebhookIngressChannel } from "../../../shared/plugins/manifest";
import {
  clampPluginWebhookBody,
  sanitizePluginWebhookHeaders,
  PLUGIN_WEBHOOK_DELIVERIES_PER_TICK,
  PLUGIN_WEBHOOK_HEADER_VALUE_MAX_CHARS,
  PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX,
  PLUGIN_WEBHOOK_LEDGER_RETENTION_DAYS,
  PLUGIN_WEBHOOK_LEDGER_ROWS_MAX,
  PLUGIN_WEBHOOK_POLL_INTERVAL_MS,
  PLUGIN_WEBHOOK_SECRET_BYTES,
  PLUGIN_WEBHOOK_SECRET_NAME,
  type PluginWebhookChannelStatus,
  type PluginWebhookIngressStatus,
  type PluginWebhookPayload,
} from "../../../shared/plugins/sdk";

/** Pages drained per plugin per tick, matching the Cursor drain's own ceiling. */
const RELAY_PAGE_LIMIT = 500;
const RELAY_MAX_PAGES_PER_POLL = 20;
const RELAY_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_CHANNEL_ID = "default";
const DEFAULT_VERIFY_HEADER = "x-webhook-signature";
const DEFAULT_VERIFY_PREFIX = "sha256=";

export const PLUGIN_RELAY_API_BASE_REF = "plugins.webhookRelay.apiBaseUrl";
export const PLUGIN_RELAY_API_BASE_ENV_KEY = "ADE_PLUGIN_RELAY_API_BASE_URL";

/** Per-plugin kv keys. One namespace so a plugin's state is greppable as a unit. */
function pluginCursorRef(pluginId: string): string {
  return `plugins.webhookIngress.${pluginId}.cursor`;
}
function pluginLastPolledRef(pluginId: string): string {
  return `plugins.webhookIngress.${pluginId}.lastPolledAt`;
}
function pluginLastErrorRef(pluginId: string): string {
  return `plugins.webhookIngress.${pluginId}.lastError`;
}
function pluginRegisteredRef(pluginId: string): string {
  return `plugins.webhookIngress.${pluginId}.registeredAt`;
}

export type PluginWebhookIngressDb = Pick<AdeDb, "getJson" | "setJson" | "get" | "all" | "run">;

/** What the host tells the drain about one plugin. Read fresh on every tick. */
export type PluginWebhookIngressPlugin = {
  pluginId: string;
  channels: PluginManifestWebhookIngressChannel[];
};

export type PluginWebhookIngressServiceDeps = {
  db: PluginWebhookIngressDb;
  projectId: string;
  logger: Logger;
  /**
   * Plugins installed AND enabled on this machine that declare at least one
   * channel. Called on every tick rather than captured, because an install,
   * an uninstall or a disable changes the answer and the drain must follow it
   * without being rebuilt.
   */
  listPlugins: () => PluginWebhookIngressPlugin[];
  /** The machine-scoped plugin secret store. */
  secrets: {
    get: (pluginId: string, name: string) => Promise<string | null>;
    set: (pluginId: string, name: string, value: string) => Promise<void>;
  };
  /**
   * Hand one delivery to the plugin's child.
   *
   * Returns false when there is nobody to hand it to — the child is not
   * running, or it never subscribed to `webhook.received`. A false answer must
   * NOT count as an attempt: a plugin that has not started yet has not failed,
   * and burning its five attempts while it boots would abandon deliveries it
   * would have handled fine.
   */
  deliver: (pluginId: string, payload: PluginWebhookPayload) => boolean;
  getAccountAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
};

type RelayEvent = {
  cursor: string;
  eventId: string;
  channel: string;
  eventType: string;
  createdAt: string;
  headers: Record<string, unknown>;
  body: string;
};

type LedgerRow = {
  id: string;
  plugin_id: string;
  channel: string;
  delivery_id: string;
  event_type: string;
  received_at: string;
  headers_json: string | null;
  body: string | null;
  attempts: number;
  acked_at: string | null;
  abandoned_at: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRelaySequence(cursor: string): number | null {
  const match = /^seq:(\d+)$/.exec(cursor.trim());
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Machine-scoped ownership
//
// Module-level for the same reason `pluginEvents.ts`'s bus is: the thing being
// coordinated (a plugin child, a relay stream) is machine-scoped, while the
// things doing the coordinating (project scopes) are constructed and destroyed
// independently and never learn about each other.
// ---------------------------------------------------------------------------

const ingressOwners = new Map<string, symbol>();

function claimPluginIngress(pluginId: string, owner: symbol): boolean {
  const existing = ingressOwners.get(pluginId);
  if (existing && existing !== owner) return false;
  ingressOwners.set(pluginId, owner);
  return true;
}

function releasePluginIngress(owner: symbol): void {
  for (const [pluginId, holder] of [...ingressOwners]) {
    if (holder === owner) ingressOwners.delete(pluginId);
  }
}

/** Test seam. Production has no reason to evict another scope's claims. */
export function resetPluginIngressOwnersForTests(): void {
  ingressOwners.clear();
}

export function resolvePluginRelayBaseUrl(db: Pick<AdeDb, "getJson">): string {
  const stored = db.getJson<unknown>(PLUGIN_RELAY_API_BASE_REF);
  const configured = typeof stored === "string" && stored.trim() ? stored.trim() : null;
  return (
    configured
    || process.env[PLUGIN_RELAY_API_BASE_ENV_KEY]?.trim()
    || DEFAULT_GITHUB_RELAY_API_BASE_URL
  ).replace(/\/+$/, "");
}

/**
 * The URL a third party posts to for one channel.
 *
 * `default` has no path segment, so a plugin with one channel hands out a URL
 * with nothing in it the user could mistype.
 */
export function pluginWebhookUrl(relayBaseUrl: string, pluginId: string, channelId: string): string {
  const base = `${relayBaseUrl.replace(/\/+$/, "")}/plugin/${encodeURIComponent(pluginId)}/webhook`;
  return channelId === DEFAULT_CHANNEL_ID ? base : `${base}/${encodeURIComponent(channelId)}`;
}

/**
 * Verify a third party's HMAC-SHA256 signature over the raw body.
 *
 * Exported for its test. Constant-time on the digest compare, and it refuses a
 * length mismatch BEFORE `timingSafeEqual` (which throws on unequal lengths)
 * rather than after, so a malformed header is a `false`, never a crash inside
 * the drain loop.
 */
export function verifyPluginWebhookSignature(args: {
  secret: string;
  body: string;
  signature: string;
  prefix?: string;
}): boolean {
  const prefix = args.prefix ?? DEFAULT_VERIFY_PREFIX;
  const raw = args.signature.trim();
  if (!raw) return false;
  const offered = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!/^[0-9a-fA-F]+$/.test(offered)) return false;
  const expected = createHmac("sha256", args.secret).update(args.body, "utf8").digest("hex");
  const offeredBuffer = Buffer.from(offered.toLowerCase(), "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (offeredBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(offeredBuffer, expectedBuffer);
}

function parseRelayEventsResponse(value: unknown): { events: RelayEvent[]; nextCursor: string | null; cursorExpired: boolean } {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new Error("The relay returned an invalid plugin events response.");
  }
  const events = value.events.map((entry) => {
    if (!isRecord(entry)) throw new Error("The relay returned an invalid plugin event.");
    const cursor = readString(entry, "cursor");
    const eventId = readString(entry, "eventId");
    const channel = readString(entry, "channel") ?? DEFAULT_CHANNEL_ID;
    const eventType = readString(entry, "eventType") ?? "webhook";
    const createdAt = readString(entry, "createdAt");
    const body = typeof entry.body === "string" ? entry.body : null;
    if (!cursor || !eventId || !createdAt || body == null) {
      throw new Error("The relay returned an incomplete plugin event.");
    }
    return {
      cursor,
      eventId,
      channel,
      eventType,
      createdAt,
      headers: isRecord(entry.headers) ? entry.headers : {},
      body,
    };
  });
  return {
    events,
    nextCursor: typeof value.nextCursor === "string" && value.nextCursor.trim() ? value.nextCursor.trim() : null,
    cursorExpired: value.cursorExpired === true,
  };
}

export function createPluginWebhookIngressService(deps: PluginWebhookIngressServiceDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollIntervalMs = Math.max(1_000, deps.pollIntervalMs ?? PLUGIN_WEBHOOK_POLL_INTERVAL_MS);
  const owner = Symbol("plugin-webhook-ingress");
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight: Promise<void> | null = null;
  let disposed = false;

  const setLastError = (pluginId: string, message: string | null): void => {
    deps.db.setJson(pluginLastErrorRef(pluginId), message);
  };

  const readAccountAccessToken = async (): Promise<string | null> => {
    return deps.getAccountAccessToken
      ? await deps.getAccountAccessToken().catch(() => null)
      : null;
  };

  /**
   * The plugin's relay secret, generated on first use.
   *
   * Generated by the HOST and written into the plugin's own secret namespace,
   * so an uninstall sweeps it with everything else the plugin held and a
   * reinstall starts clean. Never handed to the child: `secrets.get` refuses
   * the reserved name, and no domain action returns it.
   */
  const ensureSecret = async (pluginId: string): Promise<string> => {
    const existing = await deps.secrets.get(pluginId, PLUGIN_WEBHOOK_SECRET_NAME);
    if (existing && existing.length >= PLUGIN_WEBHOOK_SECRET_BYTES) return existing;
    const secret = randomBytes(PLUGIN_WEBHOOK_SECRET_BYTES).toString("hex");
    await deps.secrets.set(pluginId, PLUGIN_WEBHOOK_SECRET_NAME, secret);
    return secret;
  };

  const registerSecret = async (pluginId: string, relayBaseUrl: string, secret: string): Promise<void> => {
    const accountAccessToken = await readAccountAccessToken();
    const response = await fetchImpl(`${relayBaseUrl}/plugin/${encodeURIComponent(pluginId)}/register`, {
      method: "POST",
      headers: {
        // Self-attestation: presenting the secret being registered is what
        // proves ownership on a machine with no ADE account, exactly as the
        // Cursor registration does. An account token, when there is one, links
        // the registration so a second machine on the account reads the same
        // stream.
        authorization: `Bearer ${secret}`,
        ...(accountAccessToken ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = isRecord(payload) ? readString(payload, "error") : null;
      throw new Error(detail ?? `The relay refused the plugin registration (HTTP ${response.status}).`);
    }
    deps.db.setJson(pluginRegisteredRef(pluginId), new Date().toISOString());
  };

  const findDelivery = (pluginId: string, deliveryId: string): { id: string } | null => {
    return deps.db.get<{ id: string }>(
      `select id from plugin_ingress_events
        where project_id = ? and plugin_id = ? and delivery_id = ?
        limit 1`,
      [deps.projectId, pluginId, deliveryId],
    );
  };

  /**
   * The headers one row keeps at rest.
   *
   * The child-facing allowlist plus ONE more: the signature header this
   * channel's `verify` names. A signature is not readable by a plugin — the
   * delivery path re-filters with `sanitizePluginWebhookHeaders` and drops it
   * again — but it has to survive storage, because verification runs when the
   * row is delivered rather than when it is fetched, so a crash between the two
   * would otherwise turn every pending verified delivery into a rejection.
   *
   * A channel whose `verify.header` is not one the relay stores can never be
   * verified here. That is the relay's allowlist to widen, and it already
   * carries the signature headers of every provider a plugin is likely to use.
   */
  const storedHeadersFor = (
    channel: PluginManifestWebhookIngressChannel,
    raw: Record<string, unknown>,
  ): Record<string, string> => {
    const headers = sanitizePluginWebhookHeaders(raw);
    if (!channel.verify) return headers;
    const headerName = (channel.verify.header ?? DEFAULT_VERIFY_HEADER).toLowerCase();
    const value = raw[headerName];
    if (typeof value === "string" && value) {
      headers[headerName] = value.slice(0, PLUGIN_WEBHOOK_HEADER_VALUE_MAX_CHARS);
    }
    return headers;
  };

  /** Store one delivery. False when it was already known — the replay guard. */
  const persistDelivery = (
    pluginId: string,
    channel: PluginManifestWebhookIngressChannel,
    event: RelayEvent,
  ): boolean => {
    if (findDelivery(pluginId, event.eventId)) return false;
    deps.db.run(
      `insert into plugin_ingress_events(
        id, project_id, plugin_id, channel, delivery_id, event_type,
        received_at, stored_at, headers_json, body, attempts, acked_at, abandoned_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, null, null)`,
      [
        // A synthetic primary key rather than a hash of the delivery id: the
        // dedupe check is the indexed lookup above, and this keeps a third
        // party's identifier out of the row's own identity.
        randomUUID(),
        deps.projectId,
        pluginId,
        event.channel,
        event.eventId,
        event.eventType,
        event.createdAt,
        new Date().toISOString(),
        JSON.stringify(storedHeadersFor(channel, event.headers)),
        event.body,
      ],
    );
    return true;
  };

  const channelFor = (
    plugin: PluginWebhookIngressPlugin,
    channelId: string,
  ): PluginManifestWebhookIngressChannel | null => {
    return plugin.channels.find((channel) => channel.id === channelId) ?? null;
  };

  /**
   * Check a channel's declared signature over the stored body.
   *
   * A channel with no `verify` passes. A channel WITH one whose secret is not
   * on this machine FAILS — refusing is the only safe reading of "the manifest
   * says check this and I cannot". The status surface reports the missing
   * secret by name so the user can fix it rather than wonder why nothing
   * arrives.
   */
  const passesVerification = async (
    pluginId: string,
    channel: PluginManifestWebhookIngressChannel | null,
    row: LedgerRow,
  ): Promise<boolean> => {
    const verify = channel?.verify;
    if (!verify) return true;
    const secret = await deps.secrets.get(pluginId, verify.secretRef).catch(() => null);
    if (!secret) return false;
    let headers: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.headers_json ?? "{}") as unknown;
      if (isRecord(parsed)) headers = parsed;
    } catch {
      headers = {};
    }
    const headerName = (verify.header ?? DEFAULT_VERIFY_HEADER).toLowerCase();
    const signature = typeof headers[headerName] === "string" ? headers[headerName] : "";
    if (!signature) return false;
    return verifyPluginWebhookSignature({
      secret,
      body: row.body ?? "",
      signature,
      ...(verify.prefix ? { prefix: verify.prefix } : {}),
    });
  };

  const markAbandoned = (id: string, reason: string, pluginId: string, deliveryId: string): void => {
    deps.db.run(
      "update plugin_ingress_events set abandoned_at = ? where id = ?",
      [new Date().toISOString(), id],
    );
    deps.logger.warn("plugin.webhook_delivery_abandoned", { pluginId, deliveryId, reason });
  };

  /**
   * Hand every unacked delivery for one plugin to its child.
   *
   * Ordered oldest-first so a plugin sees its events in the order the relay
   * accepted them, and capped per tick so a backlog drain cannot become a
   * thousand writes to one stdin.
   */
  const deliverPending = async (plugin: PluginWebhookIngressPlugin): Promise<void> => {
    const rows = deps.db.all<LedgerRow>(
      `select id, plugin_id, channel, delivery_id, event_type, received_at,
              headers_json, body, attempts, acked_at, abandoned_at
         from plugin_ingress_events
        where project_id = ? and plugin_id = ? and acked_at is null and abandoned_at is null
        order by received_at asc, rowid asc
        limit ?`,
      [deps.projectId, plugin.pluginId, PLUGIN_WEBHOOK_DELIVERIES_PER_TICK],
    );
    for (const row of rows) {
      const channel = channelFor(plugin, row.channel);
      // A channel the manifest no longer declares can never be handled: the
      // plugin removed it. Abandoned rather than delivered, so an upgrade that
      // drops a channel does not wake the new build with the old one's traffic.
      if (!channel) {
        markAbandoned(row.id, "channel_undeclared", plugin.pluginId, row.delivery_id);
        continue;
      }
      if (!(await passesVerification(plugin.pluginId, channel, row))) {
        markAbandoned(row.id, "signature_rejected", plugin.pluginId, row.delivery_id);
        continue;
      }
      if (row.attempts >= PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX) {
        markAbandoned(row.id, "attempts_exhausted", plugin.pluginId, row.delivery_id);
        continue;
      }

      const clamped = clampPluginWebhookBody(row.body ?? "");
      let headers: Record<string, string> = {};
      try {
        headers = sanitizePluginWebhookHeaders(JSON.parse(row.headers_json ?? "{}"));
      } catch {
        headers = {};
      }
      const attempt = row.attempts + 1;
      const delivered = deps.deliver(plugin.pluginId, {
        event: "webhook.received",
        id: row.delivery_id,
        channel: row.channel,
        eventType: row.event_type,
        receivedAt: row.received_at,
        headers,
        body: clamped.body,
        ...(clamped.truncated ? { truncated: true as const } : {}),
        attempt,
      });
      // Not delivered is not a failed attempt. The child is down or has not
      // subscribed yet; charging it an attempt would abandon deliveries after
      // five ticks of a plugin that simply had not started.
      if (!delivered) continue;
      deps.db.run("update plugin_ingress_events set attempts = ? where id = ?", [attempt, row.id]);
    }
  };

  /**
   * Retention, on both axes.
   *
   * Age first, then a per-plugin row cap that evicts the oldest SETTLED rows
   * (acked or abandoned). A pending row is never evicted by the cap: it is
   * still owed an attempt, and dropping it would lose a delivery the plugin
   * has not seen — the row cap exists to bound a busy plugin's history, not to
   * silently discard its backlog.
   */
  const prune = (pluginId: string): void => {
    const cutoff = new Date(Date.now() - PLUGIN_WEBHOOK_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    deps.db.run(
      `delete from plugin_ingress_events
        where project_id = ? and plugin_id = ? and stored_at < ?`,
      [deps.projectId, pluginId, cutoff],
    );
    const total = deps.db.get<{ count: number }>(
      "select count(*) as count from plugin_ingress_events where project_id = ? and plugin_id = ?",
      [deps.projectId, pluginId],
    )?.count ?? 0;
    if (total <= PLUGIN_WEBHOOK_LEDGER_ROWS_MAX) return;
    deps.db.run(
      `delete from plugin_ingress_events
        where id in (
          select id from plugin_ingress_events
           where project_id = ? and plugin_id = ?
             and (acked_at is not null or abandoned_at is not null)
           order by stored_at asc
           limit ?
        )`,
      [deps.projectId, pluginId, total - PLUGIN_WEBHOOK_LEDGER_ROWS_MAX],
    );
  };

  const pollPlugin = async (plugin: PluginWebhookIngressPlugin): Promise<void> => {
    const relayBaseUrl = resolvePluginRelayBaseUrl(deps.db);
    const secret = await ensureSecret(plugin.pluginId);
    if (!deps.db.getJson<unknown>(pluginRegisteredRef(plugin.pluginId))) {
      await registerSecret(plugin.pluginId, relayBaseUrl, secret);
    }
    const accountAccessToken = await readAccountAccessToken();

    for (let page = 0; page < RELAY_MAX_PAGES_PER_POLL; page += 1) {
      const stored = deps.db.getJson<unknown>(pluginCursorRef(plugin.pluginId));
      const cursor = typeof stored === "string" && stored.trim() ? stored.trim() : null;
      const url = new URL(`${relayBaseUrl}/plugin/${encodeURIComponent(plugin.pluginId)}/events`);
      url.searchParams.set("limit", String(RELAY_PAGE_LIMIT));
      if (cursor) url.searchParams.set("after", cursor);
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${secret}`,
          ...(accountAccessToken ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken } : {}),
        },
        signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
      });
      const rawPayload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        // A registration that the relay has forgotten — the D1 row aged out, the
        // user unlinked the account — reads as a 401. Re-register on the next
        // tick rather than reporting an auth error forever.
        if (response.status === 401) deps.db.setJson(pluginRegisteredRef(plugin.pluginId), null);
        const detail = isRecord(rawPayload) ? readString(rawPayload, "error") : null;
        throw new Error(detail ?? `The relay refused the plugin events poll (HTTP ${response.status}).`);
      }
      const payload = parseRelayEventsResponse(rawPayload);
      if (payload.cursorExpired) {
        deps.db.setJson(pluginCursorRef(plugin.pluginId), payload.nextCursor);
        deps.logger.info("plugin.webhook_cursor_reset", {
          pluginId: plugin.pluginId,
          cursor: payload.nextCursor,
        });
        return;
      }

      const ordered = [...payload.events].sort(
        (a, b) => (parseRelaySequence(a.cursor) ?? 0) - (parseRelaySequence(b.cursor) ?? 0),
      );
      for (const event of ordered) {
        // A delivery on a channel the manifest does not declare is dropped at
        // the door: the relay accepts any channel segment for a registered
        // plugin, and storing traffic no declaration asked for would let a
        // mistyped URL fill the ledger.
        const channel = channelFor(plugin, event.channel);
        if (!channel) {
          deps.logger.warn("plugin.webhook_channel_undeclared", {
            pluginId: plugin.pluginId,
            channel: event.channel,
          });
          continue;
        }
        persistDelivery(plugin.pluginId, channel, event);
      }
      if (payload.nextCursor) deps.db.setJson(pluginCursorRef(plugin.pluginId), payload.nextCursor);
      if (payload.events.length < RELAY_PAGE_LIMIT || !payload.nextCursor) break;
    }

    await deliverPending(plugin);
    prune(plugin.pluginId);
    deps.db.setJson(pluginLastPolledRef(plugin.pluginId), new Date().toISOString());
    setLastError(plugin.pluginId, null);
  };

  const poll = async (): Promise<void> => {
    if (disposed) return;
    const plugins = deps.listPlugins().filter((plugin) => plugin.channels.length > 0);
    // Ownership is re-claimed on every tick, never once at start: a plugin that
    // another project scope owned becomes claimable the moment that scope
    // detaches, and a drain that claimed at construction would leave the plugin
    // undrained until the app restarted.
    for (const plugin of plugins) {
      if (!claimPluginIngress(plugin.pluginId, owner)) continue;
      try {
        await pollPlugin(plugin);
      } catch (error: unknown) {
        const message = errorMessage(error);
        setLastError(plugin.pluginId, message);
        deps.logger.warn("plugin.webhook_poll_failed", { pluginId: plugin.pluginId, error: message });
      }
    }
  };

  const pollNow = async (): Promise<void> => {
    if (pollInFlight) return pollInFlight;
    pollInFlight = poll()
      .catch((error: unknown) => {
        deps.logger.warn("plugin.webhook_drain_failed", { error: errorMessage(error) });
      })
      .finally(() => {
        pollInFlight = null;
      });
    return pollInFlight;
  };

  /**
   * Record an ack. Idempotent, and scoped to the plugin that owns the row —
   * a plugin acking another's delivery id must be a no-op, not a write.
   */
  const ack = (pluginId: string, deliveryId: string): void => {
    deps.db.run(
      `update plugin_ingress_events
          set acked_at = ?
        where project_id = ? and plugin_id = ? and delivery_id = ? and acked_at is null`,
      [new Date().toISOString(), deps.projectId, pluginId, deliveryId],
    );
  };

  const statusFor = async (plugin: PluginWebhookIngressPlugin): Promise<PluginWebhookIngressStatus> => {
    const relayBaseUrl = resolvePluginRelayBaseUrl(deps.db);
    const lastErrorRaw = deps.db.getJson<unknown>(pluginLastErrorRef(plugin.pluginId));
    const lastError = typeof lastErrorRaw === "string" && lastErrorRaw.trim() ? lastErrorRaw.trim() : null;
    const lastPolledRaw = deps.db.getJson<unknown>(pluginLastPolledRef(plugin.pluginId));
    const lastPolledAt = typeof lastPolledRaw === "string" ? lastPolledRaw : null;
    const registered = Boolean(deps.db.getJson<unknown>(pluginRegisteredRef(plugin.pluginId)));

    const perChannel = deps.db.all<{ channel: string; last_received_at: string | null }>(
      `select channel, max(received_at) as last_received_at
         from plugin_ingress_events
        where project_id = ? and plugin_id = ?
        group by channel`,
      [deps.projectId, plugin.pluginId],
    );
    const lastByChannel = new Map(perChannel.map((row) => [row.channel, row.last_received_at]));

    const channels: PluginWebhookChannelStatus[] = [];
    for (const channel of plugin.channels) {
      const missingSecretRef = channel.verify
        && !(await deps.secrets.get(plugin.pluginId, channel.verify.secretRef).catch(() => null))
        ? channel.verify.secretRef
        : null;
      channels.push({
        channelId: channel.id,
        label: channel.label,
        ...(channel.description ? { description: channel.description } : {}),
        url: pluginWebhookUrl(relayBaseUrl, plugin.pluginId, channel.id),
        verified: Boolean(channel.verify),
        ...(missingSecretRef ? { missingSecretRef } : {}),
        lastReceivedAt: lastByChannel.get(channel.id) ?? null,
      });
    }

    const counts = deps.db.get<{ pending: number; abandoned: number; last_received_at: string | null }>(
      `select
         sum(case when acked_at is null and abandoned_at is null then 1 else 0 end) as pending,
         sum(case when abandoned_at is not null then 1 else 0 end) as abandoned,
         max(received_at) as last_received_at
       from plugin_ingress_events
      where project_id = ? and plugin_id = ?`,
      [deps.projectId, plugin.pluginId],
    );

    return {
      pluginId: plugin.pluginId,
      state: lastError ? "error" : registered ? "ready" : "unconfigured",
      relayBaseUrl,
      channels,
      lastReceivedAt: counts?.last_received_at ?? null,
      lastPolledAt,
      lastError,
      pendingDeliveries: Number(counts?.pending ?? 0),
      abandonedDeliveries: Number(counts?.abandoned ?? 0),
    };
  };

  const getStatus = async (pluginId?: string): Promise<PluginWebhookIngressStatus[]> => {
    const plugins = deps.listPlugins();
    if (pluginId) {
      const plugin = plugins.find((entry) => entry.pluginId === pluginId);
      if (!plugin || plugin.channels.length === 0) {
        return [{
          pluginId,
          state: "undeclared",
          relayBaseUrl: resolvePluginRelayBaseUrl(deps.db),
          channels: [],
          lastReceivedAt: null,
          lastPolledAt: null,
          lastError: null,
          pendingDeliveries: 0,
          abandonedDeliveries: 0,
        }];
      }
      return [await statusFor(plugin)];
    }
    const declared = plugins.filter((plugin) => plugin.channels.length > 0);
    const rows: PluginWebhookIngressStatus[] = [];
    for (const plugin of declared) rows.push(await statusFor(plugin));
    return rows;
  };

  /**
   * The URL for one of a plugin's declared channels, for `sdk.webhooks.url`.
   *
   * Resolved from the manifest rather than from what the plugin asked for, so a
   * channel it never declared cannot be turned into a working URL by guessing.
   */
  const urlFor = (pluginId: string, channelId: string): string | null => {
    const plugin = deps.listPlugins().find((entry) => entry.pluginId === pluginId);
    if (!plugin?.channels.some((channel) => channel.id === channelId)) return null;
    return pluginWebhookUrl(resolvePluginRelayBaseUrl(deps.db), pluginId, channelId);
  };

  const start = (): void => {
    if (pollTimer || disposed) return;
    void pollNow();
    pollTimer = setInterval(() => void pollNow(), pollIntervalMs);
    pollTimer.unref?.();
  };

  const stop = (): void => {
    disposed = true;
    releasePluginIngress(owner);
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  return { start, stop, pollNow, ack, getStatus, urlFor };
}

export type PluginWebhookIngressService = ReturnType<typeof createPluginWebhookIngressService>;
