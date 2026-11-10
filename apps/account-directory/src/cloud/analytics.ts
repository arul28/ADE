import { accountDistinctId, uuidFromSeed } from "../signupAnalytics";
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
  | "computer_limit"
  | "plan_disk"
  | "needs_approval"
  | "extra_off"
  | "monthly_limit"
  | "tier_limit"
  | "owner_limit"
  | "over_plan_disk";

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

async function send(env: CloudEnv, body: Record<string, unknown>): Promise<void> {
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
    await send(env, {
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
    await send(env, {
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
