// Spend and abuse guards for every relay request: the global daily request
// budget, the per-IP gate, and the D1-backed gate on the unauthenticated claim
// path. They run before any route, so each must stay cheap: none writes D1 per
// request except the rare claim gate.

export type SpendGuardEnv = {
  DB: D1Database;
  DAILY_REQUEST_BUDGET?: string;
};

// Spend backstop. Cloudflare has no native hard billing cap, so we enforce one
// in code. The guards themselves no longer write D1 per request (the IP gate is
// in memory, the budget flushes one row per ~50 requests), so a request at the
// cap costs about its own fee plus CPU: ~$0.30/M requests over the account's
// 10M included plus ~6 ms CPU ≈ $0.12/M. 750,000/day ≈ 22.5M/month, so a whole
// month pinned at the cap adds about $7 — inside a ~$10 ceiling — while leaving
// ~2x headroom over legitimate traffic at ~100 users (≈ 330K/day: one presence
// beat per brain per 30 s plus phone and browser sessions). Raise it with the
// user base, not past the ceiling. Tunable via `DAILY_REQUEST_BUDGET`.
export const DEFAULT_DAILY_REQUEST_BUDGET = 750_000;
// General per-IP gate: a busy brain makes maybe 10–30 relay calls/min, so 120
// tolerates several machines behind one NAT yet crushes a flood.
export const DEFAULT_IP_RATE_LIMIT_PER_MIN = 120;
// Tighter gate on the one unauthenticated *write* path. A machine claims once
// (idempotent reclaims are rare), so 10/min/IP is generous for legit pairing
// bursts and near-zero for a spammer trying to grow the machines table.
export const DEFAULT_CLAIM_RATE_LIMIT_PER_MIN = 10;
export const RATE_WINDOW_SECONDS = 60;

export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * Fixed-window per-key limiter backed by the `rate_counters` D1 table. A single
 * atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` both admits
 * and counts:
 *  - a `WHERE` guard on the DO UPDATE means an already-over-limit window is a
 *    no-op — no write, and `RETURNING` yields no row, so a sustained flood costs
 *    a read (not a write) per rejected hit and the limiter never amplifies the
 *    spend it exists to bound;
 *  - because it is one statement, a parallel burst at a window boundary cannot
 *    all observe a below-limit count and all be admitted.
 */
export async function checkRateLimit(
  env: SpendGuardEnv,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; count: number }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  const row = await env.DB
    .prepare(
      `insert into rate_counters(bucket, window_start, count, updated_at)
       values (?1, ?2, 1, ?3)
       on conflict(bucket) do update set
         window_start = case when ?2 - window_start >= ?4 then ?2 else window_start end,
         count        = case when ?2 - window_start >= ?4 then 1  else count + 1 end,
         updated_at   = ?3
         where (?2 - window_start >= ?4) or (count < ?5)
       returning count`,
    )
    .bind(bucket, nowSeconds, nowIso, windowSeconds, limit)
    .first<{ count: number }>();
  // No returned row ⇒ the WHERE guard suppressed the update (window still open
  // and already at the limit) ⇒ rejected, with no D1 write.
  if (!row) return { allowed: false, count: limit };
  return { allowed: true, count: row.count };
}

// Per-isolate memory: once this isolate has seen the daily budget blown, reject
// every further request for free (no D1) until the UTC day rolls over.
let budgetTrippedUntilMs = 0;

// The per-IP gate and the daily budget run on every request, so they must not
// write D1 per request: at 4 billed rows per request they were three quarters
// of this relay's D1 writes. The IP gate is in-isolate memory; the budget is
// counted in memory and flushed to its D1 row in batches.
const ipWindows = new Map<string, { windowStart: number; count: number }>();
const MAX_TRACKED_IPS = 10_000;
let ipWindowsSweptAtSecond = 0;
const BUDGET_FLUSH_EVERY_REQUESTS = 50;
const BUDGET_FLUSH_INTERVAL_MS = 30_000;
let budgetDay = "";
let budgetPending = 0;
let budgetFlushedTotal = 0;
let budgetLastFlushMs = 0;

/** Cheap memory check — true when this isolate already saw today's budget blown. */
export function budgetTrippedNow(): boolean {
  return Date.now() < budgetTrippedUntilMs;
}

/** Test hook: clears the in-isolate budget latch so cases don't leak state. */
export function resetSpendGuardsForTests(): void {
  budgetTrippedUntilMs = 0;
  ipWindows.clear();
  ipWindowsSweptAtSecond = 0;
  budgetDay = "";
  budgetPending = 0;
  budgetFlushedTotal = 0;
  budgetLastFlushMs = 0;
}

/**
 * Fixed-window per-IP limiter in isolate memory: same window and limit as the
 * D1 limiter, without a write per request. It is per isolate, so a client
 * spread across isolates can exceed `limit` by that factor; the global daily
 * budget remains the hard spend backstop, as it already was against rotating
 * IPs. The map is bounded so a flood of distinct IPs cannot grow memory.
 */
export function checkIpRateInMemory(ip: string, limit: number, windowSeconds: number): { allowed: boolean; count: number } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  let entry = ipWindows.get(ip);
  if (!entry || nowSeconds - entry.windowStart >= windowSeconds) {
    if (!entry && ipWindows.size >= MAX_TRACKED_IPS) {
      // Sweep expired windows at most once a second, so a flood of distinct
      // IPs cannot make every request scan the whole map.
      if (nowSeconds !== ipWindowsSweptAtSecond) {
        ipWindowsSweptAtSecond = nowSeconds;
        for (const [key, value] of ipWindows) {
          if (nowSeconds - value.windowStart >= windowSeconds) ipWindows.delete(key);
        }
      }
      // Still full of live windows: drop the oldest-inserted entry rather than
      // grow without bound. That IP starts a fresh window.
      if (ipWindows.size >= MAX_TRACKED_IPS) {
        const oldest = ipWindows.keys().next();
        if (!oldest.done) ipWindows.delete(oldest.value);
      }
    }
    entry = { windowStart: nowSeconds, count: 0 };
    ipWindows.set(ip, entry);
  }
  if (entry.count >= limit) return { allowed: false, count: entry.count };
  entry.count += 1;
  return { allowed: true, count: entry.count };
}

async function flushBudgetCount(env: SpendGuardEnv, day: string, increment: number, nowMs: number): Promise<number> {
  const row = await env.DB
    .prepare(
      `insert into rate_counters(bucket, window_start, count, updated_at)
       values (?, ?, ?, ?)
       on conflict(bucket) do update set count = rate_counters.count + excluded.count,
                                         updated_at = excluded.updated_at
       returning count`,
    )
    .bind(`budget:${day}`, Math.floor(nowMs / 1000), increment, new Date(nowMs).toISOString())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Counts this request against the global daily budget and returns whether the
 * day is still under it. Requests are counted in isolate memory and flushed to
 * the shared `budget:<day>` row every `BUDGET_FLUSH_EVERY_REQUESTS` requests or
 * `BUDGET_FLUSH_INTERVAL_MS`, whichever comes first; the first request in an
 * isolate flushes at once so it learns the global count. The cap is a coarse
 * spend backstop: overshoot is bounded by one unflushed batch per isolate. On
 * the first over-budget request the isolate latches `budgetTrippedUntilMs` to
 * end-of-day so later checks short-circuit in memory.
 */
export async function recordDailyBudget(
  env: SpendGuardEnv,
): Promise<{ allowed: true } | { allowed: false; day: string; count: number; budget: number }> {
  const nowMs = Date.now();
  const budget = positiveIntEnv(env.DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (day !== budgetDay) {
    const previousDay = budgetDay;
    const carried = budgetPending;
    budgetDay = day;
    budgetPending = 0;
    budgetFlushedTotal = 0;
    budgetLastFlushMs = 0;
    if (previousDay && carried > 0) {
      // Best effort: yesterday's tail only matters for its own (closed) cap.
      await flushBudgetCount(env, previousDay, carried, nowMs).catch(() => undefined);
    }
  }
  budgetPending += 1;
  if (budgetPending >= BUDGET_FLUSH_EVERY_REQUESTS || nowMs - budgetLastFlushMs >= BUDGET_FLUSH_INTERVAL_MS) {
    const increment = budgetPending;
    budgetPending = 0;
    budgetLastFlushMs = nowMs;
    try {
      const total = await flushBudgetCount(env, day, increment, nowMs);
      // A flush that straddles UTC midnight returns yesterday's total; it must
      // not become today's baseline (it could trip today's cap at 00:00).
      if (budgetDay === day) budgetFlushedTotal = total;
    } catch (error) {
      // Keep the requests counted for the next flush, then fail as before.
      if (budgetDay === day) budgetPending += increment;
      budgetLastFlushMs = 0;
      throw error;
    }
  }
  const count = budgetFlushedTotal + budgetPending;
  if (count > budget) {
    budgetTrippedUntilMs = Date.parse(`${day}T23:59:59.999Z`);
    return { allowed: false, day, count, budget };
  }
  return { allowed: true };
}
