import { captureCloudReferral, type CloudWaitUntil } from "./analytics";
import {
  CLOUD_INVITE_ALPHABET,
  CLOUD_INVITE_CODE_LENGTH,
  CLOUD_PATHS,
  CLOUD_REFERRAL_ENTER_DAYS,
  CLOUD_REFERRAL_REWARD_LIMIT,
  CLOUD_REFERRAL_REWARD_MILLI,
  cloudInviteLink,
  parseCloudInviteCode,
  type CloudInviteLookup,
  type CloudInviteRedeemResult,
  type CloudInviteRefusalReason,
  type CloudReferralSummary,
} from "./contract";
import { readClerkUser } from "./email";
import { UNREADABLE_REQUEST_MESSAGE, cloudAccessAllows, fail, json, readJson } from "./http";
import { checkDeviceRateLimit } from "../deviceAuthorization";
import { loadAccount, logCloud, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

/**
 * The referral program (README, "Referrals and the free plan"), the only way
 * to earn hours for now.
 *
 * - Each account has one invite code (`cloud_invite_codes`), made the first
 *   time its summary is built, and the link `https://ade-app.dev/invite/<code>`.
 * - A friend enters the link or the code (`POST /cloud/referrals/redeem`)
 *   within 30 days of creating their ADE account. One referrer per account,
 *   never changed (the friend is `cloud_referrals`' primary key); not their own.
 * - The reward, 20 hours to both, is paid when the friend's first chat runs
 *   on an ADE Cloud computer. The server sees that as the first saved part of
 *   any chat from one of the friend's computers (`chats.ts`, which only a
 *   computer the account owns can write), or, when the friend already had one
 *   before entering the code, at the redeem itself. Either way a free or a
 *   paid plan counts.
 * - A referrer gets at most 10 rewards ever; past that the friend still gets 20.
 * - No reward when the two accounts were seen on one computer, or when the
 *   friend's computer already gave another account its free hours: the
 *   referral is `refused` with that reason.
 * - Race-safe: the reward is one batch (one transaction on D1) that moves the
 *   referral out of `pending` with a fresh token and grants only under that
 *   token; grants are unique per (account, reason, friend), and the referrer's
 *   grant counts its earlier ones in the same statement, so two first chats at
 *   once pay once and the cap holds.
 */

export const REFERRER_REASON = "referral_referrer";
export const FRIEND_REASON = "referral_friend";
/**
 * A deleted account's kept rows (referrals, earned hours, its free-plan
 * claim) carry `deleted:<sha256 of the Clerk id>` instead of the id
 * (`accountDeletion.ts`), so nothing kept names the person.
 */
export const DELETED_ACCOUNT_PREFIX = "deleted:";
const DAY_MS = 24 * 60 * 60_000;
const ENTER_WINDOW_MS = CLOUD_REFERRAL_ENTER_DAYS * DAY_MS;
/** A referrer who reaches the cap this soon after their first reward is reported. */
const CAP_FAST_MS = 7 * DAY_MS;
/** Friends seen on one computer past which a redeem is reported as abuse-shaped. */
const MANY_FRIENDS_ONE_COMPUTER = 3;
const CODE_ATTEMPTS = 6;

type Ctx = { now: number; waitUntil: CloudWaitUntil };

/* ---- Codes ---- */

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CLOUD_INVITE_CODE_LENGTH));
  // 31 letters: a byte modulo 31 is biased by under 1%, which only makes some codes a little likelier.
  return [...bytes].map((byte) => CLOUD_INVITE_ALPHABET[byte % CLOUD_INVITE_ALPHABET.length]).join("");
}

/** The account's invite code, made on first use. A clash with another account's code tries a new one. */
export async function ensureInviteCode(env: CloudEnv, userId: string, now: number): Promise<string> {
  const existing = await env.DB.prepare("select code from cloud_invite_codes where user_id = ?").bind(userId).first<{ code: string }>();
  if (existing) return existing.code;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    // `do nothing` on either key: a second request making this account's code at once keeps the first.
    await env.DB.prepare("insert into cloud_invite_codes (user_id, code, created_at) values (?, ?, ?) on conflict do nothing")
      .bind(userId, randomCode(), now).run();
    const made = await env.DB.prepare("select code from cloud_invite_codes where user_id = ?").bind(userId).first<{ code: string }>();
    if (made) return made.code;
  }
  throw new Error("invite_code_unavailable");
}

/** After Clerk couldn't say, the account read doesn't ask again for this long (per isolate). */
const CLERK_RETRY_MS = 10 * 60_000;
const clerkRetryAt = new Map<string, number>();

/**
 * When the ADE account was created, read from Clerk once and kept on the
 * account row. Without Clerk (development, or Clerk down) it falls back to the
 * ADE Cloud account's own creation, which is never earlier, and keeps nothing;
 * Clerk is asked again at most every `CLERK_RETRY_MS`. A Clerk user with no
 * creation time keeps that fallback, so it is never asked again.
 */
async function accountCreatedAt(env: CloudEnv, account: AccountRow, now: number): Promise<number> {
  if (account.account_created_at != null) return account.account_created_at;
  if ((clerkRetryAt.get(account.user_id) ?? 0) > now) return account.created_at;
  const facts = await readClerkUser(env, account.user_id).catch((error: unknown) => {
    reportCloudFailure("cloud.referral.clerk_read_failed", { message: error instanceof Error ? error.name : "unknown" }, "cloud-referrals");
    return null;
  });
  if (!facts) {
    logCloud("cloud.referral.created_at_fallback", { userId: account.user_id });
    if (clerkRetryAt.size > 10_000) clerkRetryAt.clear();
    clerkRetryAt.set(account.user_id, now + CLERK_RETRY_MS);
    return account.created_at;
  }
  const createdAt = facts.createdAt ?? account.created_at;
  await env.DB.prepare("update cloud_accounts set account_created_at = ? where user_id = ?").bind(createdAt, account.user_id).run();
  account.account_created_at = createdAt;
  return createdAt;
}

/* ---- The summary ---- */

/** Everything `CloudReferralSummary` needs that isn't the code, in one read. */
type SummaryRow = {
  joined: number;
  rewarded: number;
  referred_state: string | null;
  referral_milli: number;
  has_claim: number | null;
};

export async function readSummaryRow(env: CloudEnv, userId: string): Promise<SummaryRow> {
  const row = await env.DB.prepare(`
    select
      (select count(*) from cloud_referrals where referrer_user_id = ?) as joined,
      (select coalesce(sum(referrer_rewarded), 0) from cloud_referrals where referrer_user_id = ?) as rewarded,
      (select state from cloud_referrals where friend_user_id = ?) as referred_state,
      (select coalesce(sum(milli), 0) from cloud_earned_hours where user_id = ? and reason in ('${REFERRER_REASON}', '${FRIEND_REASON}')) as referral_milli,
      (select 1 from cloud_free_plan_claims where user_id = ?) as has_claim
  `).bind(userId, userId, userId, userId, userId).first<SummaryRow>();
  return row ?? { joined: 0, rewarded: 0, referred_state: null, referral_milli: 0, has_claim: null };
}

/** The account's referral summary; `row` when the caller already read it. */
export async function referralSummary(env: CloudEnv, account: AccountRow, now: number, row?: SummaryRow): Promise<CloudReferralSummary> {
  const [code, facts] = await Promise.all([ensureInviteCode(env, account.user_id, now), row ? Promise.resolve(row) : readSummaryRow(env, account.user_id)]);
  const hasReferrer = facts.referred_state != null;
  // Clerk is asked only while the answer can matter: no referrer yet.
  const until = hasReferrer ? null : (await accountCreatedAt(env, account, now)) + ENTER_WINDOW_MS;
  const rewardsPaid = Number(facts.rewarded) || 0;
  return {
    code,
    link: cloudInviteLink(code),
    friendsJoined: Number(facts.joined) || 0,
    rewardsPaid,
    rewardsLeft: Math.max(0, CLOUD_REFERRAL_REWARD_LIMIT - rewardsPaid),
    rewardLimit: CLOUD_REFERRAL_REWARD_LIMIT,
    rewardMilli: CLOUD_REFERRAL_REWARD_MILLI,
    hoursEarnedMilli: Number(facts.referral_milli) || 0,
    canEnterCode: until != null && now < until,
    enterCodeUntil: until,
    hasReferrer,
    referredState: facts.referred_state === "pending" || facts.referred_state === "rewarded" || facts.referred_state === "refused" ? facts.referred_state : null,
  };
}

/* ---- Redeem ---- */

const REFUSALS: Record<CloudInviteRefusalReason, { status: number; message: string }> = {
  invalid_code: { status: 400, message: "That isn't an ADE invite code. Paste the invite link or its 8-character code." },
  unknown_code: { status: 404, message: "No ADE account has that invite code. Check it and try again." },
  own_code: { status: 400, message: "That's your own invite code. Send it to a friend instead." },
  already_referred: { status: 409, message: "This account already used an invite code, and it can't be changed." },
  mutual: { status: 409, message: "That account already used your invite code, so you can't use theirs." },
  too_late: { status: 403, message: `Invite codes can be entered for ${CLOUD_REFERRAL_ENTER_DAYS} days after you make your ADE account.` },
  rate_limited: { status: 429, message: "Too many tries. Wait a minute and try again." },
};

/** Codes one account may try in a minute: enough for typos, too few to guess codes. */
const REDEEM_TRIES_PER_MINUTE = 10;
const REDEEM_WINDOW_MS = 60_000;
const redeemTries = new Map<string, { at: number; count: number }>();

function admitRedeemTry(userId: string, now: number): boolean {
  const entry = redeemTries.get(userId);
  if (!entry || now - entry.at >= REDEEM_WINDOW_MS) {
    redeemTries.set(userId, { at: now, count: 1 });
    if (redeemTries.size > 10_000) redeemTries.clear();
    return true;
  }
  entry.count += 1;
  return entry.count <= REDEEM_TRIES_PER_MINUTE;
}

function refused(env: CloudEnv, userId: string, reason: CloudInviteRefusalReason, ctx: Ctx): Response {
  logCloud("cloud.referral.code_refused", { userId, reason });
  captureCloudReferral(env, ctx.waitUntil, userId, { step: "code_entered", result: "refused", reason }, reason, ctx.now);
  const { status, message } = REFUSALS[reason];
  return fail("invite_refused", message, status, { reason });
}

async function redeem(request: Request, env: CloudEnv, userId: string, ctx: Ctx): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  if (!admitRedeemTry(userId, ctx.now)) return refused(env, userId, "rate_limited", ctx);
  const code = parseCloudInviteCode(body.code);
  if (!code) return refused(env, userId, "invalid_code", ctx);
  const owner = await env.DB.prepare("select user_id from cloud_invite_codes where code = ?").bind(code).first<{ user_id: string }>();
  // An inviter without ADE Cloud has no code to give: the same answer as no code at all.
  if (!owner || !cloudAccessAllows(env, owner.user_id)) return refused(env, userId, "unknown_code", ctx);
  if (owner.user_id === userId) return refused(env, userId, "own_code", ctx);
  const account = await loadAccount(env, userId, ctx.now);
  if (await env.DB.prepare("select 1 as taken from cloud_referrals where friend_user_id = ?").bind(userId).first()) {
    return refused(env, userId, "already_referred", ctx);
  }
  // Two accounts can't refer each other: that would pay each of them twice.
  if (await env.DB.prepare("select 1 as mutual from cloud_referrals where friend_user_id = ? and referrer_user_id = ?").bind(owner.user_id, userId).first()) {
    return refused(env, userId, "mutual", ctx);
  }
  if (ctx.now >= (await accountCreatedAt(env, account, ctx.now)) + ENTER_WINDOW_MS) return refused(env, userId, "too_late", ctx);
  // The primary key keeps one referrer however many redeems race here.
  const inserted = await env.DB.prepare(`
    insert into cloud_referrals (friend_user_id, referrer_user_id, entered_at, state) values (?, ?, ?, 'pending')
    on conflict (friend_user_id) do nothing
  `).bind(userId, owner.user_id, ctx.now).run();
  if ((inserted.meta.changes ?? 0) !== 1) return refused(env, userId, "already_referred", ctx);
  logCloud("cloud.referral.code_accepted", { userId, referrerUserId: owner.user_id });
  captureCloudReferral(env, ctx.waitUntil, userId, { step: "code_entered", result: "accepted" }, "accepted", ctx.now);
  await reportManyFriendsOnOneComputer(env, userId);
  // A friend whose first cloud chat already ran is rewarded now.
  const ranCloudChat = await env.DB.prepare("select 1 as ran from cloud_chat_copies where user_id = ? limit 1").bind(userId).first();
  const rewarded = ranCloudChat ? (await rewardReferralIfDue(env, userId, ctx)) === "rewarded" : false;
  const result: CloudInviteRedeemResult = { result: "accepted", rewarded, referral: await referralSummary(env, await loadAccount(env, userId, ctx.now), ctx.now) };
  return json(result);
}

/** Abuse-shaped: three or more friends seen on one computer this friend was seen on. */
async function reportManyFriendsOnOneComputer(env: CloudEnv, friendId: string): Promise<void> {
  const row = await env.DB.prepare(`
    select count(distinct r.friend_user_id) as friends from cloud_referrals r
    join cloud_account_computers c on c.user_id = r.friend_user_id
    where c.computer_hash in (select computer_hash from cloud_account_computers where user_id = ?)
  `).bind(friendId).first<{ friends: number }>();
  if ((row?.friends ?? 0) >= MANY_FRIENDS_ONE_COMPUTER) {
    reportCloudFailure("cloud.referral.many_friends_one_computer", { userId: friendId, friends: row?.friends }, "cloud-referrals");
  }
}

/* ---- Reward ---- */

export type ReferralRewardOutcome = "none" | "rewarded" | "refused";

/**
 * The account a grant just landed on: its balance recomputed, and its
 * out-of-hours warning and 30-day delete clock reset. Takes `now` twice, then
 * the `where`.
 */
const GRANT_LANDED_SQL = `
  update cloud_accounts set
    earned_granted_milli = (select coalesce(sum(milli), 0) from cloud_earned_hours g where g.user_id = cloud_accounts.user_id),
    hours_restored_at = case when warned_zero_at is not null then ? else hours_restored_at end,
    warned_zero_at = null, updated_at = ?`;

/**
 * Pays a friend's pending referral, or refuses it for a shared computer.
 * Safe to call any number of times, at once too: only the call whose token
 * moved the row out of `pending` writes grants. Called after the friend's
 * first saved cloud chat part and at the redeem.
 */
export async function rewardReferralIfDue(env: CloudEnv, friendId: string, ctx: Ctx): Promise<ReferralRewardOutcome> {
  const referral = await env.DB.prepare("select referrer_user_id from cloud_referrals where friend_user_id = ? and state = 'pending'")
    .bind(friendId).first<{ referrer_user_id: string }>();
  if (!referral) return "none";
  const referrerId = referral.referrer_user_id;
  // A deleted referrer's rows are re-keyed (`accountDeletion.ts`): the friend is still paid, the referrer isn't.
  const referrerGone = referrerId.startsWith(DELETED_ACCOUNT_PREFIX);
  const [friend] = await Promise.all([loadAccount(env, friendId, ctx.now), referrerGone ? null : loadAccount(env, referrerId, ctx.now)]);
  const shared = await env.DB.prepare(`
    select 1 as shared from cloud_account_computers f
    join cloud_account_computers r on r.computer_hash = f.computer_hash
    where f.user_id = ? and r.user_id = ? limit 1
  `).bind(friendId, referrerId).first();
  const refusal = friend.free_refused_at != null ? "friend_computer_used" : shared ? "same_computer" : null;
  if (refusal) {
    const result = await env.DB.prepare("update cloud_referrals set state = 'refused', reason = ?, decided_at = ? where friend_user_id = ? and state = 'pending'")
      .bind(refusal, ctx.now, friendId).run();
    if ((result.meta.changes ?? 0) === 1) {
      logCloud("cloud.referral.reward_refused", { userId: friendId, reason: refusal });
      captureCloudReferral(env, ctx.waitUntil, friendId, { step: "reward_refused", reason: refusal }, "reward", ctx.now);
    }
    return "refused";
  }

  const token = crypto.randomUUID();
  const mine = `exists (select 1 from cloud_referrals where friend_user_id = ? and reward_token = ?)`;
  await env.DB.batch([
    env.DB.prepare("update cloud_referrals set state = 'rewarded', rewarded_at = ?, decided_at = ?, reward_token = ? where friend_user_id = ? and state = 'pending'")
      .bind(ctx.now, ctx.now, token, friendId),
    env.DB.prepare(`
      insert into cloud_earned_hours (user_id, milli, reason, reference, created_at)
      select ?, ?, '${FRIEND_REASON}', ?, ? where ${mine}
      on conflict (user_id, reason, reference) do nothing
    `).bind(friendId, CLOUD_REFERRAL_REWARD_MILLI, friendId, ctx.now, friendId, token),
    // The cap is counted inside this statement, in this transaction: two rewards at once can't both be the 10th.
    env.DB.prepare(`
      insert into cloud_earned_hours (user_id, milli, reason, reference, created_at)
      select ?, ?, '${REFERRER_REASON}', ?, ? where ${mine} and ? = 0
        and (select count(*) from cloud_earned_hours where user_id = ? and reason = '${REFERRER_REASON}') < ?
      on conflict (user_id, reason, reference) do nothing
    `).bind(referrerId, CLOUD_REFERRAL_REWARD_MILLI, friendId, ctx.now, friendId, token, referrerGone ? 1 : 0, referrerId, CLOUD_REFERRAL_REWARD_LIMIT),
    env.DB.prepare(`
      update cloud_referrals set referrer_rewarded = exists (
        select 1 from cloud_earned_hours where user_id = ? and reason = '${REFERRER_REASON}' and reference = ?
      ) where friend_user_id = ? and reward_token = ?
    `).bind(referrerId, friendId, friendId, token),
    // Balances from the grants themselves, so a retry or a race can't count one twice.
    // Hours back after 0: the 30-day delete clock restarts, as for any hours that come back.
    env.DB.prepare(`${GRANT_LANDED_SQL} where user_id = ? and ${mine}`).bind(ctx.now, ctx.now, friendId, friendId, token),
    // The referrer only when its grant landed: past the cap nothing came back, so its out-of-hours warning and clock stay.
    env.DB.prepare(`
      ${GRANT_LANDED_SQL} where user_id = ? and ${mine}
        and exists (select 1 from cloud_earned_hours where user_id = ? and reason = '${REFERRER_REASON}' and reference = ?)
    `).bind(ctx.now, ctx.now, referrerId, friendId, token, referrerId, friendId),
  ]);
  const after = await env.DB.prepare("select reward_token, referrer_rewarded from cloud_referrals where friend_user_id = ?")
    .bind(friendId).first<{ reward_token: string | null; referrer_rewarded: number }>();
  if (after?.reward_token !== token) return "none";
  const referrerRewarded = after.referrer_rewarded === 1;
  logCloud("cloud.referral.reward_paid", { userId: friendId, referrerUserId: referrerId, referrerRewarded });
  captureCloudReferral(env, ctx.waitUntil, friendId, { step: "reward_paid", role: "friend", referrerRewarded }, "reward", ctx.now);
  if (!referrerGone) captureCloudReferral(env, ctx.waitUntil, referrerId, { step: "reward_paid", role: "referrer", referrerRewarded }, friendId, ctx.now);
  if (referrerRewarded) await noteCap(env, referrerId, ctx);
  return "rewarded";
}

/** The referrer's 10th reward: counted, and reported when it came fast. */
async function noteCap(env: CloudEnv, referrerId: string, ctx: Ctx): Promise<void> {
  const row = await env.DB.prepare(`
    select count(*) as rewards, min(created_at) as first_at from cloud_earned_hours where user_id = ? and reason = '${REFERRER_REASON}'
  `).bind(referrerId).first<{ rewards: number; first_at: number | null }>();
  if ((row?.rewards ?? 0) < CLOUD_REFERRAL_REWARD_LIMIT) return;
  logCloud("cloud.referral.cap_reached", { userId: referrerId });
  captureCloudReferral(env, ctx.waitUntil, referrerId, { step: "cap_reached" }, "cap", ctx.now);
  if (row?.first_at != null && ctx.now - row.first_at < CAP_FAST_MS) {
    reportCloudFailure("cloud.referral.cap_reached_fast", { userId: referrerId }, "cloud-referrals");
  }
}

/** After a chat part was saved: the friend's first cloud chat may be the one that pays the referral. Never throws. */
export async function rewardAfterCloudChat(env: CloudEnv, userId: string, now: number): Promise<void> {
  try {
    await rewardReferralIfDue(env, userId, { now, waitUntil: undefined });
  } catch (error) {
    reportCloudFailure("cloud.referral.reward_failed", { userId, message: error instanceof Error ? error.message : "unknown" }, "cloud-referrals");
  }
}

/* ---- Routes ---- */

/** `/cloud/referrals` and `/cloud/referrals/redeem`, behind the `/cloud` access gate. Null for any other path. */
export async function routeReferrals(request: Request, path: string, env: CloudEnv, userId: string, ctx: Ctx): Promise<Response | null> {
  if (path === CLOUD_PATHS.referrals) {
    if (request.method !== "GET") return fail("not_found", "ADE Cloud has no such route.", 404);
    return json(await referralSummary(env, await loadAccount(env, userId, ctx.now), ctx.now));
  }
  if (path === CLOUD_PATHS.referralsRedeem) {
    if (request.method !== "POST") return fail("not_found", "ADE Cloud has no such route.", 404);
    return redeem(request, env, userId, ctx);
  }
  return null;
}

/* ---- The public invite lookup, for the website's invite page ---- */

const LOOKUP_PREFIX = "/invites/";
/** Lookups one address may make in a minute (the device sign-in's limiter, with its own scope). */
const LOOKUPS_PER_MINUTE = 30;
const firstNames = new Map<string, { at: number; firstName: string | null }>();
const FIRST_NAME_TTL_MS = 10 * 60_000;

export function isInviteLookupRequest(url: URL): boolean {
  return url.pathname.startsWith(LOOKUP_PREFIX);
}

/**
 * `GET /invites/<code>`: the inviter's first name for the invite page, and
 * nothing else. "Not found" for a code nobody has and for an inviter without
 * ADE Cloud access, so the page can't tell the two apart.
 */
export async function handleInviteLookup(request: Request, env: CloudEnv): Promise<Response> {
  const url = new URL(request.url);
  // Public by design (a first name the inviter shares with a link), so any page may read it; no credentials ride along.
  const cors: Record<string, string> = { "access-control-allow-origin": "*" };
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
  });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET" } });
  if (request.method !== "GET") return answer(404, { error: { code: "not_found", message: "Not found." } });
  const now = Date.now();
  if (!await checkDeviceRateLimit(request, env, now, "invite_lookup", LOOKUPS_PER_MINUTE)) return answer(429, { error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } });
  let raw: string;
  try {
    raw = decodeURIComponent(url.pathname.slice(LOOKUP_PREFIX.length));
  } catch {
    // A malformed `%` sequence is no code: the same answer as an unknown one, not a 500.
    raw = "";
  }
  const code = parseCloudInviteCode(raw);
  const owner = code ? await env.DB.prepare("select user_id from cloud_invite_codes where code = ?").bind(code).first<{ user_id: string }>() : null;
  if (!owner || !cloudAccessAllows(env, owner.user_id)) return answer(404, { error: { code: "not_found", message: "That invite isn't valid." } });
  let cached = firstNames.get(owner.user_id);
  if (!cached || now - cached.at > FIRST_NAME_TTL_MS) {
    const facts = await readClerkUser(env, owner.user_id).catch((error: unknown) => {
      logCloud("cloud.referral.invite_lookup_clerk_failed", { message: error instanceof Error ? error.name : "unknown" });
      return null;
    });
    cached = { at: now, firstName: facts?.firstName ?? null };
    if (firstNames.size > 5_000) firstNames.clear();
    firstNames.set(owner.user_id, cached);
  }
  logCloud("cloud.referral.invite_looked_up", { found: true });
  return answer(200, { firstName: cached.firstName } satisfies CloudInviteLookup);
}
