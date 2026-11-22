import { accountDistinctId, uuidFromSeed } from "../sinkUtils";
import type { CloudPlanId, CloudTierId } from "./contract";
import { logCloud, type CloudEnv } from "./store";

/**
 * ADE Cloud's server-side product analytics (docs/logging.md, "ADE Cloud
 * (server-side)"). The Worker is where every create, grow, refusal and plan
 * change is decided, for every client version and for work nobody watches,
 * so it records them, not the apps.
 *
 * Closed names and values only: no instance id, name, size in numbers, price,
 * message or Stripe id. The distinct id is the same account hash the apps
 * identify with. The uuid comes from the account, the action, a key and a
 * time bucket, so a retry or a repeat inside the bucket stays one event.
 */

export type CloudAction = "create" | "move" | "copy" | "tier_change" | "grow" | "delete" | "plan_change" | "refused";
export type CloudActionOrigin = "person" | "agent" | "system";
/** The refusals worth counting, as the codes and reasons the routes answer with. */
export type CloudRefusal =
  | "out_of_hours"
  /** Past the hidden cap on computers awake at once (never a plan limit). */
  | "awake_cap"
  /** Past the plan's computer limit (Pricing v2, `computer_limit`). */
  | "computer_limit"
  /** An outside agent (ADE MCP) starting ADE Cloud work on the free plan (`outside_agent_free_plan`). */
  | "outside_agent_free"
  | "tier_limit"
  | "owner_limit"
  | "over_plan_limits";

export type CloudActionEvent = {
  action: CloudAction;
  plan: CloudPlanId;
  origin: CloudActionOrigin;
  /** The computer's size in the main list; `other` for the other four. */
  tier?: CloudTierId | "other" | null;
  refusal?: CloudRefusal;
  /** What was refused. */
  refusedAction?: CloudRefusedAction;
};

export type CloudRefusedAction = "create" | "move" | "copy" | "tier_change" | "grow" | "wake";

/** Holds a promise past the response, when the Worker gave a way to. */
export type CloudWaitUntil = ((promise: Promise<unknown>) => void) | undefined;

const CAPTURE_TIMEOUT_MS = 2_000;
const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;

/** What a capture reads: PostHog's token and host. */
type AnalyticsEnv = Pick<CloudEnv, "POSTHOG_PROJECT_TOKEN" | "POSTHOG_HOST">;

/** One event to PostHog's capture API; nothing without a token. Throws when PostHog can't be reached. */
export async function sendAnalyticsEvent(env: AnalyticsEnv, body: Record<string, unknown>): Promise<void> {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) return;
  const host = (env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "");
  const response = await fetch(`${host}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: token, ...body }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  if (!response.ok) logCloud("cloud.analytics_capture_failed", { status: response.status });
}

function hold(waitUntil: CloudWaitUntil, work: Promise<void>): void {
  // Analytics never fails a request or a tick.
  const quiet = work.catch((error: unknown) => {
    logCloud("cloud.analytics_capture_failed", { message: error instanceof Error ? error.name : "unknown" });
  });
  if (waitUntil) waitUntil(quiet);
}

/**
 * One `ade_cloud_action`. `key` names what it was done to (an instance id,
 * hashed into the uuid and never sent). A refusal is one event per account,
 * refusal and hour; anything else one per account, action, key and minute.
 */
export function captureCloudAction(env: CloudEnv, waitUntil: CloudWaitUntil, userId: string, event: CloudActionEvent, key: string, now: number): void {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const bucketMs = event.action === "refused" ? HOUR_MS : MINUTE_MS;
  const bucket = Math.floor(now / bucketMs) * bucketMs;
  const seedKey = event.action === "refused" ? `${event.refusal}` : key;
  hold(waitUntil, (async () => {
    await sendAnalyticsEvent(env, {
      event: "ade_cloud_action",
      distinct_id: await accountDistinctId(userId),
      uuid: await uuidFromSeed(`ade-cloud-action-v1:${userId}:${event.action}:${seedKey}:${bucket}`),
      timestamp: new Date(bucket).toISOString(),
      properties: {
        client: "account",
        action: event.action,
        plan: event.plan,
        origin: event.origin,
        ...(event.tier ? { tier: event.tier } : {}),
        ...(event.refusal ? { refusal: event.refusal } : {}),
        ...(event.refusedAction ? { refused_action: event.refusedAction } : {}),
        $geoip_disable: true,
      },
    });
  })());
}

/** One request's analytics: who, which plan, from where, about what. */
export type CloudActionTracker = {
  /** Records an action that happened. */
  track: (event: Pick<CloudActionEvent, "action" | "tier">) => void;
  /** Records a refusal of `refusedAction` and hands its response back to return. */
  refuse: <T>(refused: { response: T; refusal: CloudRefusal }) => T;
};

export function cloudActionTracker(args: {
  env: CloudEnv;
  waitUntil: CloudWaitUntil;
  userId: string;
  plan: CloudPlanId;
  origin: CloudActionOrigin;
  /** What it was done to, hashed into the uuid. */
  key: string;
  refusedAction: CloudRefusedAction;
  now: number;
}): CloudActionTracker {
  const { env, waitUntil, userId, plan, origin, key, refusedAction, now } = args;
  return {
    track: (event) => captureCloudAction(env, waitUntil, userId, { ...event, plan, origin }, key, now),
    refuse: (refused) => {
      captureCloudAction(env, waitUntil, userId, { action: "refused", refusal: refused.refusal, refusedAction, plan, origin }, key, now);
      return refused.response;
    },
  };
}

/** Counts a day's power changes can reach; more reads as this many. */
const DAY_COUNT_CAP = 1000;

export type CloudDayCounts = { wakes: number; sleeps: number; stops: number; starts: number; computers: number };

/** One `ade_cloud_day` per account and UTC day, from the daily run: how often its computers woke and slept. */
export function captureCloudDay(env: CloudEnv, waitUntil: CloudWaitUntil, userId: string, day: string, plan: CloudPlanId, counts: CloudDayCounts): void {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const cap = (value: number) => Math.min(DAY_COUNT_CAP, Math.max(0, Math.floor(value)));
  hold(waitUntil, (async () => {
    await sendAnalyticsEvent(env, {
      event: "ade_cloud_day",
      distinct_id: await accountDistinctId(userId),
      uuid: await uuidFromSeed(`ade-cloud-day-v1:${userId}:${day}`),
      timestamp: `${day}T12:00:00.000Z`,
      properties: {
        client: "account",
        plan,
        wakes: cap(counts.wakes),
        sleeps: cap(counts.sleeps),
        stops: cap(counts.stops),
        starts: cap(counts.starts),
        computers: cap(counts.computers),
        $geoip_disable: true,
      },
    });
  })());
}

/* ---- Referrals and the free plan per computer (`referrals.ts`, `freePlan.ts`) ---- */

/** One step of a referral. No code, email or other account's id is ever sent. */
export type CloudReferralStep = "code_entered" | "reward_paid" | "reward_refused" | "cap_reached";

export type CloudReferralEvent = {
  step: CloudReferralStep;
  /** `code_entered`: whether it was taken. */
  result?: "accepted" | "refused";
  /** Why a code or a reward was refused (`CloudInviteRefusalReason`, or `friend_computer_used` | `same_computer`). */
  reason?: string;
  /** `reward_paid`: which side this account is, and whether the referrer got theirs too. */
  role?: "friend" | "referrer";
  referrerRewarded?: boolean;
};

/**
 * One `ade_cloud_referral` per account, step and `key` (hashed into the uuid,
 * never sent) and hour, so a retry stays one event.
 */
export function captureCloudReferral(env: CloudEnv, waitUntil: CloudWaitUntil, userId: string, event: CloudReferralEvent, key: string, now: number): void {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const bucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  hold(waitUntil, (async () => {
    await sendAnalyticsEvent(env, {
      event: "ade_cloud_referral",
      distinct_id: await accountDistinctId(userId),
      uuid: await uuidFromSeed(`ade-cloud-referral-v1:${userId}:${event.step}:${event.result ?? ""}:${event.reason ?? ""}:${key}:${bucket}`),
      timestamp: new Date(now).toISOString(),
      properties: {
        client: "account",
        step: event.step,
        ...(event.result ? { result: event.result } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.role ? { role: event.role } : {}),
        ...(event.referrerRewarded !== undefined ? { referrer_rewarded: event.referrerRewarded } : {}),
        $geoip_disable: true,
      },
    });
  })());
}

/**
 * - `claimed`: a computer's free plan went to this account.
 * - `restored`: an account refused before claimed a computer of its own.
 * - `refused`: the computer already gave another account its free hours.
 * - `id_unreadable`: the computer couldn't read its OS id, so nothing was claimed.
 * - `unclaimed_use`: free hours used with no computer seen (phone or MCP only).
 * The GitHub rules (`freePlanGithub.ts`):
 * - `github_missing`: free hours held, no GitHub connected.
 * - `github_too_new`: held, the GitHub account is younger than 30 days.
 * - `github_used`: held, that GitHub account already gives another ADE account its free plan.
 * - `github_check_failed`: held while GitHub couldn't be asked (tried again later).
 * - `github_released`: a hold cleared, so the free hours came back.
 * - `github_claimed`: this account's GitHub account now holds its free plan.
 * - `card_unlock_started`: the person opened the card page (no charge) for a too-new GitHub account.
 * - `card_unlocked`: a card saved with no charge unlocked a too-new GitHub account.
 */
export type CloudFreePlanStep =
  | "claimed" | "restored" | "refused" | "id_unreadable" | "unclaimed_use"
  | "github_missing" | "github_too_new" | "github_used" | "github_check_failed" | "github_released" | "github_claimed" | "card_unlock_started" | "card_unlocked";

/** One `ade_cloud_free_plan` per account, step and day. The computer's id is never sent. */
export function captureCloudFreePlan(env: CloudEnv, waitUntil: CloudWaitUntil, userId: string, step: CloudFreePlanStep, platform: string | null, now: number): void {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const day = Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS;
  hold(waitUntil, (async () => {
    await sendAnalyticsEvent(env, {
      event: "ade_cloud_free_plan",
      distinct_id: await accountDistinctId(userId),
      uuid: await uuidFromSeed(`ade-cloud-free-plan-v1:${userId}:${step}:${day}`),
      timestamp: new Date(now).toISOString(),
      properties: {
        client: "account",
        step,
        ...(platform ? { platform } : {}),
        $geoip_disable: true,
      },
    });
  })());
}

/* ---- Idle cleanup (`idleCleanup.ts`) ---- */

/**
 * - `warned`: the first warning went out (email and in-app).
 * - `emailed`: a follow-up email (free: about 6 hours before; paid: one a day).
 * - `saved`: every lane's work was saved (a lane backup) before the delete.
 * - `push_refused`: a lane's work wasn't saved, so the computer was kept (the old name stays for the dashboards).
 * - `deleted`: the computer was deleted; its lane stays.
 * - `kept`: the person kept it after a warning (`how`: `button`, `used`,
 *   `hours_back`, or `scheduled`: it has a timed wake-up booked).
 * - `failed`: an ADE-side failure that didn't keep the computer for good
 *   (`reason`: `email_failed`, `delete_failed`, `run_failed`); retried later.
 */
export type CloudIdleCleanupStep = "warned" | "emailed" | "saved" | "push_refused" | "deleted" | "kept" | "failed";

export type CloudIdleCleanupEvent = {
  step: CloudIdleCleanupStep;
  plan: CloudPlanId;
  /** `push_refused` and `failed`: the closed code (`push_left_work`, `prepare_stop_failed`, `wake_timeout`, `delete_failed` ...). */
  reason?: string;
  /** `kept`: how. */
  how?: "button" | "used" | "hours_back" | "scheduled";
};

/** One `ade_cloud_idle_cleanup` per account, step, computer (hashed into the uuid, never sent) and hour. */
export function captureCloudIdleCleanup(env: CloudEnv, waitUntil: CloudWaitUntil, userId: string, event: CloudIdleCleanupEvent, key: string, now: number): void {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const bucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  hold(waitUntil, (async () => {
    await sendAnalyticsEvent(env, {
      event: "ade_cloud_idle_cleanup",
      distinct_id: await accountDistinctId(userId),
      uuid: await uuidFromSeed(`ade-cloud-idle-cleanup-v1:${userId}:${event.step}:${key}:${bucket}`),
      timestamp: new Date(now).toISOString(),
      properties: {
        client: "account",
        step: event.step,
        plan: event.plan,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.how ? { how: event.how } : {}),
        $geoip_disable: true,
      },
    });
  })());
}

/* ---- Safety (`blocks.ts`, `safety.ts`, `costReport.ts`) ---- */

/**
 * - `first_chat`: the account's first saved cloud chat part (once).
 * - `free_cap_50` / `free_cap_80` / `free_cap_100`: free use this month passed that share of the owner's cap (owner-wide, once a month each).
 * - `free_cap_refused`: a free account's new computer or disk grow was refused at the cap.
 * - `blocked` / `unblocked`: the owner blocked or unblocked the account.
 * - `card_reused`: a card that already unlocked free hours on another account was tried again.
 * - `blocked_returned`: a blocked GitHub account or card came back on this account.
 * - `rate_limited`: too many new computers or launches in an hour.
 * - `creates_paused`: a new computer or launch refused by the owner's kill switch.
 * - `signup_burst`: sign-ups from one address reached the hourly alarm.
 */
export type CloudSafetyStep =
  | "first_chat"
  | "free_cap_50" | "free_cap_80" | "free_cap_100" | "free_cap_refused"
  | "blocked" | "unblocked" | "card_reused" | "blocked_returned"
  | "rate_limited" | "creates_paused" | "signup_burst";

/** The distinct id for an owner-wide event that belongs to no account (a cap threshold). */
const SERVER_DISTINCT_ID = "ade-cloud-server";

/** One `ade_cloud_safety` per account (or the server), step, `key` (hashed into the uuid, never sent) and hour. */
export function captureCloudSafety(env: AnalyticsEnv, waitUntil: CloudWaitUntil, userId: string | null, step: CloudSafetyStep, key: string, now: number): void {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const bucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  hold(waitUntil, (async () => {
    await sendAnalyticsEvent(env, {
      event: "ade_cloud_safety",
      distinct_id: userId ? await accountDistinctId(userId) : SERVER_DISTINCT_ID,
      uuid: await uuidFromSeed(`ade-cloud-safety-v1:${userId ?? SERVER_DISTINCT_ID}:${step}:${key}:${bucket}`),
      timestamp: new Date(now).toISOString(),
      properties: { client: "account", step, $geoip_disable: true },
    });
  })());
}

/* ---- The ADE Cloud iPhone (`phones.ts`) ---- */

/**
 * - `started`: a new phone started (`extra`: on extra minutes, the plan's were used up).
 * - `ended`: NoMac said a phone ended (`reason`: `stopped`, `idle`, `time_limit`, `spend_cap`, ...; `billedMinutes`).
 * - `refused`: a start was refused (`reason`: `phone_minutes_out`, `phone_extra_limit`, `phone_free_held`, `paused`).
 */
export type CloudPhoneEvent = {
  step: "started" | "ended" | "refused";
  plan: CloudPlanId;
  device?: string;
  reason?: string;
  minutesLeft?: number;
  extra?: boolean;
  billedMinutes?: number;
};

/** One `ade_cloud_phone` per account, step and phone (hashed into the uuid, never sent); a refusal one per reason and hour. */
export function captureCloudPhone(env: CloudEnv, waitUntil: CloudWaitUntil, userId: string, event: CloudPhoneEvent, key: string, now: number): void {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const bucket = event.step === "refused" ? Math.floor(now / HOUR_MS) * HOUR_MS : 0;
  hold(waitUntil, (async () => {
    await sendAnalyticsEvent(env, {
      event: "ade_cloud_phone",
      distinct_id: await accountDistinctId(userId),
      uuid: await uuidFromSeed(`ade-cloud-phone-v1:${userId}:${event.step}:${key}:${bucket}`),
      timestamp: new Date(now).toISOString(),
      properties: {
        client: "account",
        step: event.step,
        plan: event.plan,
        ...(event.device ? { device: event.device } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.minutesLeft != null ? { minutes_left: event.minutesLeft } : {}),
        ...(event.extra != null ? { extra: event.extra } : {}),
        ...(event.billedMinutes != null ? { billed_minutes: event.billedMinutes } : {}),
        $geoip_disable: true,
      },
    });
  })());
}
