import { CLOUD_INSTANCE_ID, CLOUD_PATHS, type CloudComputerActivityReport, type CloudComputerStatus, type CloudResourcePressure } from "./contract";
import { fail, json } from "./http";
import type { CloudProvider, CloudInstanceHealth, CloudInstanceMetrics } from "./provider";
import { logCloud, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";
import type { CloudWaitUntil } from "./analytics";
import { readBoundedBody } from "../sinkUtils";
import { verifyWebhookSignature, type WebhookSignatureCheck } from "../webhookSignature";

/**
 * A lane computer's live status, for the status menu on a cloud lane's chat
 * header (README, "ADE Cloud account"):
 *
 * - The provider's signed status webhook (`POST /cloud/agent37/webhook`)
 *   records every status change of the account's computers
 *   (`cloud_instance_events`), the sleeps, wakes and restarts the provider
 *   did on its own between two minute ticks included. On a change to running
 *   it also keeps the provider's restart count, so a later read can tell the
 *   restarts since then (that count also counts wakes).
 * - The computer's brain says when its work starts or stops
 *   (`POST /cloud/instances/:id/activity`, `cloud_computer_activity`).
 * - `GET /cloud/instances/:id/status` puts those together with the provider's
 *   health readout and its newest disk measure, read when someone opens the
 *   menu and kept `STATUS_CACHE_TTL_S` seconds. Nothing polls, and no read
 *   wakes the computer: the provider's logs and metrics answer in any state.
 */

/** A delivery is a few hundred bytes; anything far bigger is not one. */
const WEBHOOK_MAX_BYTES = 64_000;
/** Status changes kept per computer: enough to read the current stretch awake. */
export const INSTANCE_EVENT_KEEP_MS = 14 * 24 * 60 * 60_000;
/** How long one status read is kept on the server: menus opened by several windows share it. */
const STATUS_CACHE_TTL_S = 15;
/** The longest run of agents a report may claim; anything past it is not a real count. */
const MAX_RUNNING_AGENTS = 500;
/** A report's clock may run this far ahead of the server's. */
const REPORT_CLOCK_SKEW_MS = 2 * 60_000;
/** How long after a change the minute tick may record it: an event this much older than the row's change is still that change. */
const TICK_LAG_MS = 3 * 60_000;

const CACHE_NAME = "ade-cloud-computer-status";
const cacheUrl = (instanceId: string) => `https://ade-cloud-cache.invalid/computer-status/${encodeURIComponent(instanceId)}`;

/* ---- The provider's webhook ---- */

export const isAgent37WebhookRequest = (path: string, method: string): boolean => path === CLOUD_PATHS.agent37Webhook && method === "POST";

/**
 * The provider signs with Standard Webhooks (`verifyWebhookSignature`); its
 * timestamp is whole seconds, so anything else is refused before the HMAC.
 */
async function agent37SignatureCheck(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  raw: string,
  now: number,
): Promise<WebhookSignatureCheck> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return "invalid";
  return await verifyWebhookSignature({ secret, id, timestamp, body: raw, signatureHeader: signature, nowSeconds: now / 1000 });
}

type StatusEvent = { id: string; status: string; previousStatus: string | null; at: number; reason: string | null };

function statusEventOf(value: unknown, fallbackAt: number): StatusEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown; timestamp?: unknown; data?: Record<string, unknown> | null };
  if (event.type !== "instance.status.updated" || !event.data || typeof event.data !== "object") return null;
  const id = typeof event.data.id === "string" ? event.data.id : "";
  const status = typeof event.data.status === "string" ? event.data.status.trim().slice(0, 40) : "";
  if (!CLOUD_INSTANCE_ID.test(id) || !status) return null;
  const parsed = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
  const previous = typeof event.data.previous_status === "string" ? event.data.previous_status.trim().slice(0, 40) || null : null;
  const reasonRecord = event.data.status_reason && typeof event.data.status_reason === "object" ? event.data.status_reason as Record<string, unknown> : null;
  const reason = typeof reasonRecord?.code === "string" ? reasonRecord.code.slice(0, 80) : null;
  return { id, status, previousStatus: previous, at: Number.isFinite(parsed) ? parsed : fallbackAt, reason };
}

/**
 * `POST /cloud/agent37/webhook`: the provider's signed status changes. Each
 * one is kept for a computer of the account's only, once per `webhook-id`
 * (the same on every try). A failed save answers 503 so the provider tries
 * again; anything else answers 2xx at once, as it asks within 5 seconds.
 */
export async function handleAgent37Webhook(
  request: Request,
  env: CloudEnv,
  now: number,
  deps: { provider: Pick<CloudProvider, "instanceHealth"> | null; waitUntil?: CloudWaitUntil },
): Promise<Response> {
  const secret = env.AGENT37_WEBHOOK_SECRET?.trim();
  if (!secret) return fail("unavailable", "The provider webhook isn't set up.", 503);
  // Read with a cap, never whole: an unsigned sender could otherwise make the Worker buffer any size.
  const read = await readBoundedBody(request, WEBHOOK_MAX_BYTES);
  if (!read.ok) {
    logCloud("cloud.agent37_webhook_refused", { reason: "too_large" });
    return fail("bad_request", "That delivery is too large.", 413);
  }
  const deliveryId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const check = await agent37SignatureCheck(secret, { id: deliveryId, timestamp, signature: request.headers.get("webhook-signature") }, read.text, now);
  if (check !== "valid" || !deliveryId) {
    // `secret_unreadable`: AGENT37_WEBHOOK_SECRET itself is malformed, so every delivery fails until it is fixed.
    if (check === "secret_unreadable") reportCloudFailure("cloud.agent37_webhook_refused", { reason: "secret_unreadable" });
    else logCloud("cloud.agent37_webhook_refused", { reason: "signature" });
    return fail("unauthorized", "That signature isn't valid.", 401);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return fail("bad_request", "That delivery could not be read.", 400);
  }
  // Another event type (added later) or an instance ADE can't read: taken, nothing to keep.
  const event = statusEventOf(parsed, Number(timestamp) * 1000);
  if (!event) return json({ ok: true, ignored: true });
  try {
    const [inserted] = await env.DB.batch([
      env.DB.prepare(`
        insert or ignore into cloud_instance_events (delivery_id, instance_id, status, previous_status, at, reason, received_at)
        select ?, ?, ?, ?, ?, ?, ? where exists (select 1 from cloud_computers where instance_id = ? and deleted_at is null)
      `).bind(deliveryId.slice(0, 120), event.id, event.status, event.previousStatus, event.at, event.reason, now, event.id),
      env.DB.prepare("delete from cloud_instance_events where instance_id = ? and at < ?").bind(event.id, now - INSTANCE_EVENT_KEEP_MS),
    ]);
    const kept = (inserted?.meta?.changes ?? 0) === 1;
    if (kept) {
      logCloud("cloud.instance_status_event", { instanceId: event.id, status: event.status, previous: event.previousStatus });
      forgetStatus(event.id, deps.waitUntil);
      // The count right after the change to running: restarts since then are what it grows by.
      if (event.status === "running" && deps.provider) {
        const provider = deps.provider;
        const save = provider.instanceHealth(event.id).then(async (health) => {
          if (health?.restartCount == null) return;
          await env.DB.prepare("update cloud_instance_events set restart_count = ? where delivery_id = ?").bind(health.restartCount, deliveryId.slice(0, 120)).run();
        }).catch((error: unknown) => {
          logCloud("cloud.instance_restart_base_failed", { instanceId: event.id, message: error instanceof Error ? error.message : "unknown" });
        });
        if (deps.waitUntil) deps.waitUntil(save);
        else await save;
      }
    }
    // `kept: false`: a repeat of a delivery already kept, or an instance that isn't one of the account's computers.
    return json({ ok: true, kept });
  } catch (error) {
    reportCloudFailure("cloud.agent37_webhook_failed", { message: error instanceof Error ? error.message : "unknown" });
    return fail("unavailable", "That delivery could not be saved. Send it again.", 503);
  }
}

/* ---- The computer's own activity report ---- */

function timeOrNull(value: unknown, now: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value > now + REPORT_CLOCK_SKEW_MS || value < now - 30 * 24 * 60 * 60_000) return undefined;
  return Math.round(value);
}

/** The body the computer sends, checked; null when it can't be read. `sleepsAt` may lie ahead. */
export function parseActivityReport(body: Record<string, unknown> | null, now: number): CloudComputerActivityReport | null {
  if (!body || typeof body.busy !== "boolean") return null;
  const runningAgents = body.runningAgents;
  if (typeof runningAgents !== "number" || !Number.isInteger(runningAgents) || runningAgents < 0 || runningAgents > MAX_RUNNING_AGENTS) return null;
  const idleSince = timeOrNull(body.idleSince ?? null, now);
  const reportedAt = timeOrNull(body.reportedAt, now);
  const sleepsAt = body.sleepsAt == null ? null
    : typeof body.sleepsAt === "number" && Number.isFinite(body.sleepsAt) && Math.abs(body.sleepsAt - now) < 24 * 60 * 60_000 ? Math.round(body.sleepsAt) : undefined;
  if (idleSince === undefined || reportedAt == null || sleepsAt === undefined) return null;
  // Busy has no idle stretch; an idle one has no sleep while busy.
  return body.busy
    ? { busy: true, idleSince: null, sleepsAt: null, runningAgents, reportedAt }
    : { busy: false, idleSince, sleepsAt, runningAgents, reportedAt };
}

/** Keeps the report; an older one (sent late) never replaces a newer one. */
export async function recordActivity(env: Pick<CloudEnv, "DB">, instanceId: string, report: CloudComputerActivityReport, waitUntil?: CloudWaitUntil): Promise<void> {
  await env.DB.prepare(`
    insert into cloud_computer_activity (instance_id, busy, idle_since, sleeps_at, running_agents, reported_at) values (?, ?, ?, ?, ?, ?)
    on conflict(instance_id) do update set busy = excluded.busy, idle_since = excluded.idle_since, sleeps_at = excluded.sleeps_at,
      running_agents = excluded.running_agents, reported_at = excluded.reported_at
    where excluded.reported_at >= cloud_computer_activity.reported_at
  `).bind(instanceId, report.busy ? 1 : 0, report.idleSince, report.sleepsAt, report.runningAgents, report.reportedAt).run();
  forgetStatus(instanceId, waitUntil);
}

/* ---- The status read ---- */

type EventRow = { delivery_id: string; status: string; at: number; restart_count: number | null };
type ActivityRow = { busy: number; idle_since: number | null; sleeps_at: number | null; running_agents: number; reported_at: number };

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : "unknown";

/** Null when the cache can't open: every read then asks the provider. */
async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  return await caches.open(CACHE_NAME).catch((error: unknown) => {
    logCloud("cloud.computer_status_cache_failed", { step: "open", message: errorMessage(error) });
    return null;
  });
}

/** Drops this colo's kept read, so the next menu reads the change. Never throws. */
function forgetStatus(instanceId: string, waitUntil?: CloudWaitUntil): void {
  const drop = openCache().then((cache) => cache?.delete(cacheUrl(instanceId))).catch((error: unknown) => {
    // The kept read then ages out on its own (`STATUS_CACHE_TTL_S`).
    logCloud("cloud.computer_status_cache_failed", { step: "forget", instanceId, message: errorMessage(error) });
  });
  waitUntil?.(drop);
}

/**
 * The status as the provider's events, the tick and the brain left it, with
 * the provider's health and disk read now (`readComputerStatus` keeps it).
 * A read of a resting computer asks the provider only for its disk.
 */
async function buildComputerStatus(env: Pick<CloudEnv, "DB">, provider: Pick<CloudProvider, "instanceHealth" | "instanceMetrics">, computer: ComputerRow, now: number): Promise<CloudComputerStatus> {
  const id = computer.instance_id;
  const [latest, activity] = await Promise.all([
    env.DB.prepare("select delivery_id, status, at, restart_count from cloud_instance_events where instance_id = ? order by at desc limit 1")
      .bind(id).first<EventRow>(),
    env.DB.prepare("select busy, idle_since, sleeps_at, running_agents, reported_at from cloud_computer_activity where instance_id = ?")
      .bind(id).first<ActivityRow>(),
  ]);
  // The webhook's change wins when it is newer than the tick's, and is the
  // tick's own when they agree (with the exact time; the tick sees it up to a
  // minute late). An agreeing event from before the row's change is an older
  // stretch (a delivery in between was missed): the row's own time then
  // stands, and restarts are unknown. Out of order deliveries are ordered by `at`.
  const fromEvent = latest != null && (latest.at > computer.status_changed_at
    || (latest.status === computer.status && latest.at >= computer.status_changed_at - TICK_LAG_MS));
  const status = fromEvent ? latest.status : computer.status;
  const running = status === "running";
  const awakeSince = running ? (fromEvent ? latest.at : computer.status_changed_at) : null;
  const [health, metrics] = await Promise.all([
    running ? provider.instanceHealth(id).catch((error: unknown): CloudInstanceHealth | null => {
      logCloud("cloud.computer_health_read_failed", { instanceId: id, message: error instanceof Error ? error.message : "unknown" });
      return null;
    }) : Promise.resolve(null),
    provider.instanceMetrics(id).catch((error: unknown): CloudInstanceMetrics | null => {
      logCloud("cloud.computer_metrics_read_failed", { instanceId: id, message: error instanceof Error ? error.message : "unknown" });
      return null;
    }),
  ]);
  const base = running && fromEvent ? latest.restart_count : null;
  const restarts = base != null && health?.restartCount != null ? Math.max(0, health.restartCount - base) : null;
  // A report from before this stretch awake (the last one before a sleep) says nothing about now.
  const fresh = running && activity != null && awakeSince != null && activity.reported_at >= awakeSince - REPORT_CLOCK_SKEW_MS;
  const memory: CloudResourcePressure | null = health?.memory ?? null;
  return {
    instanceId: id,
    status,
    awakeSince,
    activity: fresh
      ? {
          busy: activity.busy === 1,
          idleSince: activity.idle_since,
          sleepsAt: activity.sleeps_at,
          runningAgents: activity.running_agents,
          reportedAt: activity.reported_at,
        }
      : null,
    restarts,
    memory,
    outOfMemory: health?.oomSuspected === true,
    disk: metrics?.diskBytes ? { usedBytes: metrics.diskBytes.value, limitBytes: metrics.limits.diskBytes, at: metrics.diskBytes.at } : null,
    readAt: now,
  };
}

/** `GET /cloud/instances/:id/status`, kept a few seconds in this colo so several open menus share one provider read. */
export async function readComputerStatus(
  env: Pick<CloudEnv, "DB">,
  provider: Pick<CloudProvider, "instanceHealth" | "instanceMetrics">,
  computer: ComputerRow,
  now: number,
): Promise<CloudComputerStatus> {
  const cache = await openCache();
  const url = cacheUrl(computer.instance_id);
  if (cache) {
    const hit = await cache.match(url).catch((error: unknown) => {
      logCloud("cloud.computer_status_cache_failed", { step: "match", instanceId: computer.instance_id, message: errorMessage(error) });
      return undefined;
    });
    const kept = hit ? await hit.json().catch((error: unknown) => {
      logCloud("cloud.computer_status_cache_failed", { step: "read", instanceId: computer.instance_id, message: errorMessage(error) });
      return null;
    }) as CloudComputerStatus | null : null;
    if (kept && kept.instanceId === computer.instance_id) return kept;
  }
  const status = await buildComputerStatus(env, provider, computer, now);
  if (cache) {
    await cache.put(url, new Response(JSON.stringify(status), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${STATUS_CACHE_TTL_S}` },
    })).catch((error: unknown) => {
      logCloud("cloud.computer_status_cache_failed", { step: "put", instanceId: computer.instance_id, message: errorMessage(error) });
    });
  }
  return status;
}
