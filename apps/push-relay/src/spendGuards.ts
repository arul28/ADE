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
// in memory, the budget reserves requests in growing blocks), so a request at the
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
// Custom notifications (`ade notify`, the automations "Send notification"
// step). One push is one Worker request and one D1 row write, and APNs is
// free, so the cap is about the phone, not the bill: 60 an hour is far past
// what a person wants to read, and it stops a looping automation from
// buzzing a phone all night. Counted per account in `rate_counters`
// (bucket `notify:<account>`), kept past the short rate-window prune.
export const ACCOUNT_NOTIFY_LIMIT_PER_HOUR = 60;
export const ACCOUNT_NOTIFY_WINDOW_SECONDS = 60 * 60;
export const ACCOUNT_NOTIFY_BUCKET_PREFIX = "notify:";

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

/**
 * Admits one custom notification for an account, or says how long until the
 * hour window reopens. A rejected call writes nothing (see `checkRateLimit`)
 * and reads the window start once, for the retry hint.
 */
export async function checkAccountNotifyQuota(
  env: SpendGuardEnv,
  accountKey: string,
): Promise<{ allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number }> {
  const bucket = `${ACCOUNT_NOTIFY_BUCKET_PREFIX}${accountKey}`;
  const gate = await checkRateLimit(env, bucket, ACCOUNT_NOTIFY_LIMIT_PER_HOUR, ACCOUNT_NOTIFY_WINDOW_SECONDS);
  if (gate.allowed) {
    return { allowed: true, remaining: Math.max(0, ACCOUNT_NOTIFY_LIMIT_PER_HOUR - gate.count) };
  }
  const row = await env.DB
    .prepare("select window_start from rate_counters where bucket = ?")
    .bind(bucket)
    .first<{ window_start: number }>();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const reopensAt = Number(row?.window_start ?? nowSeconds) + ACCOUNT_NOTIFY_WINDOW_SECONDS;
  return { allowed: false, retryAfterSeconds: Math.max(1, reopensAt - nowSeconds) };
}

// Per-isolate memory: once this isolate has seen the daily budget blown, reject
// every further request for free (no D1) until the UTC day rolls over.
let budgetTrippedUntilMs = 0;

// The per-IP gate and the daily budget run on every request, so they must not
// write D1 per request: at 4 billed rows per request they were three quarters
// of this relay's D1 writes. The IP gate is in-isolate memory; the budget is
// reserved from its D1 row in blocks and spent from memory.
//
// Blocks start at one request and double per reservation up to the cap. A fixed
// 50 counted the unused tail of every block as spent, and most isolates live
// for a handful of requests: on 2026-10-08 the row said 877K against 218K real
// requests, the 750K cap tripped at under a third of its value, and every
// machine's account sync was refused until midnight UTC. Doubling bounds the
// waste to what the isolate actually used (at most 2x, and exact for a
// one-request isolate) while keeping the guarantee that the shared count can
// only run ahead of real traffic, never behind it.
const ipWindows = new Map<string, { windowStart: number; count: number }>();
const MAX_TRACKED_IPS = 10_000;
let ipWindowsSweptAtSecond = 0;
const BUDGET_RESERVATION_FIRST = 1;
const BUDGET_RESERVATION_MAX = 50;
/** The size of this isolate's next reservation; doubles up to the max. */
let budgetNextReservationSize = BUDGET_RESERVATION_FIRST;
let budgetDay = "";
/** Requests left in this isolate's current reservation. */
let budgetReservedRemaining = 0;
/** The shared count right after this isolate's last reservation landed. */
let budgetReservedThrough = 0;
/** The reservation in flight, shared by every request waiting on it. */
let budgetReservation: { day: string; promise: Promise<void> } | null = null;

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
  budgetReservedRemaining = 0;
  budgetReservedThrough = 0;
  budgetReservation = null;
  budgetNextReservationSize = BUDGET_RESERVATION_FIRST;
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

async function reserveBudget(env: SpendGuardEnv, day: string, nowMs: number): Promise<void> {
  const size = budgetNextReservationSize;
  const total = await flushBudgetCount(env, day, size, nowMs);
  // A reservation that straddles UTC midnight belongs to a closed day.
  if (budgetDay !== day) return;
  budgetReservedThrough = total;
  budgetReservedRemaining = size;
  budgetNextReservationSize = Math.min(BUDGET_RESERVATION_MAX, size * 2);
}

/**
 * Counts this request against the global daily budget and returns whether the
 * day is still under it.
 *
 * Each isolate reserves a block of requests from the shared `budget:<day>` row
 * in one upsert and spends them from memory, so the row is written once per
 * block instead of once per request. Blocks grow 1, 2, 4, … up to
 * `BUDGET_RESERVATION_MAX` (see the note at the reservation state). A request never runs
 * ahead of its reservation: concurrent requests wait on the one in flight and
 * are judged against the count it returns. An isolate that stops with unused
 * reservation leaves the shared count high, never low, so the cap can trip a
 * little early but spend can never slip past it. On the first over-budget
 * request the isolate latches `budgetTrippedUntilMs` to end-of-day so later
 * checks short-circuit in memory.
 */
export async function recordDailyBudget(
  env: SpendGuardEnv,
): Promise<{ allowed: true } | { allowed: false; day: string; count: number; budget: number }> {
  const nowMs = Date.now();
  const budget = positiveIntEnv(env.DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (day !== budgetDay) {
    budgetDay = day;
    budgetReservedRemaining = 0;
    budgetReservedThrough = 0;
    budgetReservation = null;
    budgetNextReservationSize = BUDGET_RESERVATION_FIRST;
  }
  for (;;) {
    // The day rolled over while this request waited: it was yesterday's, and
    // yesterday's cap is closed.
    if (budgetDay !== day) return { allowed: true };
    // Another waiter on the same reservation already found the day over budget;
    // reserving again would only inflate the shared count.
    if (budgetTrippedNow()) {
      return { allowed: false, day, count: budgetReservedThrough, budget };
    }
    if (budgetReservedRemaining > 0) {
      budgetReservedRemaining -= 1;
      const count = budgetReservedThrough - budgetReservedRemaining;
      if (count > budget) {
        budgetTrippedUntilMs = Date.parse(`${day}T23:59:59.999Z`);
        return { allowed: false, day, count, budget };
      }
      return { allowed: true };
    }
    if (!budgetReservation || budgetReservation.day !== day) {
      const promise: Promise<void> = reserveBudget(env, day, nowMs).finally(() => {
        if (budgetReservation?.promise === promise) budgetReservation = null;
      });
      budgetReservation = { day, promise };
    }
    // A D1 failure rejects every waiter, as the per-request upsert did.
    await budgetReservation.promise;
  }
}
