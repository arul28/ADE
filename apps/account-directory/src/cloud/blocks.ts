import { sha256Hex } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";
import { captureCloudSafety, type CloudSafetyStep, type CloudWaitUntil } from "./analytics";
import { sendCloudEmail, type CloudEmailEnv } from "./email";
import { fail } from "./http";
import { planIdOf, reportCloudAbuse, reportCloudFailure, type AccountRow, type CloudDb, type CloudEnv } from "./store";

/**
 * The reads and refusals of ADE Cloud's safety rules (README, "ADE Cloud
 * safety"). The actions (block, unblock, the owner routes) live in
 * `safety.ts`; this file has no provider or Stripe calls, so billing and the
 * free plan can import it.
 *
 * - The block list (`cloud_blocks`): a blocked account gets no `/cloud`
 *   route; a blocked GitHub account or card is refused on any new account.
 * - One card unlocks the free hours on one account (`cloud_free_card_claims`).
 * - The owner's kill switch (`CLOUD_CREATES_PAUSED=1`): no new computers or launches.
 * - Per-account limits on new computers and launches an hour.
 * - Owner alerts: sent at once, one email per event (`cloud_owner_alerts`).
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** New computers (creates, moves, copies, a launch's or an automation's) one account may make in an hour. */
const CREATES_PER_HOUR = 10;
/** Server launches one account may start in an hour. */
const LAUNCHES_PER_HOUR = 15;

export const ACCOUNT_BLOCKED_MESSAGE = "ADE Cloud is turned off for this account. Contact ADE support if you think this is a mistake.";
const CREATES_PAUSED_MESSAGE = "ADE Cloud isn't making new computers right now. Your computers keep working. Try again later.";
const TOO_MANY_CREATES_MESSAGE = `You made ${CREATES_PER_HOUR} computers in the last hour. Wait a little, then try again.`;
const TOO_MANY_LAUNCHES_MESSAGE = `You started ${LAUNCHES_PER_HOUR} cloud launches in the last hour. Wait a little, then try again.`;

export const accountBlocked = (): Response => fail("account_blocked", ACCOUNT_BLOCKED_MESSAGE, 403);

/* ---- The block list ---- */

/** Whether the account is on the block list. One indexed read. */
export async function isCloudBlocked(env: CloudDb, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as one from cloud_blocks where user_id = ? limit 1").bind(userId).first<{ one: number }>();
  return row != null;
}

/** "Not blocked" answers the router keeps per isolate, so a busy client's requests don't each read D1. */
const NOT_BLOCKED_TTL_MS = 30_000;
const NOT_BLOCKED_MAX = 10_000;
const notBlockedUntil = new Map<string, number>();

/**
 * {@link isCloudBlocked} for the `/cloud` router: a "not blocked" answer is
 * kept 30 seconds in this isolate. A block still lands at once where it
 * matters: its computers are stopped and cut off by the block itself.
 */
export async function isCloudBlockedForRequest(env: CloudDb, userId: string): Promise<boolean> {
  const now = Date.now();
  if ((notBlockedUntil.get(userId) ?? 0) > now) return false;
  const blocked = await isCloudBlocked(env, userId);
  if (blocked) {
    notBlockedUntil.delete(userId);
  } else {
    if (notBlockedUntil.size >= NOT_BLOCKED_MAX) notBlockedUntil.clear();
    notBlockedUntil.set(userId, now + NOT_BLOCKED_TTL_MS);
  }
  return blocked;
}

/** Drops the kept "not blocked" answer, after a block in this isolate. */
export function forgetNotBlocked(userId: string): void {
  notBlockedUntil.delete(userId);
}

/** SQL that is true when the account in `userIdSql` is not on the block list, for an account select. */
export const notBlockedSql = (userIdSql: string): string => `not exists (select 1 from cloud_blocks where cloud_blocks.user_id = ${userIdSql})`;

/** The accounts of `userIds` on the block list, in one read. */
export async function blockedUsersAmong(env: CloudDb, userIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const rows = await env.DB.prepare("select distinct user_id from cloud_blocks where user_id in (select value from json_each(?))")
    .bind(JSON.stringify(ids)).all<{ user_id: string }>();
  return new Set((rows.results ?? []).map((row) => row.user_id));
}

/** Whether a card is on the block list. */
async function isCardBlocked(env: CloudDb, fingerprint: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as one from cloud_blocks where card_fingerprint = ? limit 1").bind(fingerprint).first<{ one: number }>();
  return row != null;
}

/* ---- The kill switch and the rate limits ---- */

/** `CLOUD_CREATES_PAUSED=1`: no new computers or launches; existing computers keep working. */
const createsPaused = (env: Pick<CloudEnv, "CLOUD_CREATES_PAUSED">): boolean => env.CLOUD_CREATES_PAUSED?.trim() === "1";

/** What asks for new work: a new computer (a create, a move, a copy) or a server launch. */
export type NewWork = "create" | "move" | "copy" | "launch";

/**
 * The owner's kill switch, then the account's hourly limit, for new work.
 * A move replaces a computer, so the kill switch lets it through; it still
 * counts against the hourly limit of new computers. Null when the work may
 * go on, else the refusal to answer.
 */
export async function newWorkRefusal(env: CloudEnv, userId: string, what: NewWork, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  if (what !== "move" && createsPaused(env)) {
    captureCloudSafety(env, waitUntil, userId, "creates_paused", what, now);
    return fail("creates_paused", CREATES_PAUSED_MESSAGE, 503);
  }
  return what === "launch" ? await launchRateRefusal(env, userId, now, waitUntil) : await createRateRefusal(env, userId, now, waitUntil);
}

/**
 * A 429 when the account made {@link CREATES_PER_HOUR} computers in the last
 * hour (deleted ones count; a reservation the provider refused is released
 * and doesn't), else null.
 */
async function createRateRefusal(env: CloudEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  const row = await env.DB.prepare("select count(*) as n from cloud_computers where user_id = ? and created_at > ?")
    .bind(userId, now - HOUR_MS).first<{ n: number }>();
  if ((row?.n ?? 0) < CREATES_PER_HOUR) return null;
  await rateLimited(env, userId, "creates", row?.n ?? 0, now, waitUntil);
  return fail("rate_limited", TOO_MANY_CREATES_MESSAGE, 429);
}

/** A 429 when the account started {@link LAUNCHES_PER_HOUR} server launches in the last hour, else null. */
async function launchRateRefusal(env: CloudEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  const row = await env.DB.prepare("select count(*) as n from cloud_launches where user_id = ? and created_at > ? and state <> 'draft'")
    .bind(userId, now - HOUR_MS).first<{ n: number }>();
  if ((row?.n ?? 0) < LAUNCHES_PER_HOUR) return null;
  await rateLimited(env, userId, "launches", row?.n ?? 0, now, waitUntil);
  return fail("rate_limited", TOO_MANY_LAUNCHES_MESSAGE, 429);
}

/** Saved once per account, kind and hour: a client retrying in a loop must not write a row per try. */
async function rateLimited(env: CloudEnv, userId: string, what: "creates" | "launches", count: number, now: number, waitUntil: CloudWaitUntil): Promise<void> {
  captureCloudSafety(env, waitUntil, userId, "rate_limited", what, now);
  // A record, not an email: it never gets `sent_at`, so it is never taken over.
  const claimed = await claimAlertKey(env, `rate_limited:${what}:${userId}:${Math.floor(now / HOUR_MS)}`, "rate_limited", userId, now, false);
  if (claimed) await reportCloudAbuse(env, "rate_limited", userId, { what, count }, now);
}

/* ---- One free unlock per card ---- */

export type FreeCardClaim = "claimed" | "taken" | "blocked";

/**
 * Claims `fingerprint` for this account's free unlock. `taken`: it already
 * unlocked another account. `blocked`: the card is on the block list.
 * Two accounts racing with one card settle to one claim (the primary key).
 */
async function claimFreeCard(env: CloudDb, userId: string, fingerprint: string, now: number): Promise<{ claim: FreeCardClaim; holder: string | null }> {
  if (await isCardBlocked(env, fingerprint)) return { claim: "blocked", holder: null };
  await env.DB.prepare("insert into cloud_free_card_claims (card_fingerprint, user_id, claimed_at) values (?, ?, ?) on conflict do nothing")
    .bind(fingerprint, userId, now).run();
  const row = await env.DB.prepare("select user_id from cloud_free_card_claims where card_fingerprint = ?").bind(fingerprint).first<{ user_id: string }>();
  const holder = row?.user_id ?? null;
  return { claim: holder === userId ? "claimed" : "taken", holder };
}

/**
 * One card unlocks the free hours on one account (`cloud_free_card_claims`).
 * `claimed` when this account holds the card's claim now. A card that
 * unlocked another account, or one on the block list, is refused, and the
 * owner is alerted once per account and card.
 */
export async function claimCardForFreeUnlock(env: CloudEnv, userId: string, fingerprint: string, ctx: { now: number; waitUntil: CloudWaitUntil }): Promise<FreeCardClaim> {
  const { claim, holder } = await claimFreeCard(env, userId, fingerprint, ctx.now);
  if (claim === "claimed") return claim;
  // The fingerprint stays out of the email: a hash of it names the event.
  const cardKey = (await sha256Hex(fingerprint)).slice(0, 16);
  await sendOwnerAlert(env, claim === "taken"
    ? {
      key: `card_reused:${userId}:${cardKey}`,
      kind: "card_reused",
      userId,
      subject: "ADE Cloud: a card was used again for free hours",
      reason: `A card that already unlocked free hours on account ${holder ?? "(unknown)"} was tried again for account ${userId}. The unlock was refused.`,
      counts: { "Account that holds the card": holder ?? "(unknown)" },
      step: "card_reused",
      abuse: true,
    }
    : {
      key: `blocked_card:${userId}:${cardKey}`,
      kind: "blocked_card_returned",
      userId,
      subject: "ADE Cloud: a blocked card came back",
      reason: `A card on the block list was used to unlock free hours for account ${userId}. The unlock was refused.`,
      step: "blocked_returned",
      abuse: true,
    }, ctx.now, ctx.waitUntil);
  return claim;
}

/* ---- Owner alerts ---- */

/** A claim this old with no `sent_at` belongs to a try that died before it sent or gave the key back. */
const ABANDONED_ALERT_CLAIM_MS = 30 * 60_000;

/**
 * Takes `key` for one alert. False when it was taken already: the event was
 * alerted, or another try is sending it now. A claim left unsent for
 * {@link ABANDONED_ALERT_CLAIM_MS} (its give-back failed too) is taken over,
 * so a database hiccup can't silence the alert for good. `takeOver` false
 * (a once-only record with no email) never takes a key over.
 */
async function claimAlertKey(env: CloudDb, key: string, kind: string, userId: string | null, now: number, takeOver = true): Promise<boolean> {
  const result = await env.DB.prepare(`
    insert into cloud_owner_alerts (alert_key, kind, user_id, created_at) values (?, ?, ?, ?)
    on conflict (alert_key) do update set created_at = excluded.created_at
    where ? = 1 and cloud_owner_alerts.sent_at is null and cloud_owner_alerts.created_at < ?
  `).bind(key, kind, userId, now, takeOver ? 1 : 0, now - ABANDONED_ALERT_CLAIM_MS).run();
  return (result.meta.changes ?? 0) === 1;
}

/** Whether an alert of `kind` whose key starts with `prefix` went out since `since`. */
export async function alertedSince(env: CloudDb, prefix: string, since: number): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as one from cloud_owner_alerts where alert_key >= ? and alert_key < ? and created_at > ? limit 1")
    .bind(prefix, `${prefix}￿`, since).first<{ one: number }>();
  return row != null;
}

const ageText = (ms: number): string => {
  const days = Math.floor(ms / DAY_MS);
  return days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.max(1, Math.round(ms / HOUR_MS))} hours`;
};

/** The facts every owner alert carries about an account: id, plan, ADE account age, GitHub login and its age. Never an email address. */
async function accountAlertLines(env: CloudDb, userId: string, now: number): Promise<string[]> {
  const row = await env.DB.prepare(`
    select a.plan, a.paid_plan, a.stripe_status, coalesce(a.account_created_at, a.created_at) as created_at,
      g.github_login, g.github_user_id, ga.github_created_at
    from (select 1) one
    left join cloud_accounts a on a.user_id = ?
    left join github_app_grants g on g.user_id = ?
    left join github_account_ages ga on ga.github_user_id = g.github_user_id
  `).bind(userId, userId).first<{
    plan: AccountRow["plan"] | null; paid_plan: AccountRow["paid_plan"] | null; stripe_status: string | null; created_at: number | null;
    github_login: string | null; github_user_id: number | null; github_created_at: number | null;
  }>();
  const plan = row?.plan ? planIdOf({ plan: row.plan, paid_plan: row.paid_plan ?? "plus", stripe_status: row.stripe_status }) : "free (no ADE Cloud account row yet)";
  const github = row?.github_login
    ? `${row.github_login} (GitHub id ${row.github_user_id}${row.github_created_at != null ? `, GitHub account ${ageText(now - row.github_created_at)} old` : ", age unknown"})`
    : "not connected";
  return [
    `Account: ${userId}`,
    `Plan: ${plan}`,
    ...(row?.created_at != null ? [`ADE account age: ${ageText(now - row.created_at)}`] : []),
    `GitHub: ${github}`,
  ];
}

/** Where the owner routes live: the production custom domain, or the Worker's own origin. */
function ownerRouteOrigin(env: Pick<CloudEnv, "BILLING_RETURN_ORIGIN">): string {
  return trustedHttpsOrigin(env.BILLING_RETURN_ORIGIN, { requireExactOrigin: true }) ?? "https://<account-directory worker>";
}

/** The exact command that blocks the account (README, "ADE Cloud safety"). */
export function blockCommand(env: Pick<CloudEnv, "BILLING_RETURN_ORIGIN">, userId: string, reason: string): string {
  const body = JSON.stringify({ userId, reason });
  return `curl -X POST ${ownerRouteOrigin(env)}/cloud/owner/block -H "Authorization: Bearer $CLOUD_OWNER_TOKEN" -H "content-type: application/json" -d '${body}'`;
}

/** What an owner alert reads: the database, the email keys, the owner routes' origin and analytics. */
export type OwnerAlertEnv = CloudDb & CloudEmailEnv & Pick<CloudEnv, "BILLING_RETURN_ORIGIN" | "POSTHOG_PROJECT_TOKEN" | "POSTHOG_HOST">;

export type OwnerAlert = {
  /** Names the event: one key sends one email, ever. */
  key: string;
  /** `cloud_abuse_events.kind` and the alert's kind. */
  kind: string;
  /** The account it is about, or null for an owner-wide alert (the free-use cap). */
  userId: string | null;
  subject: string;
  /** One sentence: what happened. */
  reason: string;
  /** Counts that tell how big it is. */
  counts?: Record<string, number | string>;
  /** Other accounts the alert names (a burst's sign-ups), listed under the facts. */
  more?: string[];
  /** The analytics step, when the event has one. */
  step?: CloudSafetyStep;
  /** Saves a `cloud_abuse_events` row and sends a Sentry error too (abuse, not a cap step). */
  abuse?: boolean;
};

/** Gives an alert's key back, so the next time the event is seen it is tried again. */
async function giveBackAlertKey(env: CloudDb, key: string): Promise<void> {
  await env.DB.prepare("delete from cloud_owner_alerts where alert_key = ? and sent_at is null").bind(key).run();
}

/**
 * Whether an abuse row was already saved for this alert, by an earlier try
 * whose key was given back. The row keeps a hash of the key, never the key.
 */
async function abuseAlreadySaved(env: CloudDb, alert: OwnerAlert, keyHash: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    select 1 as one from cloud_abuse_events where user_id is ? and kind = ? and json_extract(detail_json, '$.alert') = ? limit 1
  `).bind(alert.userId, alert.kind, keyHash).first<{ one: number }>();
  return row != null;
}

/**
 * Sends an owner alert at once, unless this event (its key) was already
 * alerted: never throttled, one email per event. A send that fails, or an
 * error after the key was taken, gives the key back, so the next time the
 * event is seen it is tried again; that try saves no second abuse row or
 * Sentry event. Never throws.
 */
export async function sendOwnerAlert(env: OwnerAlertEnv, alert: OwnerAlert, now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  let claimed = false;
  try {
    claimed = await claimAlertKey(env, alert.key, alert.kind, alert.userId, now);
    if (!claimed) return;
    if (alert.abuse) {
      const keyHash = (await sha256Hex(alert.key)).slice(0, 16);
      if (!(await abuseAlreadySaved(env, alert, keyHash))) {
        await reportCloudAbuse(env, alert.kind, alert.userId, { reason: alert.reason, ...alert.counts, alert: keyHash }, now);
      }
    }
    const facts = alert.userId ? await accountAlertLines(env, alert.userId, now) : [];
    const counts = Object.entries(alert.counts ?? {}).map(([name, value]) => `${name}: ${value}`);
    const text = [
      alert.reason,
      ...facts,
      ...counts,
      ...(alert.more?.length ? ["Accounts:", ...alert.more] : []),
      ...(alert.userId ? [`Block it: ${blockCommand(env, alert.userId, alert.kind)}`] : []),
    ].join("\n");
    const result = await sendCloudEmail(env, { owner: true, subject: alert.subject, text });
    if (result === "failed") {
      await giveBackAlertKey(env, alert.key);
      claimed = false;
      return;
    }
    await env.DB.prepare("update cloud_owner_alerts set sent_at = ? where alert_key = ?").bind(now, alert.key).run();
    claimed = false;
    // Once the key is kept, so a retried send never counts the step twice.
    if (alert.step) captureCloudSafety(env, waitUntil, alert.userId, alert.step, alert.key, now);
  } catch (error) {
    reportCloudFailure("cloud.owner_alert_failed", { kind: alert.kind, message: error instanceof Error ? error.message : "unknown" });
    if (claimed) {
      await giveBackAlertKey(env, alert.key).catch((giveBackError: unknown) => {
        reportCloudFailure("cloud.owner_alert_give_back_failed", { kind: alert.kind, message: giveBackError instanceof Error ? giveBackError.message : "unknown" });
      });
    }
  }
}
