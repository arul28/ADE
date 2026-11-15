import { authenticate, type CallerTokenEnv } from "./callerToken";
import { AWAKE_COMPUTER_CAP } from "./cloud/plans";
import { AWAKE_CAP_COUNT_SQL, PENDING_TIMEOUT_MS, logCloud, reportCloudFailure } from "./cloud/store";

/**
 * Timed wakes for cloud machines (README, "the provider timed wakes").
 *
 * A sleeping cloud machine is frozen, so the timers ADE keeps on it (a
 * chat's scheduled wake-up, an automation's cron) can't fire. Before it lets
 * the machine sleep, the machine's ADE sends its next time here:
 *
 *   PUT    /cloud/wake  {instanceId, url, at}   account bearer
 *   DELETE /cloud/wake  {instanceId}            account bearer
 *
 * The minute cron requests `url`, the machine's public the provider address,
 * `CLOUD_WAKE_LEAD_MS` before `at`. Any request to that address wakes the
 * machine (the provider counts it as traffic, even when nothing listens), so no
 * the provider key ever reaches this Worker. The address must be an
 * `https://<slug>.agent37.app` origin, so a caller can't point the cron
 * anywhere else.
 */

export const CLOUD_WAKE_PATH = "/cloud/wake";
/** Woken this early, so the machine's ADE is back (about 7 s) before its timer is due. */
export const CLOUD_WAKE_LEAD_MS = 2 * 60_000;
/** Further out than this is refused; the machine sends a nearer time when it next sleeps. */
const MAX_AHEAD_MS = 32 * 24 * 60 * 60_000;
/** One account can't fill the table. */
const MAX_PER_ACCOUNT = 50;
/** A wake not delivered by this long after its time is dropped (the machine was deleted). */
const GIVE_UP_AFTER_MS = 30 * 60_000;
const BATCH = 100;
const REQUEST_TIMEOUT_MS = 10_000;

const WAKE_URL = /^https:\/\/[a-z0-9-]{1,63}\.agent37\.app\/?$/i;
const INSTANCE_ID = /^[a-z0-9]{10}$/;

export type CloudWakeEnv = CallerTokenEnv & { DB: D1Database };

export function isCloudWakeRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === CLOUD_WAKE_PATH;
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function handleCloudWakeRequest(request: Request, env: CloudWakeEnv, now = Date.now()): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);
  const caller = await authenticate(request, env);
  if (!caller.ok) return json({ error: "unauthorized" }, 401);
  const body = await readBody(request);
  const instanceId = typeof body?.instanceId === "string" ? body.instanceId.trim() : "";
  if (!INSTANCE_ID.test(instanceId)) return json({ error: "bad_request" }, 400);

  if (request.method === "DELETE") {
    await env.DB.prepare("delete from cloud_wakes where user_id = ? and instance_id = ?").bind(caller.userId, instanceId).run();
    return json({ ok: true }, 200);
  }

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const at = typeof body?.at === "number" && Number.isFinite(body.at) ? Math.round(body.at) : Number.NaN;
  if (!WAKE_URL.test(url) || !Number.isFinite(at) || at < now - 60_000 || at > now + MAX_AHEAD_MS) {
    return json({ error: "bad_request" }, 400);
  }
  const count = await env.DB.prepare("select count(*) as n from cloud_wakes where user_id = ? and instance_id != ?")
    .bind(caller.userId, instanceId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PER_ACCOUNT) return json({ error: "too_many" }, 429);
  await env.DB.prepare(`
    insert into cloud_wakes (user_id, instance_id, wake_url, wake_at, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict (user_id, instance_id) do update set wake_url = excluded.wake_url, wake_at = excluded.wake_at, updated_at = excluded.updated_at
  `).bind(caller.userId, instanceId, url, at, now).run();
  return json({ ok: true, wakeAt: at - CLOUD_WAKE_LEAD_MS }, 200);
}

/**
 * The minute cron: wakes every machine whose time is within the lead, and
 * forgets each once woken. One that doesn't answer is tried each minute until
 * `GIVE_UP_AFTER_MS` past its time.
 *
 * The awake cap holds for timed wakes too, counted as the create and wake
 * routes count it (awake computers and recent reservations,
 * `AWAKE_CAP_COUNT_SQL`): a computer whose account is at it waits for a later
 * tick, and is given up on (reported) once `GIVE_UP_AFTER_MS` passes. Rows of
 * an account at the cap are left out of the read, so they never fill the
 * batch and hold back other accounts' wakes. A computer already awake (one of
 * the caller's own, by its record) takes no slot.
 */
export async function runCloudWakes(env: CloudWakeEnv, options: { now?: number; fetchImpl?: typeof fetch } = {}): Promise<{ woken: number; failed: number }> {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const cutoff = now - PENDING_TIMEOUT_MS;
  const due = await env.DB.prepare(`
    select w.user_id, w.instance_id, w.wake_url, w.wake_at from cloud_wakes w
    where w.wake_at <= ?
      and (w.wake_at < ?
        or exists (select 1 from cloud_computers c where c.instance_id = w.instance_id and c.user_id = w.user_id and c.deleted_at is null and c.status in ('running', 'restarting', 'updating'))
        or (select count(*) from cloud_computers c where c.user_id = w.user_id and c.deleted_at is null and ${AWAKE_CAP_COUNT_SQL}) < ?)
    order by w.wake_at limit ?
  `).bind(now + CLOUD_WAKE_LEAD_MS, now - GIVE_UP_AFTER_MS, cutoff, AWAKE_COMPUTER_CAP, BATCH)
    .all<{ user_id: string; instance_id: string; wake_url: string; wake_at: number }>();
  let woken = 0;
  let failed = 0;
  const rows = due.results ?? [];
  const userIds = [...new Set(rows.map((row) => row.user_id))];
  const counted = userIds.length ? await env.DB.prepare(`
    select user_id, instance_id, status from cloud_computers
    where deleted_at is null and ${AWAKE_CAP_COUNT_SQL} and user_id in (select value from json_each(?))
  `).bind(cutoff, JSON.stringify(userIds)).all<{ user_id: string; instance_id: string; status: string }>() : { results: [] };
  // Awake already, by the account's own record: the wake takes no slot.
  const awakeKey = (userId: string, instanceId: string) => `${userId}\n${instanceId}`;
  const awakeIds = new Set((counted.results ?? []).filter((row) => row.status !== "provisioning").map((row) => awakeKey(row.user_id, row.instance_id)));
  const awakeByUser = new Map<string, number>();
  for (const row of counted.results ?? []) awakeByUser.set(row.user_id, (awakeByUser.get(row.user_id) ?? 0) + 1);
  const givenUp: typeof rows = [];
  const allowed = rows.filter((row) => {
    if (awakeIds.has(awakeKey(row.user_id, row.instance_id))) return true;
    const awake = awakeByUser.get(row.user_id) ?? 0;
    if (awake < AWAKE_COMPUTER_CAP) {
      awakeByUser.set(row.user_id, awake + 1);
      return true;
    }
    if (now - row.wake_at > GIVE_UP_AFTER_MS) {
      reportCloudFailure("cloud.timed_wake_capped", { userId: row.user_id, instanceId: row.instance_id, awake });
      givenUp.push(row);
    } else logCloud("cloud.timed_wake_waits_for_cap", { userId: row.user_id, instanceId: row.instance_id, awake });
    return false;
  });
  await Promise.all(givenUp.map((row) => env.DB.prepare("delete from cloud_wakes where user_id = ? and instance_id = ? and wake_at = ?")
    .bind(row.user_id, row.instance_id, row.wake_at).run()));
  failed += givenUp.length;
  await Promise.all(allowed.map(async (row) => {
    let reached = false;
    if (WAKE_URL.test(row.wake_url)) {
      try {
        // Any answer, a 502 included, means the request reached the machine.
        await fetchImpl(row.wake_url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        reached = true;
      } catch {
        reached = false;
      }
    }
    if (reached) woken += 1;
    else failed += 1;
    if (reached || !WAKE_URL.test(row.wake_url) || now - row.wake_at > GIVE_UP_AFTER_MS) {
      // Only the row this tick read: a newer time the machine sent meanwhile stays.
      await env.DB.prepare("delete from cloud_wakes where user_id = ? and instance_id = ? and wake_at = ?")
        .bind(row.user_id, row.instance_id, row.wake_at).run();
    }
  }));
  return { woken, failed };
}
